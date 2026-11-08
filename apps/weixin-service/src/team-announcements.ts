import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** What the platform said about one send: accepted, rejected, or an outcome that is not known. */
export type AnnouncementSend = (announcement: Readonly<{ chatId: string; text: string }>) => Promise<"accepted" | "rejected" | "unknown">;
/**
 * A Coordinator announcement of a team joining or leaving a group, with its own delivery state: pending until sent, then
 * accepted, failed (rejected) or unknown. A state other than pending is final; nothing is resent automatically.
 */
export type TeamAnnouncement = Readonly<{
  id: number; chatId: string; teamId: string; kind: "join" | "leave"; text: string;
  state: "pending" | "sending" | "accepted" | "failed" | "unknown"; createdAt: number;
}>;

/**
 * The durable store of the Coordinator's join and leave announcements (agent-dispatch::REQ-015/AC-03). An announcement is
 * marked as sending before its one send starts, so a restart turns a send that was cut off into unknown instead of repeating it.
 */
export class TeamAnnouncements {
  private readonly database: DatabaseSync;
  private delivering: Promise<void> = Promise.resolve();

  constructor(databasePath: string, private readonly now: () => number = Date.now) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath); chmodSync(databasePath, 0o600);
    this.database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS team_announcement (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, team_id TEXT NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL);
      UPDATE team_announcement SET state = 'unknown' WHERE state = 'sending';`);
  }

  enqueue(announcement: Readonly<{ chatId: string; teamId: string; kind: TeamAnnouncement["kind"]; text: string }>): void {
    this.database.prepare("INSERT INTO team_announcement (chat_id, team_id, kind, text, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(announcement.chatId, announcement.teamId, announcement.kind, announcement.text, this.now());
  }

  /** Sends every pending announcement once, in order. Calls are serialized, so no announcement is sent twice. */
  deliver(send: AnnouncementSend): Promise<void> {
    this.delivering = this.delivering.then(async () => {
      for (;;) {
        const row = this.database.prepare("SELECT id, chat_id, text FROM team_announcement WHERE state = 'pending' ORDER BY id LIMIT 1").get();
        if (!row) return;
        const id = Number(row.id);
        this.database.prepare("UPDATE team_announcement SET state = 'sending' WHERE id = ?").run(id);
        let state: TeamAnnouncement["state"];
        try {
          const outcome = await send({ chatId: String(row.chat_id), text: String(row.text) });
          state = outcome === "accepted" ? "accepted" : outcome === "rejected" ? "failed" : "unknown";
        } catch { state = "unknown"; }
        this.database.prepare("UPDATE team_announcement SET state = ? WHERE id = ?").run(state, id);
      }
    });
    return this.delivering;
  }

  /** Every announcement, oldest first. */
  list(): TeamAnnouncement[] {
    return this.database.prepare("SELECT * FROM team_announcement ORDER BY id").all().map((row) => ({ id: Number(row.id), chatId: String(row.chat_id),
      teamId: String(row.team_id), kind: String(row.kind) as TeamAnnouncement["kind"], text: String(row.text),
      state: String(row.state) as TeamAnnouncement["state"], createdAt: Number(row.created_at) }));
  }

  close(): void { this.database.close(); }
}
