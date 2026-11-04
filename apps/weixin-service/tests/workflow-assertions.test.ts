import { describe, expect, it } from "vitest";
import { assertFileDeliveries, assertNoFileDelivery, assertRunTransition, type WorkflowObservation } from "../e2e/workflow-assertions.js";
import type { PublicWorkflowRun } from "../src/workflow-engine.js";

function sentRun(runRef = "run-a"): PublicWorkflowRun {
  return {
    runRef, source: "fixture", workflowId: "weixin.send-files", status: "succeeded",
    occurredAt: 1, createdAt: 1, updatedAt: 2,
    steps: [{ stepId: "send#1", capabilityId: "weixin.submit_file", dependsOn: [], attemptCount: 1, status: "succeeded" }],
    effects: [{ stepId: "send#1", state: "accepted" }],
  };
}

function state(names: string[] = [], runs: PublicWorkflowRun[] = []): WorkflowObservation {
  return { workflows: { runs }, fixtureOutbox: names.map((fileName, index) => ({
    kind: "file", fileName, displayPath: `Vault/${fileName}`, simulated: true, acceptedAt: index + 1,
  })) };
}

describe("current-interaction file delivery evidence", () => {
  it("accepts the production map-step projection with one parent and multiple item Effects", () => {
    // WorkflowEngine.getPublicState projects the parent step, not each map item.
    const run = sentRun(); run.steps[0]!.stepId = "send";
    run.effects.push({ stepId: "send#2", state: "accepted" });
    expect(() => assertFileDeliveries(state(), state(["one.md", "two.md"], [run]), {
      runRef: "run-a", files: [{ kind: "file", fileName: "one.md" }, { kind: "file", fileName: "two.md" }],
    })).not.toThrow();
  });
  it("rejects incomplete map Effect ordinals even when their count matches", () => {
    const run = sentRun(); run.steps[0]!.stepId = "send";
    run.effects.push({ stepId: "send#3", state: "accepted" });
    expect(() => assertFileDeliveries(state(), state(["one.md", "two.md"], [run]), {
      runRef: "run-a", files: [{ kind: "file", fileName: "one.md" }, { kind: "file", fileName: "two.md" }],
    })).toThrow(/Effect ordinals/);
  });
  it("rejects a historical delivery that masks no delivery in the current interaction", () => {
    const before = state(["one.md"], [sentRun()]);
    const after = state(["one.md"], [sentRun()]);
    expect(() => assertFileDeliveries(before, after, {
      files: [{ kind: "file", fileName: "one.md" }], runRef: "run-a",
    })).toThrow(/deliveries.*count/);
  });

  it("accepts a new delivery after an unrelated historical send", () => {
    expect(() => assertFileDeliveries(state(["old.md"], [sentRun("old")]), state(["old.md", "one.md"], [sentRun(), sentRun("old")]), {
      files: [{ kind: "file", fileName: "one.md" }], runRef: "run-a",
    })).not.toThrow();
  });

  it.each([
    ["missing", []], ["extra", ["one.md", "two.md"]], ["duplicate", ["one.md", "one.md"]], ["wrong file", ["wrong.md"]],
  ])("rejects %s delivery", (_name, names) => {
    expect(() => assertFileDeliveries(state(), state(names, [sentRun()]), {
      files: [{ kind: "file", fileName: "one.md" }], runRef: "run-a",
    })).toThrow(/deliveries run-a/);
  });

  it("rejects the right name with the wrong media kind or path", () => {
    const after = state(["one.md"], [sentRun()]);
    expect(() => assertFileDeliveries(state(), after, {
      files: [{ kind: "image", fileName: "one.md" }], runRef: "run-a",
    })).toThrow(/identities/);
    expect(() => assertFileDeliveries(state(), after, {
      files: [{ kind: "file", fileName: "one.md", displayPath: "Other/one.md" }], runRef: "run-a",
    })).toThrow(/identities/);
  });

  it("reports the expected and observed file identities with the Run reference", () => {
    expect(() => assertFileDeliveries(state(), state(["wrong.md"], [sentRun()]), {
      files: [{ kind: "file", fileName: "one.md" }], runRef: "run-a",
    })).toThrow(/run-a.*one\.md.*wrong\.md/);
  });

  it("checks every batch member in order, or an explicit unordered multiset", () => {
    const run = sentRun();
    run.steps.push({ ...run.steps[0]!, stepId: "send#2" });
    run.effects.push({ stepId: "send#2", state: "accepted" });
    const files = [{ kind: "file" as const, fileName: "one.md" }, { kind: "file" as const, fileName: "two.md" }];
    expect(() => assertFileDeliveries(state(), state(["two.md", "one.md"], [run]), { files, runRef: "run-a" })).toThrow(/identities/);
    expect(() => assertFileDeliveries(state(), state(["two.md", "one.md"], [run]), { files, runRef: "run-a", order: "any" })).not.toThrow();
    expect(() => assertFileDeliveries(state(), state(["one.md", "one.md"], [run]), { files, runRef: "run-a", order: "any" })).toThrow(/identities/);
  });

  it("rejects empty success expectations and ambiguous duplicate names", () => {
    expect(() => assertFileDeliveries(state(), state(), { files: [], runRef: "run-a" })).toThrow(/nonempty/);
    expect(() => assertFileDeliveries(state(), state(["one.md", "one.md"], [sentRun()]), {
      files: [{ kind: "file", fileName: "one.md" }, { kind: "file", fileName: "one.md" }], runRef: "run-a",
    })).toThrow(/ambiguous/);
  });

  it.each(["prepared", "rejected", "unknown"] as const)("rejects an outbox success with a %s Effect", (effectState) => {
    const run = sentRun(); run.effects[0]!.state = effectState;
    expect(() => assertFileDeliveries(state(), state(["one.md"], [run]), {
      files: [{ kind: "file", fileName: "one.md" }], runRef: "run-a",
    })).toThrow(/Effect/);
  });

  it("rejects missing Effects, extra Effects and the wrong Run", () => {
    const run = sentRun(); run.effects = [];
    const expected = { files: [{ kind: "file" as const, fileName: "one.md" }], runRef: "run-a" };
    expect(() => assertFileDeliveries(state(), state(["one.md"], [run]), expected)).toThrow(/Effect/);
    expect(() => assertFileDeliveries(state(), state(["one.md"], [sentRun(), sentRun("extra")]), expected)).toThrow(/Effect/);
    expect(() => assertFileDeliveries(state(), state(["one.md"], [sentRun("other")]), expected)).toThrow(/Run run-a/);
  });

  it("rejects a changed or shortened historical outbox prefix", () => {
    for (const after of [state(["changed.md", "one.md"], [sentRun()]), state([], [])]) {
      expect(() => assertFileDeliveries(state(["old.md"]), after, {
        files: [{ kind: "file", fileName: "one.md" }], runRef: "run-a",
      })).toThrow(/outbox prefix/);
    }
  });
});

describe("no new outbound delivery", () => {
  it("does not accept an empty outbox when an outbound Effect is unresolved", () => {
    const run = sentRun(); run.status = "running"; run.effects[0]!.state = "prepared";
    expect(() => assertNoFileDelivery(state(), state([], [run]))).toThrow(/Effect/);
  });
  it("allows unchanged historical sends and local edits, but rejects new sends and unknown Effects", () => {
    const before = state(["old.md"], [sentRun("old")]);
    const local = sentRun("edit"); local.steps[0]!.capabilityId = "files.edit";
    expect(() => assertNoFileDelivery(before, state(["old.md"], [local, sentRun("old")]))).not.toThrow();
    expect(() => assertNoFileDelivery(before, state(["old.md", "one.md"], [sentRun("old"), sentRun()]))).toThrow(/delivery/);
    for (const value of ["unknown", "accepted"] as const) {
      const run = sentRun(); run.effects[0]!.state = value;
      expect(() => assertNoFileDelivery(state(), state([], [run]))).toThrow(/Effect/);
    }
    const rejected = sentRun(); rejected.status = "failed"; rejected.effects[0]!.state = "rejected";
    expect(() => assertNoFileDelivery(state(), state([], [rejected]))).not.toThrow();
  });
});

describe("Run identity and creation policy", () => {
  it("rejects success on another Run while the original choice remains pending", () => {
    const pending = sentRun(); pending.status = "needs_input"; pending.effects = []; pending.steps = [];
    expect(() => assertRunTransition(state([], [pending, sentRun("other")]), state([], [pending, sentRun("other")]), {
      existing: [{ runRef: "run-a", status: "succeeded" }],
    })).toThrow(/Run run-a/);
  });
  it("resumes the original Run despite list reordering, and forbids an extra Run", () => {
    const pending = sentRun(); pending.status = "needs_input"; pending.effects = []; pending.steps = [];
    const before = state([], [sentRun("old"), pending]);
    const expected = { existing: [{ runRef: "run-a", status: "succeeded" as const }] };
    expect(() => assertRunTransition(before, state([], [sentRun(), sentRun("old")]), expected)).not.toThrow();
    expect(() => assertRunTransition(before, state([], [sentRun(), sentRun("old"), sentRun("extra")]), expected)).toThrow(/new Run/);
  });
  it("allows only the explicitly expected replacement and checks its reason and status", () => {
    const pending = sentRun(); pending.status = "needs_input"; pending.effects = []; pending.steps = [];
    const cancelled = { ...pending, status: "cancelled" as const, errorCode: "superseded" };
    const expected = { existing: [{ runRef: "run-a", status: "cancelled" as const, errorCode: "superseded" }],
      created: { workflowId: "weixin.send-files", status: "succeeded" as const } };
    const before = state([], [pending]);
    expect(assertRunTransition(before, state([], [sentRun("new"), cancelled]), expected)?.runRef).toBe("new");
    expect(() => assertRunTransition(before, state([], [cancelled]), expected)).toThrow(/new Run/);
    expect(() => assertRunTransition(before, state([], [sentRun("new"), sentRun("extra"), cancelled]), expected)).toThrow(/new Run/);
    expect(() => assertRunTransition(before, state([], [sentRun("new"), { ...cancelled, errorCode: "wrong" }]), expected)).toThrow(/reason/);
    expect(() => assertRunTransition(before, state([], [sentRun("new"), cancelled]), { ...expected, created: { workflowId: "wrong", status: "succeeded" } })).toThrow(/workflow/);
    expect(() => assertRunTransition(before, state([], [sentRun("new"), cancelled]), { ...expected, created: { workflowId: "weixin.send-files", status: "failed" } })).toThrow(/status/);
    expect(() => assertRunTransition(before, state([], [cancelled]), { existing: expected.existing })).not.toThrow();
  });
  it("fails incomplete and ambiguous public observations explicitly", () => {
    expect(() => assertNoFileDelivery(state(), { ...state(), fixtureOutbox: undefined! })).toThrow(/missing outbox/);
    expect(() => assertNoFileDelivery(state(), { ...state(), workflows: undefined! })).toThrow(/missing Run/);
    expect(() => assertRunTransition(state(), state([], [sentRun(), sentRun()]))).toThrow(/duplicate/);
    expect(() => assertRunTransition(state([], [sentRun()]), state())).toThrow(/missing from after/);
    expect(() => assertRunTransition(state(), state([], Array.from({ length: 50 }, (_, i) => sentRun(String(i)))))).toThrow(/truncated/);
    const run = sentRun(); run.effects.push({ stepId: "send#1", state: "accepted" });
    expect(() => assertRunTransition(state(), state([], [run]))).toThrow(/duplicate Effect/);
    const invalid = state(["one.md"]); invalid.fixtureOutbox[0]!.displayPath = "";
    expect(() => assertNoFileDelivery(state(), invalid)).toThrow(/incomplete outbox/);
  });
  it("does not use a historical Effect to justify a new delivery", () => {
    expect(() => assertFileDeliveries(state([], [sentRun()]), state(["one.md"], [sentRun()]), {
      files: [{ kind: "file", fileName: "one.md" }], runRef: "run-a",
    })).toThrow(/current Effect/);
  });
  it("rejects a disappearing Effect instead of treating it as no new delivery", () => {
    const before = state([], [sentRun()]);
    const incomplete = sentRun(); incomplete.effects = [];
    expect(() => assertNoFileDelivery(before, state([], [incomplete]))).toThrow(/Effect.*missing/);
  });
});
