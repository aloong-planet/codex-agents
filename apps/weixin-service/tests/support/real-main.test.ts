import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { config, start, type State } from "./real-main.js";

// The shared real-main helper's reads, checked against a main that answers late. SIGSTOP holds main for a fixed time while a read
// is in flight, as a loaded machine can: longer than the 1 s and 5 s the reads used to allow, shorter than processWaitLimitMs.
type Running = Awaited<ReturnType<typeof start>>;
const pauseMs = 6000;
let directory: string | undefined, running: Running | undefined, mainPid: number;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), "real-main-slow-read-"));
  writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
  running = await start(directory);
  const children = execFileSync("pgrep", ["-P", String(process.pid), "-f", "src/main.ts"], { encoding: "utf8" }).trim().split("\n");
  expect(children).toHaveLength(1);
  mainPid = Number(children[0]);
}, 30000);
afterAll(async () => { await running?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

it.each([
  { reader: "state()", read: (main: Running) => main.state() },
  { reader: "get()", read: (main: Running) => main.get<State>("/api/state") },
])("waits for a $reader read that main answers only after a 6 s pause", async ({ read }) => {
  process.kill(mainPid, "SIGSTOP");
  try {
    const reading = read(running!);
    const first = await Promise.race([reading.then(() => "answer", () => "failure"), delay(pauseMs).then(() => "pause")]);
    process.kill(mainPid, "SIGCONT");
    expect((await reading).accounts.map((account) => account.accountId)).toEqual(["fixture-bot"]);
    // Main was really held: the read was still waiting when the pause ended.
    expect(first).toBe("pause");
  } finally { process.kill(mainPid, "SIGCONT"); }
}, 30000);
