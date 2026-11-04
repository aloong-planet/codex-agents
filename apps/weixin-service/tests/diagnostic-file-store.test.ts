import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticFileStore as DiagnosticFiles } from "../src/diagnostic-file-store.js";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-files-"));
  directories.push(directory);
  return directory;
}

it("persists UTF-8 JSONL in separate private signal files without overwriting after restart", async () => {
  const directory = await fixture();
  const files = new DiagnosticFiles(directory);
  files.append("traces", { name: "first", text: "换行\n不是另一条记录" });
  files.append("checkpoints", { name: "started" });
  await files.close();
  const restarted = new DiagnosticFiles(directory);
  restarted.append("traces", { name: "second" });
  await restarted.close();
  const names = await fs.readdir(directory);
  expect(names.filter((name) => name.startsWith("traces-")).length).toBe(2);
  expect(names.filter((name) => name.startsWith("checkpoints-")).length).toBe(1);
  const records: unknown[] = [];
  for (const name of names) {
    expect((await fs.stat(path.join(directory, name))).mode & 0o777).toBe(0o600);
    const text = await fs.readFile(path.join(directory, name), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    records.push(...text.trimEnd().split("\n").map((line) => JSON.parse(line)));
  }
  expect(records).toEqual(expect.arrayContaining([{ name: "first", text: "换行\n不是另一条记录" }, { name: "started" }, { name: "second" }]));
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
});

it.each(["traces", "metrics"] as const)("seals idle hourly %s files and expires only owned sealed diagnostics", async (signal) => {
  const directory = await fixture();
  let now = 1_780_000_000_000;
  const files = new DiagnosticFiles(directory, { now: () => now, retentionMs: 7 * 86_400_000 });
  await fs.writeFile(path.join(directory, "business.json"), "keep");
  files.append(signal, { name: "old" });
  await files.flush();
  now += 3_600_000;
  await files.maintain();
  expect((await fs.readdir(directory)).filter((name) => name.endsWith("-open.jsonl"))).toEqual([]);
  now += 7 * 86_400_000 + 1;
  await files.maintain();
  expect(await fs.readdir(directory)).toEqual(["business.json"]);
  expect(await fs.readFile(path.join(directory, "business.json"), "utf8")).toBe("keep");
  await files.close();
});

it("bounds segments, aggregate bytes, queue and record size without deleting unrelated files", async () => {
  const directory = await fixture();
  const files = new DiagnosticFiles(directory, { maxFileBytes: 40, maxTotalBytes: 80, maxFiles: 2, maxQueuedRecords: 1, maxRecordBytes: 40 });
  await fs.writeFile(path.join(directory, "keep.txt"), "business");
  files.append("traces", { n: 1 });
  files.append("traces", { n: 2 });
  files.append("traces", { secret: "x".repeat(50) });
  files.append("traces", undefined);
  await files.flush();
  for (let n = 3; n < 20; n += 1) { files.append("traces", { n }); await files.flush(); }
  await files.close();
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  expect(names.length).toBeLessThanOrEqual(2);
  const sizes = await Promise.all(names.map(async (name) => (await fs.stat(path.join(directory, name))).size));
  expect(sizes.every((size) => size <= 40)).toBe(true);
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(80);
  expect(files.stats().dropped).toBeGreaterThanOrEqual(3);
  expect(files.stats().removed).toBeGreaterThan(0);
  expect(await fs.readFile(path.join(directory, "keep.txt"), "utf8")).toBe("business");
});

it("rejects unserializable records and isolates an unavailable or symlinked destination", async () => {
  const directory = await fixture();
  const files = new DiagnosticFiles(directory);
  files.append("traces", undefined);
  await files.close();
  expect(await fs.readdir(directory)).toEqual([]);
  const target = path.join(directory, "target");
  await fs.mkdir(target, { mode: 0o755 });
  const link = path.join(directory, "link");
  await fs.symlink(target, link);
  const unavailable = new DiagnosticFiles(link);
  unavailable.append("traces", { name: "must not follow" });
  await expect(unavailable.close()).resolves.toBeUndefined();
  expect(await fs.readdir(target)).toEqual([]);
  expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
  expect(unavailable.stats().failures).toBeGreaterThan(0);
});

it("runs idle maintenance from its timer without new application writes", async () => {
  const directory = await fixture();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  const files = new DiagnosticFiles(directory, { retentionMs: 1000 });
  try {
    files.append("traces", { name: "idle" });
    await files.flush();
    await vi.advanceTimersByTimeAsync(3_600_000);
    await files.flush();
    expect((await fs.readdir(directory)).some((name) => name.endsWith("-open.jsonl"))).toBe(false);
    expect(await fs.readdir(directory)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await files.flush();
    expect(await fs.readdir(directory)).toEqual([]);
  } finally { await files.close(); vi.useRealTimers(); }
});

it("reserves bounded queue capacity for business evidence during a runtime metric burst", async () => {
  const directory = await fixture();
  const files = new DiagnosticFiles(directory, { maxQueuedRecords: 8 });
  for (let n = 0; n < 20; n++) files.append("metrics", { name: "v8js.memory.heap.used", n }, "background");
  files.append("checkpoints", { name: "workflow.batch", acceptedCount: 6 });
  await files.close();
  const records = (await Promise.all((await fs.readdir(directory)).map((name) => fs.readFile(path.join(directory, name), "utf8"))))
    .join("").trim().split("\n").map((line) => JSON.parse(line));
  expect(records.filter((r) => r.name === "v8js.memory.heap.used")).toHaveLength(6);
  expect(records.find((r) => r.name === "workflow.batch")?.acceptedCount).toBe(6);
  expect(files.stats().dropped).toBe(14);
});

it("does not inventory accumulated diagnostic shards on every append", async () => {
  const directory = await fixture();
  const timestamp = Date.now();
  for (let n = 0; n < 267; n++) await fs.writeFile(path.join(directory,
    `traces-${timestamp}-1-00000000-0000-0000-0000-000000000000-${n}-${timestamp}.jsonl`), "{}\n");
  const inventory = vi.spyOn(fs, "readdir");
  const files = new DiagnosticFiles(directory);
  try {
    files.append("traces", { n: 0 });
    await files.flush();
    const initial = inventory.mock.calls.length;
    for (let n = 1; n <= 50; n++) { files.append("traces", { n }); await files.flush(); }
    expect(inventory.mock.calls.length - initial).toBe(0);
  } finally { await files.close(); inventory.mockRestore(); }
});


it("reconciles partial failed writes before admitting another record against the quota", async () => {
  const directory = await fixture();
  const files = new DiagnosticFiles(directory, { maxTotalBytes: 34 });
  const open = fs.open.bind(fs);
  const opening = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    const write = handle.writeFile.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
      await write("partial");
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    return handle;
  });
  try {
    files.append("traces", { first: true });
    await files.flush();
    expect(files.stats().failures).toBe(1);
    files.append("traces", { text: "x".repeat(20) }); // 32 bytes plus the existing 7 exceeds 34.
    await files.flush();
    expect(files.stats().dropped).toBe(2);
    const names = await fs.readdir(directory);
    expect(names).toHaveLength(1);
    expect((await fs.stat(path.join(directory, names[0]!))).size).toBe(7);
  } finally { opening.mockRestore(); await files.close(); }
});
