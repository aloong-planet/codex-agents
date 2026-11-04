import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { InboundContent, MessageAttachment as StoredIlinkMedia } from "./channel-contract.js";

const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_ID = /^[A-Za-z0-9._-]+@im\.wechat$/;
const EVENT_KEY = /^[a-f0-9]{64}$/;
const MAX_SECRET_CHARS = 32 * 1024;
const MAX_TEXT_CHARS = 8_000;

export type DurableInboundContext = {
  generation?: string;
  target: string;
  contextToken: string;
  lastInboundAt: number;
  contextUpdatedAt: number;
};

export type DurableAdmission = { senderId: string; conversationType: "private" | "group"; bindingHash: string; observation?: boolean };

export type DurableInboundEnvelope = {
  admission?: DurableAdmission;
  eventKey: string;
  accountId: string;
  target: string;
  messageId: string;
  kind: "message" | "rejected";
  source: "text" | "voice" | "media";
  text: string;
  attachments?: StoredIlinkMedia[];
  quote?: { title?: string; text?: string; attachments: StoredIlinkMedia[] };
  rejectionReason?: "voice_too_long" | "voice_duration_invalid" | "voice_transcript_missing";
  durationMs?: number;
  receivedAt: number;
  observedAt: number;
  contextToken: string;
};

export type DurableInboundBatch = {
  accountId: string;
  nextCursor: string;
  contexts: DurableInboundContext[];
  envelopes: DurableInboundEnvelope[];
};

export type DurableInboundCheckpoint = {
  accountId: string;
  getUpdatesBuf: string;
  contexts: DurableInboundContext[];
};

export type QueuedInboundEnvelope = DurableInboundEnvelope & {
  state: "queued";
  revision: number;
};

export type DurableInboundJob = DurableInboundEnvelope & {
  state: "queued" | "leased" | "completed" | "recovery_blocked";
  revision: number;
  attempts: number;
  leaseOwner?: string;
  leaseUntil?: number;
};

type CheckpointRow = { account_id: string; get_updates_buf: string };
type ContextRow = {
  context_generation: string | null;
  target: string;
  context_token: string;
  last_inbound_at: number;
  context_updated_at: number;
};
type InboxRow = {
  event_key: string;
  account_id: string;
  target: string;
  message_id: string;
  kind: string;
  payload_json: string;
  context_token: string;
  received_at: number;
  observed_at: number;
  state: string;
  revision: number;
  attempts: number;
  lease_owner: string | null;
  lease_until: number | null;
};

export class DurableInboundStore {
  private readonly database: DatabaseSync;

  constructor(
    databasePath: string,
    private readonly now: () => number = Date.now,
  ) {
    const directory = path.dirname(databasePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    this.database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS channel_binding (account_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_checkpoint (
        account_id TEXT PRIMARY KEY,
        get_updates_buf TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS target_context (
        account_id TEXT NOT NULL,
        target TEXT NOT NULL,
        context_token TEXT NOT NULL,
        last_inbound_at INTEGER NOT NULL,
        context_updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, target)
      );
      CREATE TABLE IF NOT EXISTS inbox (
        event_key TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        target TEXT NOT NULL,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'rejected')),
        payload_json TEXT NOT NULL,
        context_token TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed', 'recovery_blocked')),
        revision INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        attempts INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_target_queue
        ON inbox(account_id, target, state, received_at, event_key);
    `);
    if (!this.database.prepare("PRAGMA table_info(target_context)").all().some((column) => column.name === "context_generation")) {
      this.database.exec("ALTER TABLE target_context ADD COLUMN context_generation TEXT");
    }
  }

  bindCredentials(accountId: string, generation: string, adoptLegacy = false): void {
    this.assertAccountId(accountId);
    if (!/^[a-f0-9-]{36,64}$/u.test(generation)) throw new Error("inbound_binding_invalid");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT generation FROM channel_binding WHERE account_id = ?").get(accountId);
      if (existing?.generation !== generation && (existing || !adoptLegacy)) {
        this.database.prepare("DELETE FROM target_context WHERE account_id = ?").run(accountId);
        this.database.prepare("DELETE FROM channel_checkpoint WHERE account_id = ?").run(accountId);
      }
      this.database.prepare("INSERT INTO channel_binding VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET generation = excluded.generation").run(accountId, generation);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  ingestBatch(batch: DurableInboundBatch): { inserted: number; duplicates: number } {
    this.validateBatch(batch);
    const at = this.now();
    let inserted = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO channel_checkpoint(account_id, get_updates_buf, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          get_updates_buf = excluded.get_updates_buf,
          updated_at = excluded.updated_at
      `).run(batch.accountId, batch.nextCursor, at);
      const upsertContext = this.database.prepare(`
        INSERT INTO target_context(account_id, target, context_token, last_inbound_at, context_updated_at, context_generation)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, target) DO UPDATE SET
          context_token = excluded.context_token,
          last_inbound_at = excluded.last_inbound_at,
          context_updated_at = excluded.context_updated_at,
          context_generation = excluded.context_generation
      `);
      for (const context of batch.contexts) {
        upsertContext.run(
          batch.accountId,
          context.target,
          context.contextToken,
          context.lastInboundAt,
          context.contextUpdatedAt,
          context.generation ?? null,
        );
      }
      const insertEnvelope = this.database.prepare(`
        INSERT OR IGNORE INTO inbox(
          event_key, account_id, target, message_id, kind, payload_json,
          context_token, received_at, observed_at, state, revision,
          attempts, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?)
      `);
      for (const envelope of batch.envelopes) {
        const payload = JSON.stringify({
          source: envelope.source,
          text: envelope.text,
          ...(envelope.attachments ? { attachments: envelope.attachments } : {}),
          ...(envelope.quote ? { quote: envelope.quote } : {}),
          ...(envelope.rejectionReason ? { rejectionReason: envelope.rejectionReason } : {}),
          ...(envelope.durationMs !== undefined ? { durationMs: envelope.durationMs } : {}),
        });
        const result = insertEnvelope.run(
          envelope.eventKey,
          envelope.accountId,
          envelope.target,
          envelope.messageId,
          envelope.kind,
          payload,
          envelope.contextToken,
          envelope.receivedAt,
          envelope.observedAt,
          at,
          at,
        );
        inserted += Number(result.changes);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { inserted, duplicates: batch.envelopes.length - inserted };
  }

  /** Commit an authenticated, normalized message before acknowledging its transport event. */
  ingestMessage(message: InboundContent, bindingHash: string, observation = false): { inserted: number; duplicates: number } {
    this.assertAccountId(message.accountId);
    this.assertQueueTarget(message.target);
    if (!EVENT_KEY.test(message.key) || !EVENT_KEY.test(bindingHash) ||
        typeof message.senderId !== "string" || !message.senderId || message.senderId.length > 200 ||
        !["private", "group"].includes(message.conversationType ?? "") || (observation && message.conversationType !== "group") || !["text", "media"].includes(message.source) ||
        typeof message.messageId !== "string" || !message.messageId || message.messageId.length > 512 ||
        typeof message.text !== "string" || Array.from(message.text).length > MAX_TEXT_CHARS) throw new Error("inbound_message_invalid");
    this.validateMediaList(message.attachments);
    if (message.quote) {
      if (message.quote.title !== undefined && (typeof message.quote.title !== "string" || Array.from(message.quote.title).length > 512)) throw new Error("inbound_quote_invalid");
      if (message.quote.text !== undefined && (typeof message.quote.text !== "string" || Array.from(message.quote.text).length > MAX_TEXT_CHARS)) throw new Error("inbound_quote_invalid");
      this.validateMediaList(message.quote.attachments);
    }
    this.assertTimestamp(message.receivedAt);
    const observedAt = message.observedAt ?? this.now();
    this.assertTimestamp(observedAt);
    const admission: DurableAdmission = { senderId: message.senderId, conversationType: message.conversationType!, bindingHash, ...(observation ? { observation: true } : {}) };
    const at = this.now();
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO inbox(
        event_key, account_id, target, message_id, kind, payload_json,
        context_token, received_at, observed_at, state, revision, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'message', ?, '', ?, ?, 'queued', 0, 0, ?, ?)
    `).run(message.key, message.accountId, message.target, message.messageId,
      JSON.stringify({ source: message.source, text: message.text, admission,
        ...(message.attachments ? { attachments: message.attachments } : {}), ...(message.quote ? { quote: message.quote } : {}) }),
      message.receivedAt, observedAt, at, at);
    const inserted = Number(result.changes);
    return { inserted, duplicates: 1 - inserted };
  }

  /** Bounded inert discussion, preceding the current event in durable arrival order. */
  groupDiscussion(accountId: string, target: string, beforeKey: string): NonNullable<InboundContent["discussion"]> {
    this.assertAccountId(accountId); this.assertQueueTarget(target);
    if (!EVENT_KEY.test(beforeKey)) throw new Error("inbound_event_key_invalid");
    const rows = this.database.prepare(`SELECT event_key, payload_json, received_at FROM inbox
      WHERE account_id = ? AND target = ? AND rowid < (SELECT rowid FROM inbox WHERE event_key = ?)
      AND state = 'completed' ORDER BY rowid DESC LIMIT 100`).all(accountId, target, beforeKey);
    const result: NonNullable<InboundContent["discussion"]> = [];
    let remaining = 16000;
    for (const row of rows) {
      const payload = JSON.parse(String(row.payload_json)) as { admission?: DurableAdmission; text: string };
      if (payload.admission?.conversationType !== "group") continue;
      const text = Array.from(payload.text).slice(0, Math.min(1000, remaining)).join("");
      if (!text) continue;
      result.unshift({ key: String(row.event_key), senderId: payload.admission.senderId, text, receivedAt: Number(row.received_at) });
      remaining -= Array.from(text).length;
      if (!remaining) break;
    }
    return result;
  }

  bootstrapCheckpoint(checkpoint: DurableInboundCheckpoint): boolean {
    this.assertAccountId(checkpoint.accountId);
    if (typeof checkpoint.getUpdatesBuf !== "string" || checkpoint.getUpdatesBuf.length > MAX_SECRET_CHARS) {
      throw new Error("inbound_cursor_invalid");
    }
    for (const context of checkpoint.contexts) {
      this.assertTarget(context.target);
      this.assertSecret(context.contextToken);
      this.assertTimestamp(context.lastInboundAt);
      this.assertTimestamp(context.contextUpdatedAt);
      if (context.generation !== undefined && !/^[a-f0-9-]{36}$/u.test(context.generation)) throw new Error("inbound_context_generation_invalid");
    }
    const at = this.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO channel_checkpoint(account_id, get_updates_buf, updated_at)
        VALUES (?, ?, ?)
      `).run(checkpoint.accountId, checkpoint.getUpdatesBuf, at);
      if (Number(result.changes) === 0) {
        this.database.exec("ROLLBACK");
        return false;
      }
      const insertContext = this.database.prepare(`
        INSERT INTO target_context(account_id, target, context_token, last_inbound_at, context_updated_at, context_generation)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const context of checkpoint.contexts) {
        insertContext.run(
          checkpoint.accountId,
          context.target,
          context.contextToken,
          context.lastInboundAt,
          context.contextUpdatedAt,
          context.generation ?? null,
        );
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  checkpoint(accountId: string): DurableInboundCheckpoint | null {
    this.assertAccountId(accountId);
    const checkpoint = this.database.prepare(
      "SELECT account_id, get_updates_buf FROM channel_checkpoint WHERE account_id = ?",
    ).get(accountId) as CheckpointRow | undefined;
    if (!checkpoint) return null;
    const rows = this.database.prepare(`
      SELECT target, context_token, last_inbound_at, context_updated_at, context_generation
      FROM target_context WHERE account_id = ? ORDER BY target
    `).all(accountId) as unknown as ContextRow[];
    return {
      accountId: checkpoint.account_id,
      getUpdatesBuf: checkpoint.get_updates_buf,
      contexts: rows.map((row) => ({
        target: row.target,
        contextToken: row.context_token,
        lastInboundAt: row.last_inbound_at,
        contextUpdatedAt: row.context_updated_at,
        ...(row.context_generation ? { generation: row.context_generation } : {}),
      })),
    };
  }

  peekQueued(accountId: string, target: string): QueuedInboundEnvelope | null {
    this.assertAccountId(accountId);
    this.assertQueueTarget(target);
    const row = this.database.prepare(`
      SELECT event_key, account_id, target, message_id, kind, payload_json,
             context_token, received_at, observed_at, state, revision,
             attempts, lease_owner, lease_until
      FROM inbox
      WHERE account_id = ? AND target = ? AND state = 'queued'
      ORDER BY CASE WHEN target LIKE 'feishu.group.%' THEN rowid ELSE received_at END, event_key LIMIT 1
    `).get(accountId, target) as InboxRow | undefined;
    if (!row) return null;
    return this.decodeJob(row) as QueuedInboundEnvelope;
  }

  leaseNext(
    accountId: string,
    target: string,
    owner: string,
    ttlMs: number,
  ): (DurableInboundJob & { state: "leased"; leaseOwner: string; leaseUntil: number }) | null {
    this.assertAccountId(accountId);
    this.assertQueueTarget(target);
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(owner)) throw new Error("inbound_lease_owner_invalid");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 24 * 60 * 60 * 1000) {
      throw new Error("inbound_lease_ttl_invalid");
    }
    const at = this.now();
    const leaseUntil = at + ttlMs;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(`
        SELECT event_key, account_id, target, message_id, kind, payload_json,
               context_token, received_at, observed_at, state, revision,
               attempts, lease_owner, lease_until
        FROM inbox
        WHERE account_id = ? AND target = ? AND state != 'completed'
        ORDER BY CASE WHEN target LIKE 'feishu.group.%' THEN rowid ELSE received_at END, event_key LIMIT 1
      `).get(accountId, target) as InboxRow | undefined;
      if (!row || row.state !== "queued") {
        this.database.exec("ROLLBACK");
        return null;
      }
      const result = this.database.prepare(`
        UPDATE inbox
        SET state = 'leased', revision = revision + 1, lease_owner = ?,
            lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE event_key = ? AND revision = ? AND state = 'queued'
      `).run(owner, leaseUntil, at, row.event_key, row.revision);
      if (Number(result.changes) !== 1) throw new Error("inbound_lease_conflict");
      this.database.exec("COMMIT");
      return {
        ...this.decodeJob({
          ...row,
          state: "leased",
          revision: row.revision + 1,
          attempts: row.attempts + 1,
          lease_owner: owner,
          lease_until: leaseUntil,
        }),
        state: "leased",
        leaseOwner: owner,
        leaseUntil,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  blockExpiredLeases(): number {
    const result = this.database.prepare(`
      UPDATE inbox
      SET state = 'recovery_blocked', revision = revision + 1,
          lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE state = 'leased' AND lease_until <= ?
    `).run(this.now(), this.now());
    return Number(result.changes);
  }

  complete(eventKey: string, owner: string, revision: number): void {
    if (!EVENT_KEY.test(eventKey)) throw new Error("inbound_event_key_invalid");
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(owner)) throw new Error("inbound_lease_owner_invalid");
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("inbound_revision_invalid");
    const result = this.database.prepare(`
      UPDATE inbox
      SET state = 'completed', revision = revision + 1,
          lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE event_key = ? AND state = 'leased' AND lease_owner = ? AND revision = ?
    `).run(this.now(), eventKey, owner, revision);
    if (Number(result.changes) !== 1) throw new Error("inbound_lease_conflict");
  }

  queuedTargets(accountId: string): string[] {
    this.assertAccountId(accountId);
    const rows = this.database.prepare(`
      SELECT DISTINCT candidate.target
      FROM inbox AS candidate
      WHERE candidate.account_id = ? AND candidate.state = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM inbox AS earlier
          WHERE earlier.account_id = candidate.account_id
            AND earlier.target = candidate.target
            AND earlier.state != 'completed'
            AND (
              (candidate.target LIKE 'feishu.group.%' AND earlier.rowid < candidate.rowid) OR
              (candidate.target NOT LIKE 'feishu.group.%' AND (earlier.received_at < candidate.received_at OR
              (earlier.received_at = candidate.received_at AND earlier.event_key < candidate.event_key)))
            )
        )
      ORDER BY candidate.target
    `).all(accountId) as unknown as Array<{ target: string }>;
    return rows.map((row) => row.target);
  }

  peek(eventKey: string): DurableInboundJob | null {
    if (!EVENT_KEY.test(eventKey)) throw new Error("inbound_event_key_invalid");
    const row = this.database.prepare(`
      SELECT event_key, account_id, target, message_id, kind, payload_json,
             context_token, received_at, observed_at, state, revision,
             attempts, lease_owner, lease_until
      FROM inbox WHERE event_key = ?
    `).get(eventKey) as InboxRow | undefined;
    return row ? this.decodeJob(row) : null;
  }

  close(): void {
    this.database.close();
  }

  private validateBatch(batch: DurableInboundBatch): void {
    this.assertAccountId(batch.accountId);
    if (typeof batch.nextCursor !== "string" || batch.nextCursor.length > MAX_SECRET_CHARS) {
      throw new Error("inbound_cursor_invalid");
    }
    for (const context of batch.contexts) {
      this.assertTarget(context.target);
      this.assertSecret(context.contextToken);
      this.assertTimestamp(context.lastInboundAt);
      this.assertTimestamp(context.contextUpdatedAt);
      if (context.generation !== undefined && !/^[a-f0-9-]{36}$/u.test(context.generation)) throw new Error("inbound_context_generation_invalid");
    }
    for (const envelope of batch.envelopes) {
      if (!EVENT_KEY.test(envelope.eventKey)) throw new Error("inbound_event_key_invalid");
      if (envelope.accountId !== batch.accountId) throw new Error("inbound_account_mismatch");
      this.assertTarget(envelope.target);
      if (typeof envelope.messageId !== "string" || !envelope.messageId || envelope.messageId.length > 512) {
        throw new Error("inbound_message_id_invalid");
      }
      if (envelope.kind !== "message" && envelope.kind !== "rejected") throw new Error("inbound_kind_invalid");
      if (!["text", "voice", "media"].includes(envelope.source)) throw new Error("inbound_source_invalid");
      if (typeof envelope.text !== "string" || Array.from(envelope.text).length > MAX_TEXT_CHARS) {
        throw new Error("inbound_text_invalid");
      }
      this.validateMediaList(envelope.attachments);
      if (envelope.quote) {
        if (envelope.quote.title !== undefined && (typeof envelope.quote.title !== "string" || Array.from(envelope.quote.title).length > 512)) {
          throw new Error("inbound_quote_invalid");
        }
        if (envelope.quote.text !== undefined && (typeof envelope.quote.text !== "string" || Array.from(envelope.quote.text).length > MAX_TEXT_CHARS)) {
          throw new Error("inbound_quote_invalid");
        }
        this.validateMediaList(envelope.quote.attachments);
      }
      if (envelope.kind === "rejected") {
        if (!["voice_too_long", "voice_duration_invalid", "voice_transcript_missing"].includes(envelope.rejectionReason ?? "")) {
          throw new Error("inbound_rejection_invalid");
        }
        if (envelope.durationMs !== undefined && (!Number.isSafeInteger(envelope.durationMs) || envelope.durationMs <= 0)) {
          throw new Error("inbound_rejection_invalid");
        }
      }
      this.assertTimestamp(envelope.receivedAt);
      this.assertTimestamp(envelope.observedAt);
      this.assertSecret(envelope.contextToken);
    }
  }

  private assertAccountId(value: string): void {
    if (!ACCOUNT_ID.test(value)) throw new Error("inbound_account_invalid");
  }

  private assertTarget(value: string): void {
    if (!TARGET_ID.test(value)) throw new Error("inbound_target_invalid");
  }

  private assertQueueTarget(value: string): void {
    if (!/^[A-Za-z0-9:._@-]{1,512}$/.test(value)) throw new Error("inbound_target_invalid");
  }

  private assertSecret(value: string): void {
    if (typeof value !== "string" || !value || value.length > MAX_SECRET_CHARS) {
      throw new Error("inbound_context_invalid");
    }
  }

  private assertTimestamp(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("inbound_timestamp_invalid");
  }

  private decodeJob(row: InboxRow): DurableInboundJob {
    const payload = JSON.parse(row.payload_json) as {
      admission?: DurableAdmission;
      source: DurableInboundEnvelope["source"];
      text: string;
      attachments?: StoredIlinkMedia[];
      quote?: DurableInboundEnvelope["quote"];
      rejectionReason?: DurableInboundEnvelope["rejectionReason"];
      durationMs?: number;
    };
    return {
      ...(payload.admission ? { admission: payload.admission } : {}),
      eventKey: row.event_key,
      accountId: row.account_id,
      target: row.target,
      messageId: row.message_id,
      kind: row.kind as DurableInboundEnvelope["kind"],
      source: payload.source,
      text: payload.text,
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
      ...(payload.quote ? { quote: payload.quote } : {}),
      ...(payload.rejectionReason ? { rejectionReason: payload.rejectionReason } : {}),
      ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
      receivedAt: row.received_at,
      observedAt: row.observed_at,
      contextToken: row.context_token,
      state: row.state as DurableInboundJob["state"],
      revision: row.revision,
      attempts: row.attempts,
      ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
      ...(row.lease_until !== null ? { leaseUntil: row.lease_until } : {}),
    };
  }

  private validateMediaList(media: StoredIlinkMedia[] | undefined): void {
    if (media === undefined) return;
    if (!Array.isArray(media) || media.length > 20) throw new Error("inbound_media_invalid");
    for (const item of media) {
      if (!item || !["image", "voice", "file", "video"].includes(item.kind) ||
          typeof item.path !== "string" || !path.isAbsolute(item.path) || item.path.length > 4096 ||
          typeof item.fileName !== "string" || !item.fileName || path.basename(item.fileName) !== item.fileName ||
          typeof item.mimeType !== "string" || !item.mimeType || item.mimeType.length > 200 ||
          !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 ||
          typeof item.quoted !== "boolean") {
        throw new Error("inbound_media_invalid");
      }
    }
  }
}
