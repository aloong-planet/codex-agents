import { describe, expect, it, vi } from "vitest";

import type { InboundTextEvent } from "../src/demo-service.js";
import type { WorkflowPendingSignal, WorkflowRunView, WorkflowSignal } from "../src/workflow-engine.js";
import { WeixinWorkflowTriggerAdapter } from "../src/weixin-workflow-trigger-adapter.js";

function event(text: string, key = "message-1"): InboundTextEvent {
  return {
    key, accountId: "account-a", target: "target-a", messageId: key,
    source: "text", text, receivedAt: 1_800_000_000_000,
    replyText: vi.fn(),
  };
}

function pending(signalRef = `workflow-signal:${"a1b2c3".padEnd(64, "0")}`): WorkflowPendingSignal {
  return {
    runId: "run-1", signalRef, stepId: "choose", revision: 4,
    expiresAt: 1_800_000_060_000, candidates: ["Inbox.md", "Archive.md"],
  };
}

function run(status: WorkflowRunView["status"] = "succeeded"): WorkflowRunView {
  return {
    runId: "run-1", source: "weixin", triggerId: "message-original",
    occurredAt: 1, status, revision: 5, createdAt: 1, updatedAt: 2,
  };
}

describe("WeixinWorkflowTriggerAdapter", () => {
  it("rejects a partially configured Planner/Gateway route", () => {
    expect(() => new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [], signal: vi.fn(), get: () => run() },
      candidateIntents: () => [],
    })).toThrow("workflow_trigger_adapter_configuration_invalid");
  });

  it("turns an explicit stable reference and ordinal into an idempotent workflow signal", async () => {
    const signal = vi.fn(async (input: WorkflowSignal) => {
      void input;
      return { runId: "run-1", duplicate: false };
    });
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [pending()],
        signal,
        get: () => run(),
      },
    });

    await expect(adapter.tryHandle(event("选择 a1b2c3 2"))).resolves.toEqual({
      handled: true, outcome: "succeeded", reply: "工作流已完成。",
    });
    expect(signal).toHaveBeenCalledWith({
      signalId: expect.stringMatching(/^weixin-signal:[a-f0-9]{32}$/),
      signalRef: pending().signalRef,
      expectedRevision: 4,
      accountRef: "account-a",
      targetRef: "target-a",
      selection: "Archive.md",
    });
  });

  it("routes a natural-language ordinal through the semantic pending router", async () => {
    const signal = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    const route = vi.fn(async (input: {
      requests: Array<{ requestRef: string; choices: Array<{ choiceRef: string }> }>;
    }) => ({
      kind: "respond",
      requestRef: input.requests[0]!.requestRef,
      choiceRefs: [input.requests[0]!.choices[0]!.choiceRef],
    }));
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [pending()], signal, get: () => run() },
      pendingResponseRouter: { route },
    });

    await expect(adapter.tryHandle(event("选第1个"))).resolves.toMatchObject({ handled: true, outcome: "succeeded" });
    expect(route).toHaveBeenCalledOnce();
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({ selection: "Inbox.md" }));
  });

  it("accepts a bare ordinal when the current account and target have one waiting request", async () => {
    const signal = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    const current = pending();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [current], signal, get: () => run() },
      pendingPresentations: {
        get: () => ({
          accountRef: "account-a", targetRef: "target-a", runId: current.runId,
          signalRef: current.signalRef, revision: current.revision,
          requestTextHash: "hash", expiresAt: current.expiresAt, acceptedAt: 1_799_999_999_000,
        }),
        put: vi.fn(),
      },
    });

    await expect(adapter.tryHandle(event("1"))).resolves.toMatchObject({ handled: true, outcome: "succeeded" });
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({ selection: "Inbox.md" }));
  });

  it("does not guess a bare ordinal when multiple runs are waiting", async () => {
    const signal = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [pending(), pending(`workflow-signal:${"d4e5f6".padEnd(64, "0")}`)],
        signal,
        get: () => run(),
      },
    });

    await expect(adapter.tryHandle(event("1"))).resolves.toEqual({
      handled: true,
      outcome: "needs_input",
      reply: "有多个工作流等待选择，请带上提示中的引用。",
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("redisplays the last accepted candidate prompt for a repeated request without starting another run", async () => {
    const old = pending();
    const latest = {
      ...pending(`workflow-signal:${"d4e5f6".padEnd(64, "0")}`),
      runId: "run-latest",
      candidates: ["王林2.jpg", "王林.png"],
    };
    const put = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [old, latest],
        signal: vi.fn(),
        get: (runId) => ({ ...run("needs_input"), runId }),
      },
      pendingPresentations: {
        get: () => ({
          accountRef: "account-a", targetRef: "target-a", runId: latest.runId,
          signalRef: latest.signalRef, revision: latest.revision,
          requestTextHash: "e307afb2e9c54cde11bcefe1882bdaf5cfa529ab49fc3b07afc3f8374d6f46d6",
          expiresAt: latest.expiresAt, acceptedAt: 1_799_999_999_000,
        }),
        put,
      },
      now: () => 1_800_000_000_000,
    });

    const result = await adapter.tryHandle(event("把 Pictures 里的 王林图片发给我"));
    expect(result).toMatchObject({
      handled: true,
      outcome: "needs_input",
      reply: expect.stringContaining("1. 王林2.jpg"),
    });
    expect(result.handled && result.reply).toContain("请回复一个序号或一个候选描述，也可以直接说明取消");
    if (!result.handled) throw new Error("expected workflow owner");
    await result.onAccepted?.();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-latest" }));
  });

  it("leaves a bare ordinal as ordinary chat when no request is waiting", async () => {
    const signal = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [], signal, get: () => run() },
    });

    await expect(adapter.tryHandle(event("1"))).resolves.toEqual({ handled: false });
    expect(signal).not.toHaveBeenCalled();
  });

  it.each(["0", "100"])("does not treat %s as a supported bare ordinal", async (text) => {
    const signal = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [pending()], signal, get: () => run() },
    });

    await expect(adapter.tryHandle(event(text))).resolves.toEqual({ handled: false });
    expect(signal).not.toHaveBeenCalled();
  });

  it("leaves unrelated chat untouched even when one run is waiting", async () => {
    const signal = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [pending()], signal, get: () => run() },
    });

    await expect(adapter.tryHandle(event("今天天气怎么样"))).resolves.toEqual({ handled: false });
    expect(signal).not.toHaveBeenCalled();
  });

  it("ends the old pending run when a complete new goal continues as ordinary Codex chat", async () => {
    const supersedePendingSignals = vi.fn(() => ["run-old"]);
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [pending()],
        supersedePendingSignals,
        signal: vi.fn(),
        get: () => run("needs_input"),
      },
      pendingResponseRouter: {
        route: async () => ({ kind: "new_goal", goal: "查询今天无锡的天气" }),
      },
      candidateIntents: () => [],
      planner: { plan: vi.fn() },
      gateway: { submit: vi.fn() },
    });

    await expect(adapter.tryHandle(event("查一下今天无锡的天气"))).resolves.toEqual({ handled: false });
    expect(supersedePendingSignals).toHaveBeenCalledWith("account-a", "target-a");
  });

  it("pending_new_goal_supersedes_before_main_turn", async () => {
    const supersedePendingSignals = vi.fn(() => ["run-old"]);
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [pending()],
        supersedePendingSignals,
        signal: vi.fn(),
        get: () => run("needs_input"),
      },
      pendingResponseRouter: {
        route: async () => ({ kind: "new_goal", goal: "把相册最新一张图片发给我" }),
      },
    });

    await expect(adapter.tryHandlePending?.(event("把相册最新一张图片发给我")))
      .resolves.toEqual({ handled: false });
    expect(supersedePendingSignals).toHaveBeenCalledOnce();
    expect(supersedePendingSignals).toHaveBeenCalledWith("account-a", "target-a");
  });

  it("lets the model semantically cancel the only pending operation without keyword matching", async () => {
    const cancelPending = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [pending()],
        cancelPending,
        signal: vi.fn(),
        get: () => run("cancelled"),
      },
      pendingResponseRouter: {
        route: async (input) => ({ kind: "cancel", requestRef: input.requests[0]!.requestRef }),
      },
    });

    await expect(adapter.tryHandle(event("我改主意了，这个就先放着吧"))).resolves.toEqual({
      handled: true,
      outcome: "succeeded",
      reply: "已取消之前的操作。",
    });
    expect(cancelPending).toHaveBeenCalledWith({
      cancellationId: expect.stringMatching(/^weixin-cancel:[a-f0-9]{32}$/),
      signalRef: pending().signalRef,
      expectedRevision: pending().revision,
      accountRef: "account-a",
      targetRef: "target-a",
    });
  });

  it("explains an all-selection scope change and shows the latest choices without internal terms", async () => {
    const initial = { ...pending(), candidates: ["album-a.png", "album-b.png"] };
    const current = { ...initial, revision: initial.revision + 1, candidates: ["album-a.png", "album-c.png"] };
    let reads = 0;
    const signal = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [current],
        signal,
        get: () => run("needs_input"),
      },
      pendingResponseRouter: {
        route: async (input) => ({
          kind: "respond",
          requestRef: input.requests[0]!.requestRef,
          choiceRefs: input.requests[0]!.choices.map((choice) => choice.choiceRef),
        }),
      },
      now: () => 1_800_000_000_000,
    });

    const result = await adapter.tryHandle(event("都要"));
    expect(result).toEqual({
      handled: true,
      outcome: "needs_input",
      reply: "我没有继续执行，因为候选列表已经更新，无法确认你说的“都要”是否包含变化后的项目。\n\n" +
        "现在可选：\n1. album-a.png\n2. album-c.png\n\n请重新回复序号，或者再次回复“都要”。",
    });
    if (!result.handled) throw new Error("expected workflow owner");
    expect(result.reply).not.toMatch(/stale|revision|hash/iu);
    expect(signal).not.toHaveBeenCalled();
  });

  it("names a disappeared selection and presents the current list", async () => {
    const initial = { ...pending(), candidates: ["album-a.png", "album-b.png"] };
    const current = { ...initial, revision: initial.revision + 1, candidates: ["album-b.png", "album-c.png"] };
    let reads = 0;
    const signal = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [current],
        signal,
        get: () => run("needs_input"),
      },
      pendingResponseRouter: {
        route: async (input) => ({
          kind: "respond",
          requestRef: input.requests[0]!.requestRef,
          choiceRefs: [input.requests[0]!.choices[0]!.choiceRef],
        }),
      },
      now: () => 1_800_000_000_000,
    });

    await expect(adapter.tryHandle(event("第一张"))).resolves.toEqual({
      handled: true,
      outcome: "needs_input",
      reply: "我没有继续执行，因为你刚才选择的「album-a.png」已不在当前结果中。\n\n" +
        "现在可选：\n1. album-b.png\n2. album-c.png\n\n请重新选择。",
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("does not revive an explicitly referenced pending request after it was superseded", async () => {
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [],
        signal: vi.fn(),
        get: () => undefined,
      },
    });

    await expect(adapter.tryHandle(event("选择 a1b2c3 1"))).resolves.toEqual({
      handled: true,
      outcome: "failed",
      reply: "之前的待选任务已经结束，请重新发起。",
    });
  });

  it("supersedes the old pending run before starting an independently understandable new goal", async () => {
    const signal = vi.fn();
    const supersedePendingSignals = vi.fn(() => ["run-old"]);
    const candidateIntents = vi.fn(() => [{
      intent: "media.send-image", intentVersion: 1, summary: "发送图片", clarificationSlots: [],
    }]);
    const plan = vi.fn(async () => ({
      disposition: "workflow" as const,
      intent: "media.send-image",
      intentVersion: 1,
      confidence: 0.98,
      slots: { rootId: "pictures", query: "王林" },
      missingSlots: [],
    }));
    const submit = vi.fn(async () => ({
      owner: "workflow" as const,
      workflowId: "media.send-image-one-message",
      submission: { runId: "run-new", duplicate: false },
    }));
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [pending()],
        signal,
        supersedePendingSignals,
        get: (runId) => ({ ...run(), runId, requestedWorkflowId: "media.send-image-one-message" }),
      },
      pendingResponseRouter: {
        route: async () => ({
          kind: "new_goal",
          goal: "在用户授权的 Pictures 目录中查找与王林相关的图片，并发送到当前微信会话",
        }),
      },
      candidateIntents,
      planner: { plan },
      gateway: { submit },
      localDate: () => "2026-08-27",
      timeZone: "Asia/Shanghai",
    });

    await expect(adapter.tryHandle(event("把 Pictures 里的王林图片发给我", "message-new"))).resolves.toEqual({
      handled: true,
      outcome: "succeeded",
      reply: "图片已发送，请查收。",
    });
    expect(plan).toHaveBeenCalledWith({
      currentMessage: "在用户授权的 Pictures 目录中查找与王林相关的图片，并发送到当前微信会话",
      localDate: "2026-08-27",
      timeZone: "Asia/Shanghai",
      candidateIntents: [{
        intent: "media.send-image", intentVersion: 1, summary: "发送图片", clarificationSlots: [],
      }],
    }, expect.any(Function));
    expect(candidateIntents).toHaveBeenCalledWith(expect.objectContaining({
      text: "在用户授权的 Pictures 目录中查找与王林相关的图片，并发送到当前微信会话",
    }));
    expect(submit).toHaveBeenCalledOnce();
    expect(supersedePendingSignals).toHaveBeenCalledWith("account-a", "target-a");
    expect(supersedePendingSignals.mock.invocationCallOrder[0])
      .toBeLessThan(submit.mock.invocationCallOrder[0]!);
    expect(signal).not.toHaveBeenCalled();
  });

  it("routes a host-filtered workflow proposal through the Gateway and becomes the only reply owner", async () => {
    const plan = vi.fn(async () => ({
      disposition: "workflow" as const,
      intent: "notes.send-file",
      intentVersion: 1,
      confidence: 0.95,
      slots: { query: "AI agent" },
      missingSlots: [],
    }));
    const submit = vi.fn(async () => ({
      owner: "workflow" as const,
      workflowId: "notes.send-file-from-weixin",
      submission: { runId: "run-1", duplicate: false },
    }));
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [], signal: vi.fn(), get: () => run() },
      candidateIntents: () => [{
        intent: "notes.send-file", intentVersion: 1, summary: "搜索并发送笔记原文件", clarificationSlots: [],
      }],
      planner: { plan },
      gateway: { submit },
      localDate: () => "2026-08-25",
      timeZone: "Asia/Shanghai",
    });

    await expect(adapter.tryHandle(event("把 AI agent 那篇笔记原文件发给我"))).resolves.toEqual({
      handled: true, outcome: "succeeded", reply: "工作流已完成。",
    });
    expect(plan).toHaveBeenCalledWith({
      currentMessage: "把 AI agent 那篇笔记原文件发给我",
      localDate: "2026-08-25",
      timeZone: "Asia/Shanghai",
      candidateIntents: [{
        intent: "notes.send-file", intentVersion: 1, summary: "搜索并发送笔记原文件", clarificationSlots: [],
      }],
    }, expect.any(Function));
    expect(submit).toHaveBeenCalledWith({
      protocolVersion: 1,
      proposal: expect.objectContaining({ intent: "notes.send-file" }),
      trusted: {
        triggerId: "message-1",
        source: "weixin",
        occurredAt: 1_800_000_000_000,
        accountRef: "account-a",
        targetRef: "target-a",
      },
    });
  });

  it("advertises a bare ordinal when only one unexpired request is waiting", async () => {
    const active = pending();
    const expired = { ...pending(`workflow-signal:${"d4e5f6".padEnd(64, "0")}`), expiresAt: 1_799_999_999_999 };
    const put = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [expired, active],
        supersedePendingSignals: vi.fn(() => [active.runId]),
        signal: vi.fn(),
        get: () => run("needs_input"),
      },
      candidateIntents: () => [{
        intent: "media.send-image", intentVersion: 1, summary: "发送图片", clarificationSlots: [],
      }],
      planner: { plan: async () => ({
        disposition: "workflow", intent: "media.send-image", intentVersion: 1,
        confidence: 0.9, slots: { query: "album" }, missingSlots: [],
      }) },
      gateway: { submit: async () => ({
        owner: "workflow", workflowId: "media.send-image-one-message",
        submission: { runId: "run-1", duplicate: false },
      }) },
      pendingPresentations: { get: () => undefined, put },
      now: () => 1_800_000_000_000,
    });

    const result = await adapter.tryHandle(event("把 album 图片发给我"));
    expect(result).toMatchObject({
      handled: true,
      outcome: "needs_input",
      reply: expect.stringContaining("请回复一个序号或一个候选描述，也可以直接说明取消"),
    });
    expect(put).not.toHaveBeenCalled();
    if (!result.handled) throw new Error("expected workflow owner");
    await result.onAccepted?.();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      accountRef: "account-a",
      targetRef: "target-a",
      runId: "run-1",
      signalRef: active.signalRef,
      revision: active.revision,
      expiresAt: active.expiresAt,
      acceptedAt: 1_800_000_000_000,
      requestTextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it.each([
    ["succeeded", undefined, "succeeded", "文件已发送，请查收。"],
    ["failed", "workflow_input_gate_no_candidates", "succeeded", "没有找到匹配的文件。"],
    ["failed", "workflow_file_query_rewrite_failed", "failed", "暂时无法完成文件查找，请稍后重试。"],
    ["blocked", "workflow_module_permission_denied", "failed", "没有读取这个文件的权限，请在“本地权限”中启用后重试。"],
    ["failed", "workflow_effect_rejected", "failed", "文件发送失败，请稍后重试。"],
    ["failed", "workflow_map_partial_failure", "failed", "部分文件已发送，其余文件发送失败。"],
    ["outcome_unknown", "workflow_effect_outcome_unknown", "failed", "文件发送结果暂时无法确认，请检查微信；系统不会自动重发。"],
  ] as const)("renders a fixed note-file result for %s", async (status, errorCode, outcome, reply) => {
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [],
        signal: vi.fn(),
        get: () => ({
          ...run(status),
          requestedWorkflowId: "notes.send-file-one-message",
          ...(errorCode ? { errorCode } : {}),
        }),
      },
      candidateIntents: () => [{
        intent: "notes.send-file", intentVersion: 1, summary: "发送笔记", clarificationSlots: [],
      }],
      planner: { plan: async () => ({
        disposition: "workflow", intent: "notes.send-file", intentVersion: 1,
        confidence: 0.9, slots: { query: "AI Agent" }, missingSlots: [],
      }) },
      gateway: { submit: async () => ({
        owner: "workflow", workflowId: "notes.send-file-one-message",
        submission: { runId: "run-1", duplicate: false },
      }) },
    });

    await expect(adapter.tryHandle(event("把 AI Agent 笔记发给我"))).resolves.toEqual({
      handled: true, outcome, reply,
    });
  });

  it.each([
    ["succeeded", undefined, "succeeded", "图片已发送，请查收。"],
    ["failed", "workflow_input_gate_no_candidates", "succeeded", "没有找到匹配的图片。"],
    ["blocked", "workflow_module_permission_denied", "failed", "没有读取这张图片的权限，请在“本地权限”中启用后重试。"],
    ["failed", "workflow_media_search_failed", "failed", "暂时无法完成图片查找，请稍后重试。"],
    ["failed", "workflow_effect_rejected", "failed", "图片发送失败，请稍后重试。"],
    ["failed", "workflow_map_partial_failure", "failed", "部分图片已发送，其余图片发送失败。"],
    ["outcome_unknown", "workflow_effect_outcome_unknown", "failed", "图片发送结果暂时无法确认，请检查微信；系统不会自动重发。"],
  ] as const)("renders a fixed image result for %s", async (status, errorCode, outcome, reply) => {
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [],
        signal: vi.fn(),
        get: () => ({
          ...run(status),
          requestedWorkflowId: "media.send-image-one-message",
          ...(errorCode ? { errorCode } : {}),
        }),
      },
      candidateIntents: () => [{
        intent: "media.send-image", intentVersion: 1, summary: "发送图片", clarificationSlots: [],
      }],
      planner: { plan: async () => ({
        disposition: "workflow", intent: "media.send-image", intentVersion: 1,
        confidence: 0.9, slots: { query: "holiday" }, missingSlots: [],
      }) },
      gateway: { submit: async () => ({
        owner: "workflow", workflowId: "media.send-image-one-message",
        submission: { runId: "run-1", duplicate: false },
      }) },
    });

    await expect(adapter.tryHandle(event("把 holiday 图片发给我"))).resolves.toEqual({
      handled: true, outcome, reply,
    });
  });

  it.each([
    ["notes.send-file-resolved", "暂时无法完成文件查找，请稍后重试。"],
    ["media.send-local-image-resolved", "暂时无法完成图片查找，请稍后重试。"],
  ] as const)("renders a resolver step timeout as a lookup failure for %s", async (workflowId, reply) => {
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [],
        signal: vi.fn(),
        get: () => ({
          ...run("failed"),
          requestedWorkflowId: workflowId,
          errorCode: "workflow_step_timeout",
          plan: {
            specId: workflowId,
            specVersion: 1,
            planHash: "plan-hash",
            effectBudget: { read: 1 },
            authorizationSnapshots: [],
            steps: [{
              stepId: "resolve", capabilityId: "files.resolve", capabilityVersion: 1,
              dependsOn: [], resourceKeys: [], attemptCount: 1, status: "failed",
            }],
          },
        }),
      },
      candidateIntents: () => [{
        intent: "media.send-local-image", intentVersion: 1, summary: "发送本地文件", clarificationSlots: [],
      }],
      planner: { plan: async () => ({
        disposition: "workflow", intent: "media.send-local-image", intentVersion: 1,
        confidence: 0.9, slots: {}, missingSlots: [],
      }) },
      gateway: { submit: async () => ({
        owner: "workflow", workflowId,
        submission: { runId: "run-1", duplicate: false },
      }) },
    });

    await expect(adapter.tryHandle(event("发送文件"))).resolves.toEqual({
      handled: true, outcome: "failed", reply,
    });
  });

  it("renders the resolved local-image workflow as a user-facing image send", async () => {
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: {
        listPendingSignals: () => [],
        signal: vi.fn(),
        get: () => ({ ...run("succeeded"), requestedWorkflowId: "media.send-local-image-resolved" }),
      },
      candidateIntents: () => [{
        intent: "media.send-local-image", intentVersion: 1, summary: "发送本地图片", clarificationSlots: [],
      }],
      planner: { plan: async () => ({
        disposition: "workflow", intent: "media.send-local-image", intentVersion: 1,
        confidence: 0.9, slots: {}, missingSlots: [],
      }) },
      gateway: { submit: async () => ({
        owner: "workflow", workflowId: "media.send-local-image-resolved",
        submission: { runId: "run-1", duplicate: false },
      }) },
    });

    await expect(adapter.tryHandle(event("把下载里的最新图片发给我"))).resolves.toEqual({
      handled: true, outcome: "succeeded", reply: "图片已发送，请查收。",
    });
  });

  it.each(["legacy", "shadow"] as const)("keeps %s intents on the existing owner", async (owner) => {
    const observe = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [], signal: vi.fn(), get: () => run() },
      candidateIntents: () => [{
        intent: "notes.send-file", intentVersion: 1, summary: "发送笔记", clarificationSlots: [],
      }],
      planner: { plan: async () => ({
        disposition: "workflow", intent: "notes.send-file", intentVersion: 1,
        confidence: 0.9, slots: {}, missingSlots: [],
      }) },
      gateway: { submit: async () => ({ owner, workflowId: "notes.send-file-from-weixin" }) },
      shadowObserver: { observe },
    });

    await expect(adapter.tryHandle(event("发送笔记"))).resolves.toEqual({ handled: false });
    expect(observe).toHaveBeenCalledTimes(owner === "shadow" ? 1 : 0);
    if (owner === "shadow") {
      expect(observe).toHaveBeenCalledWith({
        triggerKeyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        intent: "notes.send-file",
        intentVersion: 1,
        workflowId: "notes.send-file-from-weixin",
        confidence: 0.9,
        slotKeys: [],
      });
      expect(JSON.stringify(observe.mock.calls)).not.toContain("发送笔记");
      expect(JSON.stringify(observe.mock.calls)).not.toContain("account-a");
      expect(JSON.stringify(observe.mock.calls)).not.toContain("target-a");
    }
  });

  it("does not let shadow observation failure take ownership from the legacy path", async () => {
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [], signal: vi.fn(), get: () => run() },
      candidateIntents: () => [{
        intent: "notes.send-file", intentVersion: 1, summary: "发送笔记", clarificationSlots: [],
      }],
      planner: { plan: async () => ({
        disposition: "workflow", intent: "notes.send-file", intentVersion: 1,
        confidence: 0.9, slots: { query: "AI Agent" }, missingSlots: [],
      }) },
      gateway: { submit: async () => ({ owner: "shadow", workflowId: "notes.send-file-one-message" }) },
      shadowObserver: { observe: () => { throw new Error("disk_full"); } },
    });

    await expect(adapter.tryHandle(event("把 AI Agent 笔记发给我"))).resolves.toEqual({ handled: false });
  });

  it("passes ordinary chat through and renders clarification without calling the Gateway", async () => {
    const submit = vi.fn();
    const candidates = [{
      intent: "notes.send-file", intentVersion: 1, summary: "发送笔记", clarificationSlots: ["query"],
    }];
    const proposals = [
      { disposition: "ordinary_chat" as const, confidence: 1, slots: {}, missingSlots: [] },
      { disposition: "needs_clarification" as const, confidence: 0.7, slots: {}, missingSlots: ["query"] },
    ];
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [], signal: vi.fn(), get: () => run() },
      candidateIntents: () => candidates,
      planner: { plan: async () => proposals.shift()! },
      gateway: { submit },
    });

    await expect(adapter.tryHandle(event("聊聊天"))).resolves.toEqual({ handled: false });
    await expect(adapter.tryHandle(event("发送笔记"))).resolves.toEqual({
      handled: true, outcome: "needs_input", reply: "请补充完成这项操作所需的信息。",
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails closed when the Planner cannot produce a safe proposal", async () => {
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [], signal: vi.fn(), get: () => run() },
      candidateIntents: () => [{
        intent: "notes.send-file", intentVersion: 1, summary: "发送笔记", clarificationSlots: [],
      }],
      planner: { plan: async () => { throw new Error("workflow_planner_output_invalid"); } },
      gateway: { submit: vi.fn() },
    });

    await expect(adapter.tryHandle(event("发送笔记"))).resolves.toEqual({
      handled: true, outcome: "failed", reply: "工作流未能安全启动，请稍后重新发起。",
    });
  });

  it("explains that no file work started when both Planner attempts time out", async () => {
    const diagnostic = {
      attempt: 2 as const,
      generation: 2 as const,
      phase: "initial" as const,
      stage: "first_model_event" as const,
      startedAt: 10,
      completedAt: 20,
      durationMs: 10,
      outcome: "timeout" as const,
      errorCode: "planner_timeout" as const,
    };
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [], signal: vi.fn(), get: () => run() },
      candidateIntents: () => [{
        intent: "media.send-image", intentVersion: 1, summary: "发送图片", clarificationSlots: [],
      }],
      planner: {
        plan: async (_input, onDiagnostic) => {
          onDiagnostic?.(diagnostic);
          throw new Error("workflow_planner_timeout");
        },
      },
      gateway: { submit: vi.fn() },
    });

    await expect(adapter.tryHandle(event("把 Pictures 里的王林图片发给我"))).resolves.toEqual({
      handled: true,
      outcome: "failed",
      reply: "请求理解超时，尚未开始查找或发送任何内容，请稍后重试。",
      plannerDiagnostics: [diagnostic],
    });
  });

  it("does not submit an out-of-range selection", async () => {
    const signal = vi.fn();
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [pending()], signal, get: () => run() },
    });

    await expect(adapter.tryHandle(event("选择 a1b2c3 9"))).resolves.toEqual({
      handled: true, outcome: "needs_input", reply: "选择序号不在候选范围内，请按提示重新选择。",
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("does not submit an explicitly referenced request that is already expired", async () => {
    const signal = vi.fn(async () => { throw new Error("workflow_signal_expired"); });
    const expired = { ...pending(), expiresAt: 10 };
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: { listPendingSignals: () => [expired], signal, get: () => run() },
      now: () => 11,
    });

    await expect(adapter.tryHandle(event("选择 a1b2c3 1"))).resolves.toEqual({
      handled: true, outcome: "failed",
      reply: "我没有继续执行，因为刚才的候选已经过期。请重新发起这项操作。",
    });
    expect(signal).not.toHaveBeenCalled();
  });
});
