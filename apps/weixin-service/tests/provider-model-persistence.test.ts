// IDs and descriptor shape reproduce the live Codex model catalogue observed during Feishu startup.
// No live API, account data or model invocation is needed for the persistence regression.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CodexServiceStore } from "../src/codex-service-store.js";

it.each(["catalog", "selection", "run"])("preserves provider-qualified IDs in %s across reopen", kind => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-model-"));
  const file = path.join(dir, "state.json");
  const store = new CodexServiceStore(file), state = store.load();
  if (kind === "catalog") state.modelCatalog = { fetchedAt: 1, models: [{ model: "grok/grok-4.7@500k", displayName: "Grok 4.7 @ 500k", hidden: false, inputModalities: ["text", "image"], supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" }] };
  if (kind === "selection") state.modelSettings = [{ accountId: "bot", selection: { mode: "pinned", model: "grok/grok-4.7@500k", effort: "high" }, revision: 1, updatedAt: 1 }];
  if (kind === "run") state.runtimeRuns = [{ accountId: "bot", target: "user@im.wechat", runId: "019fef94-7da4-75a2-b9fb-226af024ddce", phase: "completed", queueDepth: 0, startedAt: 1, updatedAt: 2, completedAt: 2, recentSteps: [], timings: [], agentTimings: [], agentTimingsTruncated: false, model: "grok/grok-4.7@500k", reasoningEffort: "high", modelSelectionSource: "pinned", modelConfigRevision: 1 }];
  try {
    store.save(state);
    const loaded = new CodexServiceStore(file).load();
    if (kind === "catalog") expect(loaded.modelCatalog?.models[0]?.model).toBe("grok/grok-4.7@500k");
    if (kind === "selection") expect(loaded.modelSettings?.[0]?.selection).toEqual({ mode: "pinned", model: "grok/grok-4.7@500k", effort: "high" });
    if (kind === "run") expect(loaded.runtimeRuns[0]?.model).toBe("grok/grok-4.7@500k");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it.each(["", "grok/model\n", "grok/model name", "x".repeat(121)])("rejects invalid catalogue model %j", model => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-model-invalid-"));
  const store = new CodexServiceStore(path.join(dir, "state.json")), state = store.load();
  state.modelCatalog = { fetchedAt: 1, models: [{ model, displayName: "Example", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" }] };
  try { expect(() => store.save(state)).toThrow("Codex 服务状态格式无效"); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
