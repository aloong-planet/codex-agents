import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TeamAnnouncements, type AnnouncementSend } from "../src/team-announcements.js";

// The Coordinator's join and leave announcements (agent-dispatch::REQ-015/AC-03, team-management::REQ-004/AC-01): durable
// messages with their own delivery state, never resent automatically (ticket 11, decision D8). Real-main delivery through Sam's
// application is in team-management.integration.test.ts.
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function path() {
  const directory = mkdtempSync(join(tmpdir(), "team-announcements-"));
  directories.push(directory);
  return join(directory, "team-announcements.sqlite");
}
const join_ = { chatId: "oc_alpha", teamId: "daisy", kind: "join", text: "Daisy（设计团队）已加入本群，负责：视觉方案" } as const;

it.each([
  ["accepted by the platform", (async () => "accepted") as AnnouncementSend, "accepted"],
  ["rejected by the platform", (async () => "rejected") as AnnouncementSend, "failed"],
  ["sent with an unknown outcome", (async () => "unknown") as AnnouncementSend, "unknown"],
  ["interrupted by an error", (async () => { throw new Error("socket closed"); }) as AnnouncementSend, "unknown"],
] as const)("records an announcement %s and never sends it again", async (_case, send, state) => {
  const announcements = new TeamAnnouncements(path());
  try {
    announcements.enqueue(join_);
    const sent: string[] = [];
    const counting: AnnouncementSend = async (input) => { sent.push(input.text); return send(input); };
    await announcements.deliver(counting);
    await announcements.deliver(counting);
    expect([sent, announcements.list().map(({ chatId, teamId, kind, text, state: current }) => ({ chatId, teamId, kind, text, state: current }))])
      .toEqual([[join_.text], [{ ...join_, state }]]);
  } finally { announcements.close(); }
});

it("after a restart sends an announcement never attempted, and marks one cut off mid-send as unknown without sending it", async () => {
  const file = path();
  const first = new TeamAnnouncements(file);
  first.enqueue(join_);
  // The first send starts and never settles before the process stops: it was attempted and its outcome is not known.
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  void first.deliver(() => { started(); return new Promise(() => {}); });
  await begun;
  first.enqueue({ chatId: "oc_beta", teamId: "eve", kind: "leave", text: "Eve（内容团队）已离开本群，不再接新的事务；进行中的事务会做完。" });
  first.close();
  const restarted = new TeamAnnouncements(file);
  try {
    const sent: string[] = [];
    await restarted.deliver(async ({ text }) => { sent.push(text); return "accepted"; });
    expect(sent).toEqual(["Eve（内容团队）已离开本群，不再接新的事务；进行中的事务会做完。"]);
    expect(restarted.list().map(({ teamId, state }) => [teamId, state])).toEqual([["daisy", "unknown"], ["eve", "accepted"]]);
  } finally { restarted.close(); }
});
