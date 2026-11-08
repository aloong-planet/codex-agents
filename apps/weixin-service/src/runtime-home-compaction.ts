import fs from "node:fs";
import path from "node:path";

/** The Codex home's directories that hold thread rollouts: the only records a compacted runtime home keeps. */
const RECORD_DIRECTORIES: readonly string[] = ["sessions", "archived_sessions"];
const ROLLOUT = /^rollout-.+\.jsonl$/u;

export type RuntimeHome = { key: string; path: string };
export type CompactionOutcome = { status: "compacted" } | { status: "kept"; reason: "home_invalid" | "rollout_missing" | "removal_failed" };

/** The real directories directly under root whose names match pattern, keyed by the pattern's first capture group. */
export function runtimeHomes(root: string, pattern: RegExp): RuntimeHome[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return entries.filter((entry) => entry.isDirectory()).flatMap((entry) => {
    const key = pattern.exec(entry.name)?.[1];
    return key ? [{ key, path: path.join(root, entry.name) }] : [];
  }).sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Shrinks a closed runtime's home to its thread rollouts (agent-dispatch::QR-002); call it only when no App Server runs on
 * the home. Nothing is removed unless the records are confirmed by name: the rollout of the recorded thread, or with no
 * recorded thread at least one rollout. Rollouts are never opened, changed or removed. Entries go one at a time, so an
 * interrupted run leaves the rollouts and some removable entries for the next run; never throws.
 */
export function compactRuntimeHome(home: string, recordedThread: string | undefined,
  options: { afterRemoval?(entry: string): void } = {}): CompactionOutcome {
  try { if (!fs.lstatSync(home).isDirectory()) return { status: "kept", reason: "home_invalid" }; }
  catch { return { status: "kept", reason: "home_invalid" }; }
  const codexHome = path.join(home, "codex-home");
  // A linked Codex home would make the removals below reach outside the runtime home.
  try { if (!fs.lstatSync(codexHome).isDirectory()) return { status: "kept", reason: "home_invalid" }; }
  catch { return { status: "kept", reason: "rollout_missing" }; }
  const rollouts = RECORD_DIRECTORIES.flatMap((directory) => rolloutNames(path.join(codexHome, directory)));
  const confirmed = recordedThread === undefined ? rollouts.length > 0 : rollouts.some((name) => name.endsWith(`-${recordedThread}.jsonl`));
  if (!confirmed) return { status: "kept", reason: "rollout_missing" };
  try {
    const removable = [
      ...fs.readdirSync(home).filter((name) => name !== "codex-home").sort().map((name) => path.join(home, name)),
      ...fs.readdirSync(codexHome).filter((name) => !RECORD_DIRECTORIES.includes(name)).sort().map((name) => path.join(codexHome, name)),
    ];
    for (const entry of removable) {
      fs.rmSync(entry, { recursive: true, force: true });
      options.afterRemoval?.(entry);
    }
  } catch { return { status: "kept", reason: "removal_failed" }; }
  return { status: "compacted" };
}

/** Rollout file names under directory, without following symbolic links; unreadable parts count as holding none. */
function rolloutNames(directory: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => entry.isDirectory() ? rolloutNames(path.join(directory, entry.name))
    : entry.isFile() && ROLLOUT.test(entry.name) ? [entry.name] : []);
}
