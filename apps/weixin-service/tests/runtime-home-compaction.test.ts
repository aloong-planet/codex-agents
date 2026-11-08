import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { EXECUTOR_RUNTIME_HOME } from "../src/agent-dispatch-executor.js";
import { compactRuntimeHome, runtimeHomes } from "../src/runtime-home-compaction.js";
import { homeListing, seedExecutorHome } from "./support/runtime-home.js";

// The compaction rule of agent-dispatch::QR-002 on homes seeded with the file set a real App Server turn leaves
// (tests/support/runtime-home.ts). Its wiring into Executor release and the startup sweep is covered by
// agent-dispatch-executor.test.ts and agent-dispatch.integration.test.ts.

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const scratch = () => { const directory = mkdtempSync(join(tmpdir(), "runtime-home-compaction-")); directories.push(directory); return directory; };
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const THREAD = "01a1ba3a-5282-7791-a2b2-7b42b13eb7bd", OLDER = "01a1ba3a-5afa-7e03-9ba0-77abcdb9153e";
// The approved keep list (ticket 27, D1): the Codex home's session and archived-session directories with their rollouts.
const KEPT = ["codex-home/", "codex-home/sessions/", "codex-home/sessions/2026/", "codex-home/sessions/2026/11/", "codex-home/sessions/2026/11/08/",
  `codex-home/sessions/2026/11/08/rollout-2026-11-08T16-15-46-${THREAD}.jsonl`];

it("keeps only a home's rollouts, byte for byte, and changes nothing on a second run", () => {
  const home = join(scratch(), "dispatch-home");
  const rollouts = seedExecutorHome(home, [{ threadId: THREAD }, { threadId: OLDER, archived: true }]);
  const hashes = rollouts.map((relative) => sha256(join(home, relative)));
  const kept = [...KEPT, "codex-home/archived_sessions/", `codex-home/archived_sessions/rollout-2026-11-08T16-15-46-${OLDER}.jsonl`].sort();
  expect(homeListing(home)).toEqual(expect.arrayContaining([...kept, "codex-home/state_5.sqlite-wal", "home/", "workspace/"]));
  expect(compactRuntimeHome(home, THREAD)).toEqual({ status: "compacted" });
  expect(homeListing(home)).toEqual(kept);
  expect(rollouts.map((relative) => sha256(join(home, relative)))).toEqual(hashes);
  expect(compactRuntimeHome(home, THREAD)).toEqual({ status: "compacted" });
  expect(homeListing(home)).toEqual(kept);
});

it.each([
  ["a recorded thread without its rollout", THREAD, [OLDER], { status: "kept", reason: "rollout_missing" }],
  ["no recorded thread and no rollout", undefined, [], { status: "kept", reason: "rollout_missing" }],
  ["no recorded thread and one rollout, as in a pre-05 specialist home", undefined, [THREAD], { status: "compacted" }],
] as const)("checks the records before removing anything: %s", (_label, recorded, threads, outcome) => {
  const home = join(scratch(), "dispatch-home");
  seedExecutorHome(home, threads.map((threadId) => ({ threadId })));
  const before = homeListing(home);
  expect(compactRuntimeHome(home, recorded)).toEqual(outcome);
  expect(homeListing(home)).toEqual(outcome.status === "kept" ? before : KEPT);
});

it("keeps the records when a removal fails, and finishes on the next run", () => {
  const home = join(scratch(), "dispatch-home");
  const [rollout] = seedExecutorHome(home, [{ threadId: THREAD }]);
  const hash = sha256(join(home, rollout!));
  chmodSync(join(home, "codex-home"), 0o500);
  try {
    expect(compactRuntimeHome(home, THREAD)).toEqual({ status: "kept", reason: "removal_failed" });
  } finally { chmodSync(join(home, "codex-home"), 0o700); }
  expect(sha256(join(home, rollout!))).toBe(hash);
  expect(homeListing(home)).toContain("codex-home/state_5.sqlite-wal");
  expect(compactRuntimeHome(home, THREAD)).toEqual({ status: "compacted" });
  expect(homeListing(home)).toEqual(KEPT);
  expect(sha256(join(home, rollout!))).toBe(hash);
});

it("lists only real directories named like an Executor home, keyed by their 64-hex scope", () => {
  const root = scratch(), scope = "a1".repeat(32);
  for (const name of [`dispatch-${scope}`, "dispatch-coordinator", `dispatch-leader-${"b2".repeat(32)}`, "feishu.group.oc_alpha", "research-feishu.group.oc_alpha",
    "pending-router", "memory-curator", `dispatch-${"c".repeat(63)}`, `dispatch-${"D".repeat(64)}`]) mkdirSync(join(root, name));
  mkdirSync(join(root, "elsewhere"));
  symlinkSync(join(root, "elsewhere"), join(root, `dispatch-${"e".repeat(64)}`));
  writeFileSync(join(root, `dispatch-${"f".repeat(64)}`), "");
  expect(runtimeHomes(root, EXECUTOR_RUNTIME_HOME)).toEqual([{ key: scope, path: join(root, `dispatch-${scope}`) }]);
  expect(runtimeHomes(join(root, "absent"), EXECUTOR_RUNTIME_HOME)).toEqual([]);
});
