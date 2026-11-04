import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CodexServiceStore } from "../src/codex-service-store.js";

describe("CodexServiceStore", () => {
  it("loads only allowlisted runtime diagnostics", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-typing-diagnostics-"));
    const file = path.join(dir, "codex-service.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 7,
      targetSessions: [],
      permissions: { onboardingCompleted: false, mode: "safe", roots: [], networkPolicy: "readonly_retrieval", destructivePolicy: "block", revision: 0 },
      enabledTargets: [],
      processedKeys: [],
      transcript: [],
      modelSettings: [],
      modelCatalog: { fetchedAt: 0, models: [] },
      runtimeRuns: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        runId: "019fef94-7da4-75a2-b9fb-226af024ddce",
        phase: "completed",
        queueDepth: 0,
        startedAt: 1_723_456_789_000,
        updatedAt: 1_723_456_789_030,
        completedAt: 1_723_456_789_030,
        recentSteps: [],
        timings: [],
        agentTimings: [],
        agentTimingsTruncated: false,
        typingDiagnostics: {
          ticketCache: "miss",
          getConfig: { durationMs: 40, outcome: "completed", ticket: "must-not-load" },
          sendStart: { durationMs: 70, outcome: "completed" },
          contextToken: "must-not-load",
        },
        outboundDiagnostics: {
          prepare: { durationMs: 2, outcome: "completed", body: "must-not-load" },
          sendMessage: { durationMs: 7332, outcome: "completed", endpoint: "must-not-load" },
          responseRead: { durationMs: 3, outcome: "completed", response: "must-not-load" },
          stateSave: { durationMs: 6, outcome: "completed", path: "must-not-load" },
          requestCount: 1,
          contextToken: "must-not-load",
        },
        workflowPlannerDiagnostics: [{
          attempt: 2,
          generation: 2,
          phase: "initial",
          stage: "first_model_event",
          startedAt: 1_723_456_789_010,
          completedAt: 1_723_456_789_020,
          durationMs: 10,
          outcome: "timeout",
          errorCode: "planner_timeout",
          prompt: "must-not-load",
        }],
      }],
    }), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);

    const loaded = new CodexServiceStore(file).load().runtimeRuns[0];
    expect(loaded?.typingDiagnostics).toEqual({
      ticketCache: "miss",
      getConfig: { durationMs: 40, outcome: "completed" },
      sendStart: { durationMs: 70, outcome: "completed" },
    });
    expect(loaded?.outboundDiagnostics).toEqual({
      prepare: { durationMs: 2, outcome: "completed" },
      sendMessage: { durationMs: 7332, outcome: "completed" },
      responseRead: { durationMs: 3, outcome: "completed" },
      stateSave: { durationMs: 6, outcome: "completed" },
      requestCount: 1,
    });
    expect(JSON.stringify(loaded?.outboundDiagnostics)).not.toContain("must-not-load");
    expect(loaded?.workflowPlannerDiagnostics).toEqual([{
      attempt: 2,
      generation: 2,
      phase: "initial",
      stage: "first_model_event",
      startedAt: 1_723_456_789_010,
      completedAt: 1_723_456_789_020,
      durationMs: 10,
      outcome: "timeout",
      errorCode: "planner_timeout",
    }]);
    expect(JSON.stringify(loaded?.workflowPlannerDiagnostics)).not.toContain("must-not-load");

    const inconsistent = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const runtimeRuns = inconsistent.runtimeRuns as Array<Record<string, unknown>>;
    const outboundDiagnostics = runtimeRuns[0]?.outboundDiagnostics as Record<string, unknown>;
    outboundDiagnostics.requestCount = 17;
    fs.writeFileSync(file, JSON.stringify(inconsistent), { mode: 0o600 });
    expect(() => new CodexServiceStore(file).load()).toThrow("Codex 服务状态格式无效");
    outboundDiagnostics.requestCount = 1;
    const diagnostics = runtimeRuns[0]?.typingDiagnostics as Record<string, unknown>;
    diagnostics.getConfig = { durationMs: 40, outcome: "failed" };
    diagnostics.sendStart = { durationMs: 0, outcome: "skipped" };
    fs.writeFileSync(file, JSON.stringify(inconsistent), { mode: 0o600 });
    expect(new CodexServiceStore(file).load().runtimeRuns[0]?.typingDiagnostics).toEqual({
      ticketCache: "miss",
      getConfig: { durationMs: 40, outcome: "failed" },
      sendStart: { durationMs: 0, outcome: "skipped" },
    });

    diagnostics.ticketCache = "hit";
    fs.writeFileSync(file, JSON.stringify(inconsistent), { mode: 0o600 });
    expect(() => new CodexServiceStore(file).load()).toThrow("Codex 服务状态格式无效");
  });

  it("migrates v6 state to v7 with an empty account model configuration and catalog", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-v6-models-"));
    const file = path.join(dir, "codex-service.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 6,
      targetSessions: [],
      permissions: { onboardingCompleted: false, mode: "safe", roots: [], networkPolicy: "readonly_retrieval", destructivePolicy: "block", revision: 0 },
      enabledTargets: [], processedKeys: [], transcript: [], runtimeRuns: [],
    }), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);

    expect(new CodexServiceStore(file).load()).toMatchObject({
      version: 7,
      modelSettings: [],
      modelCatalog: { fetchedAt: 0, models: [] },
    });
  });

  it("migrates v5 runtime runs to empty internal timings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-v5-timings-"));
    const file = path.join(dir, "codex-service.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 5,
      targetSessions: [],
      permissions: {
        onboardingCompleted: false,
        mode: "safe",
        roots: [],
        networkPolicy: "readonly_retrieval",
        destructivePolicy: "block",
        revision: 0,
      },
      enabledTargets: [],
      processedKeys: [],
      transcript: [],
      runtimeRuns: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        runId: "019fef94-7da4-75a2-b9fb-226af024ddce",
        phase: "completed",
        queueDepth: 0,
        startedAt: 1_723_456_789_000,
        updatedAt: 1_723_456_789_030,
        completedAt: 1_723_456_789_030,
        recentSteps: [],
        timings: [{
          stage: "agent",
          startedAt: 1_723_456_789_010,
          completedAt: 1_723_456_789_020,
          outcome: "completed",
        }],
      }],
    }), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);

    expect(new CodexServiceStore(file).load()).toMatchObject({
      version: 7,
      runtimeRuns: [{ agentTimings: [], agentTimingsTruncated: false }],
    });
  });

  it("loads v6 Codex internal timings without exposing raw tool data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-agent-timings-"));
    const file = path.join(dir, "codex-service.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 6,
      targetSessions: [],
      permissions: {
        onboardingCompleted: false,
        mode: "safe",
        roots: [],
        networkPolicy: "readonly_retrieval",
        destructivePolicy: "block",
        revision: 0,
      },
      enabledTargets: [],
      processedKeys: [],
      transcript: [],
      runtimeRuns: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        runId: "019fef94-7da4-75a2-b9fb-226af024ddce",
        phase: "completed",
        queueDepth: 0,
        startedAt: 1_723_456_789_000,
        updatedAt: 1_723_456_789_030,
        completedAt: 1_723_456_789_030,
        recentSteps: [],
        timings: [],
        agentTimings: [{
          stage: "tool_execution",
          label: "执行本地命令",
          correlationHash: "d".repeat(64),
          startedAt: 1_723_456_789_010,
          completedAt: 1_723_456_789_020,
          outcome: "completed",
        }],
        agentTimingsTruncated: false,
      }],
    }), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);

    expect(new CodexServiceStore(file).load()).toMatchObject({
      version: 7,
      runtimeRuns: [{
        agentTimings: [{
          stage: "tool_execution",
          label: "执行本地命令",
          correlationHash: "d".repeat(64),
          outcome: "completed",
        }],
        agentTimingsTruncated: false,
      }],
    });
  });

  it("rejects an internal correlated stage without a valid opaque hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-invalid-agent-timing-"));
    const file = path.join(dir, "codex-service.json");
    const store = new CodexServiceStore(file);

    expect(() => store.save({
      version: 6,
      targetSessions: [],
      permissions: {
        onboardingCompleted: false,
        mode: "safe",
        roots: [],
        networkPolicy: "readonly_retrieval",
        destructivePolicy: "block",
        revision: 0,
      },
      enabledTargets: [],
      processedKeys: [],
      transcript: [],
      runtimeRuns: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        runId: "019fef94-7da4-75a2-b9fb-226af024ddce",
        phase: "completed",
        queueDepth: 0,
        startedAt: 1_723_456_789_000,
        updatedAt: 1_723_456_789_030,
        recentSteps: [],
        timings: [],
        agentTimings: [{
          stage: "model_reasoning",
          correlationHash: "raw-item-id",
          startedAt: 1_723_456_789_010,
        }],
        agentTimingsTruncated: false,
      }],
    })).toThrow("Codex 服务状态格式无效");
  });

  it("persists a dedicated thread, explicit targets, dedupe keys and transcript privately", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-state-"));
    const file = path.join(dir, "private", "codex-service.json");
    const store = new CodexServiceStore(file);

    store.save({
      version: 6,
      targetSessions: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        threadId: "019fef94-7da4-75a2-b9fb-226af024ddcd",
        threadProfile: "native-relay-v2",
      }],
      permissions: {
        onboardingCompleted: true,
        mode: "guarded_plus",
        roots: [{ id: "workspace", canonicalPath: "/workspace", displayName: "工作区" }],
        networkPolicy: "readonly_retrieval",
        destructivePolicy: "block",
        revision: 2,
      },
      enabledTargets: [{ accountId: "bot@im.bot", target: "user@im.wechat" }],
      processedKeys: ["a".repeat(64)],
      transcript: [
        {
          id: "m-1",
          accountId: "bot@im.bot",
          target: "user@im.wechat",
          role: "user",
          text: "你好",
          createdAt: 1_723_456_789_000,
          status: "received",
        },
      ],
      runtimeRuns: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        runId: "019fef94-7da4-75a2-b9fb-226af024ddce",
        phase: "tool",
        queueDepth: 1,
        startedAt: 1_723_456_789_000,
        updatedAt: 1_723_456_789_001,
        activeTool: "搜索网页",
        recentSteps: [{
          itemHash: "c".repeat(64),
          label: "搜索网页",
          status: "running",
          at: 1_723_456_789_001,
        }],
        timings: [{
          stage: "agent",
          startedAt: 1_723_456_789_000,
        }],
        agentTimings: [],
        agentTimingsTruncated: false,
      }],
    });

    expect(store.load()).toMatchObject({
      version: 7,
      targetSessions: [{ target: "user@im.wechat", threadProfile: "native-relay-v2" }],
      permissions: { onboardingCompleted: true, mode: "guarded_plus", revision: 2 },
      enabledTargets: [{ target: "user@im.wechat" }],
      processedKeys: ["a".repeat(64)],
      transcript: [{ text: "你好", status: "received" }],
      runtimeRuns: [{ phase: "tool", queueDepth: 1, activeTool: "搜索网页", timings: [{ stage: "agent" }] }],
    });
    expect(fs.statSync(path.dirname(file)).mode & 0o077).toBe(0);
    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it("loads legacy state without migrating the old Vault switch into authority", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-legacy-"));
    const file = path.join(dir, "codex-service.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      vaultWriteEnabled: true,
      enabledTargets: [],
      processedKeys: [],
      transcript: [],
    }), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);

    expect(new CodexServiceStore(file).load()).toMatchObject({
      version: 7,
      targetSessions: [],
      permissions: {
        onboardingCompleted: false,
        mode: "safe",
        roots: [],
        networkPolicy: "readonly_retrieval",
        destructivePolicy: "block",
        revision: 0,
      },
    });
  });

  it("drops an intermediate native-relay-v1 thread so the final relay starts clean", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-v1-relay-"));
    const file = path.join(dir, "codex-service.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      targetSessions: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        threadId: "019fef94-7da4-75a2-b9fb-226af024ddcd",
        threadProfile: "native-relay-v1",
      }],
      vaultWriteEnabled: false,
      enabledTargets: [{ accountId: "bot@im.bot", target: "user@im.wechat" }],
      processedKeys: [],
      transcript: [],
    }), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);

    expect(new CodexServiceStore(file).load()).toMatchObject({ targetSessions: [] });
  });

  it("preserves v2 relay data while requiring fresh permission onboarding", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-v2-permissions-"));
    const file = path.join(dir, "codex-service.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      targetSessions: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        threadId: "019fef94-7da4-75a2-b9fb-226af024ddcd",
        threadProfile: "native-relay-v2",
      }],
      vaultWriteEnabled: true,
      enabledTargets: [{ accountId: "bot@im.bot", target: "user@im.wechat" }],
      processedKeys: ["b".repeat(64)],
      transcript: [],
    }), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);

    expect(new CodexServiceStore(file).load()).toMatchObject({
      version: 7,
      targetSessions: [{ threadProfile: "native-relay-v2" }],
      enabledTargets: [{ target: "user@im.wechat" }],
      processedKeys: ["b".repeat(64)],
      permissions: { onboardingCompleted: false, mode: "safe", roots: [], revision: 0 },
    });
  });

  it("loads v4 runtime records without inventing historical stage timings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-v4-timings-"));
    const file = path.join(dir, "codex-service.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 4,
      targetSessions: [],
      permissions: {
        onboardingCompleted: false,
        mode: "safe",
        roots: [],
        networkPolicy: "readonly_retrieval",
        destructivePolicy: "block",
        revision: 0,
      },
      enabledTargets: [],
      processedKeys: [],
      transcript: [],
      runtimeRuns: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        runId: "019fef94-7da4-75a2-b9fb-226af024ddce",
        phase: "completed",
        queueDepth: 0,
        startedAt: 1_723_456_789_000,
        updatedAt: 1_723_456_789_010,
        completedAt: 1_723_456_789_010,
        recentSteps: [],
      }],
    }), { mode: 0o600 });
    fs.chmodSync(dir, 0o700);

    expect(new CodexServiceStore(file).load()).toMatchObject({
      version: 7,
      runtimeRuns: [{ phase: "completed", timings: [], agentTimings: [], agentTimingsTruncated: false }],
    });
  });

  it("rejects a timing whose completion precedes its start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-invalid-timing-"));
    const file = path.join(dir, "codex-service.json");
    const store = new CodexServiceStore(file);
    expect(() => store.save({
      version: 6,
      targetSessions: [],
      permissions: {
        onboardingCompleted: false,
        mode: "safe",
        roots: [],
        networkPolicy: "readonly_retrieval",
        destructivePolicy: "block",
        revision: 0,
      },
      enabledTargets: [],
      processedKeys: [],
      transcript: [],
      runtimeRuns: [{
        accountId: "bot@im.bot",
        target: "user@im.wechat",
        runId: "019fef94-7da4-75a2-b9fb-226af024ddce",
        phase: "completed",
        queueDepth: 0,
        startedAt: 1_723_456_789_000,
        updatedAt: 1_723_456_789_010,
        completedAt: 1_723_456_789_010,
        recentSteps: [],
        timings: [{
          stage: "agent",
          startedAt: 1_723_456_789_010,
          completedAt: 1_723_456_789_000,
          outcome: "completed",
        }],
        agentTimings: [],
        agentTimingsTruncated: false,
      }],
    })).toThrow("Codex 服务状态格式无效");
  });
});
