import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DurableEffectLedger } from "../src/durable-effect-ledger.js";

const tempDirs: string[] = [];

function ledgerInTemp(now = () => 1_800_000_000_000): DurableEffectLedger {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-effect-ledger-"));
  tempDirs.push(directory);
  return new DurableEffectLedger(path.join(directory, "effects.sqlite"), now);
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("DurableEffectLedger", () => {
  it("persists a prepared attempt before settling it as accepted", () => {
    const ledger = ledgerInTemp();
    const prepared = ledger.prepare({
      attemptId: "attempt-1",
      operationId: "operation-1",
      causeEventKey: "a".repeat(64),
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      kind: "weixin_text",
      clientId: "weixin-direct:1-abcd",
      ordinal: 0,
    });

    expect(prepared).toMatchObject({ state: "prepared", createdAt: 1_800_000_000_000 });
    expect(ledger.retrySafety("attempt-1")).toBe("unknown");
    expect(ledger.settle("attempt-1", "accepted")).toMatchObject({
      state: "accepted",
      settledAt: 1_800_000_000_000,
    });
    expect(ledger.retrySafety("attempt-1")).toBe("unsafe");
    ledger.close();
  });

  it("reopens prepared attempts conservatively and keeps terminal outcomes immutable", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-effect-reopen-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "effects.sqlite");
    const intent = {
      attemptId: "attempt-reopen",
      operationId: "operation-reopen",
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      kind: "weixin_text" as const,
    };
    const first = new DurableEffectLedger(databasePath, () => 100);
    first.prepare(intent);
    first.close();

    const reopened = new DurableEffectLedger(databasePath, () => 200);
    expect(reopened.prepare(intent)).toMatchObject({ state: "prepared", createdAt: 100 });
    expect(reopened.retrySafety(intent.attemptId)).toBe("unknown");
    reopened.settle(intent.attemptId, "rejected", 40013);
    expect(reopened.retrySafety(intent.attemptId)).toBe("safe");
    expect(() => reopened.settle(intent.attemptId, "accepted")).toThrow("effect_outcome_conflict");
    reopened.close();
  });

  it("rejects an attempt id reused for different immutable metadata", () => {
    const ledger = ledgerInTemp();
    ledger.prepare({
      attemptId: "attempt-conflict",
      operationId: "operation-1",
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      kind: "weixin_text",
    });
    expect(() => ledger.prepare({
      attemptId: "attempt-conflict",
      operationId: "operation-2",
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      kind: "weixin_text",
    })).toThrow("effect_attempt_conflict");
    ledger.close();
  });

  it("lists only sanitized metadata for a durable inbound cause", () => {
    const ledger = ledgerInTemp();
    const causeEventKey = "b".repeat(64);
    ledger.prepare({
      attemptId: "attempt-sanitized",
      operationId: "operation-sanitized",
      causeEventKey,
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      kind: "weixin_media_send",
      clientId: "weixin-direct:2-abcd",
    });
    const serialized = JSON.stringify(ledger.listByCause(causeEventKey));
    expect(serialized).not.toContain("context_token");
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain("message\"");
    ledger.close();
  });

  it("lists all attempts for one stable workflow operation", () => {
    const ledger = ledgerInTemp();
    for (const [attemptId, kind] of [
      ["attempt-upload", "weixin_media_upload"],
      ["attempt-send", "weixin_media_send"],
    ] as const) {
      ledger.prepare({
        attemptId,
        operationId: "workflow-operation:abc",
        accountId: "direct-bot@im.bot",
        target: "owner@im.wechat",
        kind,
      });
    }
    ledger.settle("attempt-upload", "accepted");
    ledger.settle("attempt-send", "unknown");

    expect(ledger.listByOperation("workflow-operation:abc").map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: "weixin_media_upload", state: "accepted" },
      { kind: "weixin_media_send", state: "unknown" },
    ]);
    ledger.close();
  });
});
