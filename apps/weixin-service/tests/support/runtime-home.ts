import fs from "node:fs";
import path from "node:path";

/** Where the App Server writes a thread's rollout in a runtime home, as it named one on 2026-11-08. */
export const rolloutPath = (threadId: string, archived = false) => archived
  ? `codex-home/archived_sessions/rollout-2026-11-08T16-15-46-${threadId}.jsonl`
  : `codex-home/sessions/2026/11/08/rollout-2026-11-08T16-15-46-${threadId}.jsonl`;

/**
 * Writes the file set an Executor runtime home held after one real App Server turn (the listing in ticket 27's enumeration
 * log, codex-cli 0.167.0-alpha.3.2), plus a rollout for each named thread. File contents are placeholders; compaction never
 * reads them. Returns the home-relative rollout paths.
 */
export function seedExecutorHome(home: string, rollouts: Array<{ threadId: string; archived?: boolean }>): string[] {
  const files: Record<string, string> = {
    "codex-home/.sandbox_migration": "v1\n", "codex-home/auth.json": "{\"OPENAI_API_KEY\":\"sk-synthetic\"}",
    "codex-home/config.toml": "default_permissions = \"group\"\n", "codex-home/direct-model-catalog.json": "{\"models\":[]}",
    "codex-home/goals_1.sqlite": "goals", "codex-home/installation_id": "508ac997-313f-4d83-89f1-95b97eb15601",
    "codex-home/logs_2.sqlite": "logs", "codex-home/logs_2.sqlite-wal": "logs-wal",
    "codex-home/memories_1.sqlite": "memories", "codex-home/memories_1.sqlite-wal": "memories-wal",
    "codex-home/queue_1.sqlite": "queue", "codex-home/queue_1.sqlite-shm": "queue-shm", "codex-home/queue_1.sqlite-wal": "queue-wal",
    "codex-home/state_5.sqlite": "state", "codex-home/state_5.sqlite-shm": "state-shm", "codex-home/state_5.sqlite-wal": "state-wal",
    "codex-home/thread_history_1.sqlite": "thread-history", "codex-home/thread-writer-locks/.coordination.lock": "",
    "codex-home/tmp/arg0-macos/codex-arg0uyCv97/.lock": "",
  };
  for (const directory of ["codex-home/shell_snapshots", "home", "workspace"]) fs.mkdirSync(path.join(home, directory), { recursive: true });
  const written = rollouts.map(({ threadId, archived }) => {
    const relative = rolloutPath(threadId, archived);
    files[relative] = `${JSON.stringify({ type: "session_meta", payload: { id: threadId } })}\n${JSON.stringify({ type: "response_item", payload: { text: `turn of ${threadId}` } })}\n`;
    return relative;
  });
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, relative)), { recursive: true });
    fs.writeFileSync(path.join(home, relative), content);
  }
  return written;
}

/** The listing of a compacted home seeded by seedExecutorHome with one rollout, for `threadId`. */
export const keptListing = (threadId: string) => ["codex-home/", "codex-home/sessions/", "codex-home/sessions/2026/", "codex-home/sessions/2026/11/",
  "codex-home/sessions/2026/11/08/", rolloutPath(threadId)];

/** Every file and directory under home, hidden ones included, as sorted home-relative paths; directories end with "/". */
export function homeListing(home: string): string[] {
  const listed: string[] = [];
  const walk = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(home, relative), { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { listed.push(`${child}/`); walk(child); } else listed.push(child);
    }
  };
  walk("");
  return listed.sort();
}
