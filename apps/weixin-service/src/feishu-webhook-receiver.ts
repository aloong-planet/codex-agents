import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type FeishuWebhookConfiguration = {
  port: number;
  path: string;
  verificationToken: string;
  encryptKey: string;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const bounded = (value: unknown, limit = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= limit;
const same = (a: unknown, b: string): boolean => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const MAX_BODY_BYTES = 1024 * 1024;

/** A dedicated public callback surface. It never exposes the local administration server. */
export class FeishuWebhookReceiver {
  private readonly database: DatabaseSync;
  private readonly server = createServer((request, response) => { void this.receive(request, response); });
  private consumer: ((event: unknown) => Promise<void>) | undefined;
  private draining: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closing = false;
  private started = false;
  private readonly generation: string;

  constructor(private readonly options: FeishuWebhookConfiguration & { appId: string; databasePath: string },
    private readonly report: (code: string) => void = () => {}) {
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(options.databasePath);
    chmodSync(options.databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 250;");
    this.database.exec(`CREATE TABLE IF NOT EXISTS feishu_callbacks (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, app_id TEXT NOT NULL, message_id TEXT NOT NULL,
      generation TEXT NOT NULL, payload TEXT, state TEXT NOT NULL DEFAULT 'queued',
      UNIQUE(app_id, message_id)
    )`);
    if (!this.database.prepare("PRAGMA table_info(feishu_callbacks)").all().some((column) => column.name === "retry_at")) {
      this.database.exec("ALTER TABLE feishu_callbacks ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0");
    }
    this.generation = createHash("sha256").update(JSON.stringify([options.appId, options.verificationToken, options.encryptKey])).digest("hex");
    this.database.prepare("UPDATE feishu_callbacks SET state = 'blocked', payload = NULL WHERE state = 'queued' AND generation <> ?").run(this.generation);
    this.server.requestTimeout = 3000;
    this.server.headersTimeout = 3000;
    this.server.maxHeadersCount = 32;
  }

  async start(consumer: (event: unknown) => Promise<void>): Promise<void> {
    if (this.started || this.closing) throw new Error("feishu_webhook_already_started");
    this.started = true;
    this.consumer = consumer;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      this.server.once("error", failed);
      this.server.listen(this.options.port, "127.0.0.1", () => { this.server.off("error", failed); resolve(); });
    });
    this.kick();
  }

  get port(): number | undefined {
    const address = this.server.address();
    return address && typeof address !== "string" ? address.port : undefined;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.retry);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.draining;
    this.database.close();
  }

  private async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown = {}) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    if (request.url !== this.options.path) { request.resume(); reply(404); return; }
    if (request.method !== "POST") { request.resume(); reply(405); return; }
    if (this.closing) { request.resume(); reply(503); return; }
    if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) { request.resume(); reply(413); return; }
    request.setTimeout(2000, () => request.destroy());
    let length = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += bytes.length;
        if (length > MAX_BODY_BYTES) { reply(413); return; }
        chunks.push(bytes);
      }
    } catch { if (!response.headersSent) reply(400); return; }
    const raw = Buffer.concat(chunks);
    let payload: Record<string, unknown> | undefined;
    try {
      const wrapper = record(JSON.parse(raw.toString("utf8")));
      if (!wrapper || !bounded(wrapper.encrypt, MAX_BODY_BYTES)) { reply(400); return; }
      const encrypted = Buffer.from(wrapper.encrypt, "base64");
      if (encrypted.length < 32 || encrypted.length % 16 !== 0) { reply(400); return; }
      const decipher = createDecipheriv("aes-256-cbc", createHash("sha256").update(this.options.encryptKey).digest(), encrypted.subarray(0, 16));
      payload = record(JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString("utf8")));
    } catch { reply(400); return; }
    if (!payload) { reply(400); return; }
    // Feishu URL verification has no normal-event signature; it must prove the configured token after decryption.
    if (payload.type === "url_verification") {
      if (!same(payload.token, this.options.verificationToken)) { reply(401); return; }
      if (!bounded(payload.challenge)) { reply(400); return; }
      reply(200, { challenge: payload.challenge });
      return;
    }
    const timestamp = request.headers["x-lark-request-timestamp"], nonce = request.headers["x-lark-request-nonce"];
    if (!bounded(timestamp, 32) || !/^\d+$/.test(timestamp) || !bounded(nonce, 256)) { reply(401); return; }
    // Authenticate the exact bytes, including whitespace. No short freshness window rejects Feishu's delayed retries.
    const signature = createHash("sha256").update(timestamp + nonce + this.options.encryptKey).update(raw).digest("hex");
    if (!same(request.headers["x-lark-signature"], signature)) { reply(401); return; }
    const header = record(payload.header), event = record(payload.event);
    if (payload.schema !== "2.0" || !header || !same(header.token, this.options.verificationToken) || header.app_id !== this.options.appId) { reply(401); return; }
    if (header.event_type !== "im.message.receive_v1") { reply(200); return; }
    const message = record(event?.message), sender = record(event?.sender);
    if (!message || !sender || !bounded(message.message_id) || !bounded(message.chat_id) ||
        !bounded(message.create_time, 32) || !bounded(message.message_type, 64) || typeof message.content !== "string" ||
        !["p2p", "group"].includes(String(message.chat_type))) { reply(400); return; }
    if (sender.sender_type !== "user") { reply(200); return; }
    if (!bounded(record(sender.sender_id)?.open_id, 200)) { reply(400); return; }
    // Store only the SDK-equivalent message projection, never the verification token or arbitrary header overrides.
    const normalized = { app_id: this.options.appId, sender, message };
    try {
      this.database.prepare("INSERT OR IGNORE INTO feishu_callbacks(app_id, message_id, generation, payload) VALUES (?, ?, ?, ?)")
        .run(this.options.appId, message.message_id, this.generation, JSON.stringify(normalized));
    } catch { this.failure("feishu_webhook_admission_failed"); reply(503); return; }
    reply(200);
    setImmediate(() => this.kick());
  }

  private kick(): void {
    if (this.closing || this.draining || !this.consumer || this.retry) return;
    this.draining = this.drain().catch(() => {
      this.failure("feishu_webhook_consumer_failed");
      if (!this.closing) this.retry = setTimeout(() => { this.retry = undefined; this.kick(); }, 1000);
    }).finally(() => { this.draining = undefined; });
  }

  private async drain(): Promise<void> {
    while (!this.closing && this.consumer) {
      const row = this.database.prepare(`SELECT candidate.sequence, candidate.payload FROM feishu_callbacks AS candidate
        WHERE candidate.app_id = ? AND candidate.generation = ? AND candidate.state = 'queued' AND candidate.retry_at <= ?
          AND NOT EXISTS (SELECT 1 FROM feishu_callbacks AS earlier WHERE earlier.app_id = candidate.app_id
            AND earlier.generation = candidate.generation AND earlier.state = 'queued' AND earlier.sequence < candidate.sequence
            AND json_extract(earlier.payload, '$.message.chat_id') = json_extract(candidate.payload, '$.message.chat_id'))
        ORDER BY candidate.sequence LIMIT 1`).get(this.options.appId, this.generation, Date.now());
      if (!row) {
        if (this.database.prepare("SELECT 1 FROM feishu_callbacks WHERE state = 'queued' AND generation = ? LIMIT 1").get(this.generation)) {
          this.retry = setTimeout(() => { this.retry = undefined; this.kick(); }, 1000);
        }
        return;
      }
      try {
        await this.consumer(JSON.parse(String(row.payload)));
        this.database.prepare("UPDATE feishu_callbacks SET state = 'completed', payload = NULL WHERE sequence = ?").run(row.sequence!);
      } catch {
        this.failure("feishu_webhook_consumer_failed");
        this.database.prepare("UPDATE feishu_callbacks SET retry_at = ? WHERE sequence = ?").run(Date.now() + 1000, row.sequence!);
      }
    }
  }

  private failure(code: string): void { try { this.report(code); } catch { /* Diagnostics cannot change admission. */ } }
}
