import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { NodeFileSandbox } from "../src/file-sandbox.js";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";

// Public sandbox + real Node IPC + persisted OTel, not preconstructed spans.
function fixture(prelude = "", write = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "weixin-sandbox-trace-")));
  const directory = path.join(root, "files");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "one.txt"), "BODY_NOT_IN_TELEMETRY");
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(root, "otel")));
  const spool = path.join(root, "spool");
  fs.mkdirSync(spool);
  const pidPath = path.join(spool, "pid");
  const workerPath = path.join(root, "worker.mjs");
  fs.writeFileSync(workerPath, `import traceFs from "node:fs";
traceFs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
${prelude.replaceAll("__FILES__", JSON.stringify(directory))}
` + fs.readFileSync(fileURLToPath(new URL("../src/file-sandbox-worker.mjs", import.meta.url)), "utf8"));
  const sandbox = new NodeFileSandbox({ accountId: "fixture", moduleId: "notes", revision: 1,
    scopes: [{ scopeRef: "scope", scopeId: "files", label: "Files", directory, read: true, write }],
    spoolDirectory: spool }, workerPath, diagnostics);
  return { root, directory, sandbox, diagnostics, pid: () => Number(fs.readFileSync(pidPath, "utf8")),
    evidence: () => readDiagnostics(path.join(root, "otel"), { maxRecords: 1000 }),
    cleanup: async () => { await sandbox.close(); await diagnostics.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

it("records one shared init, independent tool-parented executes and the same worker identity in metrics", async () => {
  const f = fixture();
  try {
    const query = { type: "find" as const, query: "one", limit: 1 };
    const results = await Promise.all(["first", "second"].map((runRef) =>
      f.diagnostics.run("tool.call", { runRef }, () => f.sandbox.execute(query))));
    expect(results.map((r) => r.entries.map((e) => e.fileName))).toEqual([["one.txt"], ["one.txt"]]);
    await f.sandbox.close();
    await f.diagnostics.close();
    const evidence = await f.evidence();
    const spans = evidence.records.filter((r) => r.kind === "span");
    const init = spans.filter((r) => r.name === "sandbox.init");
    const executes = spans.filter((r) => r.name === "sandbox.execute");
    expect(init).toHaveLength(1);
    expect(executes).toHaveLength(2);
    expect(executes.map((r) => r.attributes.runRef).sort()).toEqual(["first", "second"]);
    for (const execute of executes) {
      expect(execute.parentSpanId).toBe(spans.find((r) => r.name === "tool.call" && r.attributes.runRef === execute.attributes.runRef)?.spanId);
    }
    expect(new Set(executes.map((r) => r.attributes.requestId)).size).toBe(2);
    expect(executes.every((r) => r.attributes.status === "succeeded" && Number(r.attributes.durationMs) >= 0)).toBe(true);
    const workerId = init[0]!.attributes.workerInstanceId;
    expect(typeof workerId).toBe("string");
    expect(executes.every((r) => r.attributes.workerInstanceId === workerId)).toBe(true);
    expect(evidence.records.some((r) => r.kind === "metric" && r.attributes.workerInstanceId === workerId && r.attributes.generation === 1)).toBe(true);
    expect(evidence.records.find((r) => r.name === "sandbox.exit")?.attributes).toMatchObject({ reason: "file_sandbox_closed", exitCode: 0 });
    expect(evidence.unfinished).toEqual([]);
    expect(JSON.stringify(evidence)).not.toContain("BODY_NOT_IN_TELEMETRY");
  } finally { await f.cleanup(); }
});

it("preserves the timeout culprit, affected peers and retired worker exit across immediate recovery", async () => {
  const f = fixture();
  try {
    await f.sandbox.execute({ type: "find", limit: 1 });
    const oldPid = f.pid();
    process.kill(oldPid, "SIGSTOP");
    const result = await Promise.allSettled([1, 2].map((id) => f.diagnostics.run("tool.call", { runRef: `timeout-${id}` },
      () => f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "one.txt" }))));
    expect(result).toEqual([{ status: "rejected", reason: new Error("file_sandbox_timeout") }, { status: "rejected", reason: new Error("file_sandbox_timeout") }]);
    expect((await f.sandbox.execute({ type: "find", limit: 1 })).entries.map((e) => e.fileName)).toEqual(["one.txt"]);
    expect(f.pid()).not.toBe(oldPid);
    await f.sandbox.close(); await f.diagnostics.close();
    const { records } = await f.evidence();
    const failed = records.filter((r) => r.kind === "span" && r.name === "sandbox.execute" && r.attributes.status === "failed");
    expect(failed).toHaveLength(2);
    expect(failed.map((r) => r.attributes.failureRole).sort()).toEqual(["affected", "trigger"]);
    expect(new Set(failed.map((r) => r.attributes.triggerRequestId)).size).toBe(1);
    const timeout = records.filter((r) => r.name === "sandbox.timeout");
    expect(timeout).toHaveLength(1);
    expect(timeout[0]!.attributes.runRef).toBe("timeout-1");
    expect(timeout[0]!.attributes.requestId).toBe(failed.find((r) => r.attributes.failureRole === "trigger")!.attributes.requestId);
    const exit = records.find((r) => r.name === "sandbox.exit" && r.attributes.pid === oldPid);
    expect(exit?.attributes).toMatchObject({ generation: 1, signal: "SIGKILL", reason: "file_sandbox_timeout", runRef: "timeout-1" });
    expect(records.filter((r) => r.name === "sandbox.init" && r.kind === "span").map((r) => r.attributes.generation)).toEqual([1, 2]);
    expect(records.filter((r) => r.name === "sandbox.execute.end")).toHaveLength(4);
  } finally { await f.cleanup(); }
}, 15000);

it("keeps ordinary file errors in the same worker and records them as failed executes", async () => {
  const f = fixture();
  try {
    await expect(f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "missing.txt" })).rejects.toThrow("file_sandbox_file_missing");
    expect((await f.sandbox.execute({ type: "find", limit: 1 })).entries.map((e) => e.fileName)).toEqual(["one.txt"]);
    await f.sandbox.close(); await f.diagnostics.close();
    const { records } = await f.evidence();
    expect(records.filter((r) => r.name === "sandbox.init" && r.kind === "span")).toHaveLength(1);
    expect(records.filter((r) => r.name === "sandbox.execute" && r.kind === "span").map((r) => [r.attributes.status, r.attributes.errorCode]))
      .toEqual([["failed", "file_sandbox_file_missing"], ["succeeded", undefined]]);
    expect(records.filter((r) => r.name === "sandbox.invalidate")).toHaveLength(0);
  } finally { await f.cleanup(); }
});

it("exports initialization start before completion and settles concurrent waiters when closed", async () => {
  const f = fixture("setInterval(() => {}, 1000); await new Promise(() => {});");
  try {
    const results = Promise.allSettled([f.sandbox.execute({ type: "find" }), f.sandbox.execute({ type: "find" })]);
    await expect.poll(() => { try { return f.pid() > 0; } catch { return false; } }).toBe(true);
    await f.diagnostics.files.flush();
    const before = await f.evidence();
    expect(before.records.filter((r) => r.name === "sandbox.init.start")).toHaveLength(1);
    expect(before.records.filter((r) => r.name === "sandbox.execute.start")).toHaveLength(0);
    expect(before.unfinished.some((r) => r.name === "sandbox.init.start")).toBe(true);
    await Promise.all([f.sandbox.close(), f.sandbox.close()]);
    expect(await results).toEqual([{ status: "rejected", reason: new Error("file_sandbox_closed") }, { status: "rejected", reason: new Error("file_sandbox_closed") }]);
    await f.diagnostics.close();
    const { records, unfinished } = await f.evidence();
    expect(records.filter((r) => r.name === "sandbox.init" && r.kind === "span")).toHaveLength(1);
    expect(records.find((r) => r.name === "sandbox.init")?.attributes).toMatchObject({ status: "failed", errorCode: "file_sandbox_closed" });
    expect(records.filter((r) => r.name === "sandbox.close")).toHaveLength(1);
    expect(unfinished).toEqual([]);
  } finally { await f.cleanup(); }
});

it("records initialization timeout without fabricating execute spans and starts a new generation on the next call", async () => {
  const f = fixture('if (!traceFs.existsSync(__FILES__ + "/continue")) { setInterval(() => {}, 1000); await new Promise(() => {}); }');
  try {
    await expect(f.sandbox.execute({ type: "find" })).rejects.toThrow("file_sandbox_timeout");
    fs.writeFileSync(path.join(f.directory, "continue"), "go");
    await f.sandbox.execute({ type: "find", query: "one" });
    await f.sandbox.close(); await f.diagnostics.close();
    const { records } = await f.evidence();
    const inits = records.filter((r) => r.name === "sandbox.init" && r.kind === "span");
    expect(inits.map((r) => r.attributes.status)).toEqual(["failed", "succeeded"]);
    expect(inits[0]!.attributes).toMatchObject({ errorCode: "file_sandbox_timeout", failureRole: "trigger" });
    expect(records.filter((r) => r.name === "sandbox.execute" && r.kind === "span")).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 15000);

it("records real initialization exit code and preserves protocol failure on the first frame", async () => {
  for (const prelude of ['process.exit(7);', 'process.stdout.write(Buffer.from([0, 0, 0, 1]));']) {
    const f = fixture(prelude);
    try {
      await expect(f.sandbox.execute({ type: "find" })).rejects.toThrow(prelude.startsWith("process.exit") ? "file_sandbox_exited" : "file_sandbox_protocol_invalid");
      await f.sandbox.close(); await f.diagnostics.close();
      const { records } = await f.evidence();
      expect(records.filter((r) => r.name === "sandbox.init" && r.kind === "span")).toHaveLength(1);
      const exit = records.find((r) => r.name === "sandbox.exit");
      expect(exit?.attributes.reason).toBe(prelude.startsWith("process.exit") ? "file_sandbox_exited" : "file_sandbox_protocol_invalid");
      if (prelude.startsWith("process.exit")) expect(exit?.attributes.exitCode).toBe(7);
    } finally { await f.cleanup(); }
  }
});

it("does not mark an invalid successful response as a successful file operation", async () => {
  const f = fixture(`let writes = 0;
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (frame, ...args) => {
  if (++writes === 1) return originalWrite(frame, ...args);
  const value = JSON.parse(frame.subarray(4).toString("utf8"));
  const body = Buffer.from(JSON.stringify({ requestId: value.requestId, ok: true, result: {} }));
  const replacement = Buffer.alloc(body.length + 4); replacement.writeUInt32BE(body.length); body.copy(replacement, 4);
  return originalWrite(replacement, ...args);
};`);
  try {
    await expect(f.sandbox.execute({ type: "find" })).rejects.toThrow("file_sandbox_protocol_invalid");
    await f.sandbox.close(); await f.diagnostics.close();
    expect((await f.evidence()).records.find((r) => r.name === "sandbox.execute")?.attributes)
      .toMatchObject({ status: "failed", errorCode: "file_sandbox_protocol_invalid" });
  } finally { await f.cleanup(); }
});

it("includes a rejected prepared journal confirmation in execute failure without committing the file", async () => {
  const f = fixture("", true);
  try {
    const before = await f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "one.txt" });
    await expect(f.sandbox.execute({ type: "write", scopeRef: "scope", relativePath: "one.txt", content: "new body",
      overwrite: true, expectedSha256: before.sha256 }, () => { throw new Error("journal_unavailable"); })).rejects.toThrow("journal_unavailable");
    expect(fs.readFileSync(path.join(f.directory, "one.txt"), "utf8")).toBe("BODY_NOT_IN_TELEMETRY");
    await f.sandbox.close(); await f.diagnostics.close();
    const { records } = await f.evidence();
    expect(records.find((r) => r.name === "sandbox.execute" && r.attributes.operation === "write")?.attributes)
      .toMatchObject({ status: "failed", errorCode: "journal_unavailable" });
    expect(JSON.stringify(records)).not.toContain("new body");
  } finally { await f.cleanup(); }
});

it("settles an active execute once on close and does not create requests after closure", async () => {
  const f = fixture();
  try {
    await f.sandbox.execute({ type: "find", limit: 1 });
    process.kill(f.pid(), "SIGSTOP");
    const result = Promise.allSettled([f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "one.txt" })]);
    await expect.poll(async () => {
      await f.diagnostics.files.flush();
      return (await f.evidence()).records.filter((r) => r.name === "sandbox.execute.start").length;
    }).toBe(2);
    await f.sandbox.close();
    expect(await result).toEqual([{ status: "rejected", reason: new Error("file_sandbox_closed") }]);
    await expect(f.sandbox.execute({ type: "find" })).rejects.toThrow("file_sandbox_closed");
    await f.diagnostics.close();
    const { records, unfinished } = await f.evidence();
    expect(records.filter((r) => r.name === "sandbox.execute.end")).toHaveLength(2);
    expect(records.find((r) => r.name === "sandbox.execute" && r.attributes.operation === "read")?.attributes)
      .toMatchObject({ status: "failed", errorCode: "file_sandbox_closed", reason: "file_sandbox_closed" });
    expect(records.filter((r) => r.name === "sandbox.timeout")).toHaveLength(0);
    expect(unfinished).toEqual([]);
  } finally { await f.cleanup(); }
});

it("preserves file results when the diagnostic sink has already closed", async () => {
  const f = fixture();
  try {
    await f.diagnostics.close();
    expect((await f.sandbox.execute({ type: "find", query: "one" })).entries.map((e) => e.fileName)).toEqual(["one.txt"]);
    await expect(f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "absent.txt" })).rejects.toThrow("file_sandbox_file_missing");
  } finally { await f.cleanup(); }
});
