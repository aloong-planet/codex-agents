import { expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { FeishuSdkTransport, type FeishuSdkSessionFactory } from "../src/feishu-sdk-transport.js";

// Real SDK sockets and platform permissions are not exercised; factory mirrors pinned SDK readiness callbacks.
function session() {
  let hooks!: Parameters<FeishuSdkSessionFactory>[1];
  let receiver!: (event: unknown) => Promise<void>;
  let closed = false;
  const outbox: unknown[] = [];
  const factory: FeishuSdkSessionFactory = (_connection, callbacks) => {
    hooks = callbacks;
    return { async start(message) { receiver = message; }, close() { closed = true; },
      async botOpenId() { return "ou_sdkbot"; },
      async upload(input) { outbox.push(input); return "uploaded_key"; },
      async sendResource(input) { outbox.push(input); return { code: 0, data: { message_id: "om_resource" } }; },
      async getMessage(messageId) { outbox.push(messageId); return { code: 0, data: { items: [] } }; },
      async download(input) { outbox.push(input); const stream = Readable.from([Buffer.from("resource bytes")]); return { stream, cancel() { stream.destroy(); } }; },
      async sendText(input) { outbox.push(input); return { code: 0, data: { message_id: "om_result" } }; } };
  };
  return { factory, hooks: () => hooks, receiver: () => receiver, closed: () => closed, outbox };
}
it("waits for actual readiness, forwards events and uses the bound raw send payload", async () => {
  const sdk = session();
  const transport = new FeishuSdkTransport({ appId: "cli_test", appSecret: "dummy" }, sdk.factory);
  const received: unknown[] = [];
  let readyCount = 0;
  let resolved = false;
  try {
    const startup = transport.start({ async message(event) { received.push(event); }, ready() { readyCount++; }, unavailable() {} });
    void startup.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    sdk.hooks().ready();
    await startup;
    expect(readyCount).toBe(1);
    await sdk.receiver()({ message: { content: '{"text":"hello"}' } });
    expect(received).toEqual([{ message: { content: '{"text":"hello"}' } }]);
    expect(await transport.sendText({ chatId: "oc_private", text: "hello", uuid: "fixed" })).toEqual({ code: 0, data: { message_id: "om_result" } });
    expect(sdk.outbox).toEqual([{ chatId: "oc_private", text: "hello", uuid: "fixed" }]);
  } finally { transport.close(); }
});

it("forwards bot identity only through an open SDK session", async () => {
  const sdk = session();
  const transport = new FeishuSdkTransport({ appId: "cli_test", appSecret: "dummy" }, sdk.factory);
  await expect(transport.botOpenId()).rejects.toThrow("feishu_bot_identity_unavailable");
  try {
    const startup = transport.start({ async message() {}, ready() {}, unavailable() {} });
    sdk.hooks().ready(); await startup;
    expect(await transport.botOpenId()).toBe("ou_sdkbot");
  } finally { transport.close(); }
  await expect(transport.botOpenId()).rejects.toThrow("feishu_bot_identity_unavailable");
});

it("starts an outbound-only application without a socket and retains its authenticated REST sender", async () => {
  const lark = await import("@larksuiteoapi/node-sdk");
  const token = vi.spyOn(lark.defaultHttpInstance, "post").mockResolvedValue(
    { code: 0, tenant_access_token: "fixture-outbound-access", expire: 7200 } as unknown as Awaited<ReturnType<typeof lark.defaultHttpInstance.post>>);
  const request = vi.spyOn(lark.defaultHttpInstance, "request").mockResolvedValue(
    { code: 0, data: { message_id: "om_outbound" } } as unknown as Awaited<ReturnType<typeof lark.defaultHttpInstance.request>>);
  const transport = new FeishuSdkTransport({ appId: "cli_outbound_only", appSecret: "fixture-secret", mode: "outbound" });
  let ready = 0;
  try {
    await transport.start({ async message() { throw new Error("outbound_application_received_event"); }, ready() { ready++; }, unavailable() {} });
    expect(ready).toBe(1);
    expect(await transport.sendText({ chatId: "oc_group", text: "准备处理商品文案", uuid: "outbound-fixed" })).toEqual({ code: 0, data: { message_id: "om_outbound" } });
    expect(request.mock.calls).toHaveLength(1);
    expect(request.mock.calls[0]![0]).toMatchObject({ url: "https://open.feishu.cn/open-apis/im/v1/messages",
      data: { receive_id: "oc_group", msg_type: "text", content: '{"text":"准备处理商品文案"}', uuid: "outbound-fixed" } });
    expect(token.mock.calls[0]![1]).toEqual({ app_id: "cli_outbound_only", app_secret: "fixture-secret" });
  } finally { transport.close(); request.mockRestore(); token.mockRestore(); }
});

it("resolves bot identity through the real pinned SDK and rejects unusable responses", async () => {
  const lark = await import("@larksuiteoapi/node-sdk");
  const { createFeishuSdkSession } = await import("../src/feishu-sdk-transport.js");
  // Independent external shape: openclaw/openclaw extensions/feishu/src/probe.ts (2026-11-05).
  // Feishu returns bot at the top level; the SDK-compatible nested response is also accepted.
  let response: unknown = { code: 0, msg: "ok", bot: { app_name: "Fixture Agent", open_id: "ou_topbot" } };
  const token = vi.spyOn(lark.defaultHttpInstance, "post").mockResolvedValue(
    { code: 0, tenant_access_token: "fixture-bot-access", expire: 7200 } as unknown as Awaited<ReturnType<typeof lark.defaultHttpInstance.post>>);
  const request = vi.spyOn(lark.defaultHttpInstance, "request").mockImplementation(async () =>
    response as Awaited<ReturnType<typeof lark.defaultHttpInstance.request>>);
  const sdk = createFeishuSdkSession({ appId: "cli_bot_projection", appSecret: "fixture-secret" }, { ready() {}, unavailable() {}, error() {} });
  try {
    expect(await sdk.botOpenId!()).toBe("ou_topbot");
    response = { code: 0, data: { bot: { open_id: "ou_nestedbot" } } };
    expect(await sdk.botOpenId!()).toBe("ou_nestedbot");
    response = { code: 99991663, msg: "permission denied", bot: { open_id: "ou_rejected" } };
    await expect(sdk.botOpenId!()).rejects.toThrow("feishu_bot_identity_unavailable");
    response = { code: 0, bot: { app_name: "No identity" } };
    await expect(sdk.botOpenId!()).rejects.toThrow("feishu_bot_identity_unavailable");
    expect(request.mock.calls).toHaveLength(4);
    for (const [options] of request.mock.calls) expect(options).toMatchObject({
      method: "GET", url: "https://open.feishu.cn/open-apis/bot/v3/info", timeout: 15000,
    });
  } finally { sdk.close(); request.mockRestore(); token.mockRestore(); }
});

it("forwards parent lookup and resource download through the same open SDK session", async () => {
  const sdk = session();
  const transport = new FeishuSdkTransport({ appId: "cli_test", appSecret: "dummy" }, sdk.factory);
  try {
    const startup = transport.start({ async message() {}, ready() {}, unavailable() {} });
    sdk.hooks().ready(); await startup;
    expect(await transport.getMessage("om_parent")).toEqual({ code: 0, data: { items: [] } });
    const resource = await transport.download({ messageId: "om_parent", resourceKey: "img_key", type: "image" });
    const chunks: Uint8Array[] = [];
    for await (const chunk of resource.stream) chunks.push(chunk);
    resource.cancel();
    expect(Buffer.concat(chunks).toString()).toBe("resource bytes");
    expect(sdk.outbox).toEqual(["om_parent", { messageId: "om_parent", resourceKey: "img_key", type: "image" }]);
  } finally { transport.close(); }
  await expect(transport.getMessage("om_parent")).rejects.toThrow("feishu_transport_unavailable");
  await expect(transport.download({ messageId: "om_parent", resourceKey: "img_key", type: "image" })).rejects.toThrow("feishu_transport_unavailable");
});

it("forwards media only through an open SDK session", async () => {
  const sdk = session();
  const transport = new FeishuSdkTransport({ appId: "cli_test", appSecret: "dummy" }, sdk.factory);
  const upload = { kind: "file" as const, bytes: Buffer.from("private snapshot"), fileName: "报告.pdf" };
  const message = { chatId: "oc_private", msgType: "file" as const, content: '{"file_key":"uploaded_key"}', uuid: "media-operation" };
  await expect(transport.upload(upload)).rejects.toThrow("feishu_transport_unavailable");
  try {
    const startup = transport.start({ async message() {}, ready() {}, unavailable() {} });
    sdk.hooks().ready(); await startup;
    expect(await transport.upload(upload)).toBe("uploaded_key");
    expect(await transport.sendResource(message)).toEqual({ code: 0, data: { message_id: "om_resource" } });
    expect(sdk.outbox).toEqual([
      { kind: "file", bytes: Buffer.from("private snapshot"), fileName: "报告.pdf" },
      { chatId: "oc_private", msgType: "file", content: '{"file_key":"uploaded_key"}', uuid: "media-operation" },
    ]);
  } finally { transport.close(); }
  await expect(transport.upload(upload)).rejects.toThrow("feishu_transport_unavailable");
  await expect(transport.sendResource(message)).rejects.toThrow("feishu_transport_unavailable");
  expect(sdk.outbox).toHaveLength(2);
});
it("closes on timeout and ignores late readiness", async () => {
  vi.useFakeTimers();
  const sdk = session();
  let ready = false;
  const transport = new FeishuSdkTransport({ appId: "cli_test", appSecret: "dummy" }, sdk.factory, 100);
  try {
    const startup = transport.start({ async message() {}, ready() { ready = true; }, unavailable() {} });
    const rejection = expect(startup).rejects.toThrow("feishu_connect_timeout");
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    sdk.hooks().ready();
    expect(ready).toBe(false);
    expect(sdk.closed()).toBe(true);
    await expect(transport.sendText({ chatId: "oc_private", text: "no", uuid: "fixed" })).rejects.toThrow("feishu_transport_unavailable");
    expect(sdk.outbox).toEqual([]);
  } finally { transport.close(); vi.useRealTimers(); }
});
it("rejects failed or cancelled startup and reports only unavailability", async () => {
  for (const mode of ["error", "close"] as const) {
    const sdk = session();
    const transport = new FeishuSdkTransport({ appId: "cli_test", appSecret: "dummy" }, sdk.factory);
    let unavailable = 0;
    const startup = transport.start({ async message() {}, ready() {}, unavailable() { unavailable++; } });
    if (mode === "error") sdk.hooks().error(); else transport.close();
    await expect(startup).rejects.toThrow(mode === "error" ? "feishu_connect_failed" : "feishu_transport_closed");
    expect(sdk.closed()).toBe(true);
    expect(unavailable).toBe(mode === "error" ? 1 : 0);
    transport.close();
  }
});

it("maps resource operations through the real pinned SDK and bounds token HTTP requests", async () => {
  const lark = await import("@larksuiteoapi/node-sdk");
  const { createFeishuSdkSession } = await import("../src/feishu-sdk-transport.js");
  const requests: { url?: string; data?: unknown; params?: unknown; timeout?: number; responseType?: string }[] = [];
  const tokenCalls: unknown[][] = [];
  // SDK's Axios interceptor exposes decoded bodies, despite its AxiosResponse declaration.
  const token = vi.spyOn(lark.defaultHttpInstance, "post").mockImplementation(async (...args) => {
    tokenCalls.push(args);
    return { code: 0, tenant_access_token: "fixture-access", expire: 7200 } as unknown as Awaited<ReturnType<typeof lark.defaultHttpInstance.post>>;
  });
  const request = vi.spyOn(lark.defaultHttpInstance, "request").mockImplementation(async (options) => {
    requests.push(options);
    const url = options.url ?? "";
    const response = url.endsWith("/images") ? { code: 0, data: { image_key: "img_uploaded" } }
      : url.endsWith("/files") ? { code: 0, data: { file_key: "file_uploaded" } }
      : url.endsWith("/resources/img_received") ? { data: Readable.from([Buffer.from("downloaded bytes")]), headers: { "content-type": "image/png" } }
      : url.endsWith("/om_parent") ? { code: 0, data: { items: [{ message_id: "om_parent", chat_id: "oc_owner", msg_type: "text", body: { content: '{"text":"parent"}' } }] } }
      : url.endsWith("/messages") ? { code: 0, data: { message_id: "om_sent" } } : undefined;
    if (!response) throw new Error(`unexpected fixture HTTP ${url}`);
    return response as unknown as Awaited<ReturnType<typeof lark.defaultHttpInstance.request>>;
  });
  const sdk = createFeishuSdkSession({ appId: "cli_media_projection", appSecret: "fixture-secret" }, { ready() {}, unavailable() {}, error() {} });
  try {
    expect(await sdk.upload({ kind: "image", bytes: Buffer.from("image bytes"), fileName: "one.png" })).toBe("img_uploaded");
    expect(await sdk.upload({ kind: "file", bytes: Buffer.from("file bytes"), fileName: "报告.pdf" })).toBe("file_uploaded");
    expect(await sdk.sendResource({ chatId: "oc_owner", msgType: "file", content: '{"file_key":"file_uploaded"}', uuid: "fixed-operation" })).toEqual({ code: 0, data: { message_id: "om_sent" } });
    expect(await sdk.getMessage("om_parent")).toEqual({ code: 0, data: { items: [{ message_id: "om_parent", chat_id: "oc_owner", msg_type: "text", body: { content: '{"text":"parent"}' } }] } });
    const resource = await sdk.download({ messageId: "om_parent", resourceKey: "img_received", type: "image" });
    const chunks: Uint8Array[] = [];
    for await (const chunk of resource.stream) chunks.push(chunk);
    resource.cancel();
    expect(Buffer.concat(chunks).toString()).toBe("downloaded bytes");
    expect(resource.contentType).toBe("image/png");
    expect(requests).toHaveLength(5);
    expect(requests[0]).toMatchObject({ url: "https://open.feishu.cn/open-apis/im/v1/images", data: { image_type: "message", image: Buffer.from("image bytes") }, timeout: 15000 });
    expect(requests[1]).toMatchObject({ data: { file_type: "stream", file_name: "报告.pdf", file: Buffer.from("file bytes") }, timeout: 15000 });
    expect(requests[2]).toMatchObject({ params: { receive_id_type: "chat_id" }, data: { receive_id: "oc_owner", msg_type: "file", content: '{"file_key":"file_uploaded"}', uuid: "fixed-operation" }, timeout: 15000 });
    expect(requests[3]).toMatchObject({ params: { user_id_type: "open_id" } });
    expect(requests[4]).toMatchObject({ url: "https://open.feishu.cn/open-apis/im/v1/messages/om_parent/resources/img_received", params: { type: "image" }, responseType: "stream", timeout: 15000 });
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]).toEqual(["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", { app_id: "cli_media_projection", app_secret: "fixture-secret" }, expect.objectContaining({ timeout: 15000 })]);
  } finally { sdk.close(); request.mockRestore(); token.mockRestore(); }
});
