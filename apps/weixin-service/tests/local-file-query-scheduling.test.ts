// Real worker transport observations prove scheduling; no private session state.
// Physical disk failures and phone receipt require separate acceptance evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { LocalFileTools } from "../src/local-file-tools.js";
import { unrelatedProtectedRoots } from "./support/service-state.js";

const transport = vi.hoisted(() => ({
  exited: new Set<number>(), mustExitBeforeNext: 0, startedBeforeExit: false,
  active: new Set<string>(), maxActive: 0, starts: [] as string[],
  heldPid: 0, holdNext: false, held: undefined as (() => void) | undefined,
  onHeld: undefined as (() => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    if (!args[1]?.some((arg) => arg.endsWith("file-sandbox-worker.mjs"))) return child;
    child.once("close", () => { transport.exited.add(child.pid!); });
    let buffered = Buffer.alloc(0);
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4 && buffered.length >= buffered.readUInt32BE(0) + 4) {
        const size = buffered.readUInt32BE(0);
        const response = JSON.parse(buffered.subarray(4, size + 4).toString("utf8"));
        transport.active.delete(response.requestId);
        buffered = buffered.subarray(size + 4);
      }
    });
    const write = child.stdin!.write.bind(child.stdin!);
    child.stdin!.write = ((chunk: Buffer, ...rest: unknown[]) => {
      const frame = JSON.parse(chunk.subarray(4).toString("utf8"));
      if (frame.type === "execute" && ["find", "grep"].includes(frame.operation.type) && !frame.operation.cancelScan) {
        if (transport.mustExitBeforeNext && child.pid !== transport.mustExitBeforeNext && !transport.exited.has(transport.mustExitBeforeNext)) transport.startedBeforeExit = true;
        transport.active.add(frame.requestId);
        transport.starts.push(frame.requestId);
        transport.maxActive = Math.max(transport.maxActive, transport.active.size);
        if (transport.holdNext) {
          transport.holdNext = false;
          transport.heldPid = child.pid!;
          transport.held = () => Reflect.apply(write, child.stdin, [chunk, ...rest]);
          transport.onHeld?.();
          return true;
        }
      }
      return Reflect.apply(write, child.stdin, [chunk, ...rest]);
    }) as typeof write;
    return child;
  } };
});
let root: string;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "query-scheduling-")));
  fs.mkdirSync(path.join(root, "large", "nested"), { recursive: true });
  fs.mkdirSync(path.join(root, "small"));
  for (let i = 0; i < 4100; i++) fs.writeFileSync(path.join(root, "large", "nested", `item-${i}.txt`), "synthetic");
  fs.writeFileSync(path.join(root, "small", "small-proof.txt"), "synthetic");
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  transport.exited.clear(); transport.mustExitBeforeNext = 0; transport.startedBeforeExit = false;
  transport.active.clear(); transport.maxActive = 0; transport.starts = [];
  transport.holdNext = false; transport.held = undefined; transport.onHeld = undefined;
});
function fixture(options: Partial<ConstructorParameters<typeof LocalFileTools>[1]> = {}, revision = () => 1) {
  const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: revision(), saved: true,
    scopes: ["large", "small"].map((name) => ({ scopeId: name, label: name, directory: path.join(root, name), read: true, write: false })),
  }) }, { moduleIds: ["files"], protectedRoots: unrelatedProtectedRoots, spoolDirectory: path.join(root, `spool-${crypto.randomUUID()}`), ...options });
  const turns = ["weixin", "feishu"].map((channel) => ({ eventKey: crypto.randomUUID(), accountId: "owner", target: channel,
    occurredAt: Date.now(), originalTextRef: "synthetic", attachmentRefs: [] }));
  const bindings = turns.map((turn) => tools.bindTurn(turn));
  const query = (index: number, scope: number) => tools.execute({ toolId: "files.find", toolVersion: 2,
    arguments: { scopeRefs: [bindings[index]!.promptLines[scope]!.split(":", 1)[0]!], kind: "file", limit: 1 } }, turns[index]!);
  return { tools, turns, bindings, query, close: async () => {
    transport.held?.(); transport.held = undefined;
    await Promise.all(bindings.map((binding) => binding.release())); await tools.close();
  } };
}
async function holdFirst() {
  transport.holdNext = true;
  return new Promise<void>((resolve) => { transport.onHeld = resolve; });
}
it.each(["find", "grep"] as const)("rotates real traversal batches before a later %s without concurrent disk scans", async (operation) => {
  const f = fixture();
  try {
    await f.query(0, 1); await f.query(1, 1); // Warm each real worker before observing overlap.
    transport.active.clear(); transport.maxActive = 0; transport.starts = [];
    const held = holdFirst(); const order: string[] = [];
    const large = f.query(0, 0).then((result) => { order.push("large"); return result; });
    await held;
    const smallRequest = operation === "find" ? f.query(1, 1) : f.tools.execute({ toolId: "files.grep", toolVersion: 2,
      arguments: { scopeRefs: [f.bindings[1]!.promptLines[1]!.split(":", 1)[0]!], pattern: "synthetic", limit: 1 } }, f.turns[1]!);
    const small = smallRequest.then((result) => { order.push("small"); return result; });
    await setImmediate();
    transport.held!(); transport.held = undefined;
    const [a, b] = await Promise.all([large, small]);
    expect(a).toMatchObject({ scanComplete: true });
    expect(b).toMatchObject({ scanComplete: true, [operation === "find" ? "entries" : "matches"]: [{ fileName: "small-proof.txt" }] });
    expect(transport.starts.length).toBeGreaterThanOrEqual(4);
    expect(transport.maxActive).toBe(1);
    expect(order).toEqual(["small", "large"]);
  } finally { await f.close(); }
});

it("charges queue waiting separately while retaining each turn's execution allowance", async () => {
  let clock = 0;
  const f = fixture({ now: () => clock, budget: { maxWallClockMs: 100 }, queryScheduling: { maxWaitMs: 1000 } });
  try {
    await f.query(0, 1); await f.query(1, 1);
    const firstHeld = holdFirst();
    const first = f.query(0, 1); await firstHeld;
    const second = f.query(1, 1);
    await setImmediate();
    clock = 300; // Only the first turn is executing; the second is waiting.
    const releaseFirst = transport.held!;
    const secondHeld = holdFirst(); releaseFirst();
    await secondHeld;
    clock = 350; // Second turn consumes only 50 execution ms.
    transport.held!(); transport.held = undefined;
    await expect(first).resolves.toMatchObject({ scanComplete: true });
    await expect(second).resolves.toMatchObject({ scanComplete: true });
    await expect(f.query(0, 1)).rejects.toThrow("local_file_turn_budget_exhausted");
    await expect(f.query(1, 1)).resolves.toMatchObject({ scanComplete: true });
  } finally { await f.close(); }
});

it("removes a released turn's queued batch without closing the active turn", async () => {
  const f = fixture();
  try {
    await f.query(0, 1); await f.query(1, 1); transport.starts = [];
    const held = holdFirst(); const first = f.query(0, 1); await held;
    const second = f.query(1, 1); const rejected = expect(second).rejects.toThrow("local_file_turn_unavailable");
    await setImmediate(); await f.bindings[1]!.release(); await rejected;
    transport.held!(); transport.held = undefined;
    await expect(first).resolves.toMatchObject({ scanComplete: true });
    expect(transport.starts).toHaveLength(1);
    await expect(f.query(0, 1)).resolves.toMatchObject({ scanComplete: true });
  } finally { await f.close(); }
});
it("releases admission when the active turn is closed and lets the other turn complete", async () => {
  const f = fixture();
  try {
    await f.query(0, 1); await f.query(1, 1);
    const held = holdFirst(); const first = f.query(0, 1);
    const rejected = expect(first).rejects.toThrow("file_sandbox_closed"); await held;
    const second = f.query(1, 1); await setImmediate();
    transport.held = undefined; // Closed worker must never receive the held test frame.
    await f.bindings[0]!.release(); await rejected;
    await expect(second).resolves.toMatchObject({ scanComplete: true, entries: [{ fileName: "small-proof.txt" }] });
  } finally { await f.close(); }
});
it("rechecks authorization after waiting before dispatching any filesystem request", async () => {
  let revision = 1; const f = fixture({}, () => revision);
  try {
    await f.query(0, 1); await f.query(1, 1); transport.starts = [];
    const held = holdFirst(); const first = f.query(0, 1);
    const firstRejected = expect(first).rejects.toThrow("local_file_permission_changed"); await held;
    const second = f.query(1, 1); const secondRejected = expect(second).rejects.toThrow("local_file_permission_changed");
    await setImmediate(); revision = 2;
    transport.held!(); transport.held = undefined;
    await firstRejected; await secondRejected;
    expect(transport.starts).toHaveLength(1);
  } finally { await f.close(); }
});
it("rejects queued work on service close without starting another worker", async () => {
  const f = fixture();
  try {
    await f.query(0, 1); transport.starts = [];
    const held = holdFirst(); const first = f.query(0, 1);
    const firstRejected = expect(first).rejects.toThrow("file_sandbox_closed"); await held;
    const second = f.query(1, 1); const secondRejected = expect(second).rejects.toThrow("local_file_turn_unavailable");
    await setImmediate(); transport.held = undefined;
    await f.tools.close(); await firstRejected; await secondRejected;
    expect(transport.starts).toHaveLength(1);
    expect(() => f.tools.bindTurn({ ...f.turns[1]!, eventKey: "after-close" })).toThrow("local_file_tools_closed");
  } finally { await f.close(); }
});

it("does not reset cumulative queue allowance between queries in the same turn", async () => {
  let clock = 0;
  const f = fixture({ now: () => clock, queryScheduling: { maxWaitMs: 100 } });
  try {
    await f.query(0, 1); await f.query(1, 1);
    const held = holdFirst(); const first = f.query(0, 1); await held;
    const second = f.query(1, 1); await setImmediate(); clock = 60;
    transport.held!(); transport.held = undefined;
    await first; await second;
    const nextHeld = holdFirst(); const next = f.query(0, 1); await nextHeld;
    const expired = f.query(1, 1); const rejected = expect(expired).rejects.toThrow("local_file_query_queue_timeout");
    await setImmediate(); clock = 100;
    transport.held!(); transport.held = undefined;
    await next; await rejected;
    await expect(f.query(1, 1)).rejects.toThrow("local_file_query_queue_timeout");
    await expect(f.query(0, 1)).resolves.toMatchObject({ scanComplete: true });
  } finally { await f.close(); }
});
it("releases the disk slot after actual worker death without failing another turn", async () => {
  const f = fixture();
  try {
    await f.query(0, 1); await f.query(1, 1);
    const held = holdFirst(); const first = f.query(0, 1);
    const rejected = expect(first).rejects.toThrow("file_sandbox_exited"); await held;
    const second = f.query(1, 1); await setImmediate();
    transport.held = undefined; process.kill(transport.heldPid, "SIGKILL");
    await rejected;
    await expect(second).resolves.toMatchObject({ scanComplete: true });
    await expect(f.query(0, 1)).resolves.toMatchObject({ scanComplete: true });
  } finally { await f.close(); }
});
it("persists queue and execution time separately and ignores scheduling diagnostic failure", async () => {
  let clock = 0; const directory = path.join(root, "query-otel");
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(directory));
  const f = fixture({ diagnostics, now: () => clock });
  try {
    await f.query(0, 1); await f.query(1, 1);
    const held = holdFirst(); const first = f.query(0, 1); await held;
    const second = f.query(1, 1); await setImmediate(); clock = 300;
    const releaseFirst = transport.held!; const secondHeld = holdFirst(); releaseFirst();
    await secondHeld; clock = 350; transport.held!(); transport.held = undefined;
    await first; await second;
    const checkpoint = diagnostics.checkpoint.bind(diagnostics);
    const spy = vi.spyOn(diagnostics, "checkpoint").mockImplementation((name, ...args) => {
      if (name.startsWith("files.")) throw new Error("diagnostic-unavailable");
      return checkpoint(name, ...args);
    });
    try { await expect(f.query(1, 1)).resolves.toMatchObject({ scanComplete: true }); }
    finally { spy.mockRestore(); }
    await f.close(); await diagnostics.close();
    const result = await readDiagnostics(directory, { maxRecords: 1000 });
    const queued = result.records.filter((record) => record.name === "files.query.scheduling" && record.attributes.queueWaitMs === 300);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.attributes).toMatchObject({ eventKey: f.turns[1]!.eventKey, operation: "find", executionMs: 50, outcome: "succeeded" });
    expect(JSON.stringify(result)).not.toContain("small-proof.txt");
  } finally { await f.close(); await diagnostics.close(); }
});
it("waits for the cancelled active worker to exit before lending the disk slot", async () => {
  const f = fixture();
  try {
    await f.query(0, 1); await f.query(1, 1);
    const held = holdFirst(); const first = f.query(0, 1);
    const rejected = expect(first).rejects.toThrow("file_sandbox_closed"); await held;
    process.kill(transport.heldPid, "SIGSTOP");
    transport.held!(); transport.held = undefined;
    transport.mustExitBeforeNext = transport.heldPid;
    const second = f.query(1, 1); await setImmediate();
    await f.bindings[0]!.release(); await rejected;
    await expect(second).resolves.toMatchObject({ scanComplete: true });
    expect(transport.exited.has(transport.mustExitBeforeNext)).toBe(true);
    expect(transport.startedBeforeExit).toBe(false);
  } finally { await f.close(); }
});
