import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CodexServiceStore } from "../src/codex-service-store.js";
import type {
  InboundRejectedEvent,
  InboundTextEvent,
  SendTextResult,
  WeixinChannel,
} from "../src/demo-service.js";
import {
  WeixinCodexService,
  type CodexAgent,
  type CompletedInboundObserver,
  type InboundWorkflowControl,
} from "../src/weixin-codex-service.js";
import type { WorkflowTurnToolControl } from "../src/weixin-turn-adapter.js";
import { scriptedTurnRunner, type ScriptedModelReply } from "./fixtures/scripted-turn-runner.js";
import { VaultAuthorization } from "../src/vault-dynamic-tool-host.js";
import { WeixinMediaToolHost } from "../src/weixin-media-tool-host.js";
import { MediaExportLibrary } from "../src/media-export-library.js";
import { WeixinWorkflowTriggerAdapter } from "../src/weixin-workflow-trigger-adapter.js";

function modelReply(message: string): string { return JSON.stringify({ message, results: [] }); }

class FakeAgent implements CodexAgent {
  readonly prompts: string[] = [];
  private nextThread = 0;
  startOrResume = vi.fn(async (threadId?: string) => threadId ?? [
    "019fef94-7da4-75a2-b9fb-226af024ddcd",
    "019fef94-7da4-75a2-b9fb-226af024ddee",
  ][this.nextThread++]!);
  reply = vi.fn(async (...args: Parameters<ScriptedModelReply>) => {
    const [, prompt] = args;
    this.prompts.push(typeof prompt === "string" ? prompt : prompt.find((item) => item.type === "text")?.text ?? "");
    return modelReply("你好，我收到了。");
  });
  runTurn = scriptedTurnRunner((...args) => this.reply(...args));
  close = vi.fn();
}

function harness(memory?: {
  start(): Promise<void>;
  registerAccount?(accountId: string): void;
  enable(accountId: string): void;
  disable(accountId: string): void;
  captureTurn(turn: unknown): Promise<{ queued: boolean; jobId?: string }>;
  recall(accountId: string, currentUserText?: string): string;
  close(): void;
}, now: () => number = () => 1_723_456_789_000, mediaTools?: WeixinMediaToolHost, inboundWorkflows?: InboundWorkflowControl, completedInboundObserver?: CompletedInboundObserver, workflowTools?: WorkflowTurnToolControl, setupStore?: (store: CodexServiceStore) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-codex-service-"));
  const stateFile = path.join(directory, "state", "codex-service.json");
  const store = new CodexServiceStore(stateFile);
  setupStore?.(store);
  let listener: ((event: InboundTextEvent) => unknown) | undefined;
  let rejectedListener: ((event: InboundRejectedEvent) => void) | undefined;
  const channel = {
    getSnapshot: () => ({
      accounts: [{ accountId: "bot@im.bot", credentialStatus: "usable" as const }],
      targets: [
        { accountId: "bot@im.bot", target: "owner@im.wechat" },
        { accountId: "bot@im.bot", target: "second@im.wechat" },
      ],
    }),
    onInboundText: (next: (event: InboundTextEvent) => unknown) => {
      listener = next;
      return () => { listener = undefined; };
    },
    onInboundRejected: (next: (event: InboundRejectedEvent) => void) => {
      rejectedListener = next;
      return () => { rejectedListener = undefined; };
    },
  } as Pick<WeixinChannel, "getSnapshot" | "onInboundText" | "onInboundRejected">;
  const agent = new FakeAgent();
  const vault = new VaultAuthorization("demo");
  const desktop = { openThread: vi.fn(async () => {}) };
  const service = new WeixinCodexService(
    channel,
    agent,
    store,
    "/workspace",
    now,
    vault,
    undefined,
    false,
    undefined,
    mediaTools,
    desktop,
    memory,
    inboundWorkflows,
    completedInboundObserver,
    workflowTools,
  );
  const deliver = (overrides: Partial<InboundTextEvent> = {}) => {
    const replyText = vi.fn(async (message: string) => {
      void message;
      return { ok: true as const, messageId: "sent-1" };
    });
    const completion = Promise.resolve(listener?.({
      key: "a".repeat(64),
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      messageId: "message-1",
      source: "text",
      text: "Hi",
      receivedAt: 1_723_456_788_000,
      replyText,
      ...overrides,
    }));
    return { replyText, completion };
  };
  const emit = (overrides: Partial<InboundTextEvent> = {}) => deliver(overrides).replyText;
  const emitRejected = (overrides: Partial<InboundRejectedEvent> = {}) => {
    const replyText = vi.fn(async (message: string) => {
      void message;
      return { ok: true as const, messageId: "rejected-sent-1" };
    });
    rejectedListener?.({
      key: "7".repeat(64),
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      messageId: "voice-message-rejected",
      source: "voice",
      reason: "voice_too_long",
      durationMs: 60_001,
      receivedAt: 1_723_456_788_000,
      replyText,
      ...overrides,
    });
    return replyText;
  };
  return { service, store, stateFile, agent, vault, desktop, channel, emit, deliver, emitRejected };
}

describe("WeixinCodexService", () => {
  it.each([
    { name: "accepted", result: { ok: true, messageId: "accepted-once" }, status: "accepted" },
    { name: "rejected", result: { ok: false, reason: "rejected" }, status: "send_failed" },
    { name: "unknown", result: { ok: false, reason: "unknown" }, status: "send_failed" },
    { name: "partial", result: { ok: false, reason: "unknown", acceptedSegments: 1, totalSegments: 2 }, status: "partial" },
  ] satisfies Array<{ name: string; result: SendTextResult; status: string }>)("preserves a local save failure after a $name reply without replaying the turn", async ({ result, status }) => {
    const { service, store, stateFile, agent, deliver } = harness();
    agent.reply.mockResolvedValueOnce(JSON.stringify({ message: "没有找到匹配的图片。", results: [{ subject: "查找图片", status: "not_found" }] }));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const backup = `${stateFile}.before-failure`;
    const sent: string[] = [];
    try {
      const delivered = deliver({
        startTyping: async () => ({ active: true, stop: async () => {} }),
        replyText: async (text) => {
          sent.push(text);
          fs.renameSync(stateFile, backup);
          fs.mkdirSync(stateFile);
          return result;
        },
      });
      await expect(delivered.completion).resolves.toBeUndefined();
      expect(sent).toEqual(["没有找到匹配的图片。"]);
      expect(agent.reply).toHaveBeenCalledOnce();
      expect(service.getPublicState()).toMatchObject({ status: "error", notice: expect.stringContaining("本地回复记录保存失败") });
      expect(service.getPublicState().transcript.at(-1)).toMatchObject({ status, businessResult: { results: [{ subject: "查找图片", status: "not_found" }] } });
      expect(service.getPublicState().notice).not.toContain(stateFile);
    } finally {
      if (fs.existsSync(backup)) {
        fs.rmdirSync(stateFile);
        fs.renameSync(backup, stateFile);
      }
      await service.close();
    }
    expect(store.load().transcript.some((entry) => entry.text === "没有找到匹配的图片。")).toBe(false);
  });

  it("keeps the save-failure warning after storage recovers and a later message succeeds", async () => {
    const { service, store, stateFile, agent, deliver } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const backup = `${stateFile}.before-failure`;
    try {
      await deliver({
        startTyping: async () => ({ active: true, stop: async () => {} }),
        replyText: async () => {
          fs.renameSync(stateFile, backup);
          fs.mkdirSync(stateFile);
          return { ok: true };
        },
      }).completion;
      fs.rmdirSync(stateFile);
      fs.renameSync(backup, stateFile);
      const repeated = deliver();
      await repeated.completion;
      expect(repeated.replyText).not.toHaveBeenCalled();
      expect(agent.reply).toHaveBeenCalledOnce();
      const later = deliver({ key: "b".repeat(64), messageId: "next-message" });
      await later.completion;
      expect(later.replyText).toHaveBeenLastCalledWith("你好，我收到了。");
      expect(agent.reply).toHaveBeenCalledTimes(2);
      expect(store.load().transcript.filter((entry) => entry.businessResult)).toHaveLength(2);
      expect(service.getPublicState()).toMatchObject({ status: "error", notice: expect.stringContaining("本地回复记录保存失败") });
    } finally {
      if (fs.existsSync(backup)) { fs.rmdirSync(stateFile); fs.renameSync(backup, stateFile); }
      await service.close();
    }
  });

  it("still stops before invoking the model or sending when inbound persistence fails", async () => {
    const { service, stateFile, agent, deliver } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const backup = `${stateFile}.before-failure`;
    fs.renameSync(stateFile, backup);
    fs.mkdirSync(stateFile);
    try {
      const delivered = deliver();
      await expect(delivered.completion).rejects.toThrow("codex_inbound_persist_failed");
      expect(agent.reply).not.toHaveBeenCalled();
      expect(delivered.replyText).not.toHaveBeenCalled();
    } finally {
      fs.rmdirSync(stateFile);
      fs.renameSync(backup, stateFile);
      await service.close();
    }
  });

  it.each(["invalid_json", "model_error"])("retains save failure beside a %s failure without repeating its notification", async (failure) => {
    const { service, stateFile, agent, deliver } = harness();
    if (failure === "invalid_json") agent.reply.mockResolvedValueOnce("private invalid model output");
    else agent.reply.mockRejectedValueOnce(new Error("private model error"));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const backup = `${stateFile}.before-failure`;
    const sent: string[] = [];
    try {
      await deliver({
        startTyping: async () => ({ active: true, stop: async () => {} }),
        replyText: async (text) => {
          sent.push(text);
          fs.renameSync(stateFile, backup);
          fs.mkdirSync(stateFile);
          return { ok: true };
        },
      }).completion;
      expect(sent).toHaveLength(1);
      expect(sent[0]?.length).toBeGreaterThan(0);
      expect(sent[0]).not.toContain("private");
      expect(agent.reply).toHaveBeenCalledOnce();
      const state = service.getPublicState();
      expect(state.notice).toContain("Codex 处理失败");
      expect(state.notice).toContain("本地回复记录保存失败");
      expect(state.transcript.at(-1)).toMatchObject({ status: "agent_failed" });
      expect(state.transcript.at(-1)?.businessResult).toBeUndefined();
      expect(state.runs[0]?.phase).toBe("failed");
    } finally {
      if (fs.existsSync(backup)) { fs.rmdirSync(stateFile); fs.renameSync(backup, stateFile); }
      await service.close();
    }
  });

  it("keeps reported business results isolated from public snapshot mutations and later inbound turns", async () => {
    const { service, store, agent, deliver } = harness();
    agent.reply.mockResolvedValueOnce(JSON.stringify({ message: "没有找到图片，笔记已读取。", results: [
      { subject: "找图片", status: "not_found" }, { subject: "读笔记", status: "completed" },
    ] }));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    await deliver().completion;
    const exposed = service.getPublicState().transcript.at(-1)?.businessResult;
    expect(exposed).toBeDefined();
    if (!exposed?.results[0]) throw new Error("missing business result");
    exposed.results[0].status = "completed";
    await deliver({ key: "b".repeat(64), messageId: "next-message", text: "你好" }).completion;
    expect(store.load().transcript.filter((entry) => entry.businessResult).map((entry) => entry.businessResult)).toEqual([
      { version: 1, source: "main_model", inboundKey: "a".repeat(64), results: [
        { subject: "找图片", status: "not_found" }, { subject: "读笔记", status: "completed" },
      ] },
      { version: 1, source: "main_model", inboundKey: "b".repeat(64), results: [] },
    ]);
    await service.close();
  });

  it("records a safe protocol failure instead of publishing invalid model JSON or retrying the turn", async () => {
    const { service, store, agent, deliver } = harness();
    agent.reply.mockResolvedValueOnce('{"message":"secret-sentinel",');
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const delivered = deliver();
    await delivered.completion;
    expect(agent.reply).toHaveBeenCalledOnce();
    expect(delivered.replyText.mock.calls.flat().join(" ")).not.toContain("secret-sentinel");
    expect(store.load().transcript.at(-1)).toMatchObject({
      status: "agent_failed", replyFailure: "main_reply_invalid_json",
    });
    expect(store.load().transcript.at(-1)).not.toHaveProperty("businessResult");
    await service.close();
  });

  it("sends only the structured main reply message and persists its empty business results", async () => {
    const { service, store, agent, deliver } = harness();
    agent.reply.mockResolvedValueOnce(JSON.stringify({ message: "你好。", results: [] }));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const delivered = deliver({ text: "你好" });
    await delivered.completion;
    expect(delivered.replyText).toHaveBeenLastCalledWith("你好。");
    expect(store.load().transcript.at(-1)).toMatchObject({
      accountId: "bot@im.bot", target: "owner@im.wechat", text: "你好。",
      businessResult: { version: 1, source: "main_model", inboundKey: "a".repeat(64), results: [] },
    });
    expect(agent.reply.mock.calls[0]?.[4]).toMatchObject({ outputSchema: { type: "object" } });
    await service.close();
  });

  it("uses the workflow receipt as the only reply when the main Codex turn claims a domain tool", async () => {
    const onAccepted = vi.fn();
    const binding = {
      promptLines: ["scoperef_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: Demo Vault（可读、不可写）"],
      snapshot: vi.fn(() => ({
        owner: "workflow" as const,
        turnId: "turn-1",
        receipt: {
          outcome: "accepted" as const,
          reply: "文件已发送，请查收。",
          runRef: "run-ref-1",
          onAccepted,
        },
      })),
      seal: () => {},
      drain: async () => {},
      release: vi.fn(async () => {}),
    };
    const workflowTools: WorkflowTurnToolControl = { bind: vi.fn(() => binding) };
    const oldWorkflow: InboundWorkflowControl = {
      tryHandle: vi.fn(async () => ({ handled: true, outcome: "succeeded" as const, reply: "旧 Planner 回复" })),
    };
    const { service, agent, deliver } = harness(
      undefined,
      undefined,
      undefined,
      oldWorkflow,
      undefined,
      workflowTools,
    );
    agent.reply.mockResolvedValueOnce("模型协议收尾文本，不应发送给用户。");
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const delivered = deliver({
      text: "把 demo 原文件发给我",
      startTyping: vi.fn(async () => ({ active: true as const, stop: vi.fn(async () => {}) })),
    });
    await delivered.completion;

    expect(workflowTools.bind).toHaveBeenCalledWith(
      "019fef94-7da4-75a2-b9fb-226af024ddcd",
      expect.objectContaining({ text: "把 demo 原文件发给我" }),
    );
    expect(oldWorkflow.tryHandle).not.toHaveBeenCalled();
    const prompt = JSON.stringify(agent.reply.mock.calls[0]?.[1]);
    expect(prompt).toContain(binding.promptLines[0]);
    expect(prompt).toContain("本地文件的查找、正文搜索、读取、创建和修改必须使用 files 工具");
    expect(prompt).toContain("本地图片");
    expect(prompt).toContain("media.send");
    expect(prompt).toContain("非图片文件");
    expect(prompt).toContain("weixin.send_files");
    expect(delivered.replyText).toHaveBeenCalledTimes(1);
    expect(delivered.replyText).toHaveBeenCalledWith("文件已发送，请查收。");
    expect(onAccepted).toHaveBeenCalledOnce();
    expect(binding.release).toHaveBeenCalledOnce();
    await service.close();
  });

  it("keeps the workflow receipt as reply owner when the model turn fails after the tool effect", async () => {
    const binding = {
      snapshot: vi.fn(() => ({
        owner: "workflow" as const,
        turnId: "turn-1",
        receipt: {
          outcome: "accepted" as const,
          reply: "图片已发送，请查收。",
          runRef: "run-ref-1",
        },
      })),
      seal: () => {},
      drain: async () => {},
      release: vi.fn(async () => {}),
    };
    const workflowTools: WorkflowTurnToolControl = { bind: vi.fn(() => binding) };
    const { service, agent, deliver } = harness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workflowTools,
    );
    agent.reply.mockRejectedValueOnce(new Error("model failed after tool result"));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const delivered = deliver({
      text: "把图片发给我",
      startTyping: vi.fn(async () => ({ active: true as const, stop: vi.fn(async () => {}) })),
    });
    await delivered.completion;

    expect(delivered.replyText).toHaveBeenCalledTimes(1);
    expect(delivered.replyText).toHaveBeenCalledWith("图片已发送，请查收。");
    expect(binding.release).toHaveBeenCalledOnce();
    await service.close();
  });

  it("pending_deterministic_fast_path_uses_zero_app_server_turns", async () => {
    const binding = {
      snapshot: vi.fn(() => ({ owner: "model" as const })),
      seal: () => {},
      drain: async () => {},
      release: vi.fn(async () => {}),
    };
    const workflowTools: WorkflowTurnToolControl = { bind: vi.fn(() => binding) };
    const signal = vi.fn(async () => ({ runId: "run-pending", duplicate: false }));
    const pending = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [{
          runId: "run-pending",
          signalRef: "workflow-input:run-pending:choose",
          stepId: "choose",
          revision: 2,
          expiresAt: 1_723_456_889_000,
          candidates: ["first.png", "second.png"],
        }],
        signal,
        get: () => ({
          runId: "run-pending", source: "weixin", triggerId: "original", occurredAt: 1,
          status: "succeeded", revision: 3, createdAt: 1, updatedAt: 2,
        }),
      },
      pendingPresentations: {
        get: () => ({
          accountRef: "bot@im.bot", targetRef: "owner@im.wechat", runId: "run-pending",
          signalRef: "workflow-input:run-pending:choose", revision: 2,
          requestTextHash: "hash", expiresAt: 1_723_456_889_000, acceptedAt: 1_723_456_788_000,
        }),
        put: vi.fn(),
      },
      now: () => 1_723_456_789_000,
    });
    const { service, agent, deliver } = harness(
      undefined,
      undefined,
      undefined,
      pending,
      undefined,
      workflowTools,
    );
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const delivered = deliver({
      text: "2",
      startTyping: vi.fn(async () => ({ active: true as const, stop: vi.fn(async () => {}) })),
    });
    await delivered.completion;

    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      signalRef: "workflow-input:run-pending:choose",
      selection: "second.png",
    }));
    expect(agent.reply).not.toHaveBeenCalled();
    expect(workflowTools.bind).not.toHaveBeenCalled();
    expect(delivered.replyText).toHaveBeenCalledWith("工作流已完成。");
    await service.close();
  });

  it("pending_new_goal_supersedes_before_main_turn", async () => {
    const order: string[] = [];
    let pendingActive = true;
    const inboundWorkflows = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => pendingActive ? [{
          runId: "run-old",
          signalRef: "workflow-input:run-old:choose",
          stepId: "choose",
          revision: 2,
          expiresAt: 1_723_456_889_000,
          candidates: ["old.png", "other.png"],
        }] : [],
        supersedePendingSignals: () => {
          order.push("pending-superseded");
          pendingActive = false;
          return ["run-old"];
        },
        signal: vi.fn(),
        get: () => undefined,
      },
      pendingResponseRouter: {
        route: async () => ({ kind: "new_goal", goal: "查询今天的天气" }),
      },
      now: () => 1_723_456_789_000,
    });
    const workflowTools: WorkflowTurnToolControl = {
      bind: vi.fn(() => ({ seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" as const }), release: vi.fn(async () => {}) })),
    };
    const { service, agent, deliver } = harness(
      undefined,
      undefined,
      undefined,
      inboundWorkflows,
      undefined,
      workflowTools,
    );
    agent.reply.mockImplementationOnce(async () => {
      order.push("main-turn-started");
      return modelReply("今天天气不错。");
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    await deliver({
      text: "查询今天的天气",
      startTyping: vi.fn(async () => ({ active: true as const, stop: vi.fn(async () => {}) })),
    }).completion;

    expect(order).toEqual(["pending-superseded", "main-turn-started"]);
    expect(agent.reply).toHaveBeenCalledOnce();
    await service.close();
  });

  it("access_context_and_legacy_run_regression: starts a new thread when the model-visible contract changes", async () => {
    const workflowTools: WorkflowTurnToolControl = {
      contractHash: () => "f".repeat(64),
      bind: vi.fn(() => ({ seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" as const }), release: vi.fn(async () => {}) })),
    };
    const { service, agent } = harness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workflowTools,
      (store) => store.save({
        ...store.load(),
        targetSessions: [{
          accountId: "bot@im.bot",
          target: "owner@im.wechat",
          threadId: "019fef94-7da4-75a2-b9fb-226af024ddcd",
          threadProfile: "native-relay-v2",
          toolContractHash: "e".repeat(64),
        }],
        enabledTargets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }],
      }),
    );

    await service.start();

    expect(agent.startOrResume).toHaveBeenCalledWith(undefined, "/workspace", ["/workspace"]);
    await service.close();
  });

  it("access_context_and_legacy_run_regression: keeps the thread when non-file permissions change", async () => {
    const toolContractHash = "f".repeat(64);
    const workflowTools: WorkflowTurnToolControl = {
      contractHash: () => toolContractHash,
      bind: vi.fn(() => ({ seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" as const }), release: vi.fn(async () => {}) })),
    };
    const savedThreadId = "019fef94-7da4-75a2-b9fb-226af024ddcd";
    const { service, agent } = harness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workflowTools,
      (store) => {
        const current = store.load();
        store.save({
          ...current,
          permissions: {
            ...current.permissions,
            revision: current.permissions.revision + 1,
          },
          targetSessions: [{
            accountId: "bot@im.bot",
            target: "owner@im.wechat",
            threadId: savedThreadId,
            threadProfile: "native-relay-v2",
            toolContractHash,
          }],
          enabledTargets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }],
        });
      },
    );

    await service.start();

    expect(agent.startOrResume).toHaveBeenCalledWith(savedThreadId, "/workspace", ["/workspace"]);
    await service.close();
  });

  it("access_context_and_legacy_run_regression: rotates the thread after file read access narrows", async () => {
    const toolContractHash = "f".repeat(64);
    const workflowTools: WorkflowTurnToolControl = {
      contractHash: () => toolContractHash,
      bind: vi.fn(() => ({ seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" as const }), release: vi.fn(async () => {}) })),
    };
    const savedThreadId = "019fef94-7da4-75a2-b9fb-226af024ddee";
    const { service, agent, store } = harness(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workflowTools,
      (targetStore) => {
        const current = targetStore.load();
        targetStore.save({
          ...current,
          accessContextEpoch: 0,
          targetSessions: [{
            accountId: "bot@im.bot",
            target: "owner@im.wechat",
            threadId: savedThreadId,
            threadProfile: "native-relay-v2",
            toolContractHash,
            accessContextEpoch: 0,
          }],
          enabledTargets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }],
        });
      },
    );

    service.narrowFileAccessContext();
    await service.start();

    expect(agent.startOrResume).toHaveBeenCalledWith(undefined, "/workspace", ["/workspace"]);
    expect(store.load()).toMatchObject({
      accessContextEpoch: 1,
      targetSessions: [{ accessContextEpoch: 1 }],
    });
    await service.close();
  });

  it("production_contract_and_access_rotation_regression: rotates incompatible threads and requests memory again (service boundary test)", async () => {
    const contractHash = "f".repeat(64);
    const pendingSignal = {
      runId: "run-persisted",
      signalRef: "workflow-input:run-persisted:choose",
      stepId: "choose",
      revision: 2,
      expiresAt: 1_723_456_889_000,
      candidates: ["first.md", "second.md"],
    };
    const listPendingSignals = vi.fn(() => [pendingSignal]);
    const supersedePendingSignals = vi.fn(() => [] as string[]);
    const inboundWorkflows = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals,
        supersedePendingSignals,
        signal: vi.fn(),
        get: (runId) => runId === pendingSignal.runId ? ({
          runId,
          source: "weixin",
          triggerId: "persisted-trigger",
          occurredAt: 1,
          status: "needs_input",
          revision: 2,
          createdAt: 1,
          updatedAt: 2,
        }) : undefined,
      },
      now: () => 1_723_456_789_000,
    });
    const workflowTools: WorkflowTurnToolControl = {
      contractHash: () => contractHash,
      bind: vi.fn(() => ({ seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" as const }), release: vi.fn(async () => {}) })),
    };
    const memory = {
      start: vi.fn(async () => {}),
      registerAccount: vi.fn(),
      enable: vi.fn(),
      disable: vi.fn(),
      captureTurn: vi.fn(async () => ({ queued: false })),
      recall: vi.fn(() => "持久记忆：默认使用 pnpm。"),
      close: vi.fn(),
    };
    const savedThreadId = "019fef94-7da4-75a2-b9fb-226af024ddcd";
    const { service, agent, store, deliver } = harness(
      memory,
      undefined,
      undefined,
      inboundWorkflows,
      undefined,
      workflowTools,
      (targetStore) => targetStore.save({
        ...targetStore.load(),
        accessContextEpoch: 0,
        targetSessions: [{
          accountId: "bot@im.bot",
          target: "owner@im.wechat",
          threadId: savedThreadId,
          threadProfile: "native-relay-v2",
          toolContractHash: "e".repeat(64),
          accessContextEpoch: 0,
        }],
        enabledTargets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }],
      }),
    );

    await service.start();
    expect(agent.startOrResume).toHaveBeenNthCalledWith(1, undefined, "/workspace", ["/workspace"]);
    service.narrowFileAccessContext();
    await deliver({
      key: "b".repeat(64),
      text: "继续当前讨论",
      startTyping: vi.fn(async () => ({ active: true as const, stop: vi.fn(async () => {}) })),
    }).completion;

    expect(agent.startOrResume).toHaveBeenNthCalledWith(2, undefined, "/workspace", ["/workspace"]);
    expect(JSON.stringify(agent.reply.mock.calls.at(-1)?.[1])).toContain("持久记忆：默认使用 pnpm。");
    expect(memory.recall).toHaveBeenCalledWith("bot@im.bot", "继续当前讨论");
    expect(supersedePendingSignals).not.toHaveBeenCalled();
    expect(store.load()).toMatchObject({
      accessContextEpoch: 1,
      targetSessions: [{ toolContractHash: contractHash, accessContextEpoch: 1 }],
    });
    await service.close();
  });

  it("notifies a shadow observer only after the user reply path has completed and isolates observer errors", async () => {
    let replyFinished = false;
    const completedInboundObserver: CompletedInboundObserver = {
      observe: vi.fn(() => {
        expect(replyFinished).toBe(true);
        throw new Error("shadow unavailable");
      }),
    };
    const { service, deliver } = harness(undefined, undefined, undefined, undefined, completedInboundObserver);
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const delivered = deliver({
      replyText: vi.fn(async () => {
        replyFinished = true;
        return { ok: true as const, messageId: "sent" };
      }),
    });
    await expect(delivered.completion).resolves.toBeUndefined();
    await vi.waitFor(() => expect(completedInboundObserver.observe).toHaveBeenCalledOnce());

    await service.close();
  });

  it("holds completed shadow observations until all user work queues are idle", async () => {
    const completedInboundObserver: CompletedInboundObserver = { observe: vi.fn() };
    const { service, agent, deliver } = harness(undefined, undefined, undefined, undefined, completedInboundObserver);
    let finishFirst!: (reply: string) => void;
    let finishSecond!: (reply: string) => void;
    agent.reply
      .mockImplementationOnce(async () => await new Promise<string>((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(async () => await new Promise<string>((resolve) => { finishSecond = resolve; }));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    await service.enable("bot@im.bot", "second@im.wechat");

    const first = deliver({ key: "1".repeat(64), messageId: "message-1" });
    const second = deliver({
      key: "2".repeat(64), messageId: "message-2", target: "second@im.wechat",
    });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(2));
    finishFirst(modelReply("first"));
    await first.completion;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(completedInboundObserver.observe).not.toHaveBeenCalled();

    finishSecond(modelReply("second"));
    await second.completion;
    await vi.waitFor(() => expect(completedInboundObserver.observe).toHaveBeenCalledTimes(2));
    expect(completedInboundObserver.observe).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: "1".repeat(64) }));
    expect(completedInboundObserver.observe).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: "2".repeat(64) }));

    await service.close();
  });

  it("lets an inbound workflow own an explicit note request without also invoking Codex", async () => {
    const onAccepted = vi.fn();
    const inboundWorkflows: InboundWorkflowControl = {
      tryHandle: vi.fn(async () => ({
        handled: true as const,
        outcome: "succeeded" as const,
        reply: "找到 1 篇笔记：\n1. demo.md",
        onAccepted,
      })),
    };
    const { service, agent, deliver } = harness(undefined, undefined, undefined, inboundWorkflows);
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const { replyText, completion } = deliver({ text: "搜索笔记 project" });
    await completion;

    expect(inboundWorkflows.tryHandle).toHaveBeenCalledOnce();
    expect(agent.reply).not.toHaveBeenCalled();
    expect(replyText).toHaveBeenCalledWith("找到 1 篇笔记：\n1. demo.md");
    expect(onAccepted).toHaveBeenCalledOnce();
    await service.close();
  });

  it("persists and exposes sanitized Planner stage diagnostics on the inbound runtime", async () => {
    const diagnostic = {
      attempt: 1 as const,
      generation: 1 as const,
      phase: "initial" as const,
      stage: "turn_accepted" as const,
      startedAt: 1_723_456_789_010,
      completedAt: 1_723_456_789_020,
      durationMs: 10,
      outcome: "completed" as const,
    };
    const inboundWorkflows: InboundWorkflowControl = {
      tryHandle: vi.fn(async () => ({
        handled: true as const,
        outcome: "failed" as const,
        reply: "请求理解超时，尚未开始查找或发送任何内容，请稍后重试。",
        plannerDiagnostics: [diagnostic],
      })),
    };
    const { service, deliver } = harness(undefined, undefined, undefined, inboundWorkflows);
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    await deliver({ text: "把 Pictures 里的王林图片发给我" }).completion;

    expect(service.getPublicState().runs[0]?.workflowPlannerDiagnostics).toEqual([diagnostic]);
    await service.close();
  });

  it("does not accept pending presentation metadata when the workflow prompt is not channel-accepted", async () => {
    const onAccepted = vi.fn();
    const inboundWorkflows: InboundWorkflowControl = {
      tryHandle: vi.fn(async () => ({
        handled: true as const,
        outcome: "needs_input" as const,
        reply: "请选择：\n1. demo.md",
        onAccepted,
      })),
    };
    const { service, deliver } = harness(undefined, undefined, undefined, inboundWorkflows);
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const { completion } = deliver({
      text: "发送 demo 原文件",
      replyText: vi.fn(async () => ({ ok: false as const, reason: "rejected" as const })),
    });
    await completion;

    expect(onAccepted).not.toHaveBeenCalled();
    await service.close();
  });

  it("keeps durable delivery pending until processing finishes without reserving a new processed key", async () => {
    const { service, store, agent, deliver } = harness();
    let finishReply!: (value: string) => void;
    agent.reply.mockImplementationOnce(() => new Promise<string>((resolve) => { finishReply = resolve; }));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const key = "9".repeat(64);
    const { completion } = deliver({ key, text: "持久处理" });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledOnce());

    expect(store.load().processedKeys).not.toContain(key);
    expect(await Promise.race([completion.then(() => "completed"), Promise.resolve("pending")])).toBe("pending");

    finishReply(modelReply("处理完成"));
    await expect(completion).resolves.toBeUndefined();
    await service.close();
  });

  it("freezes the account model when inbound enters the queue and applies changes to the next message", async () => {
    const { service, store, agent, emit } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({ key: "1".repeat(64) });
    service.configureChatModel("bot@im.bot", { mode: "track", track: "quality", effort: "medium" });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(1));
    expect(agent.reply.mock.calls[0]?.[4]).toMatchObject({ model: "gpt-5.6-luna", effort: "low", outputSchema: { type: "object" } });

    emit({ key: "2".repeat(64), messageId: "message-2" });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(2));
    expect(agent.reply.mock.calls[1]?.[4]).toMatchObject({ model: "gpt-5.6-sol", effort: "medium", outputSchema: { type: "object" } });
    expect(service.getPublicState().runs[0]).toMatchObject({ model: "gpt-5.6-sol", reasoningEffort: "medium", modelSelectionSource: "track", modelConfigRevision: 1 });
    expect(store.load()).toMatchObject({ version: 7, modelSettings: [{ accountId: "bot@im.bot", selection: { mode: "track", track: "quality", effort: "medium" }, revision: 1 }] });
    await service.close();
  });

  it("registers every connected account at startup and again before processing inbound", async () => {
    const memory = {
      start: vi.fn(async () => {}), registerAccount: vi.fn(), enable: vi.fn(), disable: vi.fn(),
      captureTurn: vi.fn(async () => ({ queued: true })), recall: vi.fn(() => ""), close: vi.fn(),
    };
    const { service, emit } = harness(memory);
    await service.start();

    expect(memory.registerAccount).toHaveBeenCalledWith("bot@im.bot");
    await service.enable("bot@im.bot", "owner@im.wechat");
    emit();
    await vi.waitFor(() => expect(memory.registerAccount).toHaveBeenCalledTimes(2));
    await service.close();
  });

  it("confirms only a discovered target for proactive account reminders", async () => {
    const memory = {
      start: vi.fn(async () => {}), enable: vi.fn(), disable: vi.fn(),
      confirmNotificationTarget: vi.fn(),
      captureTurn: vi.fn(async () => ({ queued: true })), recall: vi.fn(() => ""), close: vi.fn(),
    };
    const { service } = harness(memory);
    await service.start();

    service.confirmMemoryNotificationTarget("bot@im.bot", "owner@im.wechat");
    expect(memory.confirmNotificationTarget).toHaveBeenCalledWith("bot@im.bot", "owner@im.wechat");
    expect(() => service.confirmMemoryNotificationTarget("bot@im.bot", "unknown@im.wechat"))
      .toThrow("只能选择已发现的微信入站目标作为计划提醒接收人");
    await service.close();
  });

  it("keeps the background memory implementation out of the user-visible reply", async () => {
    const memory = {
      start: vi.fn(async () => {}), enable: vi.fn(), disable: vi.fn(),
      captureTurn: vi.fn(async () => ({ queued: true, jobId: "job-1" })),
      recall: vi.fn(() => ""), close: vi.fn(),
    };
    const { service, agent, emit } = harness(memory);
    agent.reply.mockImplementation(async (...args: Parameters<ScriptedModelReply>) => {
      const [, input] = args;
      const prompt = typeof input === "string" ? input : input.find((item) => item.type === "text")?.text ?? "";
      return modelReply(prompt.includes("交给后台 Curator")
        ? "我会在本轮回复后交给后台 Curator 尝试处理。"
        : "好的，我会按这个偏好处理。");
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    service.enableMemory("bot@im.bot");

    const replyText = emit({ text: "请记住我偏好简洁回复" });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    const finalReply = String(replyText.mock.calls[1]?.[0] ?? "");
    expect(finalReply).not.toMatch(/Curator|后台.*记忆|记忆.*面板/u);
    await service.close();
  });

  it("injects account memory and captures the completed turn with target only for reminder correlation", async () => {
    const memory = {
      start: vi.fn(async () => {}),
      enable: vi.fn(),
      disable: vi.fn(),
      captureTurn: vi.fn(async (turn: unknown) => { void turn; return { queued: true, jobId: "job-1" }; }),
      recall: vi.fn(() => "# Long-term Memory\n\n## Preferences\n\n- 使用 pnpm。\n"),
      close: vi.fn(),
    };
    const { service, agent, emit } = harness(memory);
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    service.enableMemory("bot@im.bot");

    const replyText = emit({ key: "b".repeat(64), text: "继续项目" });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(memory.captureTurn).toHaveBeenCalledTimes(1));

    expect(agent.prompts.at(-1)).toContain("<account-memory>");
    expect(agent.prompts.at(-1)).toContain("使用 pnpm");
    expect(agent.prompts.at(-1)).toContain("不得声称“已持久化”");
    expect(agent.prompts.at(-1)).toContain("不得解释任何内部处理机制、后台任务、管理面板或落盘流程");
    expect(agent.prompts.at(-1)).not.toContain("Curator");
    expect(memory.recall).toHaveBeenCalledWith("bot@im.bot", "继续项目");
    expect(memory.captureTurn).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      userEntry: expect.objectContaining({ text: "继续项目" }),
      assistantEntry: expect.objectContaining({ text: "你好，我收到了。", status: "accepted" }),
    }));
    await service.close();
  });

  it("captures the terminal turn when Codex fails so the user decision is still reviewed", async () => {
    const memory = {
      start: vi.fn(async () => {}), enable: vi.fn(), disable: vi.fn(),
      captureTurn: vi.fn(async () => ({ queued: true, jobId: "job-failed" })),
      recall: vi.fn(() => ""), close: vi.fn(),
    };
    const { service, agent, emit } = harness(memory);
    agent.reply.mockRejectedValueOnce(new Error("agent unavailable"));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    service.enableMemory("bot@im.bot");

    const replyText = emit({ key: "f".repeat(64), text: "只在 Node.js 项目使用 pnpm" });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(memory.captureTurn).toHaveBeenCalledTimes(1));

    expect(memory.captureTurn).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "bot@im.bot",
      userEntry: expect.objectContaining({ text: "只在 Node.js 项目使用 pnpm" }),
      assistantEntry: expect.objectContaining({ status: "agent_failed" }),
    }));
    await service.close();
  });

  it("captures exactly one terminal turn when the final Weixin reply is not accepted", async () => {
    const memory = {
      start: vi.fn(async () => {}), enable: vi.fn(), disable: vi.fn(),
      captureTurn: vi.fn(async () => ({ queued: true, jobId: "job-send-failed" })),
      recall: vi.fn(() => ""), close: vi.fn(),
    };
    const { service, emit } = harness(memory);
    const replyText = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, messageId: "ack" })
      .mockResolvedValueOnce({ ok: false as const, reason: "unknown" as const });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    service.enableMemory("bot@im.bot");

    emit({ key: "d".repeat(64), text: "默认使用 pnpm", replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(memory.captureTurn).toHaveBeenCalledTimes(1));

    expect(memory.captureTurn).toHaveBeenCalledWith(expect.objectContaining({
      userEntry: expect.objectContaining({ text: "默认使用 pnpm" }),
      assistantEntry: expect.objectContaining({ status: "send_failed" }),
    }));
    await service.close();
  });

  it("can retry startup after account memory initialization fails", async () => {
    const memory = {
      start: vi.fn()
        .mockRejectedValueOnce(new Error("memory state unavailable"))
        .mockResolvedValueOnce(undefined),
      enable: vi.fn(),
      disable: vi.fn(),
      captureTurn: vi.fn(async (turn: unknown) => { void turn; return { queued: false }; }),
      recall: vi.fn(() => ""),
      close: vi.fn(),
    };
    const { service } = harness(memory);

    await expect(service.start()).rejects.toThrow("memory state unavailable");
    await expect(service.start()).resolves.toBeUndefined();
    expect(memory.start).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it("rejects enabling memory for an account that has not been discovered", async () => {
    const { service } = harness();
    await service.start();

    expect(() => service.enableMemory("unknown@im.bot")).toThrow("只能为已连接的微信账户启用记忆");
    await service.close();
  });

  it("opens only the selected target's private managed thread in Codex Desktop", async () => {
    const { service, desktop } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    await service.openInCodexDesktop("bot@im.bot", "owner@im.wechat");

    expect(desktop.openThread).toHaveBeenCalledWith("019fef94-7da4-75a2-b9fb-226af024ddcd");
    expect(JSON.stringify(service.getPublicState())).not.toContain("019fef94");
    await service.close();
  });

  it("does not invoke Desktop for an unknown or uninitialized target", async () => {
    const { service, desktop } = harness();

    await expect(service.openInCodexDesktop("bot@im.bot", "owner@im.wechat"))
      .rejects.toThrow("尚未建立 Codex 任务");
    await expect(service.openInCodexDesktop("bot@im.bot", "unknown@im.wechat"))
      .rejects.toThrow("尚未建立 Codex 任务");
    expect(desktop.openThread).not.toHaveBeenCalled();
    await service.close();
  });

  it("handles /echo directly with channel timing and skips acknowledgement and Codex", async () => {
    const memory = {
      start: vi.fn(async () => {}), enable: vi.fn(), disable: vi.fn(),
      captureTurn: vi.fn(async () => ({ queued: true, jobId: "unexpected" })),
      recall: vi.fn(() => ""), close: vi.fn(),
    };
    const { service, agent, emit } = harness(memory);
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    service.enableMemory("bot@im.bot");

    const replyText = emit({ key: "0".repeat(64), text: "/echo hello" });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(replyText).toHaveBeenNthCalledWith(1, "hello");
    expect(replyText.mock.calls[1]?.[0]).toBe([
      "⏱ 通道耗时",
      "├ 事件时间: 2024-08-12T09:59:48.000Z",
      "├ 平台→Demo: 1000ms",
      "└ Demo 处理: 0ms",
    ].join("\n"));
    expect(agent.reply).not.toHaveBeenCalled();
    expect(memory.captureTurn).not.toHaveBeenCalled();
    expect(service.getPublicState().runs[0]?.timings.filter((timing) => timing.stage === "outbound"))
      .toHaveLength(2);
    await service.close();
  });

  it("reports one fixed failure when echo payload is not channel-accepted", async () => {
    const { service, agent, emit } = harness();
    const replyText = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "unknown" as const })
      .mockResolvedValueOnce({ ok: true as const, messageId: "failure-notice" });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({ key: "e".repeat(64), text: "/echo hello", replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(replyText).toHaveBeenNthCalledWith(1, "hello");
    expect(replyText).toHaveBeenNthCalledWith(2, "我暂时无法处理这条消息，请稍后再发一条新消息。");
    expect(agent.reply).not.toHaveBeenCalled();
    await service.close();
  });

  it("persists the inbound job, sends an acknowledgement, then sends the final reply", async () => {
    const { service, emit } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const replyText = emit({ key: "9".repeat(64) });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));
    expect(replyText).toHaveBeenNthCalledWith(1, "已收到，正在处理。");
    expect(replyText).toHaveBeenNthCalledWith(2, "你好，我收到了。");
    await service.close();
  });

  it("starts the final reply without waiting for native typing to stop", async () => {
    const { service, agent, emit } = harness();
    const order: string[] = [];
    let resolveStop!: () => void;
    const stopPending = new Promise<void>((resolve) => { resolveStop = resolve; });
    const startTyping = vi.fn(async () => {
      order.push("typing:start");
      return {
        active: true,
        stop: vi.fn(async () => {
          order.push("typing:stop:start");
          await stopPending;
          order.push("typing:stop:end");
        }),
      };
    });
    agent.reply.mockImplementationOnce(async () => {
      order.push("codex");
      return modelReply("完成");
    });
    const replyText = vi.fn(async (message: string) => {
      order.push(`reply:${message}`);
      return { ok: true as const, messageId: "sent" };
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({ key: "1".repeat(64), startTyping, replyText });
    await vi.waitFor(() => expect(order).toContain("typing:stop:start"));
    let replyStartedBeforeStopCompleted = false;
    try {
      await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("完成"), { timeout: 50 });
      replyStartedBeforeStopCompleted = true;
    } catch {
      // The assertion below is the red-capable signal; first release the pending cleanup.
    }
    resolveStop();
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("完成"));

    expect(replyStartedBeforeStopCompleted).toBe(true);
    expect(replyText).toHaveBeenCalledTimes(1);
    expect(startTyping).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      "typing:start",
      "codex",
      "typing:stop:start",
      "reply:完成",
      "typing:stop:end",
    ]);
    await service.close();
  });

  it("records overlapping typing stop and outbound durations independently", async () => {
    let clock = 1_723_456_789_000;
    let resolveStop!: () => void;
    const stopPending = new Promise<void>((resolve) => { resolveStop = resolve; });
    const { service, emit } = harness(undefined, () => clock);
    const startTyping = vi.fn(async () => ({
      active: true,
      stop: vi.fn(async () => { await stopPending; }),
    }));
    const replyText = vi.fn(async () => {
      clock += 7;
      return { ok: true as const, messageId: "sent" };
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({ key: "a".repeat(64), startTyping, replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("你好，我收到了。"));

    const activeTimings = service.getPublicState().runs[0]?.timings ?? [];
    expect(activeTimings).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "outbound", durationMs: 7, outcome: "completed" }),
    ]));
    expect(activeTimings.find((timing) => timing.stage === "typing_stop")?.completedAt)
      .toBeUndefined();
    clock += 100;
    resolveStop();
    await vi.waitFor(() => expect(service.getPublicState().runs[0]?.phase).toBe("completed"));
    expect(service.getPublicState().runs[0]?.timings).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "outbound", durationMs: 7, outcome: "completed" }),
      expect.objectContaining({ stage: "typing_stop", durationMs: 107, outcome: "completed" }),
    ]));
    await service.close();
  });

  it("persists each observable reply stage and its duration", async () => {
    let clock = 1_723_456_789_000;
    const { service, agent, emit } = harness(undefined, () => clock);
    const startTyping = vi.fn(async () => {
      clock += 10;
      return {
        active: true,
        diagnostics: {
          ticketCache: "hit" as const,
          getConfig: { durationMs: 0, outcome: "skipped" as const },
          sendStart: { durationMs: 10, outcome: "completed" as const },
        },
        stop: vi.fn(async () => { clock += 5; }),
      };
    });
    agent.reply.mockImplementationOnce(async (...args: Parameters<ScriptedModelReply>) => {
      const observer = args[3];
      observer?.({ kind: "turn_submitted" });
      clock += 4;
      observer?.({ kind: "turn_accepted" });
      clock += 6;
      observer?.({ kind: "model_activity", activity: "reasoning" });
      observer?.({ kind: "reasoning", itemId: "reasoning-1", phase: "start" });
      clock += 10;
      observer?.({ kind: "reasoning", itemId: "reasoning-1", phase: "end" });
      clock += 1;
      observer?.({ kind: "model_activity", activity: "tool" });
      observer?.({ kind: "tool", itemId: "tool-1", label: "执行本地命令", phase: "start" });
      clock += 8;
      observer?.({ kind: "tool", itemId: "tool-1", label: "执行本地命令", phase: "end", status: "completed" });
      clock += 5;
      observer?.({ kind: "model_activity", activity: "reasoning" });
      observer?.({ kind: "reasoning", itemId: "reasoning-2", phase: "start" });
      clock += 9;
      observer?.({ kind: "reasoning", itemId: "reasoning-2", phase: "end" });
      clock += 2;
      observer?.({ kind: "model_activity", activity: "agent_message" });
      observer?.({ kind: "agent_message_delta" });
      clock += 7;
      observer?.({ kind: "turn_completed", status: "completed" });
      return modelReply("完成");
    });
    const replyText = vi.fn(async () => {
      clock += 7;
      return {
        ok: true as const,
        messageId: "sent",
        diagnostics: {
          prepare: { durationMs: 1, outcome: "completed" as const },
          sendMessage: { durationMs: 4, outcome: "completed" as const },
          responseRead: { durationMs: 1, outcome: "completed" as const },
          stateSave: { durationMs: 1, outcome: "completed" as const },
          requestCount: 1,
        },
      };
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({
      key: "6".repeat(64),
      observedAt: clock - 5,
      startTyping,
      replyText,
    });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("完成"));

    expect(service.getPublicState().runs).toEqual([
      expect.objectContaining({
        phase: "completed",
        totalDurationMs: 79,
        typingDiagnostics: {
          ticketCache: "hit",
          getConfig: { durationMs: 0, outcome: "skipped" },
          sendStart: { durationMs: 10, outcome: "completed" },
        },
        outboundDiagnostics: {
          prepare: { durationMs: 1, outcome: "completed" },
          sendMessage: { durationMs: 4, outcome: "completed" },
          responseRead: { durationMs: 1, outcome: "completed" },
          stateSave: { durationMs: 1, outcome: "completed" },
          requestCount: 1,
        },
        timings: [
          expect.objectContaining({ stage: "inbound", durationMs: 5, outcome: "completed" }),
          expect.objectContaining({ stage: "queue", durationMs: 0, outcome: "completed" }),
          expect.objectContaining({ stage: "typing_start", durationMs: 10, outcome: "completed" }),
          expect.objectContaining({ stage: "agent", durationMs: 52, outcome: "completed" }),
          expect.objectContaining({ stage: "typing_stop", durationMs: 12, outcome: "completed" }),
          expect.objectContaining({ stage: "outbound", durationMs: 7, outcome: "completed" }),
        ],
        agentTimings: [
          expect.objectContaining({ stage: "app_server_prepare", durationMs: 4, outcome: "completed" }),
          expect.objectContaining({ stage: "first_model_wait", durationMs: 6, outcome: "completed" }),
          expect.objectContaining({ stage: "model_reasoning", durationMs: 10, outcome: "completed" }),
          expect.objectContaining({ stage: "tool_execution", label: "执行本地命令", durationMs: 8, outcome: "completed" }),
          expect.objectContaining({ stage: "tool_result_wait", durationMs: 5, outcome: "completed" }),
          expect.objectContaining({ stage: "model_reasoning", durationMs: 9, outcome: "completed" }),
          expect.objectContaining({ stage: "final_generation", durationMs: 7, outcome: "completed" }),
        ],
        agentTimingsTruncated: false,
      }),
    ]);
    await service.close();
  });

  it("closes observable Codex stages when an agent adapter returns without a terminal event", async () => {
    let clock = 1_723_456_789_000;
    const { service, agent, emit } = harness(undefined, () => clock);
    agent.reply.mockImplementationOnce(async (...args: Parameters<ScriptedModelReply>) => {
      const observer = args[3];
      observer?.({ kind: "turn_submitted" });
      clock += 4;
      observer?.({ kind: "turn_accepted" });
      clock += 6;
      observer?.({ kind: "model_activity", activity: "agent_message" });
      observer?.({ kind: "agent_message_delta" });
      clock += 7;
      return modelReply("完成");
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const replyText = emit({ key: "b".repeat(64) });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("完成"));

    expect(service.getPublicState().runs[0]?.agentTimings).toEqual([
      expect.objectContaining({ stage: "app_server_prepare", durationMs: 4, outcome: "completed" }),
      expect.objectContaining({ stage: "first_model_wait", durationMs: 6, outcome: "completed" }),
      expect.objectContaining({ stage: "final_generation", durationMs: 7, outcome: "completed" }),
    ]);
    await service.close();
  });

  it("waits for every parallel tool before starting the tool-result wait stage", async () => {
    let clock = 1_723_456_789_000;
    const { service, agent, emit } = harness(undefined, () => clock);
    agent.reply.mockImplementationOnce(async (...args: Parameters<ScriptedModelReply>) => {
      const observer = args[3];
      observer?.({ kind: "turn_submitted" });
      observer?.({ kind: "turn_accepted" });
      observer?.({ kind: "model_activity", activity: "tool" });
      observer?.({ kind: "tool", itemId: "tool-1", label: "搜索网页", phase: "start" });
      clock += 2;
      observer?.({ kind: "tool", itemId: "tool-2", label: "调用 MCP 工具", phase: "start" });
      clock += 5;
      observer?.({ kind: "tool", itemId: "tool-1", label: "搜索网页", phase: "end", status: "completed" });
      clock += 2;
      observer?.({ kind: "tool", itemId: "tool-2", label: "调用 MCP 工具", phase: "end", status: "completed" });
      clock += 4;
      observer?.({ kind: "model_activity", activity: "agent_message" });
      observer?.({ kind: "agent_message_delta" });
      observer?.({ kind: "turn_completed", status: "completed" });
      return modelReply("完成");
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const replyText = emit({ key: "c".repeat(64) });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("完成"));

    const timings = service.getPublicState().runs[0]?.agentTimings ?? [];
    expect(timings.filter((timing) => timing.stage === "tool_execution")).toEqual([
      expect.objectContaining({ label: "搜索网页", durationMs: 7, outcome: "completed" }),
      expect.objectContaining({ label: "调用 MCP 工具", durationMs: 7, outcome: "completed" }),
    ]);
    expect(timings.filter((timing) => timing.stage === "tool_result_wait")).toEqual([
      expect.objectContaining({ durationMs: 4, outcome: "completed" }),
    ]);
    await service.close();
  });

  it("bounds persisted internal stages and reports truncation", async () => {
    const { service, agent, emit } = harness();
    agent.reply.mockImplementationOnce(async (...args: Parameters<ScriptedModelReply>) => {
      const observer = args[3];
      observer?.({ kind: "turn_submitted" });
      observer?.({ kind: "turn_accepted" });
      observer?.({ kind: "model_activity", activity: "reasoning" });
      for (let index = 0; index < 51; index += 1) {
        observer?.({ kind: "reasoning", itemId: `reasoning-${index}`, phase: "start" });
        observer?.({ kind: "reasoning", itemId: `reasoning-${index}`, phase: "end" });
      }
      observer?.({ kind: "model_activity", activity: "agent_message" });
      observer?.({ kind: "agent_message_delta" });
      observer?.({ kind: "turn_completed", status: "completed" });
      return modelReply("完成");
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const replyText = emit({ key: "f".repeat(64) });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("完成"));

    const run = service.getPublicState().runs[0]!;
    expect(run.agentTimings).toHaveLength(50);
    expect(run.agentTimingsTruncated).toBe(true);
    await service.close();
  });

  it("records acknowledgement timing when native typing is unavailable", async () => {
    let clock = 1_723_456_789_000;
    const { service, agent, emit } = harness(undefined, () => clock);
    const startTyping = vi.fn(async () => {
      clock += 3;
      return { active: false, stop: vi.fn(async () => {}) };
    });
    agent.reply.mockImplementationOnce(async () => {
      clock += 5;
      return modelReply("完成");
    });
    const replyText = vi.fn(async () => {
      clock += replyText.mock.calls.length === 1 ? 4 : 6;
      return { ok: true as const, messageId: "sent" };
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({ key: "7".repeat(64), observedAt: clock, startTyping, replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    const run = service.getPublicState().runs[0]!;
    expect(run.timings).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "typing_start", durationMs: 3, outcome: "unavailable" }),
      expect.objectContaining({ stage: "acknowledgement", durationMs: 4, outcome: "completed" }),
      expect.objectContaining({ stage: "agent", durationMs: 5, outcome: "completed" }),
      expect.objectContaining({ stage: "outbound", durationMs: 6, outcome: "completed" }),
    ]));
    await service.close();
  });

  it("marks typing stop as unknown when the channel request fails", async () => {
    const { service, emit } = harness();
    const startTyping = vi.fn(async () => ({
      active: true,
      stop: vi.fn(async () => { throw new Error("typing stop unavailable"); }),
    }));
    const replyText = vi.fn(async () => ({ ok: true as const, messageId: "sent" }));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({ key: "8".repeat(64), startTyping, replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("你好，我收到了。"));

    expect(service.getPublicState().runs[0]?.timings).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "typing_stop", outcome: "unknown" }),
    ]));
    await service.close();
  });

  it("closes an open timing as interrupted when the service recovers", async () => {
    const clock = 1_723_456_789_100;
    const initial = harness(undefined, () => clock);
    await initial.service.close();
    const state = initial.store.load();
    initial.store.save({
      ...state,
      runtimeRuns: [{
        accountId: "bot@im.bot",
        target: "owner@im.wechat",
        runId: "019fef94-7da4-75a2-b9fb-226af024ddce",
        phase: "thinking",
        queueDepth: 0,
        startedAt: clock - 100,
        updatedAt: clock - 50,
        recentSteps: [],
        timings: [{ stage: "agent", startedAt: clock - 50 }],
        agentTimings: [{ stage: "final_generation", startedAt: clock - 25 }],
        agentTimingsTruncated: false,
      }],
    });

    const recovered = new WeixinCodexService(
      initial.channel,
      initial.agent,
      initial.store,
      "/workspace",
      () => clock,
    );

    expect(recovered.getPublicState().runs[0]).toMatchObject({
      phase: "interrupted",
      completedAt: clock,
      timings: [{
        stage: "agent",
        startedAt: clock - 50,
        completedAt: clock,
        durationMs: 50,
        outcome: "interrupted",
      }],
      agentTimings: [{
        stage: "final_generation",
        startedAt: clock - 25,
        completedAt: clock,
        durationMs: 25,
        outcome: "interrupted",
      }],
    });
    await recovered.close();
  });

  it("forwards safe tool progress in order before stopping typing and sending the final reply", async () => {
    const { service, agent, emit } = harness();
    const order: string[] = [];
    const replyProgress = vi.fn(async (progress: { phase: string; label: string }) => {
      order.push(`progress:${progress.phase}:${progress.label}`);
      return { ok: true as const, messageId: "progress" };
    });
    agent.reply.mockImplementationOnce(async (...args) => {
      const observer = args[3];
      observer?.({ kind: "tool", itemId: "tool-1", label: "搜索网页", phase: "start" });
      observer?.({ kind: "tool", itemId: "tool-1", label: "搜索网页", phase: "end", status: "completed" });
      order.push("codex:done");
      return modelReply("已完成");
    });
    const startTyping = vi.fn(async () => ({
      active: true,
      stop: vi.fn(async () => { order.push("typing:stop"); }),
    }));
    const replyText = vi.fn(async (message: string) => {
      order.push(`reply:${message}`);
      return { ok: true as const, messageId: "sent" };
    });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({ key: "2".repeat(64), startTyping, replyProgress, replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("已完成"));

    expect(replyProgress).toHaveBeenCalledTimes(2);
    expect(replyProgress.mock.calls[0]?.[0]).toMatchObject({
      itemId: "tool-1",
      label: "搜索网页",
      phase: "start",
    });
    expect(replyProgress.mock.calls[1]?.[0]).toMatchObject({
      itemId: "tool-1",
      label: "搜索网页",
      phase: "end",
      status: "completed",
    });
    expect(order).toEqual([
      "codex:done",
      "progress:start:搜索网页",
      "progress:end:搜索网页",
      "typing:stop",
      "reply:已完成",
    ]);
    expect(service.getPublicState().runs).toEqual([
      expect.objectContaining({
        accountId: "bot@im.bot",
        target: "owner@im.wechat",
        phase: "completed",
        queueDepth: 0,
        recentSteps: [expect.objectContaining({ label: "搜索网页", status: "completed" })],
      }),
    ]);
    expect(JSON.stringify(service.getPublicState().runs)).not.toContain("tool-1");
    await service.close();
  });

  it("keeps a long Codex answer and records partial segmented delivery", async () => {
    const { service, store, agent, emit } = harness();
    agent.reply.mockResolvedValue(modelReply("答".repeat(2_000)));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const replyText = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, messageId: "ack" })
      .mockResolvedValueOnce({
        ok: false as const,
        messageIds: ["part-1"],
        totalSegments: 2,
        acceptedSegments: 1,
        truncated: false,
        retriedSegments: 1,
        duplicatePossible: false,
        reason: "rejected" as const,
      });

    emit({ key: "6".repeat(64), replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(replyText.mock.calls[1]?.[0]).toHaveLength(2_000);
    expect(store.load().transcript.at(-1)).toMatchObject({ status: "partial" });
    expect(service.getPublicState().notice).toMatch(/已接受 1\/2 段/);
    await service.close();
  });

  it("marks a voice transcript, acknowledges voice, and sends the raw transcript to Codex", async () => {
    const { service, store, agent, emit } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const replyText = emit({
      key: "8".repeat(64),
      source: "voice",
      text: "帮我列出 demo Vault 的文件",
    });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(replyText).toHaveBeenNthCalledWith(1, "已收到语音，正在处理。");
    expect(agent.prompts.at(-1)).toContain("用户通过语音说");
    expect(agent.prompts.at(-1)).toContain("帮我列出 demo Vault 的文件");
    expect(store.load().transcript[0]).toMatchObject({
      role: "user",
      text: "[语音转写] 帮我列出 demo Vault 的文件",
      status: "received",
    });
    await service.close();
  });

  it("passes images but never voice audio to Codex and names quoted files in text", async () => {
    const { service, agent, emit } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    emit({
      key: "5".repeat(64), source: "media", text: "分析这些内容",
      attachments: [
        { kind: "image", path: "/private/media/a.jpg", fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 12, quoted: false },
        { kind: "voice", path: "/private/media/a.silk", fileName: "a.silk", mimeType: "audio/silk", sizeBytes: 13, quoted: false },
      ],
      quote: { title: "旧文件", attachments: [{ kind: "file", path: "/private/media/a.pdf", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 14, quoted: true }] },
    });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(1));
    const input = agent.reply.mock.calls[0]?.[1];
    expect(input).toEqual(expect.arrayContaining([
      { type: "localImage", path: "/private/media/a.jpg" },
    ]));
    expect(input).not.toEqual(expect.arrayContaining([
      { type: "localAudio", path: "/private/media/a.silk" },
    ]));
    expect(JSON.stringify(input)).toContain("/private/media/a.pdf");
    await service.close();
  });

  it("adds same-target recent image paths only when the user explicitly asks to send one", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-recent-image-"));
    const imagePath = path.join(directory, "recent.png");
    fs.writeFileSync(imagePath, "image");
    const now = () => 1_723_456_789_000;
    const mediaTools = new WeixinMediaToolHost(now);
    const { service, agent, emit } = harness(undefined, now, mediaTools);
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({
      key: "3".repeat(64),
      source: "media",
      text: "看看这张图片",
      attachments: [{ kind: "image", path: imagePath, fileName: "recent.png", mimeType: "image/png", sizeBytes: 5, quoted: false }],
      replyMedia: vi.fn(async () => ({ ok: true as const, messageId: "media-1" })),
    });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(1));
    emit({ key: "4".repeat(64), messageId: "message-2", text: "把刚才的图片回发给我" });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(2));

    expect(agent.prompts.at(-1)).toContain(`近期图片 1：${fs.realpathSync(imagePath)}`);
    await service.close();
  });

  it("routes authorized local image requests to the media tools instead of ordinary file access", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-media-route-"));
    const home = path.join(directory, "home");
    for (const name of ["Downloads", "Pictures", "Documents"]) fs.mkdirSync(path.join(home, name), { recursive: true });
    const library = new MediaExportLibrary(path.join(directory, "grants.json"), home);
    library.configure({ rootIds: ["downloads"], confirmed: true });
    const { service, agent, emit } = harness(undefined, () => 1_723_456_789_000, new WeixinMediaToolHost(Date.now, library));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    emit({ text: "把 Downloads 里的图片发给我" });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(1));

    expect(agent.prompts.at(-1)).toContain("必须使用 weixin_find_images 查找");
    expect(agent.prompts.at(-1)).toContain("禁止使用 shell、exec 或普通文件工具读取这些目录");
    await service.close();
  });

  it("rejects and deduplicates an overlong voice without starting a Codex reply", async () => {
    const { service, store, agent, emitRejected } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const replyText = emitRejected();
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(1));
    const duplicateReplyText = emitRejected();
    await Promise.resolve();

    expect(replyText).toHaveBeenCalledWith(
      "这条语音超过 60 秒，暂不处理。请拆分后重发，或改发文字。",
    );
    expect(agent.reply).not.toHaveBeenCalled();
    expect(duplicateReplyText).not.toHaveBeenCalled();
    expect(store.load()).toMatchObject({
      processedKeys: [],
      transcript: [
        { role: "user", text: "[语音未处理] 语音超过 60 秒", status: "received" },
        { role: "assistant", status: "accepted" },
      ],
    });
    await service.close();
  });

  it("runs different targets concurrently instead of using one global queue", async () => {
    const { service, agent, emit } = harness();
    const resolvers: Array<(reply: string) => void> = [];
    agent.reply.mockImplementation(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    await service.enable("bot@im.bot", "second@im.wechat");

    const firstReply = emit({ key: "1".repeat(64), target: "owner@im.wechat" });
    const secondReply = emit({ key: "2".repeat(64), target: "second@im.wechat" });

    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(2), { timeout: 300 });
    expect(agent.startOrResume).toHaveBeenCalledTimes(2);

    resolvers[0]?.(modelReply("first"));
    resolvers[1]?.(modelReply("second"));
    await vi.waitFor(() => expect(firstReply).toHaveBeenCalledWith("first"));
    await vi.waitFor(() => expect(secondReply).toHaveBeenCalledWith("second"));
    await service.close();
  });

  it("keeps messages for the same target in FIFO order", async () => {
    let clock = 1_723_456_789_000;
    const { service, agent, emit } = harness(undefined, () => clock);
    const resolvers: Array<(reply: string) => void> = [];
    agent.reply.mockImplementation(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const firstReply = emit({ key: "3".repeat(64), text: "first", observedAt: clock });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(agent.reply.mock.calls[0]?.[1])).toContain("first");
    clock += 10;
    const secondObservedAt = clock;
    const secondReply = emit({ key: "4".repeat(64), text: "second", observedAt: secondObservedAt });
    expect(secondReply).not.toHaveBeenCalled();

    clock += 50;
    resolvers[0]?.(modelReply("first done"));
    await vi.waitFor(() => expect(firstReply).toHaveBeenCalledWith("first done"));
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(agent.reply.mock.calls[1]?.[1])).toContain("second");
    resolvers[1]?.(modelReply("second done"));
    await vi.waitFor(() => expect(secondReply).toHaveBeenCalledWith("second done"));
    expect(service.getPublicState().runs[0]?.timings.slice(0, 2)).toEqual([
      expect.objectContaining({ stage: "inbound", startedAt: secondObservedAt, durationMs: 0 }),
      expect.objectContaining({ stage: "queue", startedAt: secondObservedAt, durationMs: 50 }),
    ]);
    await service.close();
  });

  it("creates a dedicated thread on explicit enable and replies once to authorized inbound", async () => {
    const { service, store, agent, emit } = harness();
    await service.start();

    await service.enable("bot@im.bot", "owner@im.wechat");
    const replyText = emit();
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith("你好，我收到了。"));

    expect(agent.startOrResume).toHaveBeenCalledWith(undefined, "/workspace", ["/workspace"]);
    expect(agent.reply).toHaveBeenCalledTimes(1);
    expect(agent.prompts[0]).toContain("Hi");
    expect(agent.prompts[0]).toContain("明确要求");
    expect(store.load()).toMatchObject({
      version: 7,
      targetSessions: [{
        accountId: "bot@im.bot",
        target: "owner@im.wechat",
        threadId: "019fef94-7da4-75a2-b9fb-226af024ddcd",
        threadProfile: "native-relay-v2",
      }],
      enabledTargets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }],
      processedKeys: [],
      transcript: [
        { role: "user", text: "Hi", status: "received" },
        { role: "assistant", text: "已收到，正在处理。", status: "ack_accepted" },
        { role: "assistant", text: "你好，我收到了。", status: "accepted" },
      ],
    });
    expect(service.getPublicState()).toMatchObject({ status: "idle", threadReady: true });
    expect(JSON.stringify(service.getPublicState())).not.toContain("019fef94");
    await service.close();
  });

  it("keeps legacy Vault writes disabled until the new onboarding is completed", () => {
    const { service, store, vault } = harness();

    expect(service.getPublicState()).toMatchObject({
      permissions: {
        onboardingCompleted: false,
        mode: "safe",
        capability: { restrictedReadSupported: false },
        candidates: [{ id: "workspace", displayName: "codex-weixin 项目", path: "/workspace" }],
      },
    });
    expect(() => service.enableVault()).toThrow("旧写权限开关已停用");
    expect(vault.isEnabled()).toBe(false);
    expect(store.load()).toMatchObject({
      version: 7,
      permissions: { onboardingCompleted: false, mode: "safe", revision: 0 },
    });

    service.disableVault();
    expect(vault.isEnabled()).toBe(false);
  });

  it("freezes configured roots into the next inbound turn", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-permission-turn-"));
    const store = new CodexServiceStore(path.join(directory, "state.json"));
    let listener: ((event: InboundTextEvent) => void) | undefined;
    const channel = {
      getSnapshot: () => ({
        accounts: [{ accountId: "bot@im.bot", credentialStatus: "usable" as const }],
        targets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }],
      }),
      onInboundText: (next: (event: InboundTextEvent) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
    } as Pick<WeixinChannel, "getSnapshot" | "onInboundText" | "onInboundRejected">;
    const agent = new FakeAgent();
    const service = new WeixinCodexService(
      channel,
      agent,
      store,
      directory,
      Date.now,
      undefined,
      [directory],
      true,
    );
    service.configurePermissions({ mode: "guarded_plus", rootIds: ["workspace"], confirmed: true });
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const replyText = vi.fn(async () => ({ ok: true as const, messageId: "sent" }));

    listener?.({
      key: "b".repeat(64),
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      messageId: "message-permission",
      source: "text",
      text: "列出文件",
      receivedAt: Date.now(),
      replyText,
    });
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(1));

    expect(agent.reply.mock.calls[0]?.[2]).toEqual({
      revision: 1,
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
        access: {
          type: "restricted",
          includePlatformDefaults: true,
          readableRoots: [fs.realpathSync(directory)],
        },
        networkAccess: false,
      },
    });
    await service.close();
  });

  it("rejects a turn when a persisted authorized root no longer matches its candidate", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-permission-tamper-"));
    const store = new CodexServiceStore(path.join(directory, "state.json"));
    const state = store.load();
    store.save({
      ...state,
      enabledTargets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }],
      permissions: {
        ...state.permissions,
        onboardingCompleted: true,
        roots: [{ id: "workspace", canonicalPath: "/tmp", displayName: "OpenClaw 工作区" }],
        revision: 1,
      },
    });
    let listener: ((event: InboundTextEvent) => void) | undefined;
    const channel = {
      getSnapshot: () => ({
        accounts: [{ accountId: "bot@im.bot", credentialStatus: "usable" as const }],
        targets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }],
      }),
      onInboundText: (next: (event: InboundTextEvent) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
    } as Pick<WeixinChannel, "getSnapshot" | "onInboundText" | "onInboundRejected">;
    const agent = new FakeAgent();
    const service = new WeixinCodexService(
      channel,
      agent,
      store,
      directory,
      Date.now,
      undefined,
      [directory],
      true,
    );
    await service.start();
    const replyText = vi.fn(async () => ({ ok: true as const, messageId: "failure-notice" }));

    listener?.({
      key: "c".repeat(64),
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      messageId: "message-tampered-root",
      source: "text",
      text: "读取文件",
      receivedAt: Date.now(),
      replyText,
    });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith(
      "我暂时无法处理这条消息，请稍后再发一条新消息。",
    ));

    expect(agent.reply).not.toHaveBeenCalled();
    await service.close();
  });

  it("delegates file and news work to native Codex capabilities without custom tool names", async () => {
    const { service, agent, emit } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const replyText = emit({
      key: "d".repeat(64),
      text: "第二条新闻的集中度和风险具体是什么？",
    });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(agent.prompts.at(-1)).toContain("Codex 原生能力");
    expect(agent.prompts.at(-1)).toContain("禁止删除");
    expect(agent.prompts.at(-1)).not.toContain("news_search_archive");
    expect(agent.prompts.at(-1)).not.toContain("obsidian_");
    expect(agent.startOrResume).toHaveBeenCalledWith(undefined, "/workspace", ["/workspace"]);
    await service.close();
  });

  it("asks the model to check reply punctuation without rewriting quoted file content", async () => {
    const { service, agent, emit } = harness();
    agent.reply.mockResolvedValueOnce(modelReply("正文：章节【一】【二】，文件名为报告【终版】.md。"));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    try {
      const replyText = emit({
        key: "punctuation-fidelity",
        text: "只原样返回正文：章节【一】【二】，文件名为报告【终版】.md。",
      });
      await vi.waitFor(() => expect(replyText).toHaveBeenCalledWith(
        "正文：章节【一】【二】，文件名为报告【终版】.md。",
      ));
      const prompt = JSON.stringify(agent.reply.mock.calls[0]?.[1]);
      expect(prompt).toContain("发送最终回复前检查标点");
      expect(prompt).toContain("原样引用的正文或文件名中的符号必须保留");
    } finally {
      await service.close();
    }
  });

  it("ignores unauthorized and persisted duplicate inbound messages", async () => {
    const { service, agent, emit } = harness();
    await service.start();
    emit();
    await Promise.resolve();
    expect(agent.reply).not.toHaveBeenCalled();

    await service.enable("bot@im.bot", "owner@im.wechat");
    emit();
    await vi.waitFor(() => expect(agent.reply).toHaveBeenCalledTimes(1));
    emit();
    await Promise.resolve();
    expect(agent.reply).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("sends one fixed failure notice when Codex fails and never retries", async () => {
    const { service, agent, emit } = harness();
    agent.reply.mockRejectedValueOnce(new Error("model unavailable"));
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");

    const replyText = emit({ key: "b".repeat(64) });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(replyText).toHaveBeenCalledWith("我暂时无法处理这条消息，请稍后再发一条新消息。");
    expect(agent.reply).toHaveBeenCalledTimes(1);
    expect(service.getPublicState().transcript.at(-1)).toMatchObject({ status: "agent_failed" });
    expect(service.getPublicState().runs[0]?.timings).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "agent", outcome: "failed" }),
      expect.objectContaining({ stage: "outbound", outcome: "completed" }),
    ]));
    await service.close();
  });

  it("does not retry an unknown outbound result", async () => {
    const { service, agent, emit } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const replyText = vi.fn(async () => ({ ok: false as const, error: "timeout" }));

    emit({ key: "c".repeat(64), replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(agent.reply).toHaveBeenCalledTimes(1);
    expect(service.getPublicState().transcript.at(-1)).toMatchObject({ status: "send_failed" });
    await service.close();
  });

  it("continues to the final reply when acknowledgement delivery is unknown", async () => {
    const { service, agent, emit } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const replyText = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "timeout" })
      .mockResolvedValueOnce({ ok: true as const, messageId: "final" });

    emit({ key: "e".repeat(64), replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(agent.reply).toHaveBeenCalledTimes(1);
    expect(service.getPublicState().transcript.slice(-2)).toMatchObject([
      { status: "ack_unknown" },
      { status: "accepted" },
    ]);
    await service.close();
  });

  it("does not retry when acknowledgement succeeds but final delivery is unknown", async () => {
    const { service, emit } = harness();
    await service.start();
    await service.enable("bot@im.bot", "owner@im.wechat");
    const replyText = vi.fn()
      .mockResolvedValueOnce({ ok: true as const, messageId: "ack" })
      .mockResolvedValueOnce({ ok: false as const, error: "timeout" });

    emit({ key: "f".repeat(64), replyText });
    await vi.waitFor(() => expect(replyText).toHaveBeenCalledTimes(2));

    expect(service.getPublicState().transcript.slice(-2)).toMatchObject([
      { status: "ack_accepted" },
      { status: "send_failed" },
    ]);
    await service.close();
  });
});
