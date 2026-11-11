import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { pendingChoiceReplaced, WorkflowEngine, type WorkflowTemplate } from "../src/workflow-engine.js";
import { ConversationWorkflowTriggerAdapter } from "../src/conversation-workflow-trigger-adapter.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";

const tempDirs: string[] = [];

const readCapability = (id: string) => ({
  id,
  version: 1,
  effect: "read" as const,
  retryClass: "pure" as const,
  inputSchema: { type: "object" as const },
  outputSchema: {},
});

function inputGateFixture(id: string, expiresInMs = 60_000) {
  const searchCapability = `${id}.search`;
  const useCapability = `${id}.use`;
  const template: WorkflowTemplate = {
    id, version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
    effectBudget: { read: 2 },
    steps: [
      { id: "search", capability: searchCapability, capabilityVersion: 1, timeoutMs: 1_000 },
      {
        kind: "input_gate", id: "choose", dependsOn: ["search"],
        candidates: { dependency: "search", path: ["matches"] },
        selectionSchema: { type: "string" }, autoSelect: "unique_only", expiresInMs,
      },
      {
        id: "use", capability: useCapability, capabilityVersion: 1, dependsOn: ["choose"],
        inputBindings: { selected: { dependency: "choose" } }, timeoutMs: 1_000,
      },
    ],
  };
  return {
    template,
    searchCapability,
    useCapability,
    catalog: [
      {
        ...readCapability(searchCapability),
        outputSchema: {
          type: "object" as const, required: ["matches"], additionalProperties: false,
          properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
        },
      },
      {
        ...readCapability(useCapability),
        inputSchema: {
          type: "object" as const, required: ["selected"], additionalProperties: false,
          properties: { selected: { type: "string" as const } },
        },
      },
    ],
  };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("WorkflowEngine", () => {
  it("access_context_and_legacy_run_regression: retires only unfinished legacy resolver runs", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-retire-capability-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const schema = new WorkflowEngine(databasePath);
    await schema.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.prepare(`
      INSERT INTO workflow_run(
        run_id, source, trigger_id, requested_workflow_id, trigger_input_refs_json,
        occurred_at, status, revision, created_at, updated_at
      ) VALUES ('legacy-run-1', 'weixin', 'legacy-unfinished', 'legacy.resolve-file', '{}', 1, 'running', 2, 1, 1)
    `).run();
    legacy.prepare(`
      INSERT INTO workflow_transition(run_id, revision, event, occurred_at)
      VALUES ('legacy-run-1', 2, 'running', 1)
    `).run();
    legacy.prepare(`
      INSERT INTO workflow_plan(run_id, spec_id, spec_version, plan_hash, plan_json, created_at)
      VALUES ('legacy-run-1', 'legacy.resolve-file', 1, ?, ?, 1)
    `).run("a".repeat(64), JSON.stringify({ effectBudget: { read: 1 }, authorizationSnapshots: [], steps: [] }));
    legacy.prepare(`
      INSERT INTO workflow_step(
        run_id, step_id, ordinal, capability_id, capability_version, depends_on_json,
        resource_keys_json, status, attempt_count, updated_at
      ) VALUES ('legacy-run-1', 'resolve', 0, 'files.resolve', 1, '[]', '[]', 'pending', 0, 1)
    `).run();
    legacy.close();

    const engine = new WorkflowEngine(databasePath);
    const unfinished = { runId: "legacy-run-1" };
    expect(engine.get(unfinished.runId)?.status).toBe("running");

    expect(engine.retirePendingCapability("files.resolve", 1, "workflow_file_resolver_retired"))
      .toEqual([unfinished.runId]);
    expect(engine.get(unfinished.runId)).toMatchObject({
      status: "failed",
      errorCode: "workflow_file_resolver_retired",
      plan: { steps: [{ stepId: "resolve", status: "skipped" }] },
    });
    expect(engine.retirePendingCapability("files.resolve", 1, "workflow_file_resolver_retired")).toEqual([]);
    await engine.start();
    await engine.close();
  });

  it("keeps a successful step output available to the trusted host after restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-output-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const template: WorkflowTemplate = {
      id: "notes.search-from-weixin",
      version: 1,
      maxSteps: 1,
      maxDepth: 1,
      maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [{ id: "search", capability: "notes.search-request", capabilityVersion: 1, timeoutMs: 1_000 }],
    };
    const provider = {
      catalog: () => [{
        ...readCapability("notes.search-request"),
        outputSchema: {
          type: "object" as const,
          required: ["matches"],
          additionalProperties: false,
          properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
        },
      }],
      invoke: async () => ({ status: "succeeded" as const, output: { matches: ["Inbox.md"] } }),
    };
    const first = new WorkflowEngine(databasePath, { templates: [template], providers: [provider] });
    await first.start();
    const submission = await first.submit({
      triggerId: "note-search-message",
      source: "weixin",
      occurredAt: 1_800_000_000_000,
      requestedWorkflowId: template.id,
    });
    expect(first.getStepOutput(submission.runId, "search")).toEqual({ matches: ["Inbox.md"] });
    expect(JSON.stringify(first.getPublicState())).not.toContain("Inbox.md");
    await first.close();

    const reopened = new WorkflowEngine(databasePath, { templates: [template], providers: [provider] });
    expect(reopened.getStepOutput(submission.runId, "search")).toEqual({ matches: ["Inbox.md"] });
    await reopened.close();
  });

  it("adds durable step output storage when opening a pre-output workflow database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-output-migration-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const initial = new WorkflowEngine(databasePath);
    await initial.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE workflow_step DROP COLUMN output_json");
    legacy.close();
    const template: WorkflowTemplate = {
      id: "fixture.output-migration", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [{ id: "read", capability: "fixture.output-migration", capabilityVersion: 1, timeoutMs: 1_000 }],
    };
    const reopened = new WorkflowEngine(databasePath, {
      createRunId: () => "run-output-migration",
      templates: [template],
      providers: [{
        catalog: () => [readCapability("fixture.output-migration")],
        invoke: async () => ({ status: "succeeded" as const, output: "restored" }),
      }],
    });
    await reopened.start();
    await reopened.submit({
      triggerId: "fixture-output-migration", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    expect(reopened.getStepOutput("run-output-migration", "read")).toBe("restored");
    await reopened.close();
  });

  it("returns a bounded newest-first public projection without internal trigger or run identifiers", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-public-"));
    tempDirs.push(directory);
    let runSequence = 0;
    let now = 1_800_000_000_100;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      now: () => now,
      createRunId: () => `secret-run-${++runSequence}`,
    });

    await engine.submit({
      triggerId: "secret-trigger-first",
      source: "weixin",
      occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "media.send",
    });
    now += 100;
    await engine.submit({
      triggerId: "secret-trigger-second",
      source: "scheduler",
      occurredAt: 1_800_000_000_100,
      requestedWorkflowId: "notes.digest",
    });

    expect(engine.getPublicState(1)).toEqual({
      runs: [{
        runRef: `wf-${crypto.createHash("sha256").update("secret-run-2").digest("hex").slice(0, 12)}`,
        source: "scheduler",
        workflowId: "notes.digest",
        occurredAt: 1_800_000_000_100,
        status: "accepted",
        createdAt: 1_800_000_000_200,
        updatedAt: 1_800_000_000_200,
        steps: [],
        effects: [],
      }],
    });
    const serialized = JSON.stringify(engine.getPublicState());
    expect(serialized).not.toContain("secret-trigger");
    expect(serialized).not.toContain("secret-run");
    await engine.close();
  });

  it("returns the same durable run when a trigger is submitted again after restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-engine-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const trigger = {
      triggerId: "a".repeat(64),
      source: "weixin" as const,
      occurredAt: 1_800_000_000_000,
    };

    const first = new WorkflowEngine(databasePath, {
      now: () => 1_800_000_000_100,
      createRunId: () => "run-first",
    });
    const accepted = await first.submit(trigger);
    expect(accepted).toEqual({ runId: "run-first", duplicate: false });
    expect(first.get("run-first")).toEqual({
      runId: "run-first",
      source: "weixin",
      triggerId: "a".repeat(64),
      occurredAt: 1_800_000_000_000,
      status: "accepted",
      revision: 0,
      createdAt: 1_800_000_000_100,
      updatedAt: 1_800_000_000_100,
    });
    await first.close();

    const reopened = new WorkflowEngine(databasePath, {
      now: () => 1_800_000_000_200,
      createRunId: () => "run-must-not-be-used",
    });
    expect(await reopened.submit(trigger)).toEqual({ runId: "run-first", duplicate: true });
    expect(reopened.get("run-first")).toMatchObject({
      runId: "run-first",
      status: "accepted",
      createdAt: 1_800_000_000_100,
    });
    await reopened.close();
  });

  it("rejects a trigger key reused with different immutable metadata", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-conflict-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      now: () => 1_800_000_000_100,
      createRunId: () => "run-conflict",
    });
    const triggerId = "schedule:daily-news:2026-08-24:0830";

    await engine.submit({ triggerId, source: "scheduler", occurredAt: 1_800_000_000_000 });
    await expect(engine.submit({
      triggerId,
      source: "scheduler",
      occurredAt: 1_800_000_001_000,
    })).rejects.toThrow("workflow_trigger_conflict");
    expect(engine.get("run-conflict")).toMatchObject({ occurredAt: 1_800_000_000_000 });
    await engine.close();
  });

  it("rejects malformed triggers before creating a durable run", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-invalid-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-after-invalid",
    });

    await expect(engine.submit({
      triggerId: "x".repeat(513),
      source: "fixture",
      occurredAt: 1_800_000_000_000,
    })).rejects.toThrow("workflow_trigger_id_invalid");
    expect(engine.get("run-after-invalid")).toBeUndefined();
    await engine.close();
  });

  it("compiles and runs a reviewed fixture DAG in dependency order", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-fixture-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      now: () => 1_800_000_000_100,
      createRunId: () => "run-fixture",
      templates: [{
        id: "fixture.pipeline",
        version: 1,
        maxSteps: 32,
        maxDepth: 8,
        maxParallelism: 4,
        effectBudget: { read: 2 },
        steps: [
          { id: "seed", capability: "fixture.seed", capabilityVersion: 1, input: { value: "alpha" }, timeoutMs: 1_000 },
          { id: "finish", capability: "fixture.finish", capabilityVersion: 1, dependsOn: ["seed"], timeoutMs: 1_000 },
        ],
      }],
      providers: [{
        catalog: () => [
          readCapability("fixture.seed"),
          readCapability("fixture.finish"),
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.seed") {
            return { status: "succeeded", output: request.input.value };
          }
          if (request.dependencyResults.seed !== "alpha") {
            return { status: "failed", errorCode: "fixture_dependency_missing" };
          }
          return { status: "succeeded", output: "done" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-run-1",
      source: "fixture",
      occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.pipeline",
    });
    await engine.start();

    expect(engine.get("run-fixture")).toMatchObject({
      status: "succeeded",
      plan: {
        specId: "fixture.pipeline",
        specVersion: 1,
        steps: [
          { stepId: "seed", capabilityId: "fixture.seed", status: "succeeded" },
          { stepId: "finish", capabilityId: "fixture.finish", dependsOn: ["seed"], status: "succeeded" },
        ],
      },
    });
    await engine.close();
  });

  it("runs independent read steps concurrently before their dependent step", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-parallel-"));
    tempDirs.push(directory);
    let active = 0;
    let maxActive = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-parallel",
      templates: [{
        id: "fixture.parallel",
        version: 1,
        maxSteps: 5,
        maxDepth: 2,
        maxParallelism: 2,
        effectBudget: { read: 4 },
        steps: [
          { id: "left", capability: "fixture.branch", capabilityVersion: 1, timeoutMs: 1_000 },
          { id: "right", capability: "fixture.branch", capabilityVersion: 1, timeoutMs: 1_000 },
          { id: "third", capability: "fixture.branch", capabilityVersion: 1, timeoutMs: 1_000 },
          { id: "join", capability: "fixture.join", capabilityVersion: 1, dependsOn: ["left", "right", "third"], timeoutMs: 1_000 },
        ],
      }],
      providers: [{
        catalog: () => [
          readCapability("fixture.branch"),
          readCapability("fixture.join"),
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.join") {
            const overlapped = maxActive === 2 &&
              request.dependencyResults.left === "branch-complete" &&
              request.dependencyResults.right === "branch-complete" &&
              request.dependencyResults.third === "branch-complete";
            return overlapped
              ? { status: "succeeded", output: "joined" }
              : { status: "failed", errorCode: "fixture_not_parallel" };
          }
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          return { status: "succeeded", output: "branch-complete" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-parallel-1",
      source: "fixture",
      occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.parallel",
    });
    await engine.start();

    expect(engine.get("run-parallel")).toMatchObject({
      status: "succeeded",
      plan: {
        steps: [
          { status: "succeeded" },
          { status: "succeeded" },
          { status: "succeeded" },
          { status: "succeeded" },
        ],
      },
    });
    await engine.close();
  });

  it("fails a cyclic plan with a sanitized compiler error and no partial plan", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-cycle-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-cycle",
      templates: [{
        id: "fixture.cycle",
        version: 1,
        maxSteps: 2,
        maxDepth: 2,
        maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "left", capability: "fixture.read", capabilityVersion: 1, dependsOn: ["right"], timeoutMs: 1_000 },
          { id: "right", capability: "fixture.read", capabilityVersion: 1, dependsOn: ["left"], timeoutMs: 1_000 },
        ],
      }],
      providers: [{
        catalog: () => [readCapability("fixture.read")],
        invoke: async () => ({ status: "succeeded" }),
      }],
    });

    await engine.submit({
      triggerId: "fixture-cycle-1",
      source: "fixture",
      occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.cycle",
    });
    await engine.start();

    expect(engine.get("run-cycle")).toMatchObject({
      status: "failed",
      errorCode: "workflow_plan_cycle",
    });
    expect(engine.get("run-cycle")?.plan).toBeUndefined();
    await engine.close();
  });

  it("rejects an invalid capability catalog when the engine starts", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-catalog-"));
    tempDirs.push(directory);

    expect(() => new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      providers: [{
        catalog: () => [{ ...readCapability("fixture.invalid"), version: 0 }],
        invoke: async () => ({ status: "succeeded" }),
      }],
    })).toThrow("workflow_capability_invalid");
  });

  it("keeps the frozen plan version when the registered template changes after restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-frozen-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const provider = {
      catalog: () => [readCapability("fixture.read")],
      invoke: async () => ({ status: "succeeded" as const, output: "done" }),
    };
    const first = new WorkflowEngine(databasePath, {
      createRunId: () => "run-frozen",
      templates: [{
        id: "fixture.versioned", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{ id: "original", capability: "fixture.read", capabilityVersion: 1, timeoutMs: 1_000 }],
      }],
      providers: [provider],
    });
    await first.submit({
      triggerId: "fixture-versioned-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.versioned",
    });
    await first.start();
    const originalHash = first.get("run-frozen")?.plan?.planHash;
    expect(originalHash).toMatch(/^[a-f0-9]{64}$/);
    await first.close();

    const reopened = new WorkflowEngine(databasePath, {
      templates: [{
        id: "fixture.versioned", version: 2, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{ id: "replacement", capability: "fixture.read", capabilityVersion: 1, timeoutMs: 1_000 }],
      }],
      providers: [provider],
    });
    expect(reopened.get("run-frozen")).toMatchObject({
      status: "succeeded",
      plan: {
        specId: "fixture.versioned",
        specVersion: 1,
        planHash: originalHash,
        steps: [{ stepId: "original" }],
      },
    });
    await reopened.close();
  });

  it("fails a step that exceeds its reviewed timeout without blocking the backlog", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-timeout-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-timeout",
      templates: [{
        id: "fixture.timeout", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{ id: "slow", capability: "fixture.slow", capabilityVersion: 1, timeoutMs: 5 }],
      }],
      providers: [{
        catalog: () => [readCapability("fixture.slow")],
        invoke: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-timeout-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.timeout",
    });
    await engine.start();

    expect(engine.get("run-timeout")).toMatchObject({
      status: "failed",
      errorCode: "workflow_step_timeout",
      plan: { steps: [{ stepId: "slow", status: "failed" }] },
    });
    await engine.close();
  });

  it("allows a read provider with its own liveness policy to run without a workflow deadline", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-provider-liveness-"));
    tempDirs.push(directory);
    let finish: () => void = () => {};
    const providerFinished = new Promise<void>((resolve) => { finish = resolve; });
    const template = {
      id: "fixture.provider-liveness", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [{
        id: "resolve", capability: "fixture.provider-liveness", capabilityVersion: 1,
        timeoutMode: "provider_managed",
      }],
    } as WorkflowTemplate;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-provider-liveness",
      templates: [template],
      providers: [{
        catalog: () => [readCapability("fixture.provider-liveness")],
        invoke: async () => {
          await providerFinished;
          return { status: "succeeded" as const };
        },
      }],
    });

    const submission = engine.submit({
      triggerId: "fixture-provider-liveness-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: template.id,
    });
    await Promise.resolve();
    finish();
    await submission;
    await engine.start();

    expect(engine.get("run-provider-liveness")).toMatchObject({
      status: "succeeded",
      plan: { steps: [{ stepId: "resolve", status: "succeeded" }] },
    });
    await engine.close();
  });

  it("rejects a read step that omits both an absolute timeout and the provider-managed marker", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-missing-timeout-policy-"));
    tempDirs.push(directory);
    const template = {
      id: "fixture.missing-timeout-policy", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [{ id: "read", capability: "fixture.missing-timeout-policy", capabilityVersion: 1 }],
    } as WorkflowTemplate;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      templates: [template],
      providers: [{
        catalog: () => [readCapability("fixture.missing-timeout-policy")],
        invoke: async () => ({ status: "succeeded" as const }),
      }],
    });

    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-missing-timeout-policy-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: template.id,
    });
    expect(engine.get(submission.runId)).toMatchObject({
      status: "failed",
      errorCode: "workflow_step_timeout_invalid",
    });
    await engine.close();
  });

  it("rejects an untimed external effect because only read providers may own liveness", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-untimed-effect-"));
    tempDirs.push(directory);
    const template = {
      id: "fixture.untimed-effect", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
      effectBudget: { external_send: 1 },
      steps: [{
        id: "send", capability: "fixture.untimed-send", capabilityVersion: 1,
        timeoutMode: "provider_managed",
      }],
    } as WorkflowTemplate;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      templates: [template],
      providers: [{
        catalog: () => [{
          id: "fixture.untimed-send", version: 1, effect: "external_send" as const,
          retryClass: "non_idempotent" as const, inputSchema: { type: "object" as const }, outputSchema: {},
        }],
        invoke: async () => ({ status: "succeeded" as const }),
      }],
    });

    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-untimed-effect-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: template.id,
    });
    expect(engine.get(submission.runId)).toMatchObject({
      status: "failed",
      errorCode: "workflow_step_timeout_invalid",
    });
    await engine.close();
  });

  it("rejects a static step input that violates the capability schema before invoking its provider", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-schema-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-schema-invalid",
      templates: [{
        id: "fixture.schema", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "search", capability: "fixture.search", capabilityVersion: 1,
          input: { query: 42 }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          id: "fixture.search", version: 1, effect: "read", retryClass: "pure",
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: { query: { type: "string" } },
            additionalProperties: false,
          },
          outputSchema: { type: "string" },
        }],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded", output: "unexpected" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-schema-invalid-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.schema",
    });
    await engine.start();

    expect(engine.get("run-schema-invalid")).toMatchObject({
      status: "failed",
      errorCode: "workflow_step_input_invalid",
    });
    expect(engine.get("run-schema-invalid")?.plan).toBeUndefined();
    expect(invocationCount).toBe(0);
    await engine.close();
  });

  it("fails a step whose provider output violates the frozen capability schema", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-output-schema-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-output-invalid",
      templates: [{
        id: "fixture.output", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{ id: "read", capability: "fixture.output", capabilityVersion: 1, timeoutMs: 1_000 }],
      }],
      providers: [{
        catalog: () => [{ ...readCapability("fixture.output"), outputSchema: { type: "string" } }],
        invoke: async () => ({ status: "succeeded", output: 42 }),
      }],
    });

    await engine.submit({
      triggerId: "fixture-output-invalid-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.output",
    });
    await engine.start();

    expect(engine.get("run-output-invalid")).toMatchObject({
      status: "failed",
      errorCode: "workflow_step_output_invalid",
      plan: { steps: [{ stepId: "read", status: "failed" }] },
    });
    await engine.close();
  });

  it("skips a conditional step when its dependency output does not match the reviewed predicate", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-condition-"));
    tempDirs.push(directory);
    let guardedInvocations = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-condition",
      templates: [{
        id: "fixture.condition", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "gate", capability: "fixture.gate", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "guarded", capability: "fixture.guarded", capabilityVersion: 1,
            dependsOn: ["gate"], timeoutMs: 1_000,
            when: { dependency: "gate", path: ["enabled"], equals: true },
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.gate"),
            outputSchema: {
              type: "object", required: ["enabled"],
              properties: { enabled: { type: "boolean" } }, additionalProperties: false,
            },
          },
          readCapability("fixture.guarded"),
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.gate") {
            return { status: "succeeded", output: { enabled: false } };
          }
          guardedInvocations += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-condition-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.condition",
    });
    await engine.start();

    expect(engine.get("run-condition")).toMatchObject({
      status: "succeeded",
      plan: { steps: [{ stepId: "gate", status: "succeeded" }, { stepId: "guarded", status: "skipped" }] },
    });
    expect(guardedInvocations).toBe(0);
    await engine.close();
  });

  it("binds a dependency output into a typed capability input", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-binding-"));
    tempDirs.push(directory);
    const inputs: unknown[] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-binding",
      templates: [{
        id: "fixture.binding", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "seed", capability: "fixture.seed", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "consume", capability: "fixture.consume", capabilityVersion: 1,
            dependsOn: ["seed"], timeoutMs: 1_000,
            inputBindings: { query: { dependency: "seed", path: ["query"] } },
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.seed"),
            outputSchema: {
              type: "object", required: ["query"],
              properties: { query: { type: "string" } }, additionalProperties: false,
            },
          },
          {
            ...readCapability("fixture.consume"),
            inputSchema: {
              type: "object", required: ["query"],
              properties: { query: { type: "string" } }, additionalProperties: false,
            },
          },
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.seed") {
            return { status: "succeeded", output: { query: "typed-result" } };
          }
          inputs.push(request.input);
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-binding-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.binding",
    });
    await engine.start();

    expect(engine.get("run-binding")).toMatchObject({ status: "succeeded" });
    expect(inputs).toEqual([{ query: "typed-result" }]);
    await engine.close();
  });

  it("rejects an input binding whose source and target schemas are incompatible", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-binding-schema-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-binding-schema",
      templates: [{
        id: "fixture.binding-schema", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "seed", capability: "fixture.seed", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "consume", capability: "fixture.consume", capabilityVersion: 1,
            dependsOn: ["seed"], timeoutMs: 1_000,
            inputBindings: { query: { dependency: "seed", path: ["enabled"] } },
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.seed"),
            outputSchema: {
              type: "object", required: ["enabled"],
              properties: { enabled: { type: "boolean" } }, additionalProperties: false,
            },
          },
          {
            ...readCapability("fixture.consume"),
            inputSchema: {
              type: "object", required: ["query"],
              properties: { query: { type: "string" } }, additionalProperties: false,
            },
          },
        ],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-binding-schema-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.binding-schema",
    });
    await engine.start();

    expect(engine.get("run-binding-schema")).toMatchObject({
      status: "failed", errorCode: "workflow_input_binding_schema_incompatible",
    });
    expect(invocationCount).toBe(0);
    await engine.close();
  });

  it("fails the consumer step when an optional bound output is absent at runtime", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-binding-missing-"));
    tempDirs.push(directory);
    let consumerInvocations = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-binding-missing",
      templates: [{
        id: "fixture.binding-missing", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "seed", capability: "fixture.seed", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "consume", capability: "fixture.consume", capabilityVersion: 1,
            dependsOn: ["seed"], timeoutMs: 1_000,
            inputBindings: { query: { dependency: "seed", path: ["query"] } },
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.seed"),
            outputSchema: {
              type: "object", properties: { query: { type: "string" } }, additionalProperties: false,
            },
          },
          {
            ...readCapability("fixture.consume"),
            inputSchema: {
              type: "object", required: ["query"],
              properties: { query: { type: "string" } }, additionalProperties: false,
            },
          },
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.seed") return { status: "succeeded", output: {} };
          consumerInvocations += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-binding-missing-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.binding-missing",
    });
    await engine.start();

    expect(engine.get("run-binding-missing")).toMatchObject({
      status: "failed", errorCode: "workflow_input_binding_missing",
      plan: { steps: [{ stepId: "seed", status: "succeeded" }, { stepId: "consume", status: "failed" }] },
    });
    expect(consumerInvocations).toBe(0);
    await engine.close();
  });

  it("freezes reviewed resource keys in canonical order", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-resources-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-resources",
      templates: [{
        id: "fixture.resources", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.read", capabilityVersion: 1, timeoutMs: 1_000,
          resourceKeys: ["vault:grant-z:file-b", "vault:grant-a:file-a"],
        }],
      }],
      providers: [{
        catalog: () => [readCapability("fixture.read")],
        invoke: async () => ({ status: "succeeded" }),
      }],
    });

    await engine.submit({
      triggerId: "fixture-resources-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.resources",
    });
    await engine.start();

    expect(engine.get("run-resources")).toMatchObject({
      status: "succeeded",
      plan: {
        steps: [{
          stepId: "read",
          resourceKeys: ["vault:grant-a:file-a", "vault:grant-z:file-b"],
        }],
      },
    });
    await engine.close();
  });

  it("resolves a dynamic resource key only from a trusted dependency export", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-dynamic-resource-"));
    tempDirs.push(directory);
    const invokedResourceKeys: string[][] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-dynamic-resource",
      templates: [{
        id: "fixture.dynamic-resource", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "discover", capability: "fixture.discover", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "read", capability: "fixture.read", capabilityVersion: 1,
            dependsOn: ["discover"], timeoutMs: 1_000,
            resourceKeys: ["vault:grant-a:root"],
            resourceKeyBindings: [{ dependency: "discover", output: "document" }],
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.discover"),
            outputSchema: {
              type: "object", required: ["resourceKey"],
              properties: { resourceKey: { type: "string" } }, additionalProperties: false,
            },
            resourceKeyOutputs: { document: { path: ["resourceKey"] } },
          },
          readCapability("fixture.read"),
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.discover") {
            return { status: "succeeded", output: { resourceKey: "vault:grant-a:file-42" } };
          }
          invokedResourceKeys.push(request.resourceKeys);
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-dynamic-resource-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.dynamic-resource",
    });
    await engine.start();

    expect(engine.get("run-dynamic-resource")).toMatchObject({
      status: "succeeded",
      plan: { steps: [
        { stepId: "discover", resourceKeys: [] },
        { stepId: "read", resourceKeys: ["vault:grant-a:file-42", "vault:grant-a:root"] },
      ] },
    });
    expect(invokedResourceKeys).toEqual([["vault:grant-a:file-42", "vault:grant-a:root"]]);
    await engine.close();
  });

  it("rejects a dynamic resource key binding that the dependency did not declare", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-untrusted-resource-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-untrusted-resource",
      templates: [{
        id: "fixture.untrusted-resource", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "discover", capability: "fixture.discover", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "read", capability: "fixture.read", capabilityVersion: 1,
            dependsOn: ["discover"], timeoutMs: 1_000,
            resourceKeyBindings: [{ dependency: "discover", output: "undeclared" }],
          },
        ],
      }],
      providers: [{
        catalog: () => [readCapability("fixture.discover"), readCapability("fixture.read")],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-untrusted-resource-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.untrusted-resource",
    });
    await engine.start();

    expect(engine.get("run-untrusted-resource")).toMatchObject({
      status: "failed", errorCode: "workflow_resource_key_binding_invalid",
    });
    expect(invocationCount).toBe(0);
    await engine.close();
  });

  it("fails closed when a trusted dynamic resource export returns an invalid key", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-invalid-resource-"));
    tempDirs.push(directory);
    let readInvocations = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-invalid-resource",
      templates: [{
        id: "fixture.invalid-resource", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "discover", capability: "fixture.discover", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "read", capability: "fixture.read", capabilityVersion: 1,
            dependsOn: ["discover"], timeoutMs: 1_000,
            resourceKeyBindings: [{ dependency: "discover", output: "document" }],
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.discover"),
            outputSchema: {
              type: "object", required: ["resourceKey"],
              properties: { resourceKey: { type: "string" } }, additionalProperties: false,
            },
            resourceKeyOutputs: { document: { path: ["resourceKey"] } },
          },
          readCapability("fixture.read"),
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.discover") {
            return { status: "succeeded", output: { resourceKey: "" } };
          }
          readInvocations += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-invalid-resource-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.invalid-resource",
    });
    await engine.start();

    expect(engine.get("run-invalid-resource")).toMatchObject({
      status: "failed", errorCode: "workflow_resource_key_resolution_failed",
      plan: { steps: [{ stepId: "discover", status: "succeeded" }, { stepId: "read", status: "failed" }] },
    });
    expect(readInvocations).toBe(0);
    await engine.close();
  });

  it("freezes a saved module permission snapshot and checks the scope before provider invocation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-module-permission-"));
    tempDirs.push(directory);
    const grantedDirectory = path.join(directory, "Vault");
    fs.mkdirSync(grantedDirectory);
    const permissions = new WorkflowModulePermissionStore(path.join(directory, "permissions.sqlite"));
    permissions.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "vault", label: "Vault", directory: grantedDirectory, read: true, write: false }],
    });
    const inputs: unknown[] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-module-permission",
      modulePermissions: permissions,
      templates: [{
        id: "fixture.module-permission", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.notes-read", capabilityVersion: 1,
          input: { scopeId: "vault" }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.notes-read"),
          inputSchema: {
            type: "object", required: ["scopeId"],
            properties: { scopeId: { type: "string" } }, additionalProperties: false,
          },
          modulePermission: { moduleId: "notes", access: "read", scopeInput: "scopeId" },
        }],
        invoke: async (request) => {
          inputs.push(request.input);
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-module-permission-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.module-permission",
    });
    await engine.start();

    expect(engine.get("run-module-permission")).toMatchObject({
      status: "succeeded",
      plan: { authorizationSnapshots: [{
        moduleId: "notes", revision: 1, scopes: [{ scopeId: "vault", read: true, write: false }],
      }] },
    });
    expect(JSON.stringify(engine.get("run-module-permission")?.plan)).not.toContain(grantedDirectory);
    expect(inputs).toEqual([{ scopeId: "vault" }]);
    await engine.close();
    await permissions.close();
  });

  it("binds a generic file capability to the literal module declared by its reviewed template", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-generic-module-permission-"));
    tempDirs.push(directory);
    const grantedDirectory = path.join(directory, "Vault");
    fs.mkdirSync(grantedDirectory);
    const permissions = new WorkflowModulePermissionStore(path.join(directory, "permissions.sqlite"));
    permissions.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "vault", label: "Vault", directory: grantedDirectory, read: true, write: false }],
    });
    const inputs: unknown[] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-generic-module-permission",
      modulePermissions: permissions,
      templates: [{
        id: "fixture.generic-module-permission", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "find", capability: "fixture.files-find", capabilityVersion: 1,
          input: { moduleId: "notes", scopeId: "vault" }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.files-find"),
          inputSchema: {
            type: "object", required: ["moduleId", "scopeId"],
            properties: { moduleId: { type: "string" }, scopeId: { type: "string" } }, additionalProperties: false,
          },
          modulePermission: { moduleIdInput: "moduleId", access: "read", scopeInput: "scopeId" },
        }],
        invoke: async (request) => {
          inputs.push(request.input);
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-generic-module-permission-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.generic-module-permission",
    });
    await engine.start();

    expect(engine.get("run-generic-module-permission")).toMatchObject({
      status: "succeeded",
      plan: { authorizationSnapshots: [{ moduleId: "notes", revision: 1 }] },
    });
    expect(inputs).toEqual([{ moduleId: "notes", scopeId: "vault" }]);
    await engine.close();
    await permissions.close();
  });

  it("freezes and validates every scope in a reviewed multi-scope read", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-multi-scope-permission-"));
    tempDirs.push(directory);
    const downloads = path.join(directory, "Downloads");
    const pictures = path.join(directory, "Pictures");
    fs.mkdirSync(downloads);
    fs.mkdirSync(pictures);
    const permissions = new WorkflowModulePermissionStore(path.join(directory, "permissions.sqlite"));
    permissions.save({
      moduleId: "local-media", expectedRevision: 0, confirmed: true,
      scopes: [
        { scopeId: "downloads", label: "Downloads", directory: downloads, read: true, write: false },
        { scopeId: "pictures", label: "Pictures", directory: pictures, read: true, write: false },
      ],
    });
    const inputs: unknown[] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-multi-scope-permission",
      modulePermissions: permissions,
      templates: [{
        id: "fixture.multi-scope-permission", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "find", capability: "fixture.files-find-many", capabilityVersion: 1,
          input: { moduleId: "local-media", scopeIds: ["downloads", "pictures"] }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.files-find-many"),
          inputSchema: {
            type: "object", required: ["moduleId", "scopeIds"],
            properties: {
              moduleId: { type: "string" },
              scopeIds: { type: "array", maxItems: 16, items: { type: "string" } },
            },
            additionalProperties: false,
          },
          modulePermission: { moduleIdInput: "moduleId", access: "read", scopeListInput: "scopeIds" },
        }],
        invoke: async (request) => {
          inputs.push(request.input);
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-multi-scope-permission-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.multi-scope-permission",
    });
    await engine.start();

    expect(engine.get("run-multi-scope-permission")).toMatchObject({
      status: "succeeded",
      plan: { authorizationSnapshots: [{
        moduleId: "local-media", revision: 1,
        scopes: [{ scopeId: "downloads", read: true }, { scopeId: "pictures", read: true }],
      }] },
    });
    expect(inputs).toEqual([{ moduleId: "local-media", scopeIds: ["downloads", "pictures"] }]);
    await engine.close();
    await permissions.close();
  });

  it("rejects a generic file template that binds its module through trigger input", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-bound-module-permission-"));
    tempDirs.push(directory);
    const grantedDirectory = path.join(directory, "Vault");
    fs.mkdirSync(grantedDirectory);
    const permissions = new WorkflowModulePermissionStore(path.join(directory, "permissions.sqlite"));
    permissions.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "vault", label: "Vault", directory: grantedDirectory, read: true, write: false }],
    });
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-bound-module-permission",
      modulePermissions: permissions,
      templates: [{
        id: "fixture.bound-module-permission", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "find", capability: "fixture.files-find", capabilityVersion: 1,
          input: { scopeId: "vault" }, triggerInputBindings: { moduleId: "moduleRef" }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.files-find"),
          inputSchema: {
            type: "object", required: ["moduleId", "scopeId"],
            properties: { moduleId: { type: "string" }, scopeId: { type: "string" } }, additionalProperties: false,
          },
          modulePermission: { moduleIdInput: "moduleId", access: "read", scopeInput: "scopeId" },
        }],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-bound-module-permission-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.bound-module-permission",
      inputRefs: { moduleRef: `opaque_${"a".repeat(32)}` },
    });
    await engine.start();

    expect(engine.get("run-bound-module-permission")).toMatchObject({
      status: "failed", errorCode: "workflow_step_input_invalid",
    });
    expect(invocationCount).toBe(0);
    await engine.close();
    await permissions.close();
  });

  it("rejects a module workflow during planning when no saved scope grants its access", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-module-denied-"));
    tempDirs.push(directory);
    const otherDirectory = path.join(directory, "Other");
    fs.mkdirSync(otherDirectory);
    const permissions = new WorkflowModulePermissionStore(path.join(directory, "permissions.sqlite"));
    permissions.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "other", label: "Other", directory: otherDirectory, read: true, write: false }],
    });
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-module-denied",
      modulePermissions: permissions,
      templates: [{
        id: "fixture.module-denied", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.notes-read", capabilityVersion: 1,
          input: { scopeId: "vault" }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.notes-read"),
          inputSchema: {
            type: "object", required: ["scopeId"],
            properties: { scopeId: { type: "string" } }, additionalProperties: false,
          },
          modulePermission: { moduleId: "notes", access: "read", scopeInput: "scopeId" },
        }],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-module-denied-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.module-denied",
    });
    await engine.start();

    expect(engine.get("run-module-denied")).toMatchObject({
      status: "blocked", errorCode: "workflow_module_permission_denied",
    });
    expect(engine.get("run-module-denied")?.plan).toBeUndefined();
    expect(invocationCount).toBe(0);
    await engine.close();
    await permissions.close();
  });

  it("blocks a scoped step when its saved grant is revoked after planning", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-module-revoked-"));
    tempDirs.push(directory);
    const grantedDirectory = path.join(directory, "Vault");
    fs.mkdirSync(grantedDirectory);
    const permissions = new WorkflowModulePermissionStore(path.join(directory, "permissions.sqlite"));
    permissions.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "vault", label: "Vault", directory: grantedDirectory, read: true, write: false }],
    });
    let releaseSeed!: () => void;
    let seedStarted!: () => void;
    const seedGate = new Promise<void>((resolve) => { releaseSeed = resolve; });
    const seedObserved = new Promise<void>((resolve) => { seedStarted = resolve; });
    let readInvocations = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-module-revoked",
      modulePermissions: permissions,
      templates: [{
        id: "fixture.module-revoked", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "seed", capability: "fixture.seed", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "read", capability: "fixture.notes-read", capabilityVersion: 1,
            dependsOn: ["seed"], input: { scopeId: "vault" }, timeoutMs: 1_000,
          },
        ],
      }],
      providers: [{
        catalog: () => [
          readCapability("fixture.seed"),
          {
            ...readCapability("fixture.notes-read"),
            inputSchema: {
              type: "object", required: ["scopeId"],
              properties: { scopeId: { type: "string" } }, additionalProperties: false,
            },
            modulePermission: { moduleId: "notes", access: "read", scopeInput: "scopeId" },
          },
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.seed") {
            seedStarted();
            await seedGate;
            return { status: "succeeded" };
          }
          readInvocations += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-module-revoked-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.module-revoked",
    });
    const started = engine.start();
    await seedObserved;
    permissions.save({ moduleId: "notes", expectedRevision: 1, confirmed: true, scopes: [] });
    releaseSeed();
    await started;

    expect(engine.get("run-module-revoked")).toMatchObject({
      status: "blocked", errorCode: "workflow_module_permission_denied",
      plan: { authorizationSnapshots: [{ moduleId: "notes", revision: 1 }] },
    });
    expect(readInvocations).toBe(0);
    await engine.close();
    await permissions.close();
  });

  it("does not let a permission expansion advance an already frozen run", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-module-expanded-"));
    tempDirs.push(directory);
    const initialDirectory = path.join(directory, "Initial");
    const laterDirectory = path.join(directory, "Later");
    fs.mkdirSync(initialDirectory);
    fs.mkdirSync(laterDirectory);
    const permissions = new WorkflowModulePermissionStore(path.join(directory, "permissions.sqlite"));
    permissions.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "initial", label: "Initial", directory: initialDirectory, read: true, write: false }],
    });
    let releaseSeed!: () => void;
    let seedStarted!: () => void;
    const seedGate = new Promise<void>((resolve) => { releaseSeed = resolve; });
    const seedObserved = new Promise<void>((resolve) => { seedStarted = resolve; });
    let readInvocations = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-module-expanded",
      modulePermissions: permissions,
      templates: [{
        id: "fixture.module-expanded", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "seed", capability: "fixture.seed", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "read", capability: "fixture.notes-read", capabilityVersion: 1,
            dependsOn: ["seed"], timeoutMs: 1_000,
            inputBindings: { scopeId: { dependency: "seed", path: ["scopeId"] } },
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.seed"),
            outputSchema: {
              type: "object", required: ["scopeId"],
              properties: { scopeId: { type: "string" } }, additionalProperties: false,
            },
          },
          {
            ...readCapability("fixture.notes-read"),
            inputSchema: {
              type: "object", required: ["scopeId"],
              properties: { scopeId: { type: "string" } }, additionalProperties: false,
            },
            modulePermission: { moduleId: "notes", access: "read", scopeInput: "scopeId" },
          },
        ],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.seed") {
            seedStarted();
            await seedGate;
            return { status: "succeeded", output: { scopeId: "later" } };
          }
          readInvocations += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-module-expanded-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.module-expanded",
    });
    const started = engine.start();
    await seedObserved;
    permissions.save({
      moduleId: "notes", expectedRevision: 1, confirmed: true,
      scopes: [
        { scopeId: "initial", label: "Initial", directory: initialDirectory, read: true, write: false },
        { scopeId: "later", label: "Later", directory: laterDirectory, read: true, write: false },
      ],
    });
    releaseSeed();
    await started;

    expect(engine.get("run-module-expanded")).toMatchObject({
      status: "blocked", errorCode: "workflow_module_permission_denied",
      plan: { authorizationSnapshots: [{
        moduleId: "notes", revision: 1, scopes: [{ scopeId: "initial" }],
      }] },
    });
    expect(readInvocations).toBe(0);
    await engine.close();
    await permissions.close();
  });

  it("rejects a plan whose reviewed effect budget cannot cover every step", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-budget-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-budget",
      templates: [{
        id: "fixture.budget", version: 1, maxSteps: 2, maxDepth: 1, maxParallelism: 2,
        effectBudget: { read: 1 },
        steps: [
          { id: "left", capability: "fixture.read", capabilityVersion: 1, timeoutMs: 1_000 },
          { id: "right", capability: "fixture.read", capabilityVersion: 1, timeoutMs: 1_000 },
        ],
      }],
      providers: [{
        catalog: () => [readCapability("fixture.read")],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-budget-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.budget",
    });
    await engine.start();

    expect(engine.get("run-budget")).toMatchObject({
      status: "failed",
      errorCode: "workflow_effect_budget_exceeded",
    });
    expect(engine.get("run-budget")?.plan).toBeUndefined();
    expect(invocationCount).toBe(0);
    await engine.close();
  });

  it("rejects a reviewed template that omits its effect budget", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-budget-missing-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-budget-missing",
      templates: [{
        id: "fixture.budget-missing", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        steps: [{ id: "read", capability: "fixture.read", capabilityVersion: 1, timeoutMs: 1_000 }],
      } as unknown as WorkflowTemplate],
      providers: [{
        catalog: () => [readCapability("fixture.read")],
        invoke: async () => ({ status: "succeeded" }),
      }],
    });

    await engine.submit({
      triggerId: "fixture-budget-missing-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.budget-missing",
    });
    await engine.start();

    expect(engine.get("run-budget-missing")).toMatchObject({
      status: "failed",
      errorCode: "workflow_effect_budget_invalid",
    });
    expect(engine.get("run-budget-missing")?.plan).toBeUndefined();
    await engine.close();
  });

  it("retries a retryable pure read within its frozen attempt and backoff limits", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-retry-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const sleeps: number[] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-retry",
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      templates: [{
        id: "fixture.retry", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.retry", capabilityVersion: 1, timeoutMs: 1_000,
          retry: { maxAttempts: 3, initialBackoffMs: 10, maxElapsedMs: 5_000 },
        }],
      }],
      providers: [{
        catalog: () => [readCapability("fixture.retry")],
        invoke: async () => {
          invocationCount += 1;
          return invocationCount < 3
            ? { status: "failed", errorCode: "fixture_transient", retryable: true }
            : { status: "succeeded", output: null };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-retry-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.retry",
    });
    await engine.start();

    expect(engine.get("run-retry")).toMatchObject({
      status: "succeeded",
      plan: { steps: [{ stepId: "read", status: "succeeded", attemptCount: 3 }] },
    });
    expect(invocationCount).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    await engine.close();
  });

  it("rejects a condition whose referenced output path is absent from the dependency schema", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-condition-schema-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-condition-schema",
      templates: [{
        id: "fixture.condition-schema", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "gate", capability: "fixture.gate", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            id: "guarded", capability: "fixture.guarded", capabilityVersion: 1,
            dependsOn: ["gate"], timeoutMs: 1_000,
            when: { dependency: "gate", path: ["missing"], equals: true },
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.gate"),
            outputSchema: {
              type: "object", required: ["enabled"],
              properties: { enabled: { type: "boolean" } }, additionalProperties: false,
            },
          },
          readCapability("fixture.guarded"),
        ],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded", output: { enabled: false } };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-condition-schema-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.condition-schema",
    });
    await engine.start();

    expect(engine.get("run-condition-schema")).toMatchObject({
      status: "failed",
      errorCode: "workflow_condition_schema_incompatible",
    });
    expect(engine.get("run-condition-schema")?.plan).toBeUndefined();
    expect(invocationCount).toBe(0);
    await engine.close();
  });

  it("rejects a retry policy whose elapsed budget cannot cover its attempts and backoffs", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-retry-budget-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-retry-budget",
      templates: [{
        id: "fixture.retry-budget", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.retry", capabilityVersion: 1, timeoutMs: 1_000,
          retry: { maxAttempts: 3, initialBackoffMs: 10, maxElapsedMs: 1_000 },
        }],
      }],
      providers: [{
        catalog: () => [readCapability("fixture.retry")],
        invoke: async () => ({ status: "succeeded" }),
      }],
    });

    await engine.submit({
      triggerId: "fixture-retry-budget-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.retry-budget",
    });
    await engine.start();

    expect(engine.get("run-retry-budget")).toMatchObject({
      status: "failed",
      errorCode: "workflow_retry_policy_invalid",
    });
    expect(engine.get("run-retry-budget")?.plan).toBeUndefined();
    await engine.close();
  });

  it("rejects a capability schema whose required fields have no declared property", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-invalid-schema-"));
    tempDirs.push(directory);

    expect(() => new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.invalid-schema"),
          inputSchema: {
            type: "object",
            required: ["query"],
            properties: {},
            additionalProperties: false,
          },
        }],
        invoke: async () => ({ status: "succeeded" }),
      }],
    })).toThrow("workflow_capability_invalid");
  });

  it("rejects a capability schema whose enum values contradict their declared type", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-invalid-enum-"));
    tempDirs.push(directory);

    expect(() => new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.invalid-enum"),
          inputSchema: {
            type: "object",
            properties: { mode: { type: "string", enum: [1] } },
            additionalProperties: false,
          },
        }],
        invoke: async () => ({ status: "succeeded" }),
      }],
    })).toThrow("workflow_capability_invalid");
  });

  it("rejects non-JSON static input before hashing or invoking a provider", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-non-json-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-non-json",
      templates: [{
        id: "fixture.non-json", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.read", capabilityVersion: 1,
          input: { unstable: undefined }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [readCapability("fixture.read")],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-non-json-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.non-json",
    });
    await engine.start();

    expect(engine.get("run-non-json")).toMatchObject({
      status: "failed",
      errorCode: "workflow_step_input_invalid",
    });
    expect(engine.get("run-non-json")?.plan).toBeUndefined();
    expect(invocationCount).toBe(0);
    await engine.close();
  });

  it("rejects multi-attempt retry for a capability that is not classified as pure", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-non-pure-retry-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-non-pure-retry",
      templates: [{
        id: "fixture.non-pure-retry", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.non-pure", capabilityVersion: 1, timeoutMs: 1_000,
          retry: { maxAttempts: 2, initialBackoffMs: 10, maxElapsedMs: 3_000 },
        }],
      }],
      providers: [{
        catalog: () => [{ ...readCapability("fixture.non-pure"), retryClass: "non_idempotent" as const }],
        invoke: async () => {
          invocationCount += 1;
          return { status: "failed", errorCode: "fixture_retryable", retryable: true };
        },
      }],
    });

    await engine.submit({
      triggerId: "fixture-non-pure-retry-1", source: "fixture", occurredAt: 1_800_000_000_000,
      requestedWorkflowId: "fixture.non-pure-retry",
    });
    await engine.start();

    expect(engine.get("run-non-pure-retry")).toMatchObject({
      status: "failed",
      errorCode: "workflow_retry_policy_invalid",
    });
    expect(engine.get("run-non-pure-retry")?.plan).toBeUndefined();
    expect(invocationCount).toBe(0);
    await engine.close();
  });

  it("access_context_and_legacy_run_regression: never replays an unknown effect for a duplicate trigger", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-effect-unknown-"));
    tempDirs.push(directory);
    let invocationCount = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-effect-unknown",
      templates: [{
        id: "fixture.external-send", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { external_send: 1 },
        steps: [{
          id: "send", capability: "fixture.send", capabilityVersion: 1,
          resourceKeys: ["channel:target-a"], timeoutMs: 5,
        }],
      }],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.send"),
          effect: "external_send" as const,
          retryClass: "non_idempotent" as const,
        }],
        invoke: async () => {
          invocationCount += 1;
          return await new Promise<never>(() => undefined);
        },
      }],
    });
    const trigger = {
      triggerId: "fixture-effect-unknown-1", source: "fixture" as const,
      occurredAt: 1_800_000_000_000, requestedWorkflowId: "fixture.external-send",
    };

    const submission = await engine.submit(trigger);
    await engine.start();

    expect(engine.get(submission.runId)).toMatchObject({
      status: "outcome_unknown",
      errorCode: "workflow_effect_outcome_unknown",
      effects: [{ stepId: "send", state: "unknown" }],
      plan: { steps: [{ stepId: "send", status: "unknown", attemptCount: 1 }] },
    });
    const internal = engine.get(submission.runId);
    const publicState = engine.getPublicState();
    expect(publicState.runs[0]).toMatchObject({
      workflowId: "fixture.external-send",
      workflowVersion: 1,
      status: "outcome_unknown",
      steps: [{ stepId: "send", capabilityId: "fixture.send", status: "unknown" }],
      effects: [{ stepId: "send", state: "unknown" }],
    });
    const serialized = JSON.stringify(publicState);
    expect(internal?.effects?.[0]).toBeDefined();
    const internalEffect = internal?.effects?.[0];
    if (!internalEffect) throw new Error("missing internal effect fixture");
    expect(serialized).not.toContain("channel:target-a");
    expect(serialized).not.toContain(submission.runId);
    expect(serialized).not.toContain(trigger.triggerId);
    expect(serialized).not.toContain(internalEffect.effectRef);
    expect(serialized).not.toContain(internalEffect.operationId);
    expect(await engine.submit(trigger)).toEqual({ runId: submission.runId, duplicate: true });
    expect(invocationCount).toBe(1);
    await engine.close();
  });

  it("records a provider-declared rejection without classifying it as an unknown effect", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-effect-rejected-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-effect-rejected",
      templates: [{
        id: "fixture.rejected-send", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { external_send: 1 },
        steps: [{ id: "send", capability: "fixture.send", capabilityVersion: 1, timeoutMs: 1_000 }],
      }],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.send"), effect: "external_send" as const,
          retryClass: "non_idempotent" as const,
        }],
        invoke: async () => ({ status: "failed", errorCode: "fixture_rejected" }),
      }],
    });

    await engine.submit({
      triggerId: "fixture-effect-rejected-1", source: "fixture", occurredAt: 1,
      requestedWorkflowId: "fixture.rejected-send",
    });
    await engine.start();

    expect(engine.get("run-effect-rejected")).toMatchObject({
      status: "failed",
      errorCode: "fixture_rejected",
      effects: [{ stepId: "send", state: "rejected", errorCode: "fixture_rejected" }],
      plan: { steps: [{ stepId: "send", status: "rejected" }] },
    });
    await engine.close();
  });

  it("access_context_and_legacy_run_regression: reconciles an unknown effect without invoking it again", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-effect-reconcile-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const template: WorkflowTemplate = {
      id: "fixture.external-reconcile", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
      effectBudget: { external_send: 1 },
      steps: [{ id: "send", capability: "fixture.send", capabilityVersion: 1, timeoutMs: 5 }],
    };
    const descriptor = {
      ...readCapability("fixture.send"), effect: "external_send" as const,
      retryClass: "non_idempotent" as const,
    };
    let preparedEffectRef: string | undefined;
    let preparedOperationId: string | undefined;
    const first = new WorkflowEngine(databasePath, {
      createRunId: () => "run-effect-reconcile",
      templates: [template],
      providers: [{
        catalog: () => [descriptor],
        invoke: async (request) => {
          preparedEffectRef = request.effectRef;
          preparedOperationId = request.operationId;
          return await new Promise<never>(() => undefined);
        },
      }],
    });
    await first.submit({
      triggerId: "fixture-effect-reconcile-1", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    await first.start();
    expect(first.get("run-effect-reconcile")?.status).toBe("outcome_unknown");
    await first.close();

    let invocationCount = 0;
    const reconciledRefs: string[] = [];
    const reconciledContexts: Array<{ runId: string; operationId: string }> = [];
    const reopened = new WorkflowEngine(databasePath, {
      templates: [template],
      providers: [{
        catalog: () => [descriptor],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
        reconcile: async (effectRef, context) => {
          reconciledContexts.push(context);
          reconciledRefs.push(effectRef);
          return { status: "accepted" as const };
        },
      }],
    });

    await reopened.start();

    expect(reopened.get("run-effect-reconcile")).toMatchObject({
      status: "succeeded",
      effects: [{ stepId: "send", state: "accepted" }],
      plan: { steps: [{ stepId: "send", status: "succeeded", attemptCount: 1 }] },
    });
    expect(reconciledRefs).toHaveLength(1);
    expect(reconciledRefs[0]).toBe(preparedEffectRef);
    expect(preparedOperationId).toMatch(/^workflow-operation:[a-f0-9]{64}$/);
    expect(reconciledContexts).toEqual([{ runId: "run-effect-reconcile", operationId: preparedOperationId }]);
    expect(invocationCount).toBe(0);
    await reopened.close();
  });

  it("access_context_and_legacy_run_regression: keeps an unreconciled unknown effect terminal", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-effect-no-reconcile-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const template: WorkflowTemplate = {
      id: "fixture.external-no-reconcile", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
      effectBudget: { external_send: 1 },
      steps: [{ id: "send", capability: "fixture.send", capabilityVersion: 1, timeoutMs: 5 }],
    };
    const descriptor = {
      ...readCapability("fixture.send"), effect: "external_send" as const,
      retryClass: "non_idempotent" as const,
    };
    const first = new WorkflowEngine(databasePath, {
      createRunId: () => "run-effect-no-reconcile",
      templates: [template],
      providers: [{
        catalog: () => [descriptor],
        invoke: async () => await new Promise<never>(() => undefined),
      }],
    });
    await first.submit({
      triggerId: "fixture-effect-no-reconcile-1", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    await first.start();
    await first.close();

    let invocationCount = 0;
    const reopened = new WorkflowEngine(databasePath, {
      templates: [template],
      providers: [{
        catalog: () => [descriptor],
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
      }],
    });
    await reopened.start();

    expect(reopened.get("run-effect-no-reconcile")).toMatchObject({
      status: "outcome_unknown",
      effects: [{ state: "unknown" }],
      plan: { steps: [{ status: "unknown", attemptCount: 1 }] },
    });
    expect(invocationCount).toBe(0);
    await reopened.close();
  });

  it("blocks after accepted reconciliation when a dependent step needs unavailable recovery output", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-effect-output-recovery-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const template: WorkflowTemplate = {
      id: "fixture.effect-then-read", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
      effectBudget: { external_send: 1, read: 1 },
      steps: [
        { id: "send", capability: "fixture.send", capabilityVersion: 1, timeoutMs: 5 },
        { id: "inspect", capability: "fixture.read", capabilityVersion: 1, dependsOn: ["send"], timeoutMs: 1_000 },
      ],
    };
    const descriptors = [
      {
        ...readCapability("fixture.send"), effect: "external_send" as const,
        retryClass: "non_idempotent" as const,
      },
      readCapability("fixture.read"),
    ];
    const first = new WorkflowEngine(databasePath, {
      createRunId: () => "run-effect-output-recovery",
      templates: [template],
      providers: [{
        catalog: () => descriptors,
        invoke: async () => await new Promise<never>(() => undefined),
      }],
    });
    await first.submit({
      triggerId: "fixture-effect-output-recovery-1", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    await first.start();
    await first.close();

    let invocationCount = 0;
    const reopened = new WorkflowEngine(databasePath, {
      templates: [template],
      providers: [{
        catalog: () => descriptors,
        invoke: async () => {
          invocationCount += 1;
          return { status: "succeeded" };
        },
        reconcile: async () => ({ status: "accepted" }),
      }],
    });
    await reopened.start();

    expect(reopened.get("run-effect-output-recovery")).toMatchObject({
      status: "blocked",
      errorCode: "workflow_recovery_output_unavailable",
      plan: { steps: [{ status: "succeeded" }, { status: "pending" }] },
    });
    expect(invocationCount).toBe(0);
    await reopened.close();
  });

  it("serializes concurrent effects that claim the same opaque resource key", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-resource-lock-"));
    tempDirs.push(directory);
    let nextRun = 0;
    let active = 0;
    let maxActive = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => `run-resource-${++nextRun}`,
      templates: [{
        id: "fixture.serial-effect", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { external_send: 1 },
        steps: [{
          id: "send", capability: "fixture.send", capabilityVersion: 1,
          resourceKeys: ["channel:shared-target"], timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.send"), effect: "external_send" as const,
          retryClass: "non_idempotent" as const,
        }],
        invoke: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return { status: "succeeded" };
        },
      }],
      resourceLeaseMs: 1_000,
      resourceLockPollMs: 1,
      resourceLockWaitMs: 1_000,
    });
    await engine.start();

    const [left, right] = await Promise.all([
      engine.submit({
        triggerId: "fixture-resource-left", source: "fixture", occurredAt: 1,
        requestedWorkflowId: "fixture.serial-effect",
      }),
      engine.submit({
        triggerId: "fixture-resource-right", source: "fixture", occurredAt: 2,
        requestedWorkflowId: "fixture.serial-effect",
      }),
    ]);

    expect(maxActive).toBe(1);
    expect(engine.get(left.runId)?.status).toBe("succeeded");
    expect(engine.get(right.runId)?.status).toBe("succeeded");
    await engine.close();
  });

  it("does not globally serialize concurrent effects on different resource keys", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-resource-parallel-"));
    tempDirs.push(directory);
    let nextRun = 0;
    let active = 0;
    let maxActive = 0;
    const templateFor = (id: string, key: string): WorkflowTemplate => ({
      id, version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
      effectBudget: { external_send: 1 },
      steps: [{
        id: "send", capability: "fixture.send", capabilityVersion: 1,
        resourceKeys: [key], timeoutMs: 1_000,
      }],
    });
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => `run-resource-parallel-${++nextRun}`,
      templates: [
        templateFor("fixture.effect-left", "channel:target-left"),
        templateFor("fixture.effect-right", "channel:target-right"),
      ],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.send"), effect: "external_send" as const,
          retryClass: "non_idempotent" as const,
        }],
        invoke: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return { status: "succeeded" };
        },
      }],
    });
    await engine.start();

    await Promise.all([
      engine.submit({
        triggerId: "fixture-resource-parallel-left", source: "fixture", occurredAt: 1,
        requestedWorkflowId: "fixture.effect-left",
      }),
      engine.submit({
        triggerId: "fixture-resource-parallel-right", source: "fixture", occurredAt: 2,
        requestedWorkflowId: "fixture.effect-right",
      }),
    ]);

    expect(maxActive).toBe(2);
    await engine.close();
  });

  it("binds an opaque trigger reference into a reviewed template input", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-trigger-input-"));
    tempDirs.push(directory);
    const receivedInputs: Array<Record<string, unknown>> = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-trigger-input",
      templates: [{
        id: "fixture.read-artifact", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.read-artifact", capabilityVersion: 1,
          triggerInputBindings: { artifactHandle: "note" }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          id: "fixture.read-artifact", version: 1, effect: "read" as const, retryClass: "pure" as const,
          inputSchema: {
            type: "object" as const, required: ["artifactHandle"], additionalProperties: false,
            properties: { artifactHandle: { type: "string" as const } },
          },
          outputSchema: { type: "object" as const },
        }],
        invoke: async (request) => {
          receivedInputs.push(request.input);
          return { status: "succeeded" as const, output: {} };
        },
      }],
    });
    await engine.start();

    const submission = await engine.submit({
      triggerId: "fixture-trigger-input", source: "fixture", occurredAt: 1,
      requestedWorkflowId: "fixture.read-artifact",
      inputRefs: { note: "note_0123456789abcdef0123456789abcdef" },
    });

    expect(engine.get(submission.runId)?.status).toBe("succeeded");
    expect(receivedInputs).toEqual([{ artifactHandle: "note_0123456789abcdef0123456789abcdef" }]);
    expect(JSON.stringify(engine.getPublicState())).not.toContain("note_0123456789abcdef0123456789abcdef");
    await engine.close();
  });

  it("rejects trigger input values that are paths or message text instead of opaque references", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-trigger-input-invalid-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"));

    await expect(engine.submit({
      triggerId: "fixture-trigger-path", source: "fixture", occurredAt: 1,
      inputRefs: { note: "private/demo.md" },
    })).rejects.toThrow("workflow_trigger_input_invalid");
    await expect(engine.submit({
      triggerId: "fixture-trigger-body", source: "fixture", occurredAt: 1,
      inputRefs: { note: "请读取我的私人笔记" },
    })).rejects.toThrow("workflow_trigger_input_invalid");
    await engine.close();
  });

  it("treats changed trigger references as conflicting immutable trigger metadata", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-trigger-input-conflict-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-trigger-input-conflict",
    });
    const trigger = {
      triggerId: "fixture-trigger-input-conflict", source: "fixture" as const, occurredAt: 1,
      inputRefs: { note: "note_0123456789abcdef0123456789abcdef" },
    };

    await engine.submit(trigger);
    await expect(engine.submit({
      ...trigger,
      inputRefs: { note: "note_fedcba9876543210fedcba9876543210" },
    })).rejects.toThrow("workflow_trigger_conflict");
    await engine.close();
  });

  it("restores accepted trigger references and compiles the same input after restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-trigger-input-restart-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const template: WorkflowTemplate = {
      id: "fixture.resume-artifact", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [{
        id: "read", capability: "fixture.resume-artifact", capabilityVersion: 1,
        triggerInputBindings: { artifactHandle: "note" }, timeoutMs: 1_000,
      }],
    };
    const first = new WorkflowEngine(databasePath, { createRunId: () => "run-trigger-input-restart" });
    await first.submit({
      triggerId: "fixture-trigger-input-restart", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
      inputRefs: { note: "note_0123456789abcdef0123456789abcdef" },
    });
    await first.close();

    const receivedInputs: Array<Record<string, unknown>> = [];
    const restored = new WorkflowEngine(databasePath, {
      templates: [template],
      providers: [{
        catalog: () => [{
          id: "fixture.resume-artifact", version: 1, effect: "read" as const, retryClass: "pure" as const,
          inputSchema: {
            type: "object" as const, required: ["artifactHandle"], additionalProperties: false,
            properties: { artifactHandle: { type: "string" as const } },
          },
          outputSchema: { type: "object" as const },
        }],
        invoke: async (request) => {
          receivedInputs.push(request.input);
          return { status: "succeeded" as const, output: {} };
        },
      }],
    });
    await restored.start();

    expect(restored.get("run-trigger-input-restart")?.status).toBe("succeeded");
    expect(receivedInputs).toEqual([{ artifactHandle: "note_0123456789abcdef0123456789abcdef" }]);
    await restored.close();
  });

  it("adds trigger reference storage when opening a database created before this capability", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-trigger-input-migration-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE workflow_run (
        run_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        requested_workflow_id TEXT,
        occurred_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (source, trigger_id)
      );
    `);
    legacy.close();

    const engine = new WorkflowEngine(databasePath, { createRunId: () => "run-migrated-input" });
    await engine.submit({
      triggerId: "fixture-migrated-input", source: "fixture", occurredAt: 1,
      inputRefs: { note: "note_0123456789abcdef0123456789abcdef" },
    });
    await expect(engine.submit({
      triggerId: "fixture-migrated-input", source: "fixture", occurredAt: 1,
      inputRefs: { note: "note_fedcba9876543210fedcba9876543210" },
    })).rejects.toThrow("workflow_trigger_conflict");
    await engine.close();
  });

  it("fails before provider invocation when a reviewed trigger binding has no matching reference", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-trigger-input-missing-"));
    tempDirs.push(directory);
    let invoked = false;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-trigger-input-missing",
      templates: [{
        id: "fixture.missing-artifact", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.missing-artifact", capabilityVersion: 1,
          triggerInputBindings: { artifactHandle: "note" }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          id: "fixture.missing-artifact", version: 1, effect: "read" as const, retryClass: "pure" as const,
          inputSchema: {
            type: "object" as const, required: ["artifactHandle"], additionalProperties: false,
            properties: { artifactHandle: { type: "string" as const } },
          },
          outputSchema: { type: "object" as const },
        }],
        invoke: async () => {
          invoked = true;
          return { status: "succeeded" as const, output: {} };
        },
      }],
    });
    await engine.start();

    const submission = await engine.submit({
      triggerId: "fixture-trigger-input-missing", source: "fixture", occurredAt: 1,
      requestedWorkflowId: "fixture.missing-artifact",
    });

    expect(engine.get(submission.runId)).toMatchObject({
      status: "failed", errorCode: "workflow_trigger_input_missing",
    });
    expect(invoked).toBe(false);
    await engine.close();
  });

  it("rejects a template that binds a trigger reference into a non-string capability field", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-trigger-input-schema-"));
    tempDirs.push(directory);
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-trigger-input-schema",
      templates: [{
        id: "fixture.invalid-trigger-binding", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1,
        effectBudget: { read: 1 },
        steps: [{
          id: "read", capability: "fixture.invalid-trigger-binding", capabilityVersion: 1,
          triggerInputBindings: { limit: "note" }, timeoutMs: 1_000,
        }],
      }],
      providers: [{
        catalog: () => [{
          id: "fixture.invalid-trigger-binding", version: 1, effect: "read" as const, retryClass: "pure" as const,
          inputSchema: {
            type: "object" as const, required: ["limit"], additionalProperties: false,
            properties: { limit: { type: "integer" as const } },
          },
          outputSchema: { type: "object" as const },
        }],
        invoke: async () => ({ status: "succeeded" as const, output: {} }),
      }],
    });
    await engine.start();

    const submission = await engine.submit({
      triggerId: "fixture-trigger-input-schema", source: "fixture", occurredAt: 1,
      requestedWorkflowId: "fixture.invalid-trigger-binding",
      inputRefs: { note: "note_0123456789abcdef0123456789abcdef" },
    });

    expect(engine.get(submission.runId)).toMatchObject({
      status: "failed", errorCode: "workflow_trigger_input_binding_invalid",
    });
    await engine.close();
  });

  it("automatically selects the only input-gate candidate and continues the same run", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-input-gate-unique-"));
    tempDirs.push(directory);
    const selected: string[] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-input-gate-unique",
      templates: [{
        id: "fixture.input-gate-unique", version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
        effectBudget: { read: 2 },
        steps: [
          { id: "search", capability: "fixture.search-one", capabilityVersion: 1, timeoutMs: 1_000 },
          {
            kind: "input_gate", id: "choose", dependsOn: ["search"],
            candidates: { dependency: "search", path: ["matches"] },
            selectionSchema: { type: "string" }, autoSelect: "unique_only", expiresInMs: 60_000,
          },
          {
            id: "use", capability: "fixture.use-selection", capabilityVersion: 1, dependsOn: ["choose"],
            inputBindings: { selected: { dependency: "choose" } }, timeoutMs: 1_000,
          },
        ],
      }],
      providers: [{
        catalog: () => [
          {
            ...readCapability("fixture.search-one"),
            outputSchema: {
              type: "object" as const, required: ["matches"], additionalProperties: false,
              properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
            },
          },
          {
            ...readCapability("fixture.use-selection"),
            inputSchema: {
              type: "object" as const, required: ["selected"], additionalProperties: false,
              properties: { selected: { type: "string" as const } },
            },
          },
        ],
        invoke: async (request: { capabilityId: string; input: Record<string, unknown> }) => {
          if (request.capabilityId === "fixture.search-one") {
            return { status: "succeeded" as const, output: { matches: ["Inbox.md"] } };
          }
          selected.push(request.input.selected as string);
          return { status: "succeeded" as const, output: null };
        },
      }],
    });
    await engine.start();

    const submission = await engine.submit({
      triggerId: "fixture-input-gate-unique", source: "fixture", occurredAt: 1,
      requestedWorkflowId: "fixture.input-gate-unique",
    });

    expect(engine.get(submission.runId)).toMatchObject({ status: "succeeded" });
    expect(engine.getStepOutput(submission.runId, "choose")).toBe("Inbox.md");
    expect(selected).toEqual(["Inbox.md"]);
    await engine.close();
  });

  it("access_context_and_legacy_run_regression: pending_and_inbox_recover_after_restart preserves pending without rerunning its search", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-input-gate-wait-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    let searches = 0;
    const template: WorkflowTemplate = {
      id: "fixture.input-gate-wait", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [
        { id: "search", capability: "fixture.search-many", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["search"],
          candidates: { dependency: "search", path: ["matches"] },
          selectionSchema: { type: "string" }, autoSelect: "unique_only", expiresInMs: 60_000,
        },
      ],
    };
    const provider = {
      catalog: () => [{
        ...readCapability("fixture.search-many"),
        outputSchema: {
          type: "object" as const, required: ["matches"], additionalProperties: false,
          properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
        },
      }],
      invoke: async () => {
        searches += 1;
        return { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } };
      },
    };
    const first = new WorkflowEngine(databasePath, {
      now: () => 1_800_000_000_000,
      createRunId: () => "run-input-gate-wait",
      templates: [template], providers: [provider],
    });
    await first.start();
    const submission = await first.submit({
      triggerId: "fixture-input-gate-wait", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    expect(first.get(submission.runId)).toMatchObject({ status: "needs_input" });
    expect(first.get(submission.runId)?.plan?.steps.find((step) => step.stepId === "choose")?.status)
      .toBe("waiting_input");
    expect(searches).toBe(1);
    await first.close();

    const reopened = new WorkflowEngine(databasePath, {
      now: () => 1_800_000_001_000,
      templates: [template], providers: [provider],
    });
    await reopened.start();
    expect(reopened.get(submission.runId)).toMatchObject({ status: "needs_input" });
    expect(reopened.get(submission.runId)?.plan?.steps.find((step) => step.stepId === "choose")?.status)
      .toBe("waiting_input");
    expect(searches).toBe(1);
    await reopened.close();
  });

  it("blocks an expired pending request during restart reconciliation", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-expired-reconcile-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const fixture = inputGateFixture("fixture.expired-reconcile", 1_000);
    const provider = {
      catalog: () => fixture.catalog,
      invoke: async () => ({
        status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] },
      }),
    };
    const first = new WorkflowEngine(databasePath, {
      now: () => 1_800_000_000_000,
      templates: [fixture.template], providers: [provider],
    });
    await first.start();
    const submission = await first.submit({
      triggerId: "expired-reconcile", source: "weixin", occurredAt: 1,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    await first.close();

    const reopened = new WorkflowEngine(databasePath, {
      now: () => 1_800_000_001_000,
      templates: [fixture.template], providers: [provider],
    });
    await reopened.start();
    expect(reopened.get(submission.runId)).toMatchObject({
      status: "blocked", errorCode: "workflow_signal_expired",
    });
    expect(reopened.listPendingSignals("account-a", "target-a")).toEqual([]);
    await reopened.close();
  });

  it("consumes a valid signal once and resumes the frozen run after restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-input-gate-signal-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    let searches = 0;
    const selected: string[] = [];
    const template: WorkflowTemplate = {
      id: "fixture.input-gate-signal", version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
      effectBudget: { read: 2 },
      steps: [
        { id: "search", capability: "fixture.search-signal", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["search"],
          candidates: { dependency: "search", path: ["matches"] },
          selectionSchema: { type: "string" }, autoSelect: "unique_only", expiresInMs: 60_000,
        },
        {
          id: "use", capability: "fixture.use-signal", capabilityVersion: 1, dependsOn: ["choose"],
          inputBindings: { selected: { dependency: "choose" } }, timeoutMs: 1_000,
        },
      ],
    };
    const provider = {
      catalog: () => [
        {
          ...readCapability("fixture.search-signal"),
          outputSchema: {
            type: "object" as const, required: ["matches"], additionalProperties: false,
            properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
          },
        },
        {
          ...readCapability("fixture.use-signal"),
          inputSchema: {
            type: "object" as const, required: ["selected"], additionalProperties: false,
            properties: { selected: { type: "string" as const } },
          },
        },
      ],
      invoke: async (request: { capabilityId: string; input: Record<string, unknown> }) => {
        if (request.capabilityId === "fixture.search-signal") {
          searches += 1;
          return { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } };
        }
        selected.push(request.input.selected as string);
        return { status: "succeeded" as const, output: null };
      },
    };
    const first = new WorkflowEngine(databasePath, {
      now: () => 1_800_000_000_000,
      createRunId: () => "run-input-gate-signal",
      templates: [template], providers: [provider],
    });
    await first.start();
    const submission = await first.submit({
      triggerId: "fixture-input-gate-signal", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id, accountRef: "account-a", targetRef: "target-a",
    });
    const pending = first.get(submission.runId)?.pendingInput;
    expect(pending).toBeDefined();
    await first.close();

    const reopened = new WorkflowEngine(databasePath, {
      now: () => 1_800_000_001_000,
      templates: [template], providers: [provider],
    });
    await reopened.start();
    const receipt = await reopened.signal({
      signalId: "signal-1", signalRef: pending!.signalRef,
      expectedRevision: pending!.revision,
      accountRef: "account-a", targetRef: "target-a", selection: "Archive.md",
    });
    expect(receipt).toEqual({ runId: submission.runId, duplicate: false });
    expect(reopened.get(submission.runId)).toMatchObject({ status: "succeeded" });
    expect(reopened.getStepOutput(submission.runId, "choose")).toBe("Archive.md");
    expect(searches).toBe(1);
    expect(selected).toEqual(["Archive.md"]);

    await expect(reopened.signal({
      signalId: "signal-1", signalRef: pending!.signalRef,
      expectedRevision: pending!.revision,
      accountRef: "account-a", targetRef: "target-a", selection: "Archive.md",
    })).resolves.toEqual({ runId: submission.runId, duplicate: true });
    expect(searches).toBe(1);
    expect(selected).toEqual(["Archive.md"]);
    await reopened.close();
  });

  it("atomically cancels a bound pending request and makes replay idempotent", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-input-gate-cancel-"));
    tempDirs.push(directory);
    const fixture = inputGateFixture("fixture.input-gate-cancel");
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-input-gate-cancel",
      templates: [fixture.template],
      providers: [{
        catalog: () => fixture.catalog,
        invoke: async () => ({
          status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] },
        }),
      }],
    });
    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-input-gate-cancel", source: "weixin", occurredAt: 1,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    const pending = engine.get(submission.runId)!.pendingInput!;
    const cancellation = {
      cancellationId: "cancel-pending-1", signalRef: pending.signalRef,
      expectedRevision: pending.revision, accountRef: "account-a", targetRef: "target-a",
    };

    await expect(engine.cancelPending(cancellation)).resolves.toEqual({
      runId: submission.runId, duplicate: false,
    });
    expect(engine.get(submission.runId)).toMatchObject({
      status: "cancelled", errorCode: "workflow_pending_cancelled",
    });
    expect(engine.listPendingSignals("account-a", "target-a")).toEqual([]);
    await expect(engine.cancelPending(cancellation)).resolves.toEqual({
      runId: submission.runId, duplicate: true,
    });
    await engine.close();
  });

  it("persists a multiple-selection input gate as an ordered array", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-input-gate-multiple-"));
    tempDirs.push(directory);
    const template: WorkflowTemplate = {
      id: "fixture.input-gate-multiple", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [
        { id: "search", capability: "fixture.search-multiple", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["search"],
          candidates: { dependency: "search", path: ["matches"] },
          selectionSchema: { type: "string" }, selectionMode: "multiple",
          autoSelect: "unique_only", expiresInMs: 60_000,
        },
      ],
    };
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      templates: [template],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.search-multiple"),
          outputSchema: {
            type: "object" as const, required: ["matches"], additionalProperties: false,
            properties: { matches: { type: "array" as const, items: { type: "string" as const } } },
          },
        }],
        invoke: async () => ({
          status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] },
        }),
      }],
    });
    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-input-gate-multiple", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    const pending = engine.get(submission.runId)!.pendingInput!;

    await engine.signal({
      signalId: "multiple-selection", signalRef: pending.signalRef, expectedRevision: pending.revision,
      selection: ["Inbox.md", "Archive.md"],
    });
    expect(engine.get(submission.runId)).toMatchObject({ status: "succeeded" });
    expect(engine.getStepOutput(submission.runId, "choose")).toEqual(["Inbox.md", "Archive.md"]);
    await engine.close();
  });

  it("continues with a trusted preselected subset instead of opening a pending request", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-input-gate-preselected-"));
    tempDirs.push(directory);
    const template: WorkflowTemplate = {
      id: "fixture.input-gate-preselected", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
      effectBudget: { read: 1 },
      steps: [
        { id: "resolve", capability: "fixture.resolve-preselected", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["resolve"],
          candidates: { dependency: "resolve", path: ["matches"] },
          preselected: { dependency: "resolve", path: ["preselected"] },
          selectionSchema: { type: "string" }, selectionMode: "multiple",
          autoSelect: "unique_only", expiresInMs: 60_000,
        },
      ],
    };
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      templates: [template],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.resolve-preselected"),
          outputSchema: {
            type: "object" as const, required: ["matches", "preselected"], additionalProperties: false,
            properties: {
              matches: { type: "array" as const, items: { type: "string" as const } },
              preselected: { type: "array" as const, items: { type: "string" as const } },
            },
          },
        }],
        invoke: async () => ({
          status: "succeeded" as const,
          output: { matches: ["newest.jpg", "older.jpg"], preselected: ["newest.jpg"] },
        }),
      }],
    });

    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-input-gate-preselected", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });

    expect(engine.get(submission.runId)).toMatchObject({ status: "succeeded" });
    expect(engine.get(submission.runId)?.pendingInput).toBeUndefined();
    expect(engine.getStepOutput(submission.runId, "choose")).toEqual(["newest.jpg"]);
    await engine.close();
  });

  it("maps a multiple selection to independent ordered external effects", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-map-capability-"));
    tempDirs.push(directory);
    const sent: string[] = [];
    const template: WorkflowTemplate = {
      id: "fixture.map-capability", version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
      effectBudget: { read: 1, external_send: 3 },
      steps: [
        { id: "search", capability: "fixture.map-search", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["search"],
          candidates: { dependency: "search", path: ["matches"] }, selectionSchema: { type: "string" },
          selectionMode: "multiple", autoSelect: "unique_only", expiresInMs: 60_000,
        },
        {
          kind: "map_capability", id: "send", capability: "fixture.map-send", capabilityVersion: 1,
          dependsOn: ["choose"], items: { dependency: "choose" },
          itemInputBindings: { file: { path: [] } }, timeoutMs: 1_000,
        },
      ],
    };
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      templates: [template],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.map-search"),
          outputSchema: {
            type: "object" as const, required: ["matches"], additionalProperties: false,
            properties: {
              matches: { type: "array" as const, maxItems: 3, items: { type: "string" as const } },
            },
          },
        }, {
          id: "fixture.map-send", version: 1, effect: "external_send" as const,
          retryClass: "non_idempotent" as const,
          inputSchema: {
            type: "object" as const, required: ["file"], additionalProperties: false,
            properties: { file: { type: "string" as const } },
          },
          outputSchema: { type: "object" as const },
        }],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.map-search") {
            return { status: "succeeded" as const, output: { matches: ["a.jpg", "b.jpg"] } };
          }
          sent.push((request.input as { file: string }).file);
          return { status: "succeeded" as const, output: {} };
        },
      }],
    });
    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-map-capability", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    expect(engine.get(submission.runId)?.errorCode).toBeUndefined();
    expect(engine.get(submission.runId)).toMatchObject({ status: "needs_input" });
    const pending = engine.get(submission.runId)!.pendingInput!;
    await engine.signal({
      signalId: "map-both", signalRef: pending.signalRef, expectedRevision: pending.revision,
      selection: ["a.jpg", "b.jpg"],
    });

    expect(sent).toEqual(["a.jpg", "b.jpg"]);
    expect(engine.get(submission.runId)).toMatchObject({
      status: "succeeded",
      effects: [
        { stepId: "send#1", state: "accepted" },
        { stepId: "send#2", state: "accepted" },
      ],
    });
    await engine.close();
  });

  it("continues later selected effects when one mapped effect is rejected", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-map-partial-"));
    tempDirs.push(directory);
    const sent: string[] = [];
    const template: WorkflowTemplate = {
      id: "fixture.map-partial", version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
      effectBudget: { read: 1, external_send: 3 },
      steps: [
        { id: "search", capability: "fixture.map-search", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["search"],
          candidates: { dependency: "search", path: ["matches"] }, selectionSchema: { type: "string" },
          selectionMode: "multiple", autoSelect: "unique_only", expiresInMs: 60_000,
        },
        {
          kind: "map_capability", id: "send", capability: "fixture.map-send", capabilityVersion: 1,
          dependsOn: ["choose"], items: { dependency: "choose" },
          itemInputBindings: { file: { path: [] } }, timeoutMs: 1_000,
        },
      ],
    };
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      templates: [template],
      providers: [{
        catalog: () => [{
          ...readCapability("fixture.map-search"),
          outputSchema: {
            type: "object" as const, required: ["matches"], additionalProperties: false,
            properties: {
              matches: { type: "array" as const, maxItems: 3, items: { type: "string" as const } },
            },
          },
        }, {
          id: "fixture.map-send", version: 1, effect: "external_send" as const,
          retryClass: "non_idempotent" as const,
          inputSchema: {
            type: "object" as const, required: ["file"], additionalProperties: false,
            properties: { file: { type: "string" as const } },
          },
          outputSchema: { type: "object" as const },
        }],
        invoke: async (request) => {
          if (request.capabilityId === "fixture.map-search") {
            return { status: "succeeded" as const, output: { matches: ["a.jpg", "b.jpg", "c.jpg"] } };
          }
          const file = (request.input as { file: string }).file;
          sent.push(file);
          return file === "b.jpg"
            ? { status: "failed" as const, errorCode: "fixture_send_rejected" }
            : { status: "succeeded" as const, output: {} };
        },
      }],
    });
    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-map-partial", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    const pending = engine.get(submission.runId)!.pendingInput!;
    await engine.signal({
      signalId: "map-all", signalRef: pending.signalRef, expectedRevision: pending.revision,
      selection: ["a.jpg", "b.jpg", "c.jpg"],
    });

    expect(sent).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(engine.get(submission.runId)).toMatchObject({
      status: "failed",
      errorCode: "workflow_map_partial_failure",
      effects: [
        { stepId: "send#1", state: "accepted" },
        { stepId: "send#2", state: "rejected", errorCode: "fixture_send_rejected" },
        { stepId: "send#3", state: "accepted" },
      ],
    });
    await engine.close();
  });

  it("access_context_and_legacy_run_regression: does not replay selected items after mapped-effect recovery", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-map-reconcile-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const template: WorkflowTemplate = {
      id: "fixture.map-reconcile", version: 1, maxSteps: 3, maxDepth: 3, maxParallelism: 1,
      effectBudget: { read: 1, external_send: 2 },
      steps: [
        { id: "search", capability: "fixture.map-search", capabilityVersion: 1, timeoutMs: 1_000 },
        {
          kind: "input_gate", id: "choose", dependsOn: ["search"],
          candidates: { dependency: "search", path: ["matches"] }, selectionSchema: { type: "string" },
          selectionMode: "multiple", autoSelect: "unique_only", expiresInMs: 60_000,
        },
        {
          kind: "map_capability", id: "send", capability: "fixture.map-send", capabilityVersion: 1,
          dependsOn: ["choose"], items: { dependency: "choose" },
          itemInputBindings: { file: { path: [] } }, timeoutMs: 5,
        },
      ],
    };
    const descriptors = [{
      ...readCapability("fixture.map-search"),
      outputSchema: {
        type: "object" as const, required: ["matches"], additionalProperties: false,
        properties: { matches: { type: "array" as const, maxItems: 2, items: { type: "string" as const } } },
      },
    }, {
      id: "fixture.map-send", version: 1, effect: "external_send" as const,
      retryClass: "non_idempotent" as const,
      inputSchema: {
        type: "object" as const, required: ["file"], additionalProperties: false,
        properties: { file: { type: "string" as const } },
      },
      outputSchema: { type: "object" as const },
    }];
    const invoked: string[] = [];
    const first = new WorkflowEngine(databasePath, {
      createRunId: () => "run-map-reconcile",
      templates: [template],
      providers: [{
        catalog: () => descriptors,
        invoke: async (request) => {
          if (request.capabilityId === "fixture.map-search") {
            return { status: "succeeded" as const, output: { matches: ["a.jpg", "b.jpg"] } };
          }
          const file = (request.input as { file: string }).file;
          invoked.push(file);
          return file === "a.jpg"
            ? { status: "succeeded" as const, output: {} }
            : await new Promise<never>(() => undefined);
        },
      }],
    });
    await first.start();
    const submission = await first.submit({
      triggerId: "fixture-map-reconcile", source: "fixture", occurredAt: 1,
      requestedWorkflowId: template.id,
    });
    const pending = first.get(submission.runId)!.pendingInput!;
    await first.signal({
      signalId: "map-reconcile-both", signalRef: pending.signalRef, expectedRevision: pending.revision,
      selection: ["a.jpg", "b.jpg"],
    });
    expect(first.get(submission.runId)).toMatchObject({ status: "outcome_unknown" });
    await first.close();

    let replayCount = 0;
    const reopened = new WorkflowEngine(databasePath, {
      templates: [template],
      providers: [{
        catalog: () => descriptors,
        invoke: async () => {
          replayCount += 1;
          return { status: "succeeded" as const, output: {} };
        },
        reconcile: async () => ({ status: "accepted" as const }),
      }],
    });
    await reopened.start();

    expect(invoked).toEqual(["a.jpg", "b.jpg"]);
    expect(replayCount).toBe(0);
    expect(reopened.get(submission.runId)).toMatchObject({
      status: "succeeded",
      plan: { steps: [{ stepId: "search" }, { stepId: "choose" }, { stepId: "send", status: "succeeded" }] },
      effects: [
        { stepId: "send#1", state: "accepted" },
        { stepId: "send#2", state: "accepted" },
      ],
    });
    await reopened.close();
  });

  it("does not consume a waiting gate for the wrong source, revision, reference, or selection", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-signal-reject-"));
    tempDirs.push(directory);
    const fixture = inputGateFixture("fixture.signal-reject");
    let searches = 0;
    const selected: string[] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => "run-signal-reject",
      templates: [fixture.template],
      providers: [{
        catalog: () => fixture.catalog,
        invoke: async (request: { capabilityId: string; input: Record<string, unknown> }) => {
          if (request.capabilityId === fixture.searchCapability) {
            searches += 1;
            return { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } };
          }
          selected.push(request.input.selected as string);
          return { status: "succeeded" as const, output: null };
        },
      }],
    });
    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-signal-reject", source: "fixture", occurredAt: 1,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    const pending = engine.get(submission.runId)!.pendingInput!;
    const base = {
      signalRef: pending.signalRef, expectedRevision: pending.revision,
      accountRef: "account-a", targetRef: "target-a", selection: "Archive.md",
    };

    await expect(engine.signal({ ...base, signalId: "wrong-account", accountRef: "account-b" }))
      .rejects.toThrow("workflow_signal_source_mismatch");
    await expect(engine.signal({ ...base, signalId: "wrong-revision", expectedRevision: pending.revision - 1 }))
      .rejects.toThrow("workflow_signal_revision_mismatch");
    await expect(engine.signal({ ...base, signalId: "wrong-reference", signalRef: "missing-signal" }))
      .rejects.toThrow("workflow_signal_request_unavailable");
    await expect(engine.signal({ ...base, signalId: "wrong-selection", selection: "Missing.md" }))
      .rejects.toThrow("workflow_signal_selection_invalid");
    await expect(engine.signal({ ...base, signalId: "wrong-schema", selection: 42 }))
      .rejects.toThrow("workflow_signal_selection_invalid");
    expect(engine.get(submission.runId)).toMatchObject({ status: "needs_input" });
    expect(engine.getStepOutput(submission.runId, "choose")).toBeUndefined();
    expect(searches).toBe(1);
    expect(selected).toEqual([]);

    await engine.signal({ ...base, signalId: "valid-after-rejections" });
    expect(engine.get(submission.runId)).toMatchObject({ status: "succeeded" });
    expect(searches).toBe(1);
    expect(selected).toEqual(["Archive.md"]);
    await engine.close();
  });

  it("adds signal revision columns when opening a pre-signal-revision database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-signal-migration-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const initial = new WorkflowEngine(databasePath);
    await initial.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE workflow_signal_request DROP COLUMN candidate_revision");
    legacy.exec("ALTER TABLE workflow_signal DROP COLUMN candidate_revision");
    legacy.close();

    const reopened = new WorkflowEngine(databasePath);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const requestColumns = database.prepare("PRAGMA table_info(workflow_signal_request)")
      .all() as unknown as Array<{ name: string }>;
    const signalColumns = database.prepare("PRAGMA table_info(workflow_signal)")
      .all() as unknown as Array<{ name: string }>;
    expect(requestColumns.some((column) => column.name === "candidate_revision")).toBe(true);
    expect(signalColumns.some((column) => column.name === "candidate_revision")).toBe(true);
    database.close();
    await reopened.close();
  });

  it("migrates legacy signal request state constraints to support superseded and cancelled requests", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-superseded-migration-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const initial = new WorkflowEngine(databasePath);
    await initial.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE workflow_signal_request RENAME TO workflow_signal_request_current;
      CREATE TABLE workflow_signal_request (
        signal_ref TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_run(run_id),
        step_id TEXT NOT NULL,
        candidate_hash TEXT NOT NULL,
        selection_schema_json TEXT NOT NULL,
        candidate_revision INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('waiting', 'consumed', 'expired')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (run_id, step_id)
      );
      DROP TABLE workflow_signal_request_current;
    `);
    legacy.close();

    const reopened = new WorkflowEngine(databasePath);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    const schema = database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_signal_request'",
    ).get() as { sql: string };
    expect(schema.sql).toContain("'superseded'");
    expect(schema.sql).toContain("'cancelled'");
    database.close();
    await reopened.close();
  });

  it("blocks an expired input request instead of consuming its signal", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-signal-expired-"));
    tempDirs.push(directory);
    const fixture = inputGateFixture("fixture.signal-expired", 1_000);
    let now = 1_800_000_000_000;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      now: () => now,
      createRunId: () => "run-signal-expired",
      templates: [fixture.template],
      providers: [{
        catalog: () => fixture.catalog,
        invoke: async () => ({
          status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] },
        }),
      }],
    });
    await engine.start();
    const submission = await engine.submit({
      triggerId: "fixture-signal-expired", source: "fixture", occurredAt: 1,
      requestedWorkflowId: fixture.template.id,
    });
    const pending = engine.get(submission.runId)!.pendingInput!;
    now = pending.expiresAt;

    await expect(engine.signal({
      signalId: "expired-signal", signalRef: pending.signalRef,
      expectedRevision: pending.revision, selection: "Inbox.md",
    })).rejects.toThrow("workflow_signal_expired");
    expect(engine.get(submission.runId)).toMatchObject({
      status: "blocked", errorCode: "workflow_signal_expired",
    });
    expect(engine.get(submission.runId)?.pendingInput).toBeUndefined();
    expect(engine.getStepOutput(submission.runId, "choose")).toBeUndefined();
    await engine.close();
  });

  it("supersedes an older pending run when the same account and target creates a new pending request", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-signal-multiple-"));
    tempDirs.push(directory);
    const fixture = inputGateFixture("fixture.signal-multiple");
    let sequence = 0;
    const selected: string[] = [];
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => `run-signal-multiple-${++sequence}`,
      templates: [fixture.template],
      providers: [{
        catalog: () => fixture.catalog,
        invoke: async (request: { capabilityId: string; input: Record<string, unknown> }) => {
          if (request.capabilityId === fixture.searchCapability) {
            return { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } };
          }
          selected.push(request.input.selected as string);
          return { status: "succeeded" as const, output: null };
        },
      }],
    });
    await engine.start();
    const first = await engine.submit({
      triggerId: "fixture-signal-multiple-1", source: "fixture", occurredAt: 1,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    const firstPending = engine.get(first.runId)!.pendingInput!;
    const second = await engine.submit({
      triggerId: "fixture-signal-multiple-2", source: "fixture", occurredAt: 2,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    const secondPending = engine.get(second.runId)!.pendingInput!;
    expect(firstPending.signalRef).not.toBe(secondPending.signalRef);

    expect(engine.get(first.runId)).toMatchObject({
      status: "cancelled", errorCode: "workflow_pending_superseded",
    });
    expect(engine.get(first.runId)?.pendingInput).toBeUndefined();
    expect(engine.listPendingSignals("account-a", "target-a")).toEqual([
      expect.objectContaining({ runId: second.runId, signalRef: secondPending.signalRef }),
    ]);

    await expect(engine.signal({
      signalId: "superseded-old", signalRef: firstPending.signalRef,
      expectedRevision: firstPending.revision, accountRef: "account-a", targetRef: "target-a",
      selection: "Inbox.md",
    })).rejects.toThrow("workflow_signal_request_closed");

    await engine.signal({
      signalId: "second-only", signalRef: secondPending.signalRef, expectedRevision: secondPending.revision,
      accountRef: "account-a", targetRef: "target-a", selection: "Archive.md",
    });
    expect(engine.get(first.runId)).toMatchObject({
      status: "cancelled", errorCode: "workflow_pending_superseded",
    });
    expect(engine.get(second.runId)).toMatchObject({ status: "succeeded" });
    expect(engine.getStepOutput(first.runId, "choose")).toBeUndefined();
    expect(engine.getStepOutput(second.runId, "choose")).toBe("Archive.md");
    expect(selected).toEqual(["Archive.md"]);
    await engine.close();
  });

  it("reconciles legacy duplicate pending requests on restart and keeps only the newest one", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-pending-reconcile-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const fixture = inputGateFixture("fixture.pending-reconcile");
    let sequence = 0;
    const dependencies = {
      now: () => 1_800_000_000_000,
      createRunId: () => `run-pending-reconcile-${++sequence}`,
      templates: [fixture.template],
      providers: [{
        catalog: () => fixture.catalog,
        invoke: async () => ({
          status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] },
        }),
      }],
    };
    const firstEngine = new WorkflowEngine(databasePath, dependencies);
    await firstEngine.start();
    const first = await firstEngine.submit({
      triggerId: "pending-reconcile-1", source: "weixin", occurredAt: 1,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    const firstSignalRef = firstEngine.get(first.runId)!.pendingInput!.signalRef;
    const second = await firstEngine.submit({
      triggerId: "pending-reconcile-2", source: "weixin", occurredAt: 2,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    await firstEngine.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.prepare(`
      UPDATE workflow_signal_request SET state = 'waiting', candidate_revision = 100
      WHERE signal_ref = ?
    `).run(firstSignalRef);
    legacy.prepare(`
      UPDATE workflow_run SET status = 'needs_input', error_code = NULL, revision = 100
      WHERE run_id = ?
    `).run(first.runId);
    legacy.close();

    const reopened = new WorkflowEngine(databasePath, {
      now: dependencies.now,
      templates: dependencies.templates,
      providers: dependencies.providers,
    });
    await reopened.start();
    expect(reopened.listPendingSignals("account-a", "target-a")).toEqual([
      expect.objectContaining({ runId: second.runId }),
    ]);
    expect(reopened.get(first.runId)).toMatchObject({
      status: "cancelled", errorCode: "workflow_pending_superseded",
    });
    await reopened.close();
  });

  it("tells a choice that a newer workflow replaced from one that still waits, was cancelled, was answered or expired", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-choice-replaced-"));
    tempDirs.push(directory);
    const fixture = inputGateFixture("fixture.choice-replaced", 1_000);
    let now = 1_800_000_000_000, sequence = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      now: () => now,
      createRunId: () => `run-choice-replaced-${++sequence}`,
      templates: [fixture.template],
      providers: [{
        catalog: () => fixture.catalog,
        invoke: async (request: { capabilityId: string }) => request.capabilityId === fixture.searchCapability
          ? { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } }
          : { status: "succeeded" as const, output: null },
      }],
    });
    await engine.start();
    const source = { accountRef: "account-a", targetRef: "target-a" };
    const submit = (occurredAt: number) => engine.submit({
      triggerId: `fixture-choice-replaced-${occurredAt}`, source: "fixture", occurredAt, requestedWorkflowId: fixture.template.id, ...source,
    });
    const pendingOf = (runId: string) => engine.get(runId)!.pendingInput!;

    // The second run's choice replaces the first one's, and waits itself.
    const first = await submit(1), second = await submit(2);
    expect(pendingChoiceReplaced(engine.get(first.runId))).toBe(true);
    expect(pendingChoiceReplaced(engine.get(second.runId))).toBe(false);

    await engine.cancelPending({
      cancellationId: "cancel-choice-replaced", signalRef: pendingOf(second.runId).signalRef,
      expectedRevision: pendingOf(second.runId).revision, ...source,
    });
    expect(engine.get(second.runId)).toMatchObject({ status: "cancelled" });
    expect(pendingChoiceReplaced(engine.get(second.runId))).toBe(false);

    const third = await submit(3);
    await engine.signal({
      signalId: "answer-choice-replaced", signalRef: pendingOf(third.runId).signalRef,
      expectedRevision: pendingOf(third.runId).revision, ...source, selection: "Archive.md",
    });
    expect(engine.get(third.runId)).toMatchObject({ status: "succeeded" });
    expect(pendingChoiceReplaced(engine.get(third.runId))).toBe(false);

    const fourth = await submit(4), expiring = pendingOf(fourth.runId);
    now = expiring.expiresAt;
    await expect(engine.signal({
      signalId: "late-choice-replaced", signalRef: expiring.signalRef, expectedRevision: expiring.revision, ...source, selection: "Inbox.md",
    })).rejects.toThrow("workflow_signal_expired");
    expect(engine.get(fourth.runId)).toMatchObject({ status: "blocked" });
    expect(pendingChoiceReplaced(engine.get(fourth.runId))).toBe(false);

    expect(pendingChoiceReplaced(engine.get("run-choice-replaced-unknown"))).toBe(false);
    await engine.close();
  });

  it("does not let an older slow run supersede a newer run that reached the input gate first", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-pending-race-"));
    tempDirs.push(directory);
    const fixture = inputGateFixture("fixture.pending-race");
    let sequence = 0;
    let searches = 0;
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => `run-pending-race-${++sequence}`,
      templates: [fixture.template],
      providers: [{
        catalog: () => fixture.catalog,
        invoke: async () => {
          searches += 1;
          if (searches === 1) await oldBlocked;
          return { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } };
        },
      }],
    });
    await engine.start();

    const oldSubmission = engine.submit({
      triggerId: "pending-race-old", source: "weixin", occurredAt: 1,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    while (searches < 1) await Promise.resolve();
    const newest = await engine.submit({
      triggerId: "pending-race-new", source: "weixin", occurredAt: 2,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-a",
    });
    releaseOld();
    const old = await oldSubmission;

    expect(engine.get(newest.runId)).toMatchObject({ status: "needs_input" });
    expect(engine.get(old.runId)).toMatchObject({
      status: "cancelled", errorCode: "workflow_pending_superseded",
    });
    expect(engine.listPendingSignals("account-a", "target-a")).toEqual([
      expect.objectContaining({ runId: newest.runId }),
    ]);
    await engine.close();
  });

  it("keeps pending requests isolated across different targets", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-pending-targets-"));
    tempDirs.push(directory);
    const fixture = inputGateFixture("fixture.pending-targets");
    let sequence = 0;
    const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
      createRunId: () => `run-pending-targets-${++sequence}`,
      templates: [fixture.template],
      providers: [{
        catalog: () => fixture.catalog,
        invoke: async () => ({
          status: "succeeded" as const,
          output: { matches: ["Inbox.md", "Archive.md"] },
        }),
      }],
    });
    await engine.start();

    const left = await engine.submit({
      triggerId: "pending-target-left", source: "weixin", occurredAt: 1,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-left",
    });
    const right = await engine.submit({
      triggerId: "pending-target-right", source: "weixin", occurredAt: 2,
      requestedWorkflowId: fixture.template.id, accountRef: "account-a", targetRef: "target-right",
    });

    expect(engine.get(left.runId)).toMatchObject({ status: "needs_input" });
    expect(engine.get(right.runId)).toMatchObject({ status: "needs_input" });
    expect(engine.listPendingSignals("account-a", "target-left")).toEqual([
      expect.objectContaining({ runId: left.runId }),
    ]);
    expect(engine.listPendingSignals("account-a", "target-right")).toEqual([
      expect.objectContaining({ runId: right.runId }),
    ]);
    await engine.close();
  });

  it("keeps both channel choices isolated through shared trigger handling after restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dual-pending-"));
    tempDirs.push(directory);
    const database = path.join(directory, "workflow.sqlite");
    const fixture = inputGateFixture("fixture.dual-pending");
    const selected: Array<{ runId: string; value: unknown }> = [];
    let searches = 0;
    const providers = [{
      catalog: () => fixture.catalog,
      invoke: async (request: import("../src/workflow-engine.js").WorkflowCapabilityInvocation) => {
        if (request.capabilityId === fixture.searchCapability) {
          searches += 1;
          return { status: "succeeded" as const, output: { matches: ["Inbox.md", "Archive.md"] } };
        }
        selected.push({ runId: request.runId, value: request.input.selected });
        return { status: "succeeded" as const, output: {} };
      },
    }];
    const now = () => 1_800_000_000_000;
    const first = new WorkflowEngine(database, { templates: [fixture.template], providers, now });
    await first.start();
    const left = await first.submit({ triggerId: "wx-pending", source: "weixin", occurredAt: now(),
      requestedWorkflowId: fixture.template.id, accountRef: "bot", targetRef: "owner@im.wechat" });
    const right = await first.submit({ triggerId: "fs-pending", source: "weixin", occurredAt: now(),
      requestedWorkflowId: fixture.template.id, accountRef: "feishu.app", targetRef: "feishu.chat" });
    const leftPending = first.get(left.runId)!.pendingInput!;
    const rightPending = first.get(right.runId)!.pendingInput!;
    expect(first.get(left.runId)?.status).toBe("needs_input");
    expect(first.get(right.runId)?.status).toBe("needs_input");
    await first.close();
    const reopened = new WorkflowEngine(database, { templates: [fixture.template], providers, now });
    await reopened.start();
    try {
      await expect(reopened.signal({ signalId: "cross-channel-choice", signalRef: leftPending.signalRef,
        expectedRevision: leftPending.revision, accountRef: "feishu.app", targetRef: "feishu.chat", selection: "Inbox.md" }))
        .rejects.toThrow("workflow_signal_source_mismatch");
      const projections: string[][] = [];
      const adapter = new ConversationWorkflowTriggerAdapter({ engine: reopened, now, pendingResponseRouter: {
        route: async (input) => {
          projections.push(input.requests.map((request) => request.requestRef));
          if (input.userText === "cancel mine") return { kind: "cancel", requestRef: input.requests[0]!.requestRef };
          return { kind: "respond", requestRef: input.requests[0]!.requestRef, choiceRefs: [input.requests[0]!.choices[0]!.choiceRef] };
        },
      } });
      await expect(adapter.tryHandlePending({ key: "fs-choose", messageId: "fs-choose", accountId: "feishu.app",
        target: "feishu.chat", source: "text", text: "choose first", receivedAt: now() }))
        .resolves.toMatchObject({ handled: true, outcome: "succeeded" });
      expect(selected).toEqual([{ runId: right.runId, value: "Inbox.md" }]);
      expect(reopened.get(left.runId)?.pendingInput).toEqual(leftPending);
      expect(reopened.get(left.runId)?.status).toBe("needs_input");
      await expect(adapter.tryHandlePending({ key: "wx-cancel", messageId: "wx-cancel", accountId: "bot",
        target: "owner@im.wechat", source: "text", text: "cancel mine", receivedAt: now() }))
        .resolves.toMatchObject({ handled: true, reply: "已取消之前的操作。" });
      expect(reopened.get(left.runId)?.status).toBe("cancelled");
      expect(reopened.get(right.runId)?.status).toBe("succeeded");
      expect(selected).toEqual([{ runId: right.runId, value: "Inbox.md" }]);
      expect(searches).toBe(2);
      expect(projections).toHaveLength(2);
      expect(projections[0]).toHaveLength(1); expect(projections[1]).toHaveLength(1);
      expect(projections[0]![0]).not.toBe(projections[1]![0]);
      expect(rightPending.signalRef).not.toBe(leftPending.signalRef);
    } finally { await reopened.close(); }
  });

});
