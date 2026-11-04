import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuTransport } from "./feishu-channel.js";
import type { FeishuMediaTransport } from "./feishu-media-delivery.js";
import type { FeishuResourceTransport } from "./feishu-inbound-media.js";

type Connection = { appId: string; appSecret: string };
type Hooks = { ready(): void; unavailable(): void; error(): void };
export type FeishuSdkSession = {
  botOpenId?: () => Promise<string>;
  start(message: (event: unknown) => Promise<void>): Promise<void>;
  close(): void;
  sendText: FeishuTransport["sendText"];
  upload: FeishuMediaTransport["upload"];
  sendResource: FeishuMediaTransport["sendResource"];
  getMessage: FeishuResourceTransport["getMessage"];
  download: FeishuResourceTransport["download"];
};
export type FeishuSdkSessionFactory = (connection: Connection, hooks: Hooks) => FeishuSdkSession;

// SDK debug/error payloads can contain credentials and message bodies. Report only host-owned codes.
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
export const createFeishuSdkSession: FeishuSdkSessionFactory = (connection, hooks) => {
  // API operations use request(); token acquisition uses post(). Bound both while preserving SDK decoding.
  const httpInstance = new Proxy(lark.defaultHttpInstance, {
    get(target, property, receiver) {
      if (property === "request") return (options: Parameters<typeof target.request>[0]) => target.request({ ...options, timeout: 15_000 });
      if (property === "post") return (...[url, data, options]: Parameters<typeof target.post>) => target.post(url, data, { ...options, timeout: 15_000 });
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as NonNullable<ConstructorParameters<typeof lark.Client>[0]["httpInstance"]>;
  // Axios declares a response wrapper, while this SDK instance's response interceptor returns its decoded body.
  const client = new lark.Client({ ...connection, domain: lark.Domain.Feishu, logger, httpInstance });
  const socket = new lark.WSClient({ ...connection, domain: lark.Domain.Feishu, logger, httpInstance,
    autoReconnect: true, handshakeTimeoutMs: 15_000,
    onReady: hooks.ready, onReconnected: hooks.ready, onReconnecting: hooks.unavailable, onError: hooks.error });
  return {
    botOpenId: async () => {
      const response = await client.request<{ code?: number; bot?: { open_id?: string }; data?: { bot?: { open_id?: string } } }>({ method: "GET", url: "/open-apis/bot/v3/info", timeout: 15_000 });
      const id = response.bot?.open_id ?? response.data?.bot?.open_id;
      if (response.code !== 0 || !id) throw new Error("feishu_bot_identity_unavailable");
      return id;
    },
    start: (message) => socket.start({ eventDispatcher: new lark.EventDispatcher({ logger }).register({ "im.message.receive_v1": message }) }),
    close: () => socket.close({ force: true }),
    getMessage: (messageId) => client.im.message.get({ path: { message_id: messageId } }),
    download: async ({ messageId, resourceKey, type }) => {
      const resource = await client.im.messageResource.get({ path: { message_id: messageId, file_key: resourceKey }, params: { type } });
      const stream = resource.getReadableStream();
      const contentType: unknown = resource.headers?.["content-type"];
      return { stream, ...(typeof contentType === "string" ? { contentType } : {}), cancel() { stream.destroy(); } };
    },
    upload: async ({ kind, bytes, fileName }) => {
      const key = kind === "image"
        ? (await client.im.image.create({ data: { image_type: "message", image: bytes } }))?.image_key
        : (await client.im.file.create({ data: { file_type: "stream", file_name: fileName, file: bytes } }))?.file_key;
      if (!key) throw new Error("feishu_upload_failed");
      return key;
    },
    sendResource: async ({ chatId, msgType, content, uuid }) => {
      const result = await client.im.message.create({ params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: msgType, content, uuid } });
      return { ...(result.code !== undefined ? { code: result.code } : {}),
        ...(result.data?.message_id ? { data: { message_id: result.data.message_id } } : {}) };
    },
    // Use the raw API. The SDK's higher-level Channel helper retries/falls back, contrary to our delivery contract.
    sendText: async ({ chatId, text, uuid }) => {
      const result = await client.im.message.create({ params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }), uuid } });
      return { ...(result.code !== undefined ? { code: result.code } : {}),
        ...(result.data?.message_id ? { data: { message_id: result.data.message_id } } : {}) };
    },
  };
};

/** The SDK's start() launches a connection attempt; only onReady establishes readiness. */
export class FeishuSdkTransport implements FeishuTransport, FeishuMediaTransport, FeishuResourceTransport {
  private session: FeishuSdkSession | undefined;
  private closed = false;
  private cancelStart: (() => void) | undefined;
  constructor(private readonly connection: Connection, private readonly factory: FeishuSdkSessionFactory = createFeishuSdkSession,
    private readonly startupTimeoutMs = 30_000) {}

  async start(handlers: Parameters<FeishuTransport["start"]>[0]): Promise<void> {
    if (this.session || this.closed) throw new Error("feishu_transport_already_started");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.cancelStart = undefined;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => { this.session?.close(); finish(new Error("feishu_connect_timeout")); }, this.startupTimeoutMs);
      this.cancelStart = () => finish(new Error("feishu_transport_closed"));
      try {
        this.session = this.factory({ ...this.connection }, {
          ready: () => { if (!this.closed) { handlers.ready(); finish(); } },
          unavailable: () => { if (!this.closed) handlers.unavailable(); },
          error: () => { if (!this.closed) { handlers.unavailable(); finish(new Error("feishu_connect_failed")); } },
        });
        void this.session.start(handlers.message).catch(() => finish(new Error("feishu_connect_failed")));
      } catch { finish(new Error("feishu_connect_failed")); }
    }).catch((error: unknown) => { this.closed = true; this.session?.close(); throw error; });
  }
  async sendText(input: Parameters<FeishuTransport["sendText"]>[0]) {
    if (!this.session || this.closed) throw new Error("feishu_transport_unavailable");
    return this.session.sendText(input);
  }
  async botOpenId(): Promise<string> {
    if (!this.session?.botOpenId || this.closed) throw new Error("feishu_bot_identity_unavailable");
    return this.session.botOpenId();
  }
  async upload(input: Parameters<FeishuMediaTransport["upload"]>[0]) {
    if (!this.session || this.closed) throw new Error("feishu_transport_unavailable");
    return this.session.upload(input);
  }
  async sendResource(input: Parameters<FeishuMediaTransport["sendResource"]>[0]) {
    if (!this.session || this.closed) throw new Error("feishu_transport_unavailable");
    return this.session.sendResource(input);
  }
  async getMessage(messageId: string) {
    if (!this.session || this.closed) throw new Error("feishu_transport_unavailable");
    return this.session.getMessage(messageId);
  }
  async download(input: Parameters<FeishuResourceTransport["download"]>[0]) {
    if (!this.session || this.closed) throw new Error("feishu_transport_unavailable");
    return this.session.download(input);
  }
  close(): void { this.closed = true; this.cancelStart?.(); this.session?.close(); }
}
