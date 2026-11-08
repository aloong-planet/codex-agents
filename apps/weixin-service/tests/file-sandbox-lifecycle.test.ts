import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeFileSandbox } from "../src/file-sandbox.js";
// Waits for the worker process to start or exit are process waits.
import { processWaitLimitMs } from "./support/process-wait.js";

// Real worker and framed IPC. The injected prelude only reports this test-owned PID;
// SIGSTOP is a synthetic stall, not a claim about the historical production trigger.
function fixture(prelude = "", write = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "weixin-sandbox-lifecycle-")));
  const directory = path.join(root, "files");
  const spool = path.join(root, "spool");
  fs.mkdirSync(directory);
  fs.mkdirSync(spool);
  fs.writeFileSync(path.join(directory, "probe.txt"), "recovery probe\n");
  fs.writeFileSync(path.join(root, "outside.txt"), "must stay outside the authorized scope\n");
  const pidPath = path.join(spool, "worker.pid");
  const workerPath = path.join(root, "worker.mjs");
  const source = fs.readFileSync(fileURLToPath(new URL("../src/file-sandbox-worker.mjs", import.meta.url)), "utf8");
  fs.writeFileSync(workerPath, `import lifecycleFs from "node:fs";
lifecycleFs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
${prelude.replaceAll("__DIRECTORY__", JSON.stringify(directory)).replaceAll("__SPOOL__", JSON.stringify(spool))}
` + source);
  const sandbox = new NodeFileSandbox({ accountId: "fixture", moduleId: "files", revision: 1,
    scopes: [{ scopeRef: "scope", scopeId: "files", label: "Files", directory, read: true, write }],
    spoolDirectory: spool }, workerPath);
  return { root, directory, spool, sandbox, pid: () => Number(fs.readFileSync(pidPath, "utf8")),
    cleanup: async () => { await sandbox.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

const query = { type: "find" as const, scopeRefs: ["scope"], query: "probe", match: "literal" as const, limit: 1 };

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("file_sandbox_lifecycle", () => {
  it("lets the next query recover after a real worker timeout without replaying the failed query", async () => {
    const f = fixture();
    try {
      expect((await f.sandbox.execute(query)).entries.map((entry) => entry.fileName)).toEqual(["probe.txt"]);
      const originalPid = f.pid();
      process.kill(originalPid, "SIGSTOP");
      await expect(f.sandbox.execute(query)).rejects.toThrow("file_sandbox_timeout");
      expect((await f.sandbox.execute(query)).entries.map((entry) => entry.fileName)).toEqual(["probe.txt"]);
      expect(f.pid()).not.toBe(originalPid);
    } finally { await f.cleanup(); }
  }, 15_000);

  it("clears a rejected initialization for later calls while settling all concurrent waiters", async () => {
    const f = fixture(`if (!lifecycleFs.existsSync(__DIRECTORY__ + "/continue")) {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}`);
    try {
      const results = await Promise.allSettled([f.sandbox.execute(query), f.sandbox.execute(query)]);
      expect(results).toEqual([
        { status: "rejected", reason: new Error("file_sandbox_timeout") },
        { status: "rejected", reason: new Error("file_sandbox_timeout") },
      ]);
      fs.writeFileSync(path.join(f.directory, "continue"), "ready");
      const recovered = await Promise.all([f.sandbox.execute(query), f.sandbox.execute(query)]);
      expect(recovered.map((result) => result.entries.map((entry) => entry.fileName)))
        .toEqual([["probe.txt"], ["probe.txt"]]);
    } finally { await f.cleanup(); }
  }, 15_000);

  it("retires the worker when initialization returns an error instead of leaking it on the next start", async () => {
    const f = fixture(`if (!lifecycleFs.existsSync(__DIRECTORY__ + "/continue")) {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (frame, ...args) => {
    const value = JSON.parse(frame.subarray(4).toString("utf8"));
    const body = Buffer.from(JSON.stringify({ requestId: value.requestId, ok: false, error: "file_sandbox_operation_failed" }));
    const replacement = Buffer.alloc(body.length + 4);
    replacement.writeUInt32BE(body.length, 0); body.copy(replacement, 4);
    return originalWrite(replacement, ...args);
  };
}`);
    try {
      await expect(f.sandbox.execute(query)).rejects.toThrow("file_sandbox_operation_failed");
      const failedPid = f.pid();
      await expect.poll(() => alive(failedPid), { timeout: processWaitLimitMs }).toBe(false);
      fs.writeFileSync(path.join(f.directory, "continue"), "ready");
      expect((await f.sandbox.execute(query)).entries.map((entry) => entry.fileName)).toEqual(["probe.txt"]);
    } finally { await f.cleanup(); }
  });

  it("recovers from an idle exit and keeps ordinary file errors in the same live worker", async () => {
    const f = fixture();
    try {
      await f.sandbox.execute(query);
      const pid = f.pid();
      await expect(f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "missing.txt" }))
        .rejects.toThrow("file_sandbox_file_missing");
      await f.sandbox.execute(query);
      expect(f.pid()).toBe(pid);
      process.kill(pid, "SIGKILL");
      await expect.poll(() => alive(pid), { timeout: processWaitLimitMs }).toBe(false);
      expect((await f.sandbox.execute(query)).entries.map((entry) => entry.fileName)).toEqual(["probe.txt"]);
      expect(f.pid()).not.toBe(pid);
    } finally { await f.cleanup(); }
  });

  it("rejects all in-flight reads on timeout and fences the retired worker while new requests initialize", async () => {
    const f = fixture();
    try {
      await f.sandbox.execute(query);
      process.kill(f.pid(), "SIGSTOP");
      const results = await Promise.allSettled([
        f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "probe.txt" }),
        f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "probe.txt" }),
      ]);
      expect(results).toEqual([
        { status: "rejected", reason: new Error("file_sandbox_timeout") },
        { status: "rejected", reason: new Error("file_sandbox_timeout") },
      ]);
      // Start immediately, without waiting for the retired child's exit callback.
      const recovered = await Promise.all([f.sandbox.execute(query), f.sandbox.execute(query)]);
      expect(recovered.map((result) => result.entries.map((entry) => entry.fileName)))
        .toEqual([["probe.txt"], ["probe.txt"]]);
    } finally { await f.cleanup(); }
  }, 15_000);

  it("does not replay a modification whose worker timed out after replacing the file", async () => {
    const f = fixture(`const originalRename = lifecycleFs.promises.rename;
lifecycleFs.promises.rename = async (...args) => {
  await originalRename(...args);
  lifecycleFs.appendFileSync(__SPOOL__ + "/renames", "replaced\\n");
  await new Promise(() => {});
};`, true);
    try {
      const before = await f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "probe.txt" });
      await expect(f.sandbox.execute({ type: "write", scopeRef: "scope", relativePath: "probe.txt",
        content: "written once\n", overwrite: true, expectedSha256: before.sha256 })).rejects.toThrow("file_sandbox_timeout");
      expect((await f.sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "probe.txt" })).content)
        .toBe("written once\n");
      expect(fs.readFileSync(path.join(f.spool, "renames"), "utf8")).toBe("replaced\n");
    } finally { await f.cleanup(); }
  }, 15_000);

  it("retires malformed protocol output but preserves permission restrictions in its replacement", async () => {
    const f = fixture(`const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (frame, ...args) => originalWrite(
  lifecycleFs.existsSync(__DIRECTORY__ + "/corrupt") ? Buffer.from([0, 0, 0, 1]) : frame, ...args);`);
    try {
      await f.sandbox.execute(query);
      fs.writeFileSync(path.join(f.directory, "corrupt"), "fault");
      await expect(f.sandbox.execute(query)).rejects.toThrow("file_sandbox_protocol_invalid");
      fs.unlinkSync(path.join(f.directory, "corrupt"));
      expect((await f.sandbox.execute(query)).entries.map((entry) => entry.fileName)).toEqual(["probe.txt"]);
      expect(await f.sandbox.verifyReadDenied(path.join(f.root, "outside.txt"))).toBe(true);
      await expect(f.sandbox.execute({ type: "write", scopeRef: "scope", relativePath: "denied.txt",
        content: "must not write", overwrite: false })).rejects.toThrow("file_sandbox_permission_denied");
      expect(fs.existsSync(path.join(f.directory, "denied.txt"))).toBe(false);
    } finally { await f.cleanup(); }
  });

  for (const stage of ["before_start", "initializing", "executing"] as const) {
    it(`permanently closes ${stage}, settling callers and concurrent close requests`, async () => {
      const f = fixture(stage === "initializing" ? "setInterval(() => {}, 1000); await new Promise(() => {});" : "");
      try {
        let result: Promise<unknown> | undefined;
        let pid: number | undefined;
        if (stage === "executing") {
          await f.sandbox.execute(query);
          pid = f.pid();
          process.kill(pid, "SIGSTOP");
        }
        if (stage !== "before_start") {
          result = expect(f.sandbox.execute(query)).rejects.toThrow("file_sandbox_closed");
          await expect.poll(() => { try { return f.pid() > 0; } catch { return false; } }, { timeout: processWaitLimitMs }).toBe(true);
          pid = f.pid();
        }
        await Promise.all([f.sandbox.close(), f.sandbox.close(), result]);
        if (pid !== undefined) await expect.poll(() => alive(pid), { timeout: processWaitLimitMs }).toBe(false);
        await expect(f.sandbox.execute(query)).rejects.toThrow("file_sandbox_closed");
      } finally { await f.cleanup(); }
    });
  }
});
