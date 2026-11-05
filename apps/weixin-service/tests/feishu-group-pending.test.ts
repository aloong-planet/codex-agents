// Public workflow authority and restart boundaries. Authenticated admission and real main composition are covered separately.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WorkflowEngine, type WorkflowTemplate } from "../src/workflow-engine.js";
import { WorkflowPendingPresentationStore } from "../src/workflow-pending-presentation-store.js";
import { PendingResponseCoordinator } from "../src/workflow-pending-response-coordinator.js";
import { createWorkflowToolReplyProjector } from "../src/workflow-tool-production.js";

it("binds pending choices, cancellation, replacement and duplicate receipts to the original group requester", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-pending-"));
  const now = 1_800_000_000_000;
  const targetRef = `feishu.group.${"a".repeat(64)}`;
  const scope = { accountRef: "feishu-account", targetRef };
  const template: WorkflowTemplate = { id: "fixture.group-choice", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
    effectBudget: { read: 1 }, steps: [
      { id: "find", capability: "fixture.search", capabilityVersion: 1, timeoutMs: 1000 },
      { kind: "input_gate", id: "choose", dependsOn: ["find"], candidates: { dependency: "find", path: ["matches"] },
        selectionSchema: { type: "string" }, autoSelect: "unique_only", expiresInMs: 60_000 },
    ] };
  const open = () => new WorkflowEngine(path.join(root, "workflow.sqlite"), { now: () => now, templates: [template], providers: [{
    catalog: () => [{ id: "fixture.search", version: 1, effect: "read", retryClass: "pure", timeoutMs: 1000,
      inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["matches"], additionalProperties: false,
        properties: { matches: { type: "array", items: { type: "string" } } } } }],
    invoke: async () => ({ status: "succeeded", output: { matches: ["Agenda.md", "Notes.md"] } }),
  }] });
  let engine = open();
  let presentations = new WorkflowPendingPresentationStore(path.join(root, "presentations.sqlite"));
  const submit = async (requesterRef: string, triggerId: string, occurredAt: number) => {
    const result = await engine.submit({ ...scope, requesterRef, triggerId, occurredAt, source: "weixin", requestedWorkflowId: template.id });
    const receipt = createWorkflowToolReplyProjector(engine, presentations, () => now, { resolveQuery: () => "选择文件" })(engine.get(result.runId), {
      accountId: scope.accountRef, target: targetRef, requesterRef, eventKey: triggerId, occurredAt, originalTextRef: "source", attachmentRefs: [],
    });
    expect(receipt.outcome).toBe("needs_input"); await receipt.onAccepted?.();
    return result.runId;
  };
  try {
    await engine.start();
    const alice = await submit("ou_alice", "alice", 1);
    const bob = await submit("ou_bob", "bob", 2);
    expect(engine.listPendingSignals(scope.accountRef, targetRef, "ou_alice").map((request) => request.runId)).toEqual([alice]);
    expect(engine.listPendingSignals(scope.accountRef, targetRef, "ou_bob").map((request) => request.runId)).toEqual([bob]);
    expect(engine.listPendingSignals(scope.accountRef, targetRef)).toEqual([]);
    const alicePending = engine.get(alice)!.pendingInput!;
    for (const requesterRef of [undefined, "ou_bob"]) {
      const authority = { ...scope, ...(requesterRef ? { requesterRef } : {}) };
      await expect(engine.signal({ ...authority, signalId: `wrong-${requesterRef}`, signalRef: alicePending.signalRef,
        expectedRevision: alicePending.revision, selection: "Agenda.md" })).rejects.toThrow("workflow_signal_source_mismatch");
      await expect(engine.cancelPending({ ...authority, cancellationId: `wrong-cancel-${requesterRef}`, signalRef: alicePending.signalRef,
        expectedRevision: alicePending.revision })).rejects.toThrow("workflow_signal_source_mismatch");
    }
    expect(engine.get(alice)?.status).toBe("needs_input");
    await engine.close(); presentations.close(); engine = open();
    presentations = new WorkflowPendingPresentationStore(path.join(root, "presentations.sqlite")); await engine.start();
    expect(engine.get(alice)?.status).toBe("needs_input"); expect(engine.get(bob)?.status).toBe("needs_input");
    expect(presentations.get(scope.accountRef, targetRef, "ou_alice")?.runId).toBe(alice);
    expect(presentations.get(scope.accountRef, targetRef, "ou_bob")?.runId).toBe(bob);
    const coordinator = new PendingResponseCoordinator({ engine, presentations, now: () => now });
    const trustedTurn = { ...scope, requesterRef: "ou_alice", eventKey: "alice-choice", occurredAt: now };
    expect(await coordinator.handle({ trustedTurn, userText: "1" })).toMatchObject({ owner: "workflow", kind: "resumed", run: { runId: alice, status: "succeeded" } });
    expect(engine.getStepOutput(alice, "choose")).toBe("Agenda.md");
    expect(engine.get(bob)?.status).toBe("needs_input");
    const nextAlice = await submit("ou_alice", "alice-next", 3);
    const newerAlice = await submit("ou_alice", "alice-newer", 4);
    expect(engine.get(nextAlice)?.status).toBe("cancelled");
    expect(engine.get(bob)?.status).toBe("needs_input");
    const current = engine.get(newerAlice)!.pendingInput!;
    const signal = { ...scope, requesterRef: "ou_alice", signalId: "alice-direct", signalRef: current.signalRef,
      expectedRevision: current.revision, selection: "Notes.md" };
    expect(await engine.signal(signal)).toMatchObject({ runId: newerAlice, duplicate: false });
    expect(await engine.signal(signal)).toMatchObject({ runId: newerAlice, duplicate: true });
    await expect(engine.signal({ ...signal, requesterRef: "ou_bob" })).rejects.toThrow("workflow_signal_conflict");
    const bobPending = engine.get(bob)!.pendingInput!;
    const cancellation = { ...scope, requesterRef: "ou_bob", cancellationId: "bob-cancel", signalRef: bobPending.signalRef, expectedRevision: bobPending.revision };
    expect(await engine.cancelPending(cancellation)).toMatchObject({ runId: bob, duplicate: false });
    expect(await engine.cancelPending(cancellation)).toMatchObject({ runId: bob, duplicate: true });
    await expect(engine.cancelPending({ ...cancellation, requesterRef: "ou_alice" })).rejects.toThrow("workflow_pending_cancel_conflict");
  } finally { await engine.close(); presentations.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
