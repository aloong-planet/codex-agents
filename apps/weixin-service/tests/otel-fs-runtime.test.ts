import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { NodeFileSandbox } from "../src/file-sandbox.js";
import { RuntimeMetrics } from "../src/runtime-metrics.js";
import { consumeSandboxTelemetry } from "../src/sandbox-telemetry-channel.js";

// These tests observe SDK output, not synthetic spans. Physical disk failure/SIGKILL may lose
// the final collection; a missing observation is not a successful or failed file operation.
beforeAll(() => { execFileSync(process.execPath, ["scripts/build-sandbox-telemetry.mjs"]); });

it("keeps filesystem tracing disabled while collecting runtime metrics", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "otel-fs-runtime-"));
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(root, "otel")));
  try {
    await fs.writeFile(path.join(root, "example.txt"), "CONTENT_MUST_NOT_BE_CAPTURED");
    const result = await diagnostics.run("test.files", { runRef: "fs-run" }, () => fs.readFile(path.join(root, "example.txt"), "utf8"));
    expect(result).toBe("CONTENT_MUST_NOT_BE_CAPTURED");
    await diagnostics.close();
    const evidence = await readDiagnostics(path.join(root, "otel"), { maxRecords: 1000 });
    expect(evidence.records.filter((r) => r.name.startsWith("fs ") && r.kind === "span")).toEqual([]);
    expect(evidence.records.some((r) => r.kind === "metric" && r.name === "v8js.memory.heap.used")).toBe(true);
    expect(evidence.records.filter((r) => r.name === "http.client")).toHaveLength(0);
    expect(JSON.stringify(evidence)).not.toContain("CONTENT_MUST_NOT_BE_CAPTURED");
  } finally { await diagnostics.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("collects periodically, survives a throwing exporter and stops after close", async () => {
  let attempts = 0;
  const names: string[] = [];
  const runtime = new RuntimeMetrics((name) => { attempts++; if (attempts === 1) throw new Error("sink unavailable"); names.push(name); }, 30);
  try {
    await vi.waitFor(() => expect(names).toContain("v8js.memory.heap.used"), { timeout: 1000, interval: 20 });
    await runtime.close();
    const completed = names.length;
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(names.length).toBe(completed);
  } finally { await runtime.close(); }
});

it("contains malformed and oversized diagnostic traffic and resumes at the next record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "otel-channel-"));
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(root));
  const pipe = new PassThrough();
  consumeSandboxTelemetry(pipe, diagnostics, 1234, "notes");
  try {
    pipe.write("x".repeat(65_537));
    pipe.write("tail\nnot JSON\n");
    pipe.write(JSON.stringify({ kind: "checkpoint", name: "child.ok", attributes: { completed: true } }) + "\n");
    const ended = once(pipe, "end");
    pipe.end();
    await ended;
    await diagnostics.close();
    const evidence = await readDiagnostics(root, { maxRecords: 1000 });
    expect(evidence.records.find((r) => r.name === "child.ok")?.attributes.completed).toBe(true);
    expect(evidence.dropped).toBe(true);
    expect(evidence.malformed).toBe(0);
  } finally { await diagnostics.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("keeps sandbox results unchanged with disabled diagnostics and an unwritable diagnostic sink", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "otel-isolation-")));
  const allowed = path.join(root, "allowed");
  await fs.mkdir(allowed);
  await fs.writeFile(path.join(allowed, "one.txt"), "one");
  const blocker = path.join(root, "not-directory");
  await fs.writeFile(blocker, "keep");
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(blocker));
  const access = { accountId: "a", moduleId: "notes", revision: 1,
    scopes: [{ scopeRef: "scope", scopeId: "scope", label: "test", directory: allowed, read: true, write: false }], spoolDirectory: path.join(root, "spool") };
  const enabled = new NodeFileSandbox(access, undefined, diagnostics);
  const disabled = new NodeFileSandbox(access);
  try {
    const query = { type: "find" as const, query: "one", limit: 1 };
    const result = await enabled.execute(query);
    expect(result).toEqual(await disabled.execute(query));
    expect(result.entries.map((entry) => entry.fileName)).toEqual(["one.txt"]);
    await enabled.close();
    await diagnostics.close();
    expect(diagnostics.files.stats().failures).toBeGreaterThan(0);
    expect(await fs.readFile(blocker, "utf8")).toBe("keep");
  } finally { await enabled.close(); await disabled.close(); await diagnostics.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("collects short-lived sandbox runtime metrics without filesystem spans or wider read permissions", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "otel-child-")));
  const allowed = path.join(root, "allowed");
  await fs.mkdir(allowed);
  await fs.writeFile(path.join(allowed, "one.txt"), "SECRET_FILE_CONTENT");
  await fs.writeFile(path.join(root, "denied.txt"), "denied");
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(root, "otel")));
  const sandbox = new NodeFileSandbox({ accountId: "account", moduleId: "notes", revision: 1,
    scopes: [{ scopeRef: "scope", scopeId: "scope", label: "test", directory: allowed, read: true, write: false }],
    spoolDirectory: path.join(root, "spool"),
  }, undefined, diagnostics);
  try {
    const result = await sandbox.execute({ type: "find", query: "one", limit: 1 });
    expect(result.entries.map((entry) => entry.fileName)).toEqual(["one.txt"]);
    expect(await sandbox.verifyReadDenied(path.join(root, "denied.txt"))).toBe(true);
    await sandbox.close();
    await diagnostics.close();
    const evidence = await readDiagnostics(path.join(root, "otel"), { maxRecords: 1000 });
    const child = evidence.records.filter((r) => r.attributes.processRole === "file_sandbox");
    expect(child.filter((r) => r.kind === "span" && r.name.startsWith("fs "))).toEqual([]);
    expect(child.some((r) => r.kind === "span" && r.name === "sandbox.execute")).toBe(true);
    expect(child.some((r) => r.name === "v8js.memory.heap.used" && r.kind === "metric")).toBe(true);
    expect(child.every((r) => r.attributes.pid !== process.pid && r.attributes.moduleId === "notes")).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("SECRET_FILE_CONTENT");
  } finally { await sandbox.close(); await diagnostics.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it("persists official runtime measurements on close and reads metrics separately from spans", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "otel-metrics-"));
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(root));
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    await diagnostics.close();
    const evidence = await readDiagnostics(root, { maxRecords: 1000 });
    const metric = evidence.records.find((r) => r.kind === "metric" && r.name === "v8js.memory.heap.used");
    expect(metric).toBeDefined();
    expect(metric?.attributes.unit).toBe("By");
    expect(metric?.attributes.processRole).toBe("service");
    expect(metric?.attributes.pid).toBe(process.pid);
    const points = JSON.parse(String(metric?.attributes.dataPoints));
    expect(points.some((p: { value: number }) => p.value > 0)).toBe(true);
    expect(evidence.records.some((r) => r.kind === "metric" && r.name === "nodejs.eventloop.utilization")).toBe(true);
    expect(evidence.unfinished).toEqual([]);
    expect(evidence.malformed).toBe(0);
    expect((await fs.readdir(root)).some((name) => name.startsWith("metrics-"))).toBe(true);
  } finally { await diagnostics.close(); await fs.rm(root, { recursive: true, force: true }); }
});
