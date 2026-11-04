import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexServiceStore } from "../src/codex-service-store.js";
import { parseMainReply } from "../src/main-reply-result.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function recordFixture() {
  // Shape matches the accepted transcript in the actual live fixture report;
  // old versions omit the newly collected result metadata.
  return { id: "reply-1", accountId: "fixture-bot", target: "fixture-user@im.wechat",
    role: "assistant", text: "收到", createdAt: 1789285048326, status: "accepted" };
}

function stateFixture(version = 7, transcript: unknown[] = [recordFixture()]) {
  return { version, enabledTargets: [], processedKeys: [], transcript,
    ...(version >= 2 ? { targetSessions: [] } : {}),
    ...(version >= 3 ? { permissions: { onboardingCompleted: false, mode: "safe", roots: [],
      networkPolicy: "readonly_retrieval", destructivePolicy: "block", revision: 0 } } : {}),
    ...(version >= 4 ? { runtimeRuns: [] } : {}),
    ...(version >= 7 ? { modelSettings: [], modelCatalog: { fetchedAt: 0, models: [] } } : {}),
  };
}

function storedResult() {
  return { version: 1, source: "main_model", inboundKey: "a".repeat(64), results: [] };
}

function openFixture(value: unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-results-store-"));
  directories.push(directory);
  const file = path.join(directory, "codex-service.json");
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return { store: new CodexServiceStore(file), file };
}

describe("main reply history compatibility", () => {
  it.each([1, 2, 3, 4, 5, 6, 7])("reloads v%i history without inventing results or errors", (version) => {
    const { store, file } = openFixture(stateFixture(version));
    const loaded = store.load();
    expect(loaded.version).toBe(7);
    expect(loaded.transcript).toEqual([{ id: "reply-1", accountId: "fixture-bot", target: "fixture-user@im.wechat",
      role: "assistant", text: "收到", createdAt: 1789285048326, status: "accepted" }]);
    store.save(loaded);
    const reloaded = new CodexServiceStore(file).load();
    expect(reloaded.transcript[0]).not.toHaveProperty("businessResult");
    expect(reloaded.transcript[0]).not.toHaveProperty("replyFailure");
    expect(reloaded.transcript[0]?.text).toBe("收到");
  });

  it("keeps legacy missing results, new empty results, business results and protocol failure distinct after reload", () => {
    const { store, file } = openFixture(stateFixture(7, [
      recordFixture(),
      { ...recordFixture(), id: "reply-2", businessResult: storedResult() },
      { ...recordFixture(), id: "reply-3", target: "second@im.wechat", text: "部分处理完成", status: "send_failed",
        businessResult: { ...storedResult(), inboundKey: "b".repeat(64), results: [
          { subject: "查阅笔记", status: "completed" }, { subject: "查找图片", status: "not_found" },
        ] } },
      { ...recordFixture(), id: "reply-4", status: "agent_failed", replyFailure: "main_reply_invalid_schema" },
    ]));
    store.save(store.load());
    const entries = new CodexServiceStore(file).load().transcript;
    expect(entries).toHaveLength(4);
    expect(entries[0]).not.toHaveProperty("businessResult");
    expect(entries[1]?.businessResult).toEqual({ version: 1, source: "main_model", inboundKey: "a".repeat(64), results: [] });
    expect(entries[2]).toMatchObject({ target: "second@im.wechat", status: "send_failed", businessResult: {
      version: 1, source: "main_model", inboundKey: "b".repeat(64), results: [
        { subject: "查阅笔记", status: "completed" }, { subject: "查找图片", status: "not_found" },
      ],
    } });
    expect(entries[3]?.replyFailure).toBe("main_reply_invalid_schema");
    expect(entries[3]).not.toHaveProperty("businessResult");
  });

  it("saves and reloads results at the accepted response byte limit", () => {
    const { store, file } = openFixture(stateFixture());
    const reply = parseMainReply(JSON.stringify({ message: "a", results: [{ subject: "x".repeat(95937), status: "not_found" }] }));
    const state = store.load();
    state.transcript.push({ id: "boundary", accountId: "fixture-bot", target: "fixture-user@im.wechat",
      role: "assistant", text: reply.message, createdAt: 1789285049000, status: "accepted",
      businessResult: { version: 1, source: "main_model", inboundKey: "c".repeat(64), results: reply.results } });
    store.save(state);
    const saved = new CodexServiceStore(file).load().transcript[1];
    expect(saved?.text).toBe("a");
    expect(saved?.businessResult?.results).toEqual([{ subject: "x".repeat(95937), status: "not_found" }]);
  });

  it.each([
    ["null metadata", null], ["array metadata", []],
    ["future result version", { ...storedResult(), version: 2 }],
    ["string version", { ...storedResult(), version: "1" }],
    ["wrong source", { ...storedResult(), source: "workflow" }],
    ["missing version", { source: "main_model", inboundKey: "a".repeat(64), results: [] }],
    ["missing source", { version: 1, inboundKey: "a".repeat(64), results: [] }],
    ["missing key", { version: 1, source: "main_model", results: [] }],
    ["short key", { ...storedResult(), inboundKey: "a".repeat(63) }],
    ["long key", { ...storedResult(), inboundKey: "a".repeat(65) }],
    ["nonhex key", { ...storedResult(), inboundKey: "g".repeat(64) }],
    ["nonstring key", { ...storedResult(), inboundKey: 1 }],
    ["missing results", { version: 1, source: "main_model", inboundKey: "a".repeat(64) }],
    ["null results", { ...storedResult(), results: null }],
    ["invalid result", { ...storedResult(), results: [{ subject: "目标", status: "success" }] }],
    ["extra metadata", { ...storedResult(), accountId: "forged" }],
  ])("rejects %s rather than rewriting or dropping invalid metadata", (_name, businessResult) => {
    const { store } = openFixture(stateFixture(7, [{ ...recordFixture(), businessResult }]));
    expect(() => store.load()).toThrow("Codex 服务状态格式无效");
  });

  it.each([
    ["user result", { role: "user", status: "received", businessResult: storedResult() }],
    ["user error", { role: "user", status: "received", replyFailure: "main_reply_invalid_json" }],
    ["result with protocol failure", { businessResult: storedResult(), status: "agent_failed", replyFailure: "main_reply_invalid_json" }],
    ["accepted protocol failure", { replyFailure: "main_reply_invalid_json" }],
    ["unknown protocol failure", { status: "agent_failed", replyFailure: "private exception /secret" }],
    ["null protocol failure", { status: "agent_failed", replyFailure: null }],
  ])("rejects contradictory or unsafe history: %s", (_name, fields) => {
    const { store } = openFixture(stateFixture(7, [{ ...recordFixture(), ...fields }]));
    expect(() => store.load()).toThrow("Codex 服务状态格式无效");
  });

  it.each(["main_reply_invalid_json", "main_reply_invalid_schema", "main_reply_too_large"])("round-trips the safe failure category %s without inventing a business result", (replyFailure) => {
    const { store, file } = openFixture(stateFixture(7, [{ ...recordFixture(), status: "send_failed", replyFailure }]));
    store.save(store.load());
    const saved = new CodexServiceStore(file).load().transcript[0];
    expect(saved?.replyFailure).toBe(replyFailure);
    expect(saved).not.toHaveProperty("businessResult");
  });

  it("rejects a future state format without silently resetting history", () => {
    const { store } = openFixture(stateFixture(8));
    expect(() => store.load()).toThrow("Codex 服务状态格式无效");
  });
});
