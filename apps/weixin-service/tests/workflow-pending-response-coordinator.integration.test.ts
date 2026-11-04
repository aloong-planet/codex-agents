import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PendingResponseCoordinator } from "../src/workflow-pending-response-coordinator.js";
import { WorkflowEngine, type WorkflowTemplate } from "../src/workflow-engine.js";
import { WeixinWorkflowTriggerAdapter } from "../src/weixin-workflow-trigger-adapter.js";
import { WorkflowPendingPresentationStore } from "../src/workflow-pending-presentation-store.js";

const tempDirs: string[] = [];

// Real Engine cases below exercise replacement through submit and expiry through the clock seam.
// Older Engine-port doubles cover rebinding contracts, not production candidate-update reachability.
// Phone receipt and live model semantics require the separate Weixin acceptance/production entry gates.

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("PendingResponseCoordinator", () => {
  it.each(["tryHandle", "tryHandlePending"] as const)("%s binds replacement choices only after the refresh reply is accepted and resumes the replacement run", async (entry) => {
    const fixture = await createFixture();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pending-refresh-presentation-"));
    tempDirs.push(directory);
    const presentations = new WorkflowPendingPresentationStore(path.join(directory, "presentations.sqlite"));
    let replacementId = "";
    const now = () => 1_800_000_000_001;
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: fixture.engine, pendingPresentations: presentations, now,
      pendingResponseRouter: { route: async (input) => {
        const replacement = await fixture.engine.submit({
          triggerId: "replacement", source: "weixin", occurredAt: 2,
          requestedWorkflowId: "fixture.pending-response", accountRef: "account-a", targetRef: "target-a",
        });
        replacementId = replacement.runId;
        return { kind: "respond", requestRef: input.requests[0]!.requestRef,
          choiceRefs: [input.requests[0]!.choices[0]!.choiceRef] };
      } },
    });
    const event = { key: "answer-old", messageId: "answer-old", accountId: "account-a", target: "target-a",
      source: "text" as const, text: "第一个就好", receivedAt: now(),
      replyText: async () => { throw new Error("adapter must not send directly"); } };
    try {
      const refreshed = await adapter[entry](event);
      expect(refreshed).toMatchObject({ handled: true, outcome: "needs_input", onAccepted: expect.any(Function) });
      expect(refreshed.handled && refreshed.reply).toBe("我没有继续执行，因为当前待选内容已经换成新的列表。\n\n现在可选：\n1. Inbox.md\n2. Archive.md\n\n请按新列表选择。");
      expect(fixture.engine.get(fixture.runId)).toMatchObject({ status: "cancelled", errorCode: "workflow_pending_superseded" });
      expect(fixture.engine.get(replacementId)?.status).toBe("needs_input");
      expect(presentations.get("account-a", "target-a")).toBeUndefined();
      const ordinalAdapter = new WeixinWorkflowTriggerAdapter({ engine: fixture.engine, pendingPresentations: presentations, now });
      const ordinal = { ...event, key: "unaccepted-ordinal", text: "1" };
      await expect(ordinalAdapter.tryHandlePending(ordinal)).resolves.toEqual({ handled: false });
      expect(fixture.selected).toEqual([]);
      if (!refreshed.handled || !refreshed.onAccepted) throw new Error("missing refresh receipt binding");
      await refreshed.onAccepted();
      expect(presentations.get("account-a", "target-a")).toMatchObject({ runId: replacementId });
      await expect(ordinalAdapter.tryHandlePending({ ...ordinal, key: "accepted-ordinal" }))
        .resolves.toMatchObject({ handled: true, outcome: "succeeded" });
      expect(fixture.engine.get(replacementId)?.status).toBe("succeeded");
      expect(fixture.selected).toEqual(["Inbox.md"]);
      expect(fixture.searches()).toBe(2);
      const later = await fixture.engine.submit({
        triggerId: "later", source: "weixin", occurredAt: 3,
        requestedWorkflowId: "fixture.pending-response", accountRef: "account-a", targetRef: "target-a",
      });
      await refreshed.onAccepted();
      await expect(ordinalAdapter.tryHandlePending({ ...ordinal, key: "late-receipt" }))
        .resolves.toEqual({ handled: false });
      expect(fixture.engine.get(later.runId)?.status).toBe("needs_input");
      expect(fixture.selected).toEqual(["Inbox.md"]);
    } finally { presentations.close(); await fixture.engine.close(); }
  });

  it("does not bind an expired request when routing finishes after the real Engine deadline", async () => {
    let clock = 1_800_000_000_000;
    const fixture = await createFixture(() => clock);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pending-expired-presentation-"));
    tempDirs.push(directory);
    const presentations = new WorkflowPendingPresentationStore(path.join(directory, "presentations.sqlite"));
    const adapter = new WeixinWorkflowTriggerAdapter({
      engine: fixture.engine, pendingPresentations: presentations, now: () => clock,
      pendingResponseRouter: { route: async (input) => {
        clock += 60_001;
        return { kind: "respond", requestRef: input.requests[0]!.requestRef,
          choiceRefs: [input.requests[0]!.choices[0]!.choiceRef] };
      } },
    });
    try {
      const result = await adapter.tryHandlePending({ key: "expired-answer", messageId: "expired-answer",
        accountId: "account-a", target: "target-a", source: "text", text: "第一份吧",
        receivedAt: clock, replyText: async () => { throw new Error("adapter must not send directly"); } });
      expect(result).toMatchObject({ handled: true, outcome: "failed" });
      expect(result).not.toHaveProperty("onAccepted");
      expect(result.handled && result.reply).toContain("已经过期");
      const ordinalAdapter = new WeixinWorkflowTriggerAdapter({
        engine: fixture.engine, pendingPresentations: presentations, now: () => clock,
      });
      await expect(ordinalAdapter.tryHandlePending({ key: "expired-ordinal", messageId: "expired-ordinal",
        accountId: "account-a", target: "target-a", source: "text", text: "1",
        receivedAt: clock, replyText: async () => { throw new Error("adapter must not send directly"); } }))
        .resolves.toEqual({ handled: false });
      expect(fixture.selected).toEqual([]);
      expect(presentations.get("account-a", "target-a")).toBeUndefined();
    } finally { presentations.close(); await fixture.engine.close(); }
  });

  it("binds a bare ordinal to the latest accepted presentation when multiple runs wait", async () => {
    const first = pendingSignal("run-old", "workflow-input:old", ["old-a.jpg", "old-b.jpg"]);
    const latest = pendingSignal("run-latest", "workflow-input:latest", ["王林2.jpg", "王林.png"]);
    const signal = vi.fn(async () => ({ runId: latest.runId, duplicate: false }));
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => [first, latest],
        signal,
        get: (runId) => ({
          runId, source: "weixin", triggerId: "trigger", occurredAt: 1,
          status: "succeeded", revision: 3, createdAt: 1, updatedAt: 2,
        }),
      },
      presentations: {
        get: () => ({
          accountRef: "account-a", targetRef: "target-a", runId: latest.runId,
          signalRef: latest.signalRef, revision: latest.revision,
          requestTextHash: "hash", expiresAt: latest.expiresAt, acceptedAt: 1_800_000_000_000,
        }),
        put: vi.fn(),
      },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "select-latest", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "1",
    })).resolves.toMatchObject({ owner: "workflow", kind: "resumed", run: { runId: "run-latest" } });
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      signalRef: latest.signalRef,
      expectedRevision: latest.revision,
      selection: "王林2.jpg",
    }));
  });

  it("redisplays the accepted pending request when the same normalized request is repeated", async () => {
    const latest = pendingSignal("run-latest", "workflow-input:latest", ["王林2.jpg", "王林.png"]);
    const route = vi.fn(async () => { throw new Error("router must not run for a repeated request"); });
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => [latest],
        signal: vi.fn(),
        get: (runId) => ({
          runId, source: "weixin", triggerId: "trigger", occurredAt: 1,
          status: "needs_input", revision: 2, createdAt: 1, updatedAt: 2,
        }),
      },
      router: { route },
      presentations: {
        get: () => ({
          accountRef: "account-a", targetRef: "target-a", runId: latest.runId,
          signalRef: latest.signalRef, revision: latest.revision,
          requestTextHash: "e307afb2e9c54cde11bcefe1882bdaf5cfa529ab49fc3b07afc3f8374d6f46d6",
          expiresAt: latest.expiresAt, acceptedAt: 1_800_000_000_000,
        }),
        put: vi.fn(),
      },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "repeat-request", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "把 Pictures 里的 王林图片发给我",
    })).resolves.toMatchObject({ owner: "workflow", kind: "redisplay", run: { runId: "run-latest" } });
    expect(route).not.toHaveBeenCalled();
  });

  it("pending_deterministic_fast_path_uses_zero_app_server_turns", async () => {
    const fixture = await createFixture();
    const latest = fixture.engine.listPendingSignals("account-a", "target-a")[0]!;

    const coordinator = new PendingResponseCoordinator({
      engine: fixture.engine,
      presentations: {
        get: () => ({
          accountRef: "account-a", targetRef: "target-a", runId: latest.runId,
          signalRef: latest.signalRef, revision: latest.revision,
          requestTextHash: "hash", expiresAt: latest.expiresAt, acceptedAt: 1_800_000_000_000,
        }),
        put: vi.fn(),
      },
      now: () => 1_800_000_000_001,
    });
    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "selection", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "2",
    })).resolves.toMatchObject({ owner: "workflow", run: { runId: fixture.runId, status: "succeeded" } });
    expect(fixture.searches()).toBe(1);
    expect(fixture.selected).toEqual(["Archive.md"]);
    await fixture.engine.close();
  });

  it("does not consume a bare ordinal when no accepted candidate presentation is bound", async () => {
    const pending = pendingSignal("run-unpresented", "workflow-input:unpresented", ["one.png", "two.png"]);
    const signal = vi.fn();
    const coordinator = new PendingResponseCoordinator({
      engine: { listPendingSignals: () => [pending], signal, get: () => undefined },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "unbound-ordinal", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "2",
    })).resolves.toEqual({ owner: "chat" });
    expect(signal).not.toHaveBeenCalled();
  });

  it("rebinds a deterministic ordinal to the same current resource instead of the old array position", async () => {
    const initial = pendingSignal("run-1", "workflow-input:run-1:choose", [
      { rootId: "pictures", relativePath: "album-a.png", handle: "old-a" },
      { rootId: "pictures", relativePath: "album-b.png", handle: "old-b" },
    ]);
    const current = {
      ...initial,
      revision: initial.revision + 1,
      candidates: [
        { rootId: "pictures", relativePath: "album-b.png", handle: "new-b" },
        { rootId: "pictures", relativePath: "album-a.png", handle: "new-a" },
      ],
    };
    let reads = 0;
    const signal = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [current], signal, get: () => undefined,
      },
      presentations: {
        get: () => ({
          accountRef: "account-a", targetRef: "target-a", runId: initial.runId,
          signalRef: initial.signalRef, revision: initial.revision,
          requestTextHash: "hash", expiresAt: initial.expiresAt, acceptedAt: 1_800_000_000_000,
        }),
        put: vi.fn(),
      },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "ordinal-rebind", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "1",
    })).resolves.toEqual({ owner: "workflow", kind: "resumed", run: undefined });
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: current.revision,
      selection: current.candidates[1],
    }));
  });

  it("pending_natural_language_uses_semantic_router_and_bridge", async () => {
    const fixture = await createFixture();
    const route = vi.fn(async (input: {
      userText: string;
      requests: Array<{ requestRef: string; choices: Array<{ choiceRef: string; ordinal: number; label: string }> }>;
    }) => ({
      kind: "respond" as const,
      requestRef: input.requests[0]!.requestRef,
      choiceRefs: [input.requests[0]!.choices[1]!.choiceRef],
    }));
    const coordinator = new PendingResponseCoordinator({
      engine: fixture.engine,
      router: { route },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "semantic-selection", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "选第2个",
    })).resolves.toMatchObject({ owner: "workflow", run: { runId: fixture.runId, status: "succeeded" } });
    expect(route).toHaveBeenCalledWith({
      userText: "选第2个",
      requests: [{
        requestRef: expect.stringMatching(/^[a-f0-9]{12}$/),
        choices: [
          { choiceRef: expect.stringMatching(/^[a-f0-9]{12}$/), ordinal: 1, label: "Inbox.md" },
          { choiceRef: expect.stringMatching(/^[a-f0-9]{12}$/), ordinal: 2, label: "Archive.md" },
        ],
      }],
    });
    expect(JSON.stringify(route.mock.calls[0]![0])).not.toContain("account-a");
    expect(JSON.stringify(route.mock.calls[0]![0])).not.toContain("target-a");
    expect(fixture.searches()).toBe(1);
    expect(fixture.selected).toEqual(["Archive.md"]);
    await fixture.engine.close();
  });

  it("submits every model-selected choice from one pending request in display order", async () => {
    const pending = pendingSignal("run-multi", "workflow-input:multi", ["王林2.jpg", "王林.png"]);
    const signal = vi.fn(async () => ({ runId: pending.runId, duplicate: false }));
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => [pending],
        signal,
        get: () => undefined,
      },
      router: {
        route: async (input) => ({
          kind: "respond",
          requestRef: input.requests[0]!.requestRef,
          choiceRefs: [input.requests[0]!.choices[1]!.choiceRef, input.requests[0]!.choices[0]!.choiceRef],
        }),
      },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "select-both", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "两张都要",
    })).resolves.toMatchObject({ owner: "workflow", kind: "resumed" });
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      selection: ["王林2.jpg", "王林.png"],
    }));
  });

  it("submits all model-selected choices when the same candidates are reloaded with a different object key order", async () => {
    const initial = pendingSignal("run-multi", "workflow-input:multi", [
      { fileName: "王林2.jpg", displayPath: "Pictures/王林2.jpg" },
      { fileName: "王林.png", displayPath: "Pictures/王林.png" },
    ]);
    const reloaded = pendingSignal("run-multi", "workflow-input:multi", [
      { displayPath: "Pictures/王林2.jpg", fileName: "王林2.jpg" },
      { displayPath: "Pictures/王林.png", fileName: "王林.png" },
    ]);
    let reads = 0;
    const signal = vi.fn(async () => ({ runId: initial.runId, duplicate: false }));
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [reloaded],
        signal,
        get: () => undefined,
      },
      router: {
        route: async (input) => ({
          kind: "respond",
          requestRef: input.requests[0]!.requestRef,
          choiceRefs: input.requests[0]!.choices.map((choice) => choice.choiceRef),
        }),
      },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "select-all-reloaded", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "都要",
    })).resolves.toMatchObject({ owner: "workflow", kind: "resumed" });
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: initial.revision,
      selection: reloaded.candidates,
    }));
  });

  it("cancels the bound pending request only after a model-semantic cancel route", async () => {
    const pending = pendingSignal("run-cancel", "workflow-input:cancel", ["王林2.jpg", "王林.png"]);
    const cancelPending = vi.fn(async () => ({ runId: pending.runId, duplicate: false }));
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => [pending],
        signal: vi.fn(),
        cancelPending,
        get: (runId) => ({
          runId, source: "weixin", triggerId: "trigger", occurredAt: 1,
          status: "cancelled", revision: 3, createdAt: 1, updatedAt: 2,
        }),
      },
      router: {
        route: async (input) => ({ kind: "cancel", requestRef: input.requests[0]!.requestRef }),
      },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "cancel-choice", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "我改主意了，这个就先放着吧",
    })).resolves.toMatchObject({ owner: "workflow", kind: "cancelled", run: { status: "cancelled" } });
    expect(cancelPending).toHaveBeenCalledWith(expect.objectContaining({
      signalRef: pending.signalRef,
      expectedRevision: pending.revision,
      accountRef: "account-a",
      targetRef: "target-a",
    }));
  });

  it("does not expose absolute paths and rebinds an unchanged choice after only the revision changes", async () => {
    const route = vi.fn(async (input: {
      requests: Array<{ requestRef: string; choices: Array<{ choiceRef: string; label: string }> }>;
    }) => {
      expect(JSON.stringify(input)).not.toContain("/Users/private/secret.png");
      expect(JSON.stringify(input)).not.toContain("private-token");
      expect(input.requests[0]!.choices[0]!.label).toBe("Pictures/secret.png");
      return {
        kind: "respond" as const,
        requestRef: input.requests[0]!.requestRef,
        choiceRefs: [input.requests[0]!.choices[0]!.choiceRef],
      };
    });
    const pending = {
      signalRef: "workflow-input:run-1:choose",
      stepId: "choose",
      runId: "run-1",
      revision: 1,
      expiresAt: 1_800_000_100_000,
      candidates: [{
        fileName: "/Users/private/secret.png",
        displayPath: "Pictures/secret.png",
        token: "private-token",
      }],
    };
    let reads = 0;
    const signal = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => {
          reads += 1;
          return [{ ...pending, revision: reads === 1 ? 1 : 2 }];
        },
        signal,
        get: () => undefined,
      },
      router: { route },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "stale-selection", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "秘密那张",
    })).resolves.toEqual({ owner: "workflow", kind: "resumed", run: undefined });
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 2,
      selection: pending.candidates[0],
    }));
  });

  it("returns a structured refresh when an all-selection candidate set changes", async () => {
    const initial = pendingSignal("run-1", "workflow-input:run-1:choose", ["album-a.png", "album-b.png"]);
    const changed = pendingSignal("run-1", "workflow-input:run-1:choose", ["album-a.png", "album-c.png"]);
    let reads = 0;
    const signal = vi.fn();
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [changed],
        signal,
        get: () => undefined,
      },
      router: {
        route: async (input) => ({
          kind: "respond",
          requestRef: input.requests[0]!.requestRef,
          choiceRefs: input.requests[0]!.choices.map((choice) => choice.choiceRef),
        }),
      },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "changed-candidates", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "都要",
    })).resolves.toEqual({
      owner: "workflow",
      kind: "refresh",
      reason: "selection_scope_changed",
      selectedLabels: ["album-a.png", "album-b.png"],
      choices: ["album-a.png", "album-c.png"],
      presentation: { runId: "run-1", signalRef: "workflow-input:run-1:choose", revision: 2, expiresAt: 1_800_000_100_000 },
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("rebinds an unchanged selected resource when only unselected candidates change", async () => {
    const initial = pendingSignal("run-1", "workflow-input:run-1:choose", [
      { rootId: "pictures", relativePath: "album-a.png", handle: "old-a", expiresAt: 100 },
      { rootId: "pictures", relativePath: "album-b.png", handle: "old-b", expiresAt: 100 },
    ]);
    const current = {
      ...initial,
      revision: initial.revision + 1,
      candidates: [
        { expiresAt: 200, handle: "new-c", relativePath: "album-c.png", rootId: "pictures" },
        { expiresAt: 200, handle: "new-a", relativePath: "album-a.png", rootId: "pictures" },
      ],
    };
    let reads = 0;
    const signal = vi.fn(async () => ({ runId: "run-1", duplicate: false }));
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [current],
        signal,
        get: () => undefined,
      },
      router: {
        route: async (input) => ({
          kind: "respond",
          requestRef: input.requests[0]!.requestRef,
          choiceRefs: [input.requests[0]!.choices[0]!.choiceRef],
        }),
      },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "rebind-selected", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "第一张",
    })).resolves.toEqual({ owner: "workflow", kind: "resumed", run: undefined });
    expect(signal).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: current.revision,
      selection: current.candidates[1],
    }));
  });

  it("reports when the selected resource is no longer present", async () => {
    const initial = pendingSignal("run-1", "workflow-input:run-1:choose", ["album-a.png", "album-b.png"]);
    const current = { ...initial, revision: 3, candidates: ["album-b.png", "album-c.png"] };
    let reads = 0;
    const signal = vi.fn();
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [current], signal, get: () => undefined,
      },
      router: { route: async (input) => ({
        kind: "respond", requestRef: input.requests[0]!.requestRef,
        choiceRefs: [input.requests[0]!.choices[0]!.choiceRef],
      }) },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "selected-missing", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "第一张",
    })).resolves.toEqual({
      owner: "workflow", kind: "refresh", reason: "selected_missing",
      selectedLabels: ["album-a.png"], choices: ["album-b.png", "album-c.png"],
      presentation: { runId: "run-1", signalRef: "workflow-input:run-1:choose", revision: 3, expiresAt: 1_800_000_100_000 },
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("reports when the selected resource content changed at the same stable path", async () => {
    const initial = pendingSignal("run-1", "workflow-input:run-1:choose", [{
      rootId: "pictures", relativePath: "album-a.png", sizeBytes: 100, handle: "old",
    }]);
    const current = { ...initial, revision: 3, candidates: [{
      rootId: "pictures", relativePath: "album-a.png", sizeBytes: 200, handle: "new",
    }] };
    let reads = 0;
    const signal = vi.fn();
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [current], signal, get: () => undefined,
      },
      router: { route: async (input) => ({
        kind: "respond", requestRef: input.requests[0]!.requestRef,
        choiceRefs: [input.requests[0]!.choices[0]!.choiceRef],
      }) },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "selected-changed", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "这张",
    })).resolves.toEqual({
      owner: "workflow", kind: "refresh", reason: "selected_changed",
      selectedLabels: ["album-a.png"], choices: ["album-a.png"],
      presentation: { runId: "run-1", signalRef: "workflow-input:run-1:choose", revision: 3, expiresAt: 1_800_000_100_000 },
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("reports expiry when the request expires while semantic routing is in progress", async () => {
    const initial = { ...pendingSignal("run-1", "workflow-input:run-1:choose", ["album-a.png"]), expiresAt: 200 };
    let clockReads = 0;
    const signal = vi.fn();
    const coordinator = new PendingResponseCoordinator({
      engine: { listPendingSignals: () => [initial], signal, get: () => undefined },
      router: { route: async (input) => ({
        kind: "respond", requestRef: input.requests[0]!.requestRef,
        choiceRefs: [input.requests[0]!.choices[0]!.choiceRef],
      }) },
      now: () => clockReads++ === 0 ? 100 : 201,
    });

    await expect(coordinator.handle({
      trustedTurn: { eventKey: "expired", accountRef: "account-a", targetRef: "target-a", occurredAt: 100 },
      userText: "这张",
    })).resolves.toEqual({
      owner: "workflow", kind: "refresh", reason: "request_expired",
      selectedLabels: ["album-a.png"], choices: [],
    });
    expect(signal).not.toHaveBeenCalled();
  });

  it("shows the replacement request when a new pending request takes over", async () => {
    const initial = pendingSignal("run-1", "workflow-input:run-1:choose", ["album-a.png"]);
    const replacement = pendingSignal("run-2", "workflow-input:run-2:choose", ["latest-a.png", "latest-b.png"]);
    let reads = 0;
    const signal = vi.fn();
    const coordinator = new PendingResponseCoordinator({
      engine: {
        listPendingSignals: () => reads++ === 0 ? [initial] : [replacement], signal, get: () => undefined,
      },
      router: { route: async (input) => ({
        kind: "respond", requestRef: input.requests[0]!.requestRef,
        choiceRefs: [input.requests[0]!.choices[0]!.choiceRef],
      }) },
      now: () => 1_800_000_000_001,
    });

    await expect(coordinator.handle({
      trustedTurn: {
        eventKey: "request-replaced", accountRef: "account-a", targetRef: "target-a",
        occurredAt: 1_800_000_000_001,
      },
      userText: "这张",
    })).resolves.toEqual({
      owner: "workflow", kind: "refresh", reason: "request_replaced",
      selectedLabels: ["album-a.png"], choices: ["latest-a.png", "latest-b.png"],
      presentation: { runId: "run-2", signalRef: "workflow-input:run-2:choose", revision: 2, expiresAt: 1_800_000_100_000 },
    });
    expect(signal).not.toHaveBeenCalled();
  });
});

function pendingSignal(runId: string, signalRef: string, candidates: unknown[]) {
  return {
    runId,
    signalRef,
    stepId: "choose",
    revision: 2,
    expiresAt: 1_800_000_100_000,
    candidates,
  };
}

async function createFixture(now = () => 1_800_000_000_000): Promise<{
  engine: WorkflowEngine;
  runId: string;
  selected: string[];
  searches: () => number;
}> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pending-response-coordinator-"));
  tempDirs.push(directory);
  let searches = 0;
  const selected: string[] = [];
  const template: WorkflowTemplate = {
    id: "fixture.pending-response", version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
    effectBudget: { read: 2 },
    steps: [
      { id: "search", capability: "fixture.pending-search", capabilityVersion: 1, timeoutMs: 1_000 },
      {
        kind: "input_gate", id: "choose", dependsOn: ["search"],
        candidates: { dependency: "search", path: ["matches"] },
        selectionSchema: { type: "string" }, autoSelect: "unique_only", expiresInMs: 60_000,
      },
      {
        id: "use", capability: "fixture.pending-use", capabilityVersion: 1, dependsOn: ["choose"],
        inputBindings: { selected: { dependency: "choose" } }, timeoutMs: 1_000,
      },
    ],
  };
  const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
    now,
    templates: [template],
    providers: [{
      catalog: () => [{
        id: "fixture.pending-search", version: 1, effect: "read" as const, retryClass: "pure" as const,
        inputSchema: { type: "object" as const },
        outputSchema: {
          type: "object" as const, required: ["matches"], additionalProperties: false,
          properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
        }, timeoutMs: 1_000,
      }, {
        id: "fixture.pending-use", version: 1, effect: "read" as const, retryClass: "pure" as const,
        inputSchema: {
          type: "object" as const, required: ["selected"], additionalProperties: false,
          properties: { selected: { type: "string" as const } },
        },
        outputSchema: { type: "object" as const }, timeoutMs: 1_000,
      }],
      invoke: async (request) => {
        if (request.capabilityId === "fixture.pending-search") {
          searches += 1;
          return { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } };
        }
        selected.push((request.input as { selected: string }).selected);
        return { status: "succeeded" as const, output: {} };
      },
    }],
  });
  await engine.start();
  const submission = await engine.submit({
    triggerId: "original", source: "weixin", occurredAt: 1,
    requestedWorkflowId: template.id, accountRef: "account-a", targetRef: "target-a",
  });
  return { engine, runId: submission.runId, selected, searches: () => searches };
}
