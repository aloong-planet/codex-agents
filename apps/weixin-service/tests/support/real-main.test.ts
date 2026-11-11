import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { config, start, type State } from "./real-main.js";

// The shared real-main helper's reads, checked against a main that answers late. SIGSTOP holds main for 6 s while the reads are
// in flight, as a loaded machine can: longer than the 1 s and 5 s they used to allow, shorter than processWaitLimitMs.
// Node's fetch keeps a connection to a Node server open for 3 s after its last response (measured on Node 26.7.0), and a read sent
// on a kept connection while main is stopped can be reset when main resumes. The case first waits until start()'s connections
// have closed, so that the reads open new ones.
it("waits for state() and get() reads that main answers only after a 6 s pause", async () => {
  const directory = mkdtempSync(join(tmpdir(), "real-main-slow-read-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
    running = await start(directory);
    const children = execFileSync("pgrep", ["-P", String(process.pid), "-f", "src/main.ts"], { encoding: "utf8" }).trim().split("\n");
    expect(children).toHaveLength(1);
    const mainPid = Number(children[0]);
    await delay(5000);
    process.kill(mainPid, "SIGSTOP");
    const reading = Promise.all([running.state(), running.get<State>("/api/state")]);
    // Neither side of the race rejects, so main is always resumed before any assertion.
    const first = await Promise.race([reading.then(() => "answer", () => "failure"), delay(6000).then(() => "pause")]);
    process.kill(mainPid, "SIGCONT");
    const [state, got] = await reading;
    expect(state.accounts.map((account) => account.accountId)).toEqual(["fixture-bot"]);
    expect(got.accounts.map((account) => account.accountId)).toEqual(["fixture-bot"]);
    // Main was really held: both reads were still waiting when the pause ended.
    expect(first).toBe("pause");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60000);
