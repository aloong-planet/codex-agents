import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { InteractionProgress } from "../e2e/interaction-progress.js";
import { withinInteractionBudget } from "../e2e/interaction-budget.js";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "interaction-progress-"));
  directories.push(directory);
  const file = path.join(directory, "checkpoints-case-open.jsonl");
  const append = (name: string, traceId = "current", attributes = {}) => fs.appendFileSync(file,
    JSON.stringify({ version: 2, kind: "checkpoint", name, traceId, attributes, recordedAt: Date.now() }) + "\n");
  return { directory, file, append };
}

it("only new current-interaction progress renews the budget, including deltas before POST completes", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.append("weixin.inbound.start", "previous");
  const progress = new InteractionProgress(f.directory);
  let signal: AbortSignal | undefined;
  const pending = withinInteractionBudget(async (received) => { signal = received; await new Promise(() => {}); }, 30_000, () => progress.poll());
  const verdict = expect(pending).rejects.toThrow("interaction idle for 30000 ms");
  f.append("weixin.inbound.start");
  await vi.advanceTimersByTimeAsync(20_000);
  f.append("runtime.stage", "current", { activity: "agent_message_delta", status: "running" });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(signal?.aborted).toBe(false); // Total elapsed 40 s, but recent model data exists.
  f.append("runtime.stage", "previous", { activity: "agent_message_delta" });
  f.append("runtime.stage", "current", { status: "thinking" });
  f.append("runtime.metrics", "current");
  await vi.advanceTimersByTimeAsync(10_100);
  await verdict;
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not replay historical checkpoints after sealing, and reads complete appended records once", () => {
  const f = fixture();
  f.append("weixin.inbound.start", "old");
  const progress = new InteractionProgress(f.directory);
  expect(progress.poll()).toBe(false);
  f.append("weixin.inbound.start");
  expect(progress.poll()).toBe(true);
  expect(progress.poll()).toBe(false);
  fs.renameSync(f.file, f.file.replace("open", "sealed"));
  expect(progress.poll()).toBe(false);
  const line = JSON.stringify({ kind: "checkpoint", recordedAt: Date.now(), name: "tool.result", traceId: "current" });
  fs.appendFileSync(f.file, line);
  expect(progress.poll()).toBe(false);
  fs.appendFileSync(f.file, "\n");
  expect(progress.poll()).toBe(true);
  expect(progress.poll()).toBe(false);
});

it("observes startup before inbound and ignores malformed records and other traces", () => {
  const f = fixture();
  const progress = new InteractionProgress(f.directory);
  f.append("runtime.stage", "", { stage: "thread_start", status: "end" });
  expect(progress.poll()).toBe(true);
  f.append("weixin.inbound.start");
  expect(progress.poll()).toBe(true);
  fs.appendFileSync(f.file, "null\ninvalid json\n");
  f.append("weixin.inbound.start", "unrelated");
  f.append("tool.result", "unrelated");
  f.append("runtime.stage", "", { stage: "thread_start", status: "end" });
  expect(progress.poll()).toBe(false);
  f.append("runtime.stage", "current", { activity: "protocol_progress" });
  expect(progress.poll()).toBe(true);
});

it("preserves observer failures and clears both timers", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const error = new Error("evidence unavailable");
  const pending = withinInteractionBudget(async (received) => { signal = received; await new Promise(() => {}); }, 30_000,
    () => { throw error; });
  const verdict = expect(pending).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(100);
  await verdict;
  expect(signal?.reason).toBe(error);
  expect(vi.getTimerCount()).toBe(0);
});

it("checks data arriving immediately before the idle deadline and cleans up on completion", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const progress = new InteractionProgress(f.directory);
  let signal: AbortSignal | undefined;
  let complete!: (value: string) => void;
  const pending = withinInteractionBudget((received) => {
    signal = received;
    return new Promise<string>((resolve) => { complete = resolve; });
  }, 30_000, () => progress.poll());
  await vi.advanceTimersByTimeAsync(29_999);
  f.append("weixin.inbound.start");
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(false);
  complete("done");
  await expect(pending).resolves.toBe("done");
  expect(vi.getTimerCount()).toBe(0);
});
