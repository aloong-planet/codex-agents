import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { DirectIlinkChannel } from "../src/direct-ilink-channel.js";
import { PrivateStateStore } from "../src/private-state-store.js";
import { WorkflowEngine } from "../src/workflow-engine.js";
import { ChannelTransport } from "../src/channel-transport.js";

it.each(["timeout", "cancelled", "body_disconnect"])("records %s without confusing abort or body failure with JSON syntax", async (fault) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-channel-abort-"));
  const abort = new AbortController();
  const server = createServer((req, res) => {
    req.resume();
    if (fault === "body_disconnect") { res.writeHead(200, { "content-length": "1000" }); res.write('{"ret":'); setImmediate(() => res.destroy()); }
    else setImmediate(() => abort.abort(fault === "timeout" ? new DOMException("PRIVATE_DEADLINE", "TimeoutError") : new DOMException("PRIVATE_CANCEL", "AbortError")));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("test_listener_missing");
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(directory));
  const transport = new ChannelTransport(fetch, diagnostics);
  try {
    await expect(transport.json(`http://127.0.0.1:${address.port}/getuploadurl`, { signal: abort.signal })).rejects.toBeDefined();
    await diagnostics.close();
    const records = (await readDiagnostics(directory)).records;
    expect(records.find((r) => r.kind === "span" && r.name === "channel.request")?.attributes).toMatchObject({ errorCategory: fault === "body_disconnect" ? "network" : fault, status: "failed" });
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  } finally {
    await diagnostics.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("accounts for six selected images when the first upload disconnects and only five messages are accepted", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-six-images-"));
  let uploads = 0;
  const submissions: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8"); req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.url?.endsWith("getuploadurl")) res.end(JSON.stringify({ ret: 0, upload_full_url: "https://novac2c.cdn.weixin.qq.com/upload" }));
      else if (req.url === "/upload") {
        uploads += 1;
        if (uploads === 1) req.socket.destroy();
        else { res.setHeader("x-encrypted-param", `receipt-${uploads}`); res.end(); }
      } else { submissions.push(body); res.end(JSON.stringify({ ret: 0 })); }
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("test_listener_missing");
  const store = new PrivateStateStore(path.join(directory, "state.json"));
  store.save({ version: 1, accountId: "fixture@im.bot", token: "PRIVATE_TOKEN", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: { "fixture@im.wechat": "PRIVATE_CONTEXT" } });
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(directory, "otel")));
  const channel = new DirectIlinkChannel({ store, diagnostics, fetch: (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init) });
  const filePath = path.join(directory, "PRIVATE_IMAGE.png"); await fs.writeFile(filePath, "fixture image bytes");
  const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
    diagnostics,
    templates: [{ id: "fixture.six", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1, effectBudget: { read: 1, external_send: 6 }, steps: [
      { id: "selected", capability: "fixture.selected", capabilityVersion: 1, timeoutMs: 1000 },
      { kind: "map_capability", id: "send", capability: "fixture.send", capabilityVersion: 1, dependsOn: ["selected"], items: { dependency: "selected" }, itemInputBindings: { number: { path: [] } }, timeoutMs: 5000 },
    ] }],
    providers: [{
      catalog: () => [
        { id: "fixture.selected", version: 1, effect: "read", retryClass: "pure", inputSchema: { type: "object" }, outputSchema: { type: "array", maxItems: 6, items: { type: "integer" } } },
        { id: "fixture.send", version: 1, effect: "external_send", retryClass: "non_idempotent", inputSchema: { type: "object", properties: { number: { type: "integer" } }, required: ["number"] }, outputSchema: {} },
      ],
      invoke: async (request) => {
        if (request.capabilityId === "fixture.selected") return { status: "succeeded", output: [1, 2, 3, 4, 5, 6] };
        const result = await channel.sendImage({ accountId: "fixture@im.bot", target: "fixture@im.wechat", filePath, operationId: request.operationId! });
        return result.ok ? { status: "succeeded", output: {} } : { status: "unknown", errorCode: "weixin_media_send_unknown" };
      },
    }],
  });
  try {
    await engine.start();
    const trigger = { triggerId: "fixture-six", source: "fixture" as const, occurredAt: 1, requestedWorkflowId: "fixture.six" };
    const { runId } = await engine.submit(trigger);
    expect(engine.get(runId)?.effects?.map((effect) => effect.state)).toEqual(["unknown", "accepted", "accepted", "accepted", "accepted", "accepted"]);
    expect(uploads).toBe(6); expect(submissions).toHaveLength(5);
    expect(new Set(submissions).size).toBe(5);
    expect((await engine.submit(trigger)).duplicate).toBe(true);
    expect(uploads).toBe(6); expect(submissions).toHaveLength(5);
    await diagnostics.close();
    const evidence = await readDiagnostics(path.join(directory, "otel"), { runRef: runId, maxRecords: 1000 });
    const effects = evidence.records.filter((r) => r.kind === "span" && r.name === "workflow.effect");
    expect(effects.map((r) => r.attributes.itemOrdinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(effects.every((r) => r.attributes.itemTotal === 6)).toBe(true);
    const first = evidence.records.find((r) => r.kind === "span" && r.name === "channel.request" && r.attributes.itemOrdinal === 1 && r.attributes.endpoint === "media_upload");
    expect(first?.attributes).toMatchObject({ errorCategory: "network", networkCode: "UND_ERR_SOCKET", effectRef: effects[0]?.attributes.effectRef });
    expect(evidence.records.filter((r) => r.kind === "span" && r.name === "channel.request" && r.attributes.endpoint === "message_submit").map((r) => r.attributes.itemOrdinal)).toEqual([2, 3, 4, 5, 6]);
    expect(evidence.records.find((r) => r.name === "workflow.batch")?.attributes).toMatchObject({ selectedCount: 6, attemptedCount: 6, acceptedCount: 5, unknownCount: 1, rejectedCount: 0, notAttemptedCount: 0 });
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_");
  } finally {
    await engine.close(); channel.close(); await diagnostics.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it.each([
  { fault: "receipt_missing", endpoint: "media_upload", category: "receipt_missing", httpStatus: 200, reason: "unknown" },
  { fault: "http", endpoint: "media_upload", category: "http", httpStatus: 500, reason: "unknown" },
  { fault: "network", endpoint: "media_upload", category: "network", reason: "unknown" },
  { fault: "invalid_json", endpoint: "upload_url", category: "invalid_json", httpStatus: 200, reason: "unknown" },
  { fault: "provider", endpoint: "upload_url", category: "provider", httpStatus: 200, reason: "rejected" },
])("identifies $fault through the real channel without submitting a message", async ({ fault, endpoint, category, httpStatus, reason }) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-channel-"));
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!); req.resume();
    if (req.url?.endsWith("getuploadurl")) {
      if (fault === "invalid_json") res.end("PRIVATE_INVALID_JSON");
      else res.end(JSON.stringify({ ret: fault === "provider" ? -3 : 0, errmsg: "PRIVATE_PROVIDER_ERROR", upload_full_url: "https://novac2c.cdn.weixin.qq.com/upload" }));
    } else if (fault === "network") req.socket.destroy();
    else { res.statusCode = fault === "http" ? 500 : 200; res.end(""); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("test_listener_missing");
  const store = new PrivateStateStore(path.join(directory, "state.json"));
  store.save({ version: 1, accountId: "fixture@im.bot", token: "PRIVATE_TOKEN", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: { "fixture@im.wechat": "PRIVATE_CONTEXT" } });
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(directory, "otel")));
  // Existing external transport injection redirects requests only in this test; URL validation is unchanged.
  const options = { store, diagnostics, fetch: (url: string | URL, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${new URL(url).pathname}`, init) };
  const channel = new DirectIlinkChannel(options);
  const filePath = path.join(directory, "fixture.png"); await fs.writeFile(filePath, "image bytes");
  try {
    const result = await diagnostics.run("workflow.effect", {}, () => channel.sendImage({ accountId: "fixture@im.bot", target: "fixture@im.wechat", filePath, operationId: "test:upload" }));
    expect(result).toMatchObject({ ok: false, reason });
    expect(requests).toEqual(endpoint === "media_upload" ? ["/ilink/bot/getuploadurl", "/upload"] : ["/ilink/bot/getuploadurl"]);
    await diagnostics.close();
    const evidence = await readDiagnostics(path.join(directory, "otel"));
    const failed = evidence.records.find((r) => r.kind === "span" && r.name === "channel.request" && r.attributes.endpoint === endpoint);
    expect(failed?.attributes).toMatchObject({ ...(httpStatus ? { httpStatus } : {}), errorCategory: category, status: fault === "provider" ? "rejected" : "failed" });
    expect(failed?.status).toBe(2);
    if (fault === "network") expect(failed?.attributes.networkCode).toBe("UND_ERR_SOCKET");
    if (fault === "provider") expect(failed?.attributes.providerCode).toBe(-3);
    const raw = (await Promise.all((await fs.readdir(path.join(directory, "otel"))).map((name) => fs.readFile(path.join(directory, "otel", name), "utf8")))).join("");
    expect(raw).not.toContain("PRIVATE_");
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_");
  } finally {
    channel.close(); await diagnostics.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
