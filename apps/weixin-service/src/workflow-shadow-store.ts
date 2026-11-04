import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type WorkflowShadowObservation = {
  triggerKeyHash: string;
  intent: string;
  intentVersion: number;
  workflowId: string;
  confidence: number;
  slotKeys: string[];
};

export type StoredWorkflowShadowObservation = WorkflowShadowObservation & {
  observedAt: number;
};

const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function workflowShadowTriggerKeyHash(triggerKey: string): string {
  return crypto.createHash("sha256").update(triggerKey).digest("hex");
}

export class WorkflowShadowStore {
  private readonly database: DatabaseSync;

  constructor(
    file: string,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_shadow_observation (
        trigger_key_hash TEXT PRIMARY KEY,
        intent TEXT NOT NULL,
        intent_version INTEGER NOT NULL,
        workflow_id TEXT NOT NULL,
        confidence REAL NOT NULL,
        slot_keys_json TEXT NOT NULL,
        observed_at INTEGER NOT NULL
      ) STRICT
    `);
  }

  observe(input: WorkflowShadowObservation): void {
    validateObservation(input);
    const slotKeys = [...new Set(input.slotKeys)].sort();
    const existing = this.database.prepare(`
      SELECT intent, intent_version, workflow_id, confidence, slot_keys_json
      FROM workflow_shadow_observation WHERE trigger_key_hash = ?
    `).get(input.triggerKeyHash) as {
      intent: string; intent_version: number; workflow_id: string; confidence: number; slot_keys_json: string;
    } | undefined;
    if (existing) {
      if (existing.intent !== input.intent || existing.intent_version !== input.intentVersion ||
          existing.workflow_id !== input.workflowId || existing.confidence !== input.confidence ||
          existing.slot_keys_json !== JSON.stringify(slotKeys)) {
        throw new Error("workflow_shadow_observation_conflict");
      }
      return;
    }
    this.database.prepare(`
      INSERT INTO workflow_shadow_observation(
        trigger_key_hash, intent, intent_version, workflow_id, confidence, slot_keys_json, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.triggerKeyHash,
      input.intent,
      input.intentVersion,
      input.workflowId,
      input.confidence,
      JSON.stringify(slotKeys),
      this.now(),
    );
  }

  has(triggerKeyHash: string): boolean {
    if (!HASH.test(triggerKeyHash)) throw new Error("workflow_shadow_observation_invalid");
    return this.database.prepare(`
      SELECT 1 FROM workflow_shadow_observation WHERE trigger_key_hash = ?
    `).get(triggerKeyHash) !== undefined;
  }

  list(): StoredWorkflowShadowObservation[] {
    const rows = this.database.prepare(`
      SELECT trigger_key_hash, intent, intent_version, workflow_id, confidence, slot_keys_json, observed_at
      FROM workflow_shadow_observation ORDER BY observed_at ASC, trigger_key_hash ASC
    `).all() as Array<{
      trigger_key_hash: string; intent: string; intent_version: number; workflow_id: string;
      confidence: number; slot_keys_json: string; observed_at: number;
    }>;
    return rows.map((row) => ({
      triggerKeyHash: row.trigger_key_hash,
      intent: row.intent,
      intentVersion: row.intent_version,
      workflowId: row.workflow_id,
      confidence: row.confidence,
      slotKeys: JSON.parse(row.slot_keys_json) as string[],
      observedAt: row.observed_at,
    }));
  }

  close(): void {
    this.database.close();
  }
}

function validateObservation(input: WorkflowShadowObservation): void {
  if (!HASH.test(input.triggerKeyHash) || !IDENTIFIER.test(input.intent) ||
      !Number.isSafeInteger(input.intentVersion) || input.intentVersion < 1 ||
      !IDENTIFIER.test(input.workflowId) || !Number.isFinite(input.confidence) ||
      input.confidence < 0 || input.confidence > 1 || !Array.isArray(input.slotKeys) ||
      input.slotKeys.length > 32 || input.slotKeys.some((key) => !IDENTIFIER.test(key))) {
    throw new Error("workflow_shadow_observation_invalid");
  }
}
