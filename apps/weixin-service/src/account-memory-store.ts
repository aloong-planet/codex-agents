import type { NotificationDestination } from "./notification-channel.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { MemoryReminderAdmission } from "./reminder-intent-ownership.js";

import { extractStrongAnchors } from "./account-memory-resolver.js";
import type { DuePlanReminder, PlanReminderSegment, PlanTimePrecision } from "./plan-follow-up-monitor.js";

export type MemoryCategory = "preferences" | "projects" | "decisions" | "constraints";
export type MemoryEventKind = "planned" | "observed";
export type PlanStatus = "pending" | "occurred" | "cancelled" | "unfulfilled";
export type PlanFollowUpState = "waiting" | "awaiting_response" | "exhausted";
export type FactStatus = "valid" | "retracted";

export type AccountMemoryEntry = {
  id: string;
  category: MemoryCategory;
  value: string;
  evidenceEntryIds: string[];
  confidence: number;
  updatedAt: number;
};

export type AccountMemoryEvent = {
  id: string;
  eventKind: MemoryEventKind;
  localDate: string;
  timezone: "Asia/Shanghai";
  summary: string;
  evidenceEntryIds: string[];
  confidence: number;
  createdAt: number;
  updatedAt: number;
  planStatus?: PlanStatus;
  scheduledAt?: number;
  timePrecision?: PlanTimePrecision;
  localTime?: string;
  followUpState?: PlanFollowUpState;
  reminderCount?: number;
  lastReminderAt?: number;
  nextReminderAt?: number;
  occurredEventId?: string;
  factStatus?: FactStatus;
  fulfillsPlanId?: string;
};

export type AccountMemorySnapshot = {
  revision: number;
  entries: AccountMemoryEntry[];
  events: AccountMemoryEvent[];
  eventCount: number;
  markdown: string;
};

export type MemoryMutation =
  | { op: "supersede_task"; id: string; taskId: string; taskRevision: number; retainedValue: string | null; evidenceEntryIds: string[] }
  | { op: "add"; id: string; category: MemoryCategory; value: string; evidenceEntryIds: string[]; confidence: number }
  | { op: "update"; id: string; value: string; evidenceEntryIds: string[]; confidence: number }
  | { op: "remove"; id: string; evidenceEntryIds: string[]; reason: "user_correction" | "user_forget_request" | "consolidation" }
  | { op: "event_add"; id: string; eventKind: MemoryEventKind; localDate: string; timezone: "Asia/Shanghai"; summary: string; evidenceEntryIds: string[]; confidence: number; fulfillsPlanId?: string; timePrecision?: PlanTimePrecision; localTime?: string }
  | { op: "event_update"; id: string; localDate: string; timezone: "Asia/Shanghai"; summary: string; evidenceEntryIds: string[]; confidence: number; timePrecision?: PlanTimePrecision; localTime?: string }
  | { op: "event_complete"; id: string; observedEventId: string; evidenceEntryIds: string[] }
  | { op: "event_set_status"; id: string; status: "cancelled" | "unfulfilled"; evidenceEntryIds: string[] };

export type MemoryMutationBatch = {
  batchId: string;
  basedOnRevision: number;
  evidenceEntryIds: Set<string>;
  mutations: MemoryMutation[];
  planDestinations?: Record<string, NotificationDestination>;
};

export type MemoryCommitReceipt = {
  status: "committed";
  revision: number;
  added: number;
  updated: number;
  removed: number;
  eventsAdded?: number;
  eventsUpdated?: number;
  eventsRemoved?: number;
};

type LegacyStoredAccountMemory = {
  revision: number;
  entries: AccountMemoryEntry[];
  receipts?: Record<string, MemoryCommitReceipt>;
  contentHash: string;
};

const SECTION_NAMES: Record<MemoryCategory, string> = {
  preferences: "Preferences",
  projects: "Projects",
  decisions: "Decisions",
  constraints: "Constraints",
};

export class AccountMemoryStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  read(accountId: string, eventQuery?: string): AccountMemorySnapshot {
    this.assertSafeScope(accountId);
    const databasePath = this.databasePath(accountId);
    if (!fs.existsSync(databasePath)) {
      const legacy = this.readLegacy(accountId);
      if (!legacy) return { revision: 0, entries: [], events: [], eventCount: 0, markdown: renderMemory([]) };
      this.initializeFromLegacy(accountId, legacy);
    }
    const database = this.open(accountId);
    try {
      const revision = Number((database.prepare("SELECT revision FROM account_state WHERE singleton = 1").get() as { revision: number }).revision);
      const entries = this.readEntries(database);
      const allEvents = this.readEvents(database);
      const today = shanghaiLocalDate(this.now());
      const minimumDate = addLocalDays(today, -30);
      const maximumDate = addLocalDays(today, 7);
      const relevantIds = eventQuery ? this.searchEventIds(database, eventQuery) : new Set<string>();
      const relevantEvents = allEvents.filter((event) => relevantIds.has(event.id));
      const windowEvents = allEvents.filter((event) => event.localDate >= minimumDate && event.localDate <= maximumDate && !relevantIds.has(event.id));
      const selectedIds = new Set([
        ...relevantEvents.slice(-20).map((event) => event.id),
        ...windowEvents.slice(-(100 - Math.min(20, relevantEvents.length))).map((event) => event.id),
      ]);
      const events = allEvents.filter((event) => selectedIds.has(event.id));
      const markdown = renderMemory(entries);
      const memoryPath = this.memoryPath(accountId);
      const onDisk = fs.existsSync(memoryPath) ? fs.readFileSync(memoryPath, "utf8") : undefined;
      if (onDisk !== markdown) atomicWrite(memoryPath, markdown);
      this.writeEventProjections(accountId, allEvents);
      return { revision, entries, events, eventCount: allEvents.length, markdown };
    } finally {
      database.close();
    }
  }

  receipt(accountId: string, batchId: string): MemoryCommitReceipt | undefined {
    this.assertSafeScope(accountId);
    if (!fs.existsSync(this.databasePath(accountId))) return undefined;
    const database = this.open(accountId);
    try {
      const row = database.prepare("SELECT revision, added, updated, removed, events_added, events_updated, events_removed FROM receipts WHERE batch_id = ?").get(batchId) as
        { revision: number; added: number; updated: number; removed: number; events_added: number; events_updated: number; events_removed: number } | undefined;
      return row ? receiptFromRow(row) : undefined;
    } finally { database.close(); }
  }

  supersededTaskSettings(accountId: string): Array<{ batchId: string; entry: AccountMemoryEntry; taskId: string; taskRevision: number; evidenceEntryIds: string[]; supersededAt: number; retainedValue: string | null }> {
    this.assertSafeScope(accountId);
    if (!fs.existsSync(this.databasePath(accountId))) return [];
    const database = this.open(accountId);
    try {
      return database.prepare("SELECT * FROM superseded_task_memory ORDER BY superseded_at, rowid").all().map((row) => ({
        batchId: String(row.batch_id), entry: JSON.parse(String(row.entry_json)) as AccountMemoryEntry,
        taskId: String(row.task_id), taskRevision: Number(row.task_revision),
        evidenceEntryIds: JSON.parse(String(row.evidence_json)) as string[], supersededAt: Number(row.superseded_at),
        retainedValue: row.retained_value === null ? null : String(row.retained_value),
      }));
    } finally { database.close(); }
  }

  confirmNotificationTarget(accountId: string, target: string, confirmedAt = this.now()): void {
    this.assertSafeScope(accountId);
    if (!(/^[A-Za-z0-9._-]+@im\.wechat$/u.test(target) || /^feishu\.(?:group\.)?[a-f0-9]{64}$/u.test(target)) || !Number.isInteger(confirmedAt) || confirmedAt < 0) {
      throw new Error("memory_notification_binding_invalid");
    }
    const database = this.open(accountId);
    try {
      database.prepare("INSERT INTO notification_binding(singleton, target, confirmed_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET target = excluded.target, confirmed_at = excluded.confirmed_at")
        .run(target, confirmedAt);
    } finally { database.close(); }
  }

  notificationTarget(accountId: string): string | undefined {
    this.assertSafeScope(accountId);
    const database = this.open(accountId);
    try {
      const row = database.prepare("SELECT target FROM notification_binding WHERE singleton = 1").get() as { target: string } | undefined;
      return row?.target;
    } finally { database.close(); }
  }

  planReminderState(accountId: string, at = this.now()): { targetConfirmed: boolean; reminderTarget?: string; dueCount: number; unknownCount: number } {
    this.assertSafeScope(accountId);
    const database = this.open(accountId);
    try {
      const binding = database.prepare("SELECT target FROM notification_binding WHERE singleton = 1").get() as { target: string } | undefined;
      const due = database.prepare("SELECT COUNT(*) AS count FROM events WHERE event_kind = 'planned' AND plan_status = 'pending' AND follow_up_state <> 'exhausted' AND reminder_count < 3 AND COALESCE(next_reminder_at_ms, scheduled_at_ms) <= ?").get(at) as { count: number };
      const unknown = database.prepare("SELECT COUNT(DISTINCT item.plan_id) AS count FROM reminder_batch_items item JOIN reminder_batches batch ON batch.id = item.batch_id WHERE item.resolved_at IS NULL AND batch.status = 'unknown'").get() as { count: number };
      return {
        targetConfirmed: Boolean(binding),
        ...(binding ? { reminderTarget: binding.target } : {}),
        dueCount: Number(due.count),
        unknownCount: Number(unknown.count),
      };
    } finally { database.close(); }
  }

  recoverInterruptedReminderAttempts(accountId: string, at = this.now()): void {
    this.assertSafeScope(accountId);
    const database = this.open(accountId);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare("UPDATE reminder_attempts SET status = 'unknown', updated_at = ? WHERE status = 'sending'").run(at);
      database.prepare("UPDATE reminder_batches SET status = 'unknown', updated_at = ? WHERE status = 'sending' AND EXISTS (SELECT 1 FROM reminder_attempts attempt WHERE attempt.batch_id = reminder_batches.id AND attempt.status = 'unknown')").run(at);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    finally { database.close(); }
  }

  duePlanReminders(accountId: string, at = this.now()): DuePlanReminder[] {
    this.assertSafeScope(accountId);
    const database = this.open(accountId);
    try {
      database.exec("BEGIN IMMEDIATE");
      database.prepare("UPDATE events SET follow_up_state = 'exhausted', updated_at = ? WHERE event_kind = 'planned' AND plan_status = 'pending' AND reminder_count >= 3 AND follow_up_state <> 'exhausted' AND next_reminder_at_ms IS NOT NULL AND next_reminder_at_ms <= ?")
        .run(at, at);
      const rows = database.prepare(`
        SELECT id, summary, local_date, time_precision, local_time, reminder_count, scheduled_at_ms,
          (SELECT destination_json FROM plan_notification_destination WHERE plan_id = events.id) AS notification_destination
        FROM events
        WHERE event_kind = 'planned' AND plan_status = 'pending'
          AND follow_up_state <> 'exhausted' AND reminder_count < 3
          AND COALESCE(next_reminder_at_ms, scheduled_at_ms) <= ?
          AND NOT EXISTS (
            SELECT 1 FROM reminder_batch_items item
            JOIN reminder_batches batch ON batch.id = item.batch_id
            WHERE item.plan_id = events.id AND item.resolved_at IS NULL AND batch.status IN ('planned', 'sending', 'unknown')
          )
        ORDER BY scheduled_at_ms, created_at, id
      `).all(at) as Array<Record<string, SQLInputValue>>;
      database.exec("COMMIT");
      return rows.map((row) => ({
        id: String(row.id), summary: String(row.summary), localDate: String(row.local_date),
        ...(row.notification_destination ? { notificationDestination: JSON.parse(String(row.notification_destination)) as NotificationDestination } : {}),
        timePrecision: String(row.time_precision) as PlanTimePrecision,
        ...(row.local_time ? { localTime: String(row.local_time) } : {}),
        reminderCount: Number(row.reminder_count), scheduledAt: Number(row.scheduled_at_ms),
      }));
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally { database.close(); }
  }

  migratePlanNotificationDestinations(accountId: string, defaultDestination: () => NotificationDestination): void {
    this.assertSafeScope(accountId);
    const database = this.open(accountId);
    try {
      database.exec("BEGIN IMMEDIATE");
      const missing = database.prepare("SELECT id FROM events WHERE event_kind = 'planned' AND NOT EXISTS (SELECT 1 FROM plan_notification_destination WHERE plan_id = events.id)").all() as Array<{ id: string }>;
      if (missing.length) {
        const destination = defaultDestination();
        for (const plan of missing) database.prepare("INSERT INTO plan_notification_destination(plan_id, destination_json) VALUES (?, ?)")
          .run(plan.id, JSON.stringify(destination));
      }
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    finally { database.close(); }
  }

  createReminderBatch(accountId: string, target: string, segments: PlanReminderSegment[], createdAt = this.now(), delivery?: NotificationDestination): { id: string } {
    this.assertSafeScope(accountId);
    if (segments.length === 0) throw new Error("memory_reminder_batch_empty");
    const database = this.open(accountId);
    const batchId = `reminder-${crypto.randomUUID()}`;
    try {
      database.exec("BEGIN IMMEDIATE");
      const binding = database.prepare("SELECT target FROM notification_binding WHERE singleton = 1").get() as { target: string } | undefined;
      const preferences = segments.flatMap((segment) => segment.planIds).map((id) =>
        database.prepare("SELECT destination_json FROM plan_notification_destination WHERE plan_id = ?").get(id) as { destination_json: string } | undefined);
      if (preferences.some(Boolean)) {
        if (!delivery || preferences.some((row) => {
          if (!row) return true;
          const preference = JSON.parse(row.destination_json) as NotificationDestination;
          return preference.accountId !== delivery.accountId || preference.target !== delivery.target || (preference.channel ?? "weixin") !== (delivery.channel ?? "weixin");
        })) throw new Error("memory_reminder_destination_mismatch");
      } else if (!binding || binding.target !== target) throw new Error("memory_notification_binding_mismatch");
      database.prepare("INSERT INTO reminder_batches(id, target, status, segment_count, created_at, updated_at) VALUES (?, ?, 'planned', ?, ?, ?)")
        .run(batchId, delivery?.target ?? target, segments.length, createdAt, createdAt);
      if (delivery) database.prepare("INSERT INTO reminder_delivery(batch_id, destination_json) VALUES (?, ?)").run(batchId, JSON.stringify(delivery));
      const insert = database.prepare("INSERT INTO reminder_batch_items(batch_id, plan_id, ordinal, attempt_number, segment_index, resolved_at) VALUES (?, ?, ?, ?, ?, NULL)");
      let ordinal = 0;
      for (const [segmentIndex, segment] of segments.entries()) {
        for (const planId of segment.planIds) {
          ordinal += 1;
          const plan = database.prepare("SELECT reminder_count, plan_status FROM events WHERE id = ? AND event_kind = 'planned'").get(planId) as { reminder_count: number; plan_status: string } | undefined;
          if (!plan || plan.plan_status !== "pending" || plan.reminder_count >= 3) throw new Error("memory_reminder_plan_invalid");
          insert.run(batchId, planId, ordinal, Number(plan.reminder_count) + 1, segmentIndex);
        }
      }
      database.exec("COMMIT");
      return { id: batchId };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally { database.close(); }
  }

  reminderDelivery(accountId: string, batchId: string): NotificationDestination | undefined {
    const database = this.open(accountId);
    try {
      const row = database.prepare("SELECT batch.target, delivery.destination_json FROM reminder_batches batch LEFT JOIN reminder_delivery delivery ON delivery.batch_id = batch.id WHERE batch.id = ?").get(batchId) as { target: string; destination_json: string | null } | undefined;
      return row ? row.destination_json ? JSON.parse(row.destination_json) as NotificationDestination : { accountId, target: row.target } : undefined;
    } finally { database.close(); }
  }

  markReminderSegmentSending(accountId: string, batchId: string, segmentIndex: number, at = this.now()): void {
    const database = this.open(accountId);
    try {
      database.exec("BEGIN IMMEDIATE");
      const batch = database.prepare("SELECT 1 FROM reminder_batches WHERE id = ? AND status IN ('planned', 'sending')").get(batchId);
      if (!batch) throw new Error("memory_reminder_batch_invalid");
      database.prepare("INSERT INTO reminder_attempts(id, batch_id, segment_index, status, created_at, updated_at) VALUES (?, ?, ?, 'sending', ?, ?) ON CONFLICT(batch_id, segment_index) DO UPDATE SET status = 'sending', updated_at = excluded.updated_at")
        .run(`attempt-${crypto.randomUUID()}`, batchId, segmentIndex, at, at);
      database.prepare("UPDATE reminder_batches SET status = 'sending', updated_at = ? WHERE id = ?").run(at, batchId);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    finally { database.close(); }
  }

  finishReminderSegment(accountId: string, batchId: string, segmentIndex: number, outcome: "accepted" | "failed" | "unknown", at = this.now()): void {
    const database = this.open(accountId);
    try {
      database.exec("BEGIN IMMEDIATE");
      const attempt = database.prepare("SELECT status FROM reminder_attempts WHERE batch_id = ? AND segment_index = ?").get(batchId, segmentIndex) as { status: string } | undefined;
      if (!attempt || attempt.status !== "sending") throw new Error("memory_reminder_attempt_invalid");
      const items = database.prepare("SELECT plan_id, attempt_number FROM reminder_batch_items WHERE batch_id = ? AND segment_index = ? ORDER BY ordinal").all(batchId, segmentIndex) as Array<{ plan_id: string; attempt_number: number }>;
      if (outcome === "accepted") {
        const next = nextShanghaiCalendarDaySameTime(at);
        for (const item of items) {
          const result = database.prepare("UPDATE events SET reminder_count = ?, follow_up_state = 'awaiting_response', last_reminder_at_ms = ?, next_reminder_at_ms = ?, updated_at = ? WHERE id = ? AND plan_status = 'pending' AND reminder_count = ?")
            .run(item.attempt_number, at, next, at, item.plan_id, item.attempt_number - 1);
          if (Number(result.changes) !== 1) throw new Error("memory_reminder_plan_conflict");
        }
      } else if (outcome === "failed") {
        const next = nextShanghaiCalendarDaySameTime(at);
        for (const item of items) database.prepare("UPDATE events SET next_reminder_at_ms = ?, updated_at = ? WHERE id = ? AND plan_status = 'pending'").run(next, at, item.plan_id);
      }
      database.prepare("UPDATE reminder_attempts SET status = ?, updated_at = ? WHERE batch_id = ? AND segment_index = ?")
        .run(outcome, at, batchId, segmentIndex);
      const statuses = database.prepare("SELECT status FROM reminder_attempts WHERE batch_id = ?").all(batchId) as Array<{ status: string }>;
      const batch = database.prepare("SELECT segment_count FROM reminder_batches WHERE id = ?").get(batchId) as { segment_count: number };
      const batchStatus = statuses.some((row) => row.status === "unknown") ? "unknown"
        : statuses.some((row) => row.status === "failed") ? "failed"
          : statuses.length === batch.segment_count && statuses.every((row) => row.status === "accepted") ? "accepted"
            : "sending";
      database.prepare("UPDATE reminder_batches SET status = ?, updated_at = ? WHERE id = ?").run(batchStatus, at, batchId);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    finally { database.close(); }
  }

  latestReminderContext(accountId: string, target: string): { batchId: string; plans: Array<{ ordinal: number; planId: string; summary: string }> } | undefined {
    const database = this.open(accountId);
    try {
      const batch = database.prepare(`
        SELECT batch.id FROM reminder_batches batch
        WHERE batch.target = ? AND EXISTS (
          SELECT 1 FROM reminder_batch_items item
          JOIN reminder_attempts attempt ON attempt.batch_id = item.batch_id AND attempt.segment_index = item.segment_index
          JOIN events event ON event.id = item.plan_id
          WHERE item.batch_id = batch.id AND item.resolved_at IS NULL AND attempt.status = 'accepted'
            AND event.event_kind = 'planned' AND event.plan_status = 'pending'
        )
        ORDER BY batch.created_at DESC LIMIT 1
      `).get(target) as { id: string } | undefined;
      if (!batch) return undefined;
      const plans = database.prepare(`
        SELECT item.ordinal, item.plan_id, event.summary
        FROM reminder_batch_items item JOIN events event ON event.id = item.plan_id
        JOIN reminder_attempts attempt ON attempt.batch_id = item.batch_id AND attempt.segment_index = item.segment_index
        WHERE item.batch_id = ? AND item.resolved_at IS NULL AND attempt.status = 'accepted'
          AND event.event_kind = 'planned' AND event.plan_status = 'pending'
        ORDER BY item.ordinal
      `).all(batch.id) as Array<{ ordinal: number; plan_id: string; summary: string }>;
      return plans.length === 0 ? undefined : {
        batchId: batch.id,
        plans: plans.map((plan) => ({ ordinal: Number(plan.ordinal), planId: plan.plan_id, summary: plan.summary })),
      };
    } finally { database.close(); }
  }

  apply(accountId: string, request: MemoryMutationBatch, reminderAdmission?: MemoryReminderAdmission): MemoryCommitReceipt {
    this.assertSafeScope(accountId);
    this.ensureDirectory(accountId);
    if (!fs.existsSync(this.databasePath(accountId))) {
      const legacy = this.readLegacy(accountId);
      if (legacy) this.initializeFromLegacy(accountId, legacy);
    }
    const database = this.open(accountId);
    let receipt: MemoryCommitReceipt;
    let markdown: string;
    try {
      database.exec("BEGIN IMMEDIATE");
      try {
        const replay = database.prepare("SELECT revision, added, updated, removed, events_added, events_updated, events_removed FROM receipts WHERE batch_id = ?").get(request.batchId) as
          | { revision: number; added: number; updated: number; removed: number; events_added: number; events_updated: number; events_removed: number }
          | undefined;
        if (replay) {
          database.exec("COMMIT");
          return receiptFromRow(replay);
        }
        const state = database.prepare("SELECT revision FROM account_state WHERE singleton = 1").get() as { revision: number };
        if (Number(state.revision) !== request.basedOnRevision) throw new Error("memory_revision_conflict");
        if (request.mutations.length === 0) {
          const revision = Number(state.revision);
          database.prepare("INSERT INTO receipts(batch_id, revision, added, updated, removed) VALUES (?, ?, 0, 0, 0)")
            .run(request.batchId, revision);
          database.exec("COMMIT");
          return { status: "committed", revision, added: 0, updated: 0, removed: 0 };
        }
        const entries = this.readEntries(database);
        const next = entries.map((entry) => ({ ...entry, evidenceEntryIds: [...entry.evidenceEntryIds] }));
        let added = 0;
        let updated = 0;
        let removed = 0;
        let eventsAdded = 0;
        let eventsUpdated = 0;
        for (const mutation of request.mutations) {
          validateMutation(mutation, request.evidenceEntryIds);
          if (mutation.op === "event_add") {
            if (mutation.eventKind === "planned" && reminderAdmission && !reminderAdmission.reserve(mutation.id)) continue;
            const normalizedSummary = normalizeMemoryValue(mutation.summary);
            const duplicate = database.prepare("SELECT 1 FROM events WHERE event_kind = ? AND local_date = ? AND normalized_summary = ? LIMIT 1")
              .get(mutation.eventKind, mutation.localDate, normalizedSummary);
            if (duplicate) continue;
            if (database.prepare("SELECT 1 FROM events WHERE id = ?").get(mutation.id)) throw new Error("memory_event_exists");
            const timestamp = this.now();
            if (mutation.fulfillsPlanId) {
              const plan = database.prepare("SELECT event_kind, plan_status FROM events WHERE id = ?").get(mutation.fulfillsPlanId) as { event_kind: string; plan_status: string | null } | undefined;
              if (!plan || plan.event_kind !== "planned" || plan.plan_status !== "pending") throw new Error("memory_event_plan_invalid");
            }
            const precision = mutation.eventKind === "planned" ? mutation.timePrecision ?? "date" : null;
            const scheduledAt = mutation.eventKind === "planned"
              ? planScheduledAt(mutation.localDate, precision!, mutation.localTime)
              : null;
            database.prepare("INSERT INTO events(id, event_kind, local_date, timezone, summary, normalized_summary, evidence_json, confidence, created_at, updated_at, plan_status, fulfills_plan_id, scheduled_at_ms, time_precision, local_time, follow_up_state, reminder_count, next_reminder_at_ms, occurred_event_id, fact_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(mutation.id, mutation.eventKind, mutation.localDate, mutation.timezone, mutation.summary, normalizedSummary, JSON.stringify(mutation.evidenceEntryIds), mutation.confidence, timestamp, timestamp, mutation.eventKind === "planned" ? "pending" : null, mutation.fulfillsPlanId ?? null, scheduledAt, precision, mutation.eventKind === "planned" ? mutation.localTime ?? null : null, mutation.eventKind === "planned" ? "waiting" : null, mutation.eventKind === "planned" ? 0 : null, scheduledAt, null, mutation.eventKind === "observed" ? "valid" : null);
            const destination = request.planDestinations?.[mutation.id];
            if (mutation.eventKind === "planned" && destination) database.prepare("INSERT INTO plan_notification_destination(plan_id, destination_json) VALUES (?, ?)")
              .run(mutation.id, JSON.stringify(destination));
            database.prepare("INSERT INTO events_fts(event_id, summary, aliases) VALUES (?, ?, ?)")
              .run(mutation.id, mutation.summary, eventSearchTerms(mutation.summary).join(" "));
            eventsAdded += 1;
            continue;
          }
          if (mutation.op === "event_update") {
            const existing = database.prepare("SELECT event_kind, plan_status, occurred_event_id FROM events WHERE id = ?").get(mutation.id) as { event_kind: string; plan_status: string | null; occurred_event_id: string | null } | undefined;
            if (!existing) throw new Error("memory_event_missing");
            if (existing.event_kind !== "planned") throw new Error("memory_event_not_active_plan");
            const normalizedSummary = normalizeMemoryValue(mutation.summary);
            const duplicate = database.prepare("SELECT 1 FROM events WHERE event_kind = 'planned' AND local_date = ? AND normalized_summary = ? AND id <> ? LIMIT 1")
              .get(mutation.localDate, normalizedSummary, mutation.id);
            if (duplicate) throw new Error("memory_event_duplicate");
            const timestamp = this.now();
            const precision = mutation.timePrecision ?? "date";
            const scheduledAt = planScheduledAt(mutation.localDate, precision, mutation.localTime);
            if (existing.occurred_event_id) database.prepare("UPDATE events SET fact_status = 'retracted', updated_at = ? WHERE id = ? AND event_kind = 'observed'").run(timestamp, existing.occurred_event_id);
            database.prepare("UPDATE events SET local_date = ?, timezone = ?, summary = ?, normalized_summary = ?, evidence_json = ?, confidence = ?, updated_at = ?, plan_status = 'pending', scheduled_at_ms = ?, time_precision = ?, local_time = ?, follow_up_state = 'waiting', reminder_count = 0, last_reminder_at_ms = NULL, next_reminder_at_ms = ?, occurred_event_id = NULL WHERE id = ?")
              .run(mutation.localDate, mutation.timezone, mutation.summary, normalizedSummary, JSON.stringify(mutation.evidenceEntryIds), mutation.confidence, timestamp, scheduledAt, precision, mutation.localTime ?? null, scheduledAt, mutation.id);
            resolveReminderItems(database, mutation.id, timestamp);
            database.prepare("DELETE FROM events_fts WHERE event_id = ?").run(mutation.id);
            database.prepare("INSERT INTO events_fts(event_id, summary, aliases) VALUES (?, ?, ?)")
              .run(mutation.id, mutation.summary, eventSearchTerms(mutation.summary).join(" "));
            eventsUpdated += 1;
            continue;
          }
          if (mutation.op === "event_complete") {
            const existing = database.prepare("SELECT event_kind, plan_status, evidence_json FROM events WHERE id = ?").get(mutation.id) as { event_kind: string; plan_status: string | null; evidence_json: string } | undefined;
            if (!existing) throw new Error("memory_event_missing");
            if (existing.event_kind !== "planned" || existing.plan_status !== "pending") throw new Error("memory_event_not_active_plan");
            const linkedFact = database.prepare("SELECT 1 FROM events WHERE id = ? AND event_kind = 'observed' AND fulfills_plan_id = ?").get(mutation.observedEventId, mutation.id);
            if (!linkedFact) throw new Error("memory_event_completion_link_missing");
            const evidence = [...new Set([...(JSON.parse(existing.evidence_json) as string[]), ...mutation.evidenceEntryIds])];
            database.prepare("UPDATE events SET plan_status = 'occurred', occurred_event_id = ?, evidence_json = ?, updated_at = ? WHERE id = ?")
              .run(mutation.observedEventId, JSON.stringify(evidence), this.now(), mutation.id);
            resolveReminderItems(database, mutation.id, this.now());
            eventsUpdated += 1;
            continue;
          }
          if (mutation.op === "event_set_status") {
            const existing = database.prepare("SELECT event_kind, occurred_event_id, evidence_json FROM events WHERE id = ?").get(mutation.id) as { event_kind: string; occurred_event_id: string | null; evidence_json: string } | undefined;
            if (!existing || existing.event_kind !== "planned") throw new Error("memory_event_missing");
            const timestamp = this.now();
            if (existing.occurred_event_id) database.prepare("UPDATE events SET fact_status = 'retracted', updated_at = ? WHERE id = ? AND event_kind = 'observed'").run(timestamp, existing.occurred_event_id);
            const evidence = [...new Set([...(JSON.parse(existing.evidence_json) as string[]), ...mutation.evidenceEntryIds])];
            database.prepare("UPDATE events SET plan_status = ?, occurred_event_id = NULL, evidence_json = ?, updated_at = ? WHERE id = ?")
              .run(mutation.status, JSON.stringify(evidence), timestamp, mutation.id);
            resolveReminderItems(database, mutation.id, timestamp);
            eventsUpdated += 1;
            continue;
          }
          if ((mutation.op === "add" || mutation.op === "update") && database.prepare("SELECT 1 FROM superseded_task_memory WHERE normalized_value = ? LIMIT 1").get(normalizeMemoryValue(mutation.value))) continue;
          const index = next.findIndex((entry) => entry.id === mutation.id);
          if (mutation.op === "supersede_task") {
            if (index === -1) throw new Error("memory_entry_missing");
            const previous = next[index]!;
            if (mutation.retainedValue !== null && normalizeMemoryValue(mutation.retainedValue) === normalizeMemoryValue(previous.value)) throw new Error("memory_task_retained_value_invalid");
            database.prepare("INSERT INTO superseded_task_memory VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(request.batchId, previous.id, JSON.stringify(previous), mutation.taskId, mutation.taskRevision,
                JSON.stringify(mutation.evidenceEntryIds), this.now(), mutation.retainedValue, normalizeMemoryValue(previous.value));
            if (mutation.retainedValue === null) {
              next.splice(index, 1); removed += 1;
            } else {
              assertNoDuplicate(next, mutation.retainedValue, index);
              next[index] = { ...previous, value: mutation.retainedValue, evidenceEntryIds: [...mutation.evidenceEntryIds], updatedAt: this.now() };
              updated += 1;
            }
          } else if (mutation.op === "add") {
            if (index !== -1) throw new Error("memory_entry_exists");
            assertNoDuplicate(next, mutation.value);
            next.push({ ...mutation, evidenceEntryIds: [...mutation.evidenceEntryIds], updatedAt: this.now() });
            added += 1;
          } else if (mutation.op === "update") {
            if (index === -1) throw new Error("memory_entry_missing");
            assertNoDuplicate(next, mutation.value, index);
            next[index] = { ...next[index]!, value: mutation.value, evidenceEntryIds: [...mutation.evidenceEntryIds], confidence: mutation.confidence, updatedAt: this.now() };
            updated += 1;
          } else {
            if (index === -1) throw new Error("memory_entry_missing");
            next.splice(index, 1);
            removed += 1;
          }
        }
        if (added === 0 && updated === 0 && removed === 0 && eventsAdded === 0 && eventsUpdated === 0) {
          const revision = Number(state.revision);
          database.prepare("INSERT INTO receipts(batch_id, revision, added, updated, removed, events_added, events_updated, events_removed) VALUES (?, ?, 0, 0, 0, 0, 0, 0)")
            .run(request.batchId, revision);
          database.exec("COMMIT");
          return { status: "committed", revision, added: 0, updated: 0, removed: 0 };
        }
        markdown = renderMemory(next);
        if (next.length > 200 || Array.from(markdown).length > 12_000) throw new Error("memory_budget_exceeded");
        const revision = request.basedOnRevision + 1;
        if (added > 0 || updated > 0 || removed > 0) this.replaceEntries(database, next, revision);
        database.prepare("INSERT INTO receipts(batch_id, revision, added, updated, removed, events_added, events_updated, events_removed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)")
          .run(request.batchId, revision, added, updated, removed, eventsAdded, eventsUpdated);
        database.prepare("UPDATE account_state SET revision = ?, projection_hash = ? WHERE singleton = 1")
          .run(revision, hash(markdown));
        database.exec("COMMIT");
        receipt = {
          status: "committed", revision, added, updated, removed,
          ...(eventsAdded > 0 ? { eventsAdded } : {}),
          ...(eventsUpdated > 0 ? { eventsUpdated } : {}),
        };
      } catch (error) {
        if (reminderAdmission) reminderAdmission.rollback(() => database.exec("ROLLBACK"));
        else database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
    atomicWrite(this.memoryPath(accountId), markdown!);
    if ((receipt!.eventsAdded ?? 0) > 0 || (receipt!.eventsUpdated ?? 0) > 0) this.writeEventProjections(accountId);
    return receipt!;
  }

  private open(accountId: string): DatabaseSync {
    this.ensureDirectory(accountId);
    const databasePath = this.databasePath(accountId);
    const database = new DatabaseSync(databasePath);
    fs.chmodSync(databasePath, 0o600);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL,
        projection_hash TEXT NOT NULL,
        embedding_generation INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO account_state(singleton, revision, projection_hash) VALUES (1, 0, '');
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        value TEXT NOT NULL,
        normalized_value TEXT NOT NULL UNIQUE,
        evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS aliases (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        PRIMARY KEY(entry_id, normalized_alias)
      );
      CREATE TABLE IF NOT EXISTS entry_embeddings (
        entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        version TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        normalized INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        value_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS embedding_profiles (
        profile_id TEXT PRIMARY KEY,
        contract_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entry_embeddings_v2 (
        entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        profile_id TEXT NOT NULL REFERENCES embedding_profiles(profile_id) ON DELETE CASCADE,
        dimensions INTEGER NOT NULL,
        normalized INTEGER NOT NULL,
        vector_blob BLOB NOT NULL,
        value_hash TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(entry_id, profile_id)
      );
      CREATE TABLE IF NOT EXISTS account_embedding_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        active_profile_id TEXT,
        candidate_profile_id TEXT,
        rollback_profile_id TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'idle',
        last_error_code TEXT,
        switched_at INTEGER
      );
      INSERT OR IGNORE INTO account_embedding_state(singleton, state) VALUES (1, 'idle');
      CREATE TABLE IF NOT EXISTS receipts (
        batch_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        added INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        removed INTEGER NOT NULL,
        events_added INTEGER NOT NULL DEFAULT 0,
        events_updated INTEGER NOT NULL DEFAULT 0,
        events_removed INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        event_kind TEXT NOT NULL,
        local_date TEXT NOT NULL,
        timezone TEXT NOT NULL,
        summary TEXT NOT NULL,
        normalized_summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        plan_status TEXT,
        fulfills_plan_id TEXT,
        scheduled_at_ms INTEGER,
        time_precision TEXT,
        local_time TEXT,
        follow_up_state TEXT,
        reminder_count INTEGER,
        last_reminder_at_ms INTEGER,
        next_reminder_at_ms INTEGER,
        occurred_event_id TEXT,
        fact_status TEXT,
        UNIQUE(event_kind, local_date, normalized_summary)
      );
      CREATE TABLE IF NOT EXISTS superseded_task_memory (
        batch_id TEXT NOT NULL, entry_id TEXT NOT NULL, entry_json TEXT NOT NULL,
        task_id TEXT NOT NULL, task_revision INTEGER NOT NULL, evidence_json TEXT NOT NULL,
        superseded_at INTEGER NOT NULL, retained_value TEXT, normalized_value TEXT NOT NULL,
        PRIMARY KEY(batch_id, entry_id)
      );
      CREATE INDEX IF NOT EXISTS superseded_task_memory_value ON superseded_task_memory(normalized_value);
      CREATE TABLE IF NOT EXISTS plan_notification_destination (
        plan_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        destination_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_binding (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        target TEXT NOT NULL,
        confirmed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminder_batches (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        status TEXT NOT NULL,
        segment_count INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminder_delivery (
        batch_id TEXT PRIMARY KEY REFERENCES reminder_batches(id) ON DELETE CASCADE,
        destination_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminder_batch_items (
        batch_id TEXT NOT NULL REFERENCES reminder_batches(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES events(id),
        ordinal INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL,
        segment_index INTEGER NOT NULL,
        resolved_at INTEGER,
        PRIMARY KEY(batch_id, plan_id)
      );
      CREATE TABLE IF NOT EXISTS reminder_attempts (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES reminder_batches(id) ON DELETE CASCADE,
        segment_index INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(batch_id, segment_index)
      );
      CREATE TABLE IF NOT EXISTS embedding_outbox (
        entry_id TEXT PRIMARY KEY,
        requested_revision INTEGER NOT NULL,
        value_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(entry_id UNINDEXED, value, aliases, tokenize='unicode61');
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(event_id UNINDEXED, summary, aliases, tokenize='unicode61');
    `);
    ensureReceiptColumns(database);
    ensureEventColumns(database);
    return database;
  }

  private readEntries(database: DatabaseSync): AccountMemoryEntry[] {
    const rows = database.prepare("SELECT id, category, value, evidence_json, confidence, updated_at FROM entries ORDER BY rowid").all() as Array<Record<string, SQLInputValue>>;
    return rows.map((row) => ({
      id: String(row.id),
      category: String(row.category) as MemoryCategory,
      value: String(row.value),
      evidenceEntryIds: JSON.parse(String(row.evidence_json)) as string[],
      confidence: Number(row.confidence),
      updatedAt: Number(row.updated_at),
    }));
  }

  private replaceEntries(database: DatabaseSync, entries: AccountMemoryEntry[], revision: number): void {
    const existing = new Map((database.prepare("SELECT id, value FROM entries").all() as Array<{ id: string; value: string }>).map((row) => [row.id, row.value]));
    const activeIds = new Set(entries.map((entry) => entry.id));
    for (const id of existing.keys()) if (!activeIds.has(id)) database.prepare("DELETE FROM entries WHERE id = ?").run(id);
    database.exec("DELETE FROM entries_fts; DELETE FROM aliases");
    const insertEntry = database.prepare(`
      INSERT INTO entries(id, category, value, normalized_value, evidence_json, confidence, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET category=excluded.category, value=excluded.value,
        normalized_value=excluded.normalized_value, evidence_json=excluded.evidence_json,
        confidence=excluded.confidence, updated_at=excluded.updated_at
    `);
    const insertFts = database.prepare("INSERT INTO entries_fts(entry_id, value, aliases) VALUES (?, ?, ?)");
    const insertAlias = database.prepare("INSERT INTO aliases(entry_id, alias, normalized_alias) VALUES (?, ?, ?)");
    const enqueue = database.prepare("INSERT INTO embedding_outbox(entry_id, requested_revision, value_hash, state, attempts, last_error) VALUES (?, ?, ?, 'pending', 0, NULL) ON CONFLICT(entry_id) DO UPDATE SET requested_revision=excluded.requested_revision, value_hash=excluded.value_hash, state='pending', attempts=0, last_error=NULL");
    for (const entry of entries) {
      insertEntry.run(entry.id, entry.category, entry.value, normalizeMemoryValue(entry.value), JSON.stringify(entry.evidenceEntryIds), entry.confidence, entry.updatedAt);
      const aliases = extractStrongAnchors(entry.value);
      for (const alias of aliases) insertAlias.run(entry.id, alias, normalizeMemoryValue(alias));
      insertFts.run(entry.id, entry.value, aliases.join(" "));
      if (existing.get(entry.id) !== entry.value) enqueue.run(entry.id, revision, hash(entry.value));
    }
  }

  private readEvents(database: DatabaseSync): AccountMemoryEvent[] {
    const rows = database.prepare("SELECT id, event_kind, local_date, timezone, summary, evidence_json, confidence, created_at, updated_at, plan_status, fulfills_plan_id, scheduled_at_ms, time_precision, local_time, follow_up_state, reminder_count, last_reminder_at_ms, next_reminder_at_ms, occurred_event_id, fact_status FROM events ORDER BY local_date, created_at, rowid").all() as Array<Record<string, SQLInputValue>>;
    return rows.map((row) => ({
      id: String(row.id), eventKind: String(row.event_kind) as MemoryEventKind,
      localDate: String(row.local_date), timezone: "Asia/Shanghai", summary: String(row.summary),
      evidenceEntryIds: JSON.parse(String(row.evidence_json)) as string[], confidence: Number(row.confidence),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      ...(row.plan_status ? { planStatus: String(row.plan_status) as PlanStatus } : {}),
      ...(row.scheduled_at_ms !== null ? { scheduledAt: Number(row.scheduled_at_ms) } : {}),
      ...(row.time_precision ? { timePrecision: String(row.time_precision) as PlanTimePrecision } : {}),
      ...(row.local_time ? { localTime: String(row.local_time) } : {}),
      ...(row.follow_up_state ? { followUpState: String(row.follow_up_state) as PlanFollowUpState } : {}),
      ...(row.reminder_count !== null ? { reminderCount: Number(row.reminder_count) } : {}),
      ...(row.last_reminder_at_ms !== null ? { lastReminderAt: Number(row.last_reminder_at_ms) } : {}),
      ...(row.next_reminder_at_ms !== null ? { nextReminderAt: Number(row.next_reminder_at_ms) } : {}),
      ...(row.occurred_event_id ? { occurredEventId: String(row.occurred_event_id) } : {}),
      ...(row.fact_status ? { factStatus: String(row.fact_status) as FactStatus } : {}),
      ...(row.fulfills_plan_id ? { fulfillsPlanId: String(row.fulfills_plan_id) } : {}),
    }));
  }

  private searchEventIds(database: DatabaseSync, query: string): Set<string> {
    const anchors = eventSearchTerms(query).slice(0, 20);
    if (anchors.length === 0) return new Set();
    const expression = anchors.map((anchor) => `"${anchor.replaceAll('"', '""')}"`).join(" OR ");
    try {
      const rows = database.prepare("SELECT event_id FROM events_fts WHERE events_fts MATCH ? LIMIT 20").all(expression) as Array<{ event_id: string }>;
      return new Set(rows.map((row) => row.event_id));
    } catch {
      return new Set();
    }
  }

  private writeEventProjections(accountId: string, supplied?: AccountMemoryEvent[]): void {
    let events = supplied;
    if (!events) {
      const database = this.open(accountId);
      try { events = this.readEvents(database); }
      finally { database.close(); }
    }
    const byDate = new Map<string, AccountMemoryEvent[]>();
    for (const event of events) byDate.set(event.localDate, [...(byDate.get(event.localDate) ?? []), event]);
    for (const [localDate, datedEvents] of byDate) {
      const projectionPath = path.join(this.accountDirectory(accountId), "events", `${localDate}.md`);
      const markdown = renderEventDate(localDate, datedEvents);
      if (!fs.existsSync(projectionPath) || fs.readFileSync(projectionPath, "utf8") !== markdown) atomicWrite(projectionPath, markdown);
    }
    const directory = path.join(this.accountDirectory(accountId), "events");
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/u.test(name) || byDate.has(name.slice(0, 10))) continue;
      const stalePath = path.join(directory, name);
      const info = fs.lstatSync(stalePath);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("memory_scope_unsafe");
      fs.unlinkSync(stalePath);
    }
  }

  private readLegacy(accountId: string): LegacyStoredAccountMemory | undefined {
    const metadataPath = path.join(this.accountDirectory(accountId), "metadata.json");
    const memoryPath = this.memoryPath(accountId);
    if (!fs.existsSync(metadataPath) && !fs.existsSync(memoryPath)) return undefined;
    if (!fs.existsSync(metadataPath) || !fs.existsSync(memoryPath)) throw new Error("memory_integrity_error");
    const stored = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as LegacyStoredAccountMemory;
    const markdown = fs.readFileSync(memoryPath, "utf8");
    if (stored.contentHash !== hash(markdown) || renderMemory(stored.entries) !== markdown) throw new Error("memory_integrity_error");
    return stored;
  }

  private initializeFromLegacy(accountId: string, legacy: LegacyStoredAccountMemory): void {
    const database = this.open(accountId);
    try {
      database.exec("BEGIN IMMEDIATE");
      this.replaceEntries(database, legacy.entries, legacy.revision);
      for (const [batchId, receipt] of Object.entries(legacy.receipts ?? {})) {
        database.prepare("INSERT OR IGNORE INTO receipts(batch_id, revision, added, updated, removed, events_added, events_updated, events_removed) VALUES (?, ?, ?, ?, ?, 0, 0, 0)")
          .run(batchId, receipt.revision, receipt.added, receipt.updated, receipt.removed);
      }
      database.prepare("UPDATE account_state SET revision = ?, projection_hash = ? WHERE singleton = 1")
        .run(legacy.revision, legacy.contentHash);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }
    fs.unlinkSync(path.join(this.accountDirectory(accountId), "metadata.json"));
  }

  private ensureDirectory(accountId: string): void {
    const directory = this.accountDirectory(accountId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const legacyLock = path.join(directory, "MEMORY.lock");
    if (fs.existsSync(legacyLock)) {
      const info = fs.lstatSync(legacyLock);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("memory_scope_unsafe");
      const owner = parseLockOwner(fs.readFileSync(legacyLock, "utf8"));
      if (!owner || processExists(owner.pid)) throw new Error("memory_scope_locked");
      fs.unlinkSync(legacyLock);
    }
  }

  private databasePath(accountId: string): string { return path.join(this.accountDirectory(accountId), "memory.sqlite"); }
  private memoryPath(accountId: string): string { return path.join(this.accountDirectory(accountId), "MEMORY.md"); }
  private accountDirectory(accountId: string): string {
    const scope = crypto.createHash("sha256").update(accountId).digest("hex");
    return path.join(this.root, "accounts", scope);
  }

  private assertSafeScope(accountId: string): void {
    for (const candidate of [this.root, path.join(this.root, "accounts"), this.accountDirectory(accountId)]) {
      if (!fs.existsSync(candidate)) continue;
      const info = fs.lstatSync(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("memory_scope_unsafe");
    }
  }
}

function validateMutation(mutation: MemoryMutation, evidenceIds: Set<string>): void {
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/u.test(mutation.id)) throw new Error("memory_entry_id_invalid");
  if (mutation.op === "event_complete" && !/^[a-z0-9][a-z0-9-]{2,79}$/u.test(mutation.observedEventId)) throw new Error("memory_entry_id_invalid");
  if (mutation.evidenceEntryIds.length === 0 || mutation.evidenceEntryIds.some((id) => !evidenceIds.has(id))) throw new Error("memory_evidence_invalid");
  if (mutation.op === "supersede_task") {
    if (!mutation.taskId.trim() || mutation.taskId.length > 160 || !Number.isSafeInteger(mutation.taskRevision) || mutation.taskRevision < 1) throw new Error("memory_task_authority_invalid");
    if (mutation.retainedValue !== null) validateMemoryValue(mutation.retainedValue, 1);
  } else if (mutation.op === "event_add" || mutation.op === "event_update") {
    if (!isValidLocalDate(mutation.localDate) || mutation.timezone !== "Asia/Shanghai"
      || (mutation.op === "event_add" && !["planned", "observed"].includes(mutation.eventKind))) throw new Error("memory_event_invalid");
    validateMemoryValue(mutation.summary, mutation.confidence);
    if (mutation.op === "event_add" && mutation.fulfillsPlanId && mutation.eventKind !== "observed") throw new Error("memory_event_plan_invalid");
  } else if (mutation.op !== "remove" && mutation.op !== "event_complete" && mutation.op !== "event_set_status") validateMemoryValue(mutation.value, mutation.confidence);
}

function resolveReminderItems(database: DatabaseSync, planId: string, at: number): void {
  database.prepare("UPDATE reminder_batch_items SET resolved_at = ? WHERE plan_id = ? AND resolved_at IS NULL").run(at, planId);
}

function assertNoDuplicate(entries: AccountMemoryEntry[], value: string, ignoreIndex = -1): void {
  if (entries.some((entry, index) => index !== ignoreIndex && normalizeMemoryValue(entry.value) === normalizeMemoryValue(value))) throw new Error("memory_duplicate_value");
}

function validateMemoryValue(value: string, confidence: number): void {
  const text = value.trim();
  if (text.length === 0 || Array.from(text).length > 500) throw new Error("memory_value_invalid");
  if (!Number.isFinite(confidence) || confidence < 0.8 || confidence > 1) throw new Error("memory_confidence_invalid");
  if (
    /(?:password|passwd|api[ _-]?key|access[ _-]?token|context[ _-]?token|authorization|验证码|密码|令牌|密钥)/iu.test(text) ||
    /\bsk-[a-z0-9_-]{12,}\b/iu.test(text) ||
    /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/iu.test(text) ||
    /@[a-z0-9.-]*(?:wechat|bot)\b/iu.test(text) ||
    /(?:身份证号?|护照号?|银行卡号?|信用卡号?|诊断为|病史|血型|家庭住址|门牌号|经纬度|我的(?:妻子|丈夫|爱人|儿子|女儿|父亲|母亲)叫)/u.test(text) ||
    /\b(?:\+?86[- ]?)?1[3-9]\d{9}\b/u.test(text) ||
    /\b\d{15,18}[0-9Xx]\b/u.test(text)
  ) throw new Error("memory_sensitive_value");
}

export function normalizeMemoryValue(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\p{P}\s]+/gu, "");
}

export function renderMemory(entries: AccountMemoryEntry[]): string {
  const lines = ["# Long-term Memory", ""];
  for (const category of Object.keys(SECTION_NAMES) as MemoryCategory[]) {
    const items = entries.filter((entry) => entry.category === category);
    if (items.length === 0) continue;
    lines.push(`## ${SECTION_NAMES[category]}`, "");
    for (const entry of items) lines.push(`<!-- memory:id=${entry.id} -->`, `- ${entry.value}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderEventDate(localDate: string, events: AccountMemoryEvent[]): string {
  const lines = [`# Events · ${localDate}`, ""];
  for (const event of events) {
    const label = event.eventKind === "planned"
      ? planStatusLabel(event.planStatus)
      : event.factStatus === "retracted" ? "已发生·已撤回" : event.fulfillsPlanId ? "已发生·完成计划" : "已发生";
    lines.push(`<!-- event:id=${event.id} -->`, `- [${label}] ${event.summary}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderEventTimeline(events: AccountMemoryEvent[], today = shanghaiLocalDate(Date.now())): string {
  if (events.length === 0) return "# Events\n\n当前时间窗口内没有事件。\n";
  const lines = ["# Events", ""];
  let currentDate = "";
  for (const event of events) {
    if (event.localDate !== currentDate) {
      currentDate = event.localDate;
      lines.push(`## ${currentDate}`, "");
    }
    const label = event.eventKind === "observed"
      ? event.factStatus === "retracted" ? "已发生·已撤回" : event.fulfillsPlanId ? "已发生·完成计划" : "已发生"
      : event.planStatus === "pending" && event.localDate < today
        ? event.followUpState === "exhausted" ? "计划·已过期·结果未确认·已停止提醒" : "计划·已过期·结果未确认"
        : planStatusLabel(event.planStatus);
    lines.push(`<!-- event:id=${event.id} -->`, `- [${label}] ${event.summary}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderEventPanel(events: AccountMemoryEvent[], now = Date.now()): string {
  if (events.length === 0) return "# Events\n\n当前时间窗口内没有事件。\n";
  const today = shanghaiLocalDate(now);
  const lines = ["# Events", ""];
  let currentDate = "";
  for (const event of events) {
    if (event.localDate !== currentDate) {
      currentDate = event.localDate;
      lines.push(`## ${currentDate}`, "");
    }
    if (event.eventKind === "observed") {
      const label = event.factStatus === "retracted"
        ? "已发生·已撤回"
        : event.fulfillsPlanId ? "已发生·完成计划" : "已发生";
      lines.push(`- [${label}] ${event.summary}`, "");
      continue;
    }
    const overdue = event.planStatus === "pending" && (
      event.scheduledAt !== undefined ? event.scheduledAt < now : event.localDate < today
    );
    const label = overdue
      ? "计划·已到期·结果未确认"
      : panelPlanStatusLabel(event.planStatus);
    lines.push(`- [${label}] ${panelPlanTimeLabel(event)} · ${event.summary}`);
    if (event.planStatus === "pending") {
      const reminderCount = Math.max(0, Math.min(3, event.reminderCount ?? 0));
      const reminder = event.followUpState === "exhausted"
        ? `提醒：已停止自动提醒（已提醒 ${reminderCount}/3 次）`
        : reminderCount > 0
          ? `提醒：已提醒 ${reminderCount}/3 次，等待回复`
          : overdue ? "提醒：等待发送" : "提醒：等待计划到期";
      lines.push(`  ${reminder}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function shanghaiLocalDate(epochMs: number): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addLocalDays(localDate: string, days: number): string {
  const date = new Date(`${localDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eventSearchTerms(value: string): string[] {
  const normalized = value.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const terms = new Set(extractStrongAnchors(normalized));
  for (const run of normalized.match(/\p{Script=Han}{2,}/gu) ?? []) {
    const characters = Array.from(run);
    for (let index = 0; index < characters.length - 1; index += 1) terms.add(`${characters[index]}${characters[index + 1]}`);
  }
  for (const word of normalized.match(/[a-z0-9][a-z0-9._+/#@-]{1,}/gu) ?? []) terms.add(word);
  return [...terms];
}

function ensureReceiptColumns(database: DatabaseSync): void {
  const columns = new Set((database.prepare("PRAGMA table_info(receipts)").all() as Array<{ name: string }>).map((row) => row.name));
  for (const [name, definition] of [
    ["events_added", "INTEGER NOT NULL DEFAULT 0"],
    ["events_updated", "INTEGER NOT NULL DEFAULT 0"],
    ["events_removed", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) if (!columns.has(name)) database.exec(`ALTER TABLE receipts ADD COLUMN ${name} ${definition}`);
}

function ensureEventColumns(database: DatabaseSync): void {
  const columns = new Set((database.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("plan_status")) database.exec("ALTER TABLE events ADD COLUMN plan_status TEXT");
  if (!columns.has("fulfills_plan_id")) database.exec("ALTER TABLE events ADD COLUMN fulfills_plan_id TEXT");
  for (const [name, definition] of [
    ["scheduled_at_ms", "INTEGER"], ["time_precision", "TEXT"], ["local_time", "TEXT"],
    ["follow_up_state", "TEXT"], ["reminder_count", "INTEGER"], ["last_reminder_at_ms", "INTEGER"],
    ["next_reminder_at_ms", "INTEGER"], ["occurred_event_id", "TEXT"], ["fact_status", "TEXT"],
  ] as const) if (!columns.has(name)) database.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
  database.exec("UPDATE events SET plan_status = 'pending' WHERE event_kind = 'planned' AND (plan_status IS NULL OR plan_status = 'active')");
  database.exec("UPDATE events SET plan_status = 'occurred' WHERE event_kind = 'planned' AND plan_status = 'completed'");
  database.exec("UPDATE events SET time_precision = COALESCE(time_precision, 'date'), follow_up_state = CASE WHEN plan_status = 'pending' THEN COALESCE(follow_up_state, 'waiting') ELSE follow_up_state END, reminder_count = COALESCE(reminder_count, 0) WHERE event_kind = 'planned'");
  database.exec("UPDATE events SET fact_status = 'valid' WHERE event_kind = 'observed' AND fact_status IS NULL");
  const missingSchedules = database.prepare("SELECT id, local_date FROM events WHERE event_kind = 'planned' AND scheduled_at_ms IS NULL").all() as Array<{ id: string; local_date: string }>;
  for (const row of missingSchedules) {
    const scheduledAt = planScheduledAt(row.local_date, "date");
    database.prepare("UPDATE events SET scheduled_at_ms = ?, next_reminder_at_ms = COALESCE(next_reminder_at_ms, ?) WHERE id = ?")
      .run(scheduledAt, scheduledAt, row.id);
  }
}

export function planScheduledAt(localDate: string, precision: PlanTimePrecision, localTime?: string): number {
  if (!isValidLocalDate(localDate)) throw new Error("memory_event_invalid");
  const time = precision === "morning" ? "12:00"
    : precision === "afternoon" ? "18:00"
      : precision === "exact" ? localTime
        : "23:59";
  if (!time || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new Error("memory_event_invalid");
  return Date.parse(`${localDate}T${time}:00+08:00`);
}

function planStatusLabel(status?: PlanStatus): string {
  if (status === "occurred") return "计划·已发生";
  if (status === "cancelled") return "计划·已取消";
  if (status === "unfulfilled") return "计划·未兑现";
  return "计划·未落实";
}

function panelPlanStatusLabel(status?: PlanStatus): string {
  if (status === "occurred") return "计划·已发生";
  if (status === "cancelled") return "计划·已取消";
  if (status === "unfulfilled") return "计划·未落实";
  return "计划·待落实";
}

function panelPlanTimeLabel(event: AccountMemoryEvent): string {
  if (event.timePrecision === "morning") return "上午";
  if (event.timePrecision === "afternoon") return "下午";
  if (event.timePrecision === "evening") return "晚上";
  if (event.timePrecision === "exact" && event.localTime) return event.localTime;
  return "未指定具体时间";
}

function nextShanghaiCalendarDaySameTime(epochMs: number): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const nextDate = addLocalDays(`${value("year")}-${value("month")}-${value("day")}`, 1);
  return Date.parse(`${nextDate}T${value("hour")}:${value("minute")}:${value("second")}+08:00`);
}

function receiptFromRow(row: { revision: number; added: number; updated: number; removed: number; events_added: number; events_updated: number; events_removed: number }): MemoryCommitReceipt {
  return {
    status: "committed", revision: Number(row.revision), added: Number(row.added), updated: Number(row.updated), removed: Number(row.removed),
    ...(Number(row.events_added) > 0 ? { eventsAdded: Number(row.events_added) } : {}),
    ...(Number(row.events_updated) > 0 ? { eventsUpdated: Number(row.events_updated) } : {}),
    ...(Number(row.events_removed) > 0 ? { eventsRemoved: Number(row.events_removed) } : {}),
  };
}

function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function hash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, content); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function parseLockOwner(value: string): { pid: number } | null {
  try {
    const parsed = JSON.parse(value) as { pid?: unknown };
    return Number.isInteger(parsed.pid) && Number(parsed.pid) > 0 ? { pid: Number(parsed.pid) } : null;
  } catch { return null; }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
