import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DailyAiNewsFileStore } from "../src/daily-ai-news-store.js";
import { DailyNewsHandoff } from "../src/daily-news-handoff.js";
import { ScheduledTasks } from "../src/scheduled-tasks.js";

it.each(["accepted", "interrupted"] as const)("recovers owner crashes and independent dispatchers with %s submission", async (outcome) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "news-process-")); const children: ChildProcess[] = []; const errorsByPid = new Map<number, string>();
  fs.writeFileSync(path.join(root, "outbox.jsonl"), "");
  const launch = async (mode: string, pid = 0, advance = 0) => {
    const child = fork(fileURLToPath(new URL("./fixtures/scheduled-news-worker.ts", import.meta.url)), [root, mode, String(pid), String(advance)],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
    let errors = ""; child.stderr?.on("data", (data) => { errors += String(data); errorsByPid.set(child.pid!, errors); });
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors || "worker exited before ready"); })]); return child;
  };
  const kill = async (child: ChildProcess) => { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; };
  try {
    const legacy = await launch("legacy"), legacyExit = once(legacy, "exit"); legacy.send("wake"); expect(await legacyExit).toEqual([0, null]);
    const prepared = await launch("prepared", legacy.pid), preparedNotice = once(prepared, "message"); prepared.send("wake");
    expect(await preparedNotice).toEqual(["prepared", undefined]); await kill(prepared);
    expect(() => new DailyAiNewsFileStore(path.join(root, "news.json")).load()).toThrow();
    const closedOwner = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), dailyNewsActive: () => false, readOriginalText: () => undefined });
    expect(closedOwner.newsSnapshot().owner).toBeUndefined(); closedOwner.close();
    const committed = await launch("committed", legacy.pid), committedNotice = once(committed, "message"); committed.send("wake");
    expect(await committedNotice).toEqual(["committed", undefined]); await kill(committed);
    expect(fs.readFileSync(path.join(root, "outbox.jsonl"), "utf8")).toBe("");
    if (outcome === "interrupted") {
      const sending = await launch("sending", legacy.pid), submitted = once(sending, "message"); sending.send("wake");
      expect(await submitted).toEqual(["sending", undefined]); await kill(sending);
    }
    const racers = await Promise.all([launch("accept", legacy.pid, 61000), launch("accept", legacy.pid, 61000)]);
    const exits = racers.map((worker) => once(worker, "exit")); racers.forEach((worker) => worker.send("wake"));
    expect(await Promise.all(exits), JSON.stringify([...errorsByPid])).toEqual([[0, null], [0, null]]);
    expect(fs.readFileSync(path.join(root, "outbox.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ message: "2026-10-16 AI 新闻\n今日暂无值得汇总的重大更新。" }]);
    const tasks = new ScheduledTasks({ databasePath: path.join(root, "tasks.sqlite"), readOriginalText: () => undefined });
    const snapshot = tasks.newsSnapshot(); expect(snapshot.tasks).toHaveLength(1); expect(snapshot.occurrences).toHaveLength(1);
    expect(snapshot.occurrences[0]).toMatchObject({ delivery: outcome === "interrupted" ? "unknown" : "accepted" });
    expect(new DailyNewsHandoff(path.join(root, "news.json")).verifyCommitted(snapshot.sourceHash!)).toBe(true); tasks.close();
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) await kill(child); fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);
