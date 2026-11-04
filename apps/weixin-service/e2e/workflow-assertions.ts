import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import type { FixtureOutboxEntry } from "../src/demo-service.js";
import type { PublicWorkflowRun } from "../src/workflow-engine.js";

export type WorkflowObservation = {
  workflows: { runs: PublicWorkflowRun[] };
  fixtureOutbox: FixtureOutboxEntry[];
};

type FileIdentity = Pick<FixtureOutboxEntry, "kind" | "fileName"> & { displayPath?: string };
type RunExpectation = Pick<PublicWorkflowRun, "status"> & { errorCode?: string };

export function assertRunTransition(
  before: WorkflowObservation,
  after: WorkflowObservation,
  expected: { existing?: Array<RunExpectation & { runRef: string }>; created?: RunExpectation & { workflowId: string } } = {},
): PublicWorkflowRun | undefined {
  const { previous, current } = observations(before, after);
  for (const item of expected.existing ?? []) {
    assert(previous.has(item.runRef), `Run ${item.runRef}: not in before observation`);
    const run = current.get(item.runRef)!;
    assert.equal(run.workflowId, previous.get(item.runRef)!.workflowId, `Run ${item.runRef}: workflow identity changed`);
    assert.equal(run.status, item.status, `Run ${item.runRef}: status mismatch`);
    if (item.errorCode !== undefined) assert.equal(run.errorCode, item.errorCode, `Run ${item.runRef}: reason mismatch`);
  }
  const created = after.workflows.runs.filter((run) => !previous.has(run.runRef));
  assert.equal(created.length, expected.created ? 1 : 0, `new Run count mismatch: ${created.map((run) => run.runRef).join(", ")}`);
  if (expected.created) {
    const run = created[0]!;
    assert.equal(run.workflowId, expected.created.workflowId, `Run ${run.runRef}: workflow mismatch`);
    assert.equal(run.status, expected.created.status, `Run ${run.runRef}: status mismatch`);
    if (expected.created.errorCode !== undefined) assert.equal(run.errorCode, expected.created.errorCode, `Run ${run.runRef}: reason mismatch`);
    return run;
  }
  return undefined;
}

export function assertNoFileDelivery(before: WorkflowObservation, after: WorkflowObservation): void {
  const { delivered } = observations(before, after);
  assert.equal(delivered.length, 0, "unexpected delivery");
  const unsafe = changedOutboundEffects(before, after).filter((effect) => effect.state !== "rejected");
  assert.equal(unsafe.length, 0, `unexpected outbound Effect: ${unsafe.map((effect) => `${effect.runRef}/${effect.stepId}=${effect.state}`).join(", ")}`);
}

const outboundCapabilities = new Set(["weixin.submit_file", "weixin.send_file", "weixin.send_image"]);

function effectStep(run: PublicWorkflowRun, effectId: string) {
  const parent = /^(.*)#[1-9]\d*$/u.exec(effectId)?.[1];
  return run.steps.find((step) => step.stepId === effectId)
    ?? run.steps.find((step) => step.stepId === parent);
}

function observations(before: WorkflowObservation, after: WorkflowObservation) {
  for (const [label, snapshot] of [["before", before], ["after", after]] as const) {
    assert(Array.isArray(snapshot?.fixtureOutbox), `${label}: missing outbox evidence`);
    assert(Array.isArray(snapshot?.workflows?.runs), `${label}: missing Run evidence`);
    // The public endpoint returns at most 50 Runs. A full page cannot prove completeness.
    assert(snapshot.workflows.runs.length < 50, `${label}: possibly truncated Run evidence`);
    const refs = snapshot.workflows.runs.map((run) => run.runRef);
    assert(refs.every((ref) => typeof ref === "string" && ref.length > 0)
      && new Set(refs).size === refs.length, `${label}: duplicate or missing Run identity`);
    for (const entry of snapshot.fixtureOutbox) {
      assert(["file", "image"].includes(entry.kind) && typeof entry.fileName === "string" && entry.fileName.length > 0
        && typeof entry.displayPath === "string" && entry.displayPath.length > 0
        && entry.simulated === true && Number.isFinite(entry.acceptedAt), `${label}: incomplete outbox evidence`);
    }
    for (const run of snapshot.workflows.runs) {
      assert(Array.isArray(run.steps) && Array.isArray(run.effects), `Run ${run.runRef}: missing step/Effect evidence`);
      assert(new Set(run.steps.map((step) => step.stepId)).size === run.steps.length, `Run ${run.runRef}: duplicate step identity`);
      assert(new Set(run.effects.map((effect) => effect.stepId)).size === run.effects.length, `Run ${run.runRef}: duplicate Effect identity`);
      for (const effect of run.effects) {
        assert(effectStep(run, effect.stepId)
          && ["prepared", "accepted", "rejected", "unknown"].includes(effect.state), `Run ${run.runRef}: invalid Effect evidence`);
      }
    }
  }
  assert(isDeepStrictEqual(after.fixtureOutbox.slice(0, before.fixtureOutbox.length), before.fixtureOutbox), "outbox prefix changed or truncated");
  const previous = new Map(before.workflows.runs.map((run) => [run.runRef, run]));
  const current = new Map(after.workflows.runs.map((run) => [run.runRef, run]));
  for (const [ref, run] of previous) {
    const next = current.get(ref);
    assert(next, `Run ${ref}: missing from after observation`);
    for (const effect of run.effects) {
      assert(next.effects.some((item) => item.stepId === effect.stepId), `Run ${ref}: Effect ${effect.stepId} missing from after observation`);
    }
  }
  return { previous, current, delivered: after.fixtureOutbox.slice(before.fixtureOutbox.length) };
}

function changedOutboundEffects(before: WorkflowObservation, after: WorkflowObservation) {
  return after.workflows.runs.flatMap((run) => {
    const old = before.workflows.runs.find((item) => item.runRef === run.runRef);
    return run.effects.filter((effect) => {
      const step = effectStep(run, effect.stepId)!;
      return outboundCapabilities.has(step.capabilityId)
        && !isDeepStrictEqual(old?.effects.find((item) => item.stepId === effect.stepId), effect);
    }).map((effect) => ({ runRef: run.runRef, ...effect }));
  });
}

export function assertFileDeliveries(
  before: WorkflowObservation,
  after: WorkflowObservation,
  expected: { files: FileIdentity[]; runRef: string; order?: "exact" | "any" },
): void {
  const label = `deliveries ${expected.runRef}`;
  assert(expected.files.length > 0, `${label}: success expectation must be nonempty`);
  const { delivered, current } = observations(before, after);
  const baseKey = (file: FileIdentity) => JSON.stringify([file.kind, file.fileName]);
  for (const file of expected.files) {
    const peers = expected.files.filter((item) => baseKey(item) === baseKey(file));
    assert(peers.length === 1 || peers.every((item) => !!item.displayPath), `${label}: ambiguous identities require displayPath`);
  }
  assert.equal(delivered.length, expected.files.length, `${label}: count mismatch`);
  const remaining = [...delivered];
  for (const file of expected.files) {
    const matches = (entry: FixtureOutboxEntry) => baseKey(entry) === baseKey(file)
      && (file.displayPath === undefined || entry.displayPath === file.displayPath);
    const index = expected.order === "any" ? remaining.findIndex(matches) : 0;
    assert(index >= 0 && remaining[index] && matches(remaining[index]!),
      `${label}: identities mismatch; expected ${file.kind} ${file.displayPath ?? file.fileName}; observed ${JSON.stringify(remaining.map((entry) => ({ kind: entry.kind, fileName: entry.fileName, displayPath: entry.displayPath })))}`);
    remaining.splice(index, 1);
  }
  const run = current.get(expected.runRef);
  assert(run, `Run ${expected.runRef}: missing`);
  assert.equal(run.status, "succeeded", `Run ${expected.runRef}: not succeeded`);
  const outbound = run.steps.filter((step) => outboundCapabilities.has(step.capabilityId));
  assert(outbound.length > 0, `${label}: missing outbound step/Effect evidence`);
  for (const step of outbound) {
    assert.equal(step.status, "succeeded", `Run ${run.runRef}: outbound step ${step.stepId} not succeeded`);
    const effects = run.effects.filter((effect) => effectStep(run, effect.stepId) === step);
    assert(effects.length > 0 && effects.every((effect) => effect.state === "accepted"), `Run ${run.runRef}: Effect ${step.stepId} missing or not accepted`);
    if (effects.some((effect) => effect.stepId !== step.stepId)) {
      const ordinals = effects.map((effect) => Number(effect.stepId.slice(step.stepId.length + 1))).sort((a, b) => a - b);
      assert(ordinals.every((ordinal, index) => ordinal === index + 1), `Run ${run.runRef}: incomplete Effect ordinals for ${step.stepId}`);
    }
  }
  const changed = changedOutboundEffects(before, after);
  assert.equal(changed.length, expected.files.length, `${label}: current Effect count mismatch`);
  assert(changed.every((effect) => effect.runRef === expected.runRef && effect.state === "accepted"), `${label}: unexpected outbound Effect`);
}
