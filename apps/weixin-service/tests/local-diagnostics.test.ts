import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { WorkflowEngine } from "../src/workflow-engine.js";
import { WorkflowToolHost } from "../src/workflow-tool-host.js";
import { WorkflowToolCatalog } from "../src/workflow-tool-catalog.js";

it("exports real parent/child spans and preserves supplied diagnostic data", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-sdk-"));
  const sink = new DiagnosticFiles(directory);
  const diagnostics = new LocalDiagnostics(sink);
  try {
    const reply = await diagnostics.run("weixin.inbound", { accountId: "PRIVATE_ACCOUNT", text: "PRIVATE_PROMPT" }, async () => {
      await diagnostics.run("tool.call", { toolId: "files.find", query: "PRIVATE_QUERY", path: "/PRIVATE_PATH", errorCode: "PRIVATE_ERROR" }, async () => {
        diagnostics.checkpoint("tool.progress", { entryCount: 2 });
        await sink.flush();
        const names = await fs.readdir(directory);
        const before = (await Promise.all(names.map((name) => fs.readFile(path.join(directory, name), "utf8")))).join("");
        expect(before).toContain('"name":"tool.call.start"');
        expect(before).not.toContain('"kind":"span"');
      });
      return "received";
    });
    expect(reply).toBe("received");
    await diagnostics.close();
    const all = (await Promise.all((await fs.readdir(directory)).map((name) => fs.readFile(path.join(directory, name), "utf8")))).join("");
    expect(all).toContain("PRIVATE_PROMPT");
    expect(all).toContain("PRIVATE_QUERY");
    expect(all).toContain("/PRIVATE_PATH");
    expect(all).toContain("PRIVATE_ERROR");
    const spans = all.trim().split("\n").map((line) => JSON.parse(line)).filter((record) => record.kind === "span");
    expect(spans).toHaveLength(2);
    const parent = spans.find((span) => span.name === "weixin.inbound");
    const child = spans.find((span) => span.name === "tool.call");
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(parent.traceId).toMatch(/^[a-f0-9]{32}$/u);
  } finally { await diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

it("round-trips new diagnostic names, codes, fields and reference values without redaction", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-raw-"));
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(directory));
  try {
    await diagnostics.run("future.operation", {
      ...diagnostics.references({ accountId: "account-raw", target: "target-raw", eventKey: "inbound-raw", effectId: "effect-raw" }),
      toolId: "files.future", stage: "future_stage", status: "future_status",
      errorCode: "workflow_tool_internal_error", networkCode: "FUTURE_NETWORK_ERROR",
      method: "post", durationMs: -1, resultSuccess: "false", entryCount: "3",
      query: "周杰伦", path: "/Users/example/Pictures", message: "m".repeat(256),
      details: { code: "file_sandbox_timeout", retries: 2 }, tags: ["one", "two"],
    }, async () => {
      diagnostics.checkpoint("future.checkpoint", { errorCode: "file_sandbox_timeout", extra: "retained" });
    });
    await diagnostics.close();
    const evidence = await readDiagnostics(directory);
    expect(evidence.malformed).toBe(0);
    const span = evidence.records.find((record) => record.kind === "span" && record.name === "future.operation");
    expect(span?.attributes).toEqual({
      accountRef: "account-raw", targetRef: "target-raw", inboundRef: "inbound-raw", effectRef: "effect-raw",
      toolId: "files.future", stage: "future_stage", status: "future_status",
      errorCode: "workflow_tool_internal_error", networkCode: "FUTURE_NETWORK_ERROR",
      method: "post", durationMs: -1, resultSuccess: "false", entryCount: "3",
      query: "周杰伦", path: "/Users/example/Pictures", message: "m".repeat(256),
      details: '{"code":"file_sandbox_timeout","retries":2}', tags: ["one", "two"],
    });
    expect(evidence.records.find((record) => record.name === "future.checkpoint")?.attributes)
      .toEqual({ errorCode: "file_sandbox_timeout", extra: "retained" });
  } finally { await diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

it("keeps parallel roots distinct, reports domain rejection and never replaces a business error", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-parallel-"));
  const sink = new DiagnosticFiles(directory);
  const diagnostics = new LocalDiagnostics(sink);
  try {
    await Promise.all([1, 2].map(async (count) => diagnostics.run("weixin.inbound", { entryCount: count }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return diagnostics.run("tool.call", { entryCount: count, toolId: "files.find" }, async () => {
        diagnostics.result({ status: "rejected", resultSuccess: true, domainSuccess: false, errorCode: "local_file_permission_denied" });
      });
    })));
    const businessError = new Error("PRIVATE_ERROR_BODY");
    await expect(diagnostics.run("workflow.process", {}, async () => { throw businessError; })).rejects.toBe(businessError);
    await diagnostics.close();
    const result = await readDiagnostics(directory);
    const roots = result.records.filter((r) => r.name === "weixin.inbound" && r.kind === "span");
    const children = result.records.filter((r) => r.name === "tool.call" && r.kind === "span");
    expect(roots).toHaveLength(2);
    expect(new Set(roots.map((r) => r.traceId)).size).toBe(2);
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.traceId).toBe(roots.find((r) => r.attributes.entryCount === child.attributes.entryCount)?.traceId);
      expect(child.status).toBe(2);
      expect(child.attributes.domainSuccess).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR_BODY");
    expect(result.records.find((r) => r.kind === "span" && r.name === "workflow.process")?.status).toBe(2);
  } finally { await diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

it("completes business work despite a real unwritable diagnostic destination", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-unavailable-"));
  const blocker = path.join(directory, "not-a-directory");
  await fs.writeFile(blocker, "keep");
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(blocker));
  try {
    expect(await diagnostics.run("weixin.inbound", {}, async () => "收到")).toBe("收到");
    await diagnostics.close();
    expect(diagnostics.files.stats().failures).toBeGreaterThan(0);
    expect(await fs.readFile(blocker, "utf8")).toBe("keep");
  } finally { await diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

it("records the actual ToolHost internal failure unchanged in both span and checkpoint", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-host-failure-"));
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(directory));
  const host = new WorkflowToolHost(new WorkflowToolCatalog([{
    id: "files.find", version: 2, description: "Find files.", executionClass: "inline_query",
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
  }]), { submit: async () => { throw new Error("unexpected send"); } },
  { execute: async () => { throw new Error("file_sandbox_timeout"); } }, { diagnostics });
  const binding = host.bind("diagnostic-thread", {
    eventKey: "diagnostic-inbound", accountId: "diagnostic-account", target: "diagnostic-target",
    occurredAt: Date.now(), originalTextRef: "diagnostic-text", attachmentRefs: [],
  });
  try {
    const result = await diagnostics.run("weixin.inbound", {}, () =>
      host.execute("find", { query: "周杰伦" }, { threadId: "diagnostic-thread", turnId: "diagnostic-turn", namespace: "files" }));
    expect(result.success).toBe(false);
    expect(JSON.parse(result.contentItems[0]!.text).error.code).toBe("workflow_tool_internal_error");
    expect(binding.snapshot().owner).toBe("model");
    await diagnostics.close();
    const records = (await readDiagnostics(directory)).records;
    const span = records.find((record) => record.kind === "span" && record.name === "tool.call");
    const checkpoint = records.find((record) => record.name === "tool.result");
    expect(span?.attributes.errorCode).toBe("workflow_tool_internal_error");
    expect(checkpoint?.attributes.errorCode).toBe("workflow_tool_internal_error");
    expect(span?.attributes.queryInputs).toBe('{"query":"周杰伦"}');
    expect(span?.status).toBe(2);
    expect(span?.attributes.ownerAfter).toBe("model");
  } finally { binding.release(); await diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

it.each(["unknown", "failed"] as const)("observes a real Engine %s effect without replaying a duplicate trigger", async (outcome) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-effect-"));
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(directory, "otel")));
  let invocations = 0;
  const engine = new WorkflowEngine(path.join(directory, "workflow.sqlite"), {
    diagnostics,
    templates: [{ id: "fixture.send", version: 1, maxSteps: 1, maxDepth: 1, maxParallelism: 1, effectBudget: { external_send: 1 }, steps: [{ id: "send", capability: "fixture.send", capabilityVersion: 1, timeoutMs: 1000 }] }],
    providers: [{
      catalog: () => [{ id: "fixture.send", version: 1, effect: "external_send", retryClass: "non_idempotent", inputSchema: { type: "object" }, outputSchema: {} }],
      invoke: async () => { invocations += 1; return { status: outcome, errorCode: "workflow_effect_outcome_unknown" }; },
    }],
  });
  try {
    const trigger = { triggerId: "private-trigger", source: "fixture" as const, occurredAt: Date.now(), requestedWorkflowId: "fixture.send" };
    const submitted = await engine.submit(trigger);
    await engine.start();
    expect(engine.get(submitted.runId)?.effects?.[0]?.state).toBe(outcome === "unknown" ? "unknown" : "rejected");
    expect((await engine.submit(trigger)).duplicate).toBe(true);
    expect(invocations).toBe(1);
    await diagnostics.close();
    const evidence = await readDiagnostics(path.join(directory, "otel"));
    const effects = evidence.records.filter((r) => r.kind === "span" && r.name === "workflow.effect");
    expect(effects).toHaveLength(1);
    expect(effects[0]?.attributes.status).toBe(outcome === "unknown" ? "unknown" : "rejected");
    expect(effects[0]?.status).toBe(2);
    expect(effects[0]?.attributes.effectRef).toBe(engine.get(submitted.runId)?.effects?.[0]?.effectRef);
    expect(JSON.stringify(evidence)).not.toContain("private-trigger");
  } finally { await engine.close(); await diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
