import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseChannelStartupConfiguration } from "../src/channel-startup-config.js";
import { TeamRegistry } from "../src/team-registry.js";
import { processWaitLimitMs } from "./support/process-wait.js";
import { PRODUCTION_TOOL_IDS } from "./support/production-tools.js";
import { allowNotes, config, decision, dispatchConfig, freePort, groupMessage, start, type State } from "./support/real-main.js";

// Real main composition through the fixture-only Feishu ingress; the model and every Feishu application are fixtures, and the
// onboarding platform is the fake fixture mode uses (team-onboarding.test.ts covers its answers). The first two cases read and save
// the registry through TeamRegistry, the store's own class, before main starts; the others go through the console's team API.
// Registry rules are covered in team-registry.test.ts. Coverage gap: no real Feishu tenant is called (team-management spec, Pending).

it("imports the local configuration into the team registry on first start, and the specialist turn carries its Executor profile", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-registry-main-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_registry_seed", "请帮我规划周末一日行程",
      { kind: "dispatch", agentId: "bill", requestId: null, summary: "规划周末一日行程", message: "" }));
    const result = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    console.log(JSON.stringify({ kind: "team_registry_seed", command: "请帮我规划周末一日行程", jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes }));
    await running.close(); running = undefined;
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const current = registry.current()!;
      expect({ version: current.version, source: current.source, teams: current.definitions.teams.map(({ id }) => id) })
        .toEqual({ version: 1, source: "local_configuration", teams: ["alice", "bill", "jack"] });
      const profiles = current.definitions.teams.find(({ id }) => id === "bill")!.executorProfiles;
      expect(profiles.map(({ hostTools }) => hostTools)).toEqual([PRODUCTION_TOOL_IDS]);
      expect(profiles[0]!.instructions).toContain("出行路线须逐段核对站名、线路和换乘站");
      expect(result.fixtureModelRequests).toHaveLength(1);
      expect(JSON.stringify(result.fixtureModelRequests![0]!.input)).toContain(profiles[0]!.instructions);
    } finally { registry.close(); }
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("follows a console-saved registry version instead of the local configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-registry-console-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    const parsed = parseChannelStartupConfiguration(JSON.parse(readFileSync(join(directory, "channel.json"), "utf8")));
    const local = parsed.entries.find((entry) => entry.channel === "feishu")?.dispatch;
    if (!local) throw new Error("expected_dispatch_configuration");
    const registry = new TeamRegistry(join(directory, "team-registry.sqlite"));
    try {
      const seeded = registry.importLocalConfiguration(local, { executorHostTools: [] });
      registry.save({ ...seeded.definitions, teams: seeded.definitions.teams.map((team) => team.id === "bill"
        ? { ...team, leader: { ...team.leader, name: "Bella" } } : team) }, { basedOn: seeded.version });
    } finally { registry.close(); }
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_registry_console", "周末可能想去附近玩玩",
      { kind: "propose", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" }));
    const proposed = await running.until((state) => state.fixtureTextOutbox?.length === 1);
    console.log(JSON.stringify({ kind: "team_registry_console_save", command: "周末可能想去附近玩玩", jobs: proposed.agentDispatch, outbox: proposed.fixtureTextOutbox }));
    expect(proposed.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["要不要请 Bella 帮你安排周末出行？请回复这条建议确认，或告诉我暂时不用。"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

const DAISY_APP = "cli_dddddddddddddddd";
const SECRET_SENTINEL = "daisy-secret-SENTINEL-7f3a";
/** A new team as the console saves it: Daisy's design team on its existing application, checked into oc_alpha. */
const daisy = (overrides: Record<string, unknown> = {}) => ({ teamName: "设计团队", responsibility: "视觉方案", groups: ["oc_alpha"],
  leader: { name: "Daisy", appId: DAISY_APP, instructions: "只做视觉方案" },
  executorProfiles: [{ name: "视觉方案", noun: "视觉执行者", instructions: "", hostTools: [] }], secret: SECRET_SENTINEL, ...overrides });
const announcements = (state: State) => (state.fixtureTextOutbox ?? []).map(({ message }) => message).filter((message) => /已加入本群|已离开本群/.test(message));

it("onboards a team saved while the service runs: Sam announces it, its genuine mention is recognised and it posts with its own application", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-runtime-join-"));
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    const before = await running.get<View>("/api/teams");
    const { teamId } = await running.post<{ teamId: string }>("/api/teams/save", { basedOn: before.version, team: daisy() });
    const joined = await running.until((state) => announcements(state).length === 1);
    expect(announcements(joined)).toEqual(["Daisy（设计团队）已加入本群，负责：视觉方案"]);
    // A genuine mention of the new application is recognised: asked for work that the Coordinator gives to Bill, Daisy explains
    // the mismatch with her own application before the reassignment (agent-dispatch::US-001/AC-05, REQ-004). Unrecognised, she
    // would post nothing.
    await running.post("/api/fixture/inbound", {
      event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
        message: { message_id: "om_daisy_mention", create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
          mentions: [{ key: "@_user_0", id: { open_id: "ou_daisyview0" }, name: "Daisy" }], content: JSON.stringify({ text: "@_user_0 帮我规划周末一日行程" }) } },
      messageDetails: { message_id: "om_daisy_mention", chat_id: "oc_alpha", msg_type: "text", body: { content: '{"text":"帮我规划周末一日行程"}' },
        mentions: [{ key: "@_user_0", id: DAISY_APP, id_type: "app_id", name: "Daisy" }] },
      dispatchDecision: decision("bill", "规划周末一日行程"),
    });
    const mentioned = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    expect(mentioned.agentFixtureOutboxes?.[teamId]?.text.map(({ chatId, message }) => [chatId, message]))
      .toEqual([["oc_alpha", "这项需求属于 Bill 的职责。我请 Sam 重新分派，由他独立处理。"]]);
    // Bill's Team Leader turn after the join lists the new team in its Team Directory (agent-dispatch::REQ-015/AC-03).
    const billPlan = mentioned.fixtureLeaderRequests!.find(({ teamId: id, phase }) => id === "bill" && phase === "plan")!;
    expect(billPlan.input.directory).toContainEqual({ name: "设计团队", responsibility: "视觉方案" });
    // Work routed to the new team runs under its own application, with its Executor named after the profile's noun.
    await running.post("/api/fixture/inbound", groupMessage("om_daisy_work", "帮我设计商品主图", decision(teamId, "设计商品主图")));
    const posted = await running.until((state) => state.agentFixtureOutboxes?.[teamId]?.text.length === 3);
    console.log(JSON.stringify({ kind: "team_runtime_join", commands: ["save 设计团队", "@Daisy 帮我规划周末一日行程", "帮我设计商品主图"],
      announcements: announcements(posted), jobs: posted.agentDispatch, outboxes: posted.agentFixtureOutboxes, onboarding: posted.fixtureOnboardingCalls }));
    expect(posted.agentFixtureOutboxes?.[teamId]?.text.slice(1).map(({ chatId, message }) => [chatId, message])[0])
      .toEqual(["oc_alpha", "我安排视觉执行者 2（视觉方案）处理：设计商品主图。完成后会在本群汇报。"]);
    expect(posted.agentDispatch?.jobs.map(({ agentId, status }) => [agentId, status])).toEqual([["bill", "completed"], [teamId, "completed"]]);
    // The App Secret is stored locally only: never in a response, the service output, the audit or any other state file.
    const view = await running.get<View & { teams: Array<TeamView & { secretStored: boolean }> }>("/api/teams");
    expect(JSON.stringify(view)).not.toContain(SECRET_SENTINEL);
    expect(view.teams.find(({ id }) => id === teamId)).toMatchObject({ secretStored: true, bindings: [{ chatId: "oc_alpha", state: "accepting" }] });
    await running.close(); const output = running.output(); running = undefined;
    expect(output).not.toContain(SECRET_SENTINEL);
    const leaks = readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith("team-registry.sqlite"))
      .filter((entry) => readFileSync(join(entry.parentPath, entry.name)).includes(SECRET_SENTINEL)).map((entry) => entry.name);
    expect(leaks).toEqual([]);
    expect(readFileSync(join(directory, "console-audit.jsonl"), "utf8")).toContain('"event":"team_secret_written"');
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 45000);

type Running = Awaited<ReturnType<typeof start>>;
/** What a removal in one group still waits for (team-management::US-004). */
type Removal = { active: number; awaitingRequester: number; closing: number; tasks: Array<{ id: string; name: string; when: string }>;
  waiting: Array<{ requestId: string; label: string; summary: string; requester: string; waitingFor: string[] }> };
type TeamView = { id: string; teamName: string; responsibility: string; leader: { name: string; appId: string; instructions: string }; deleting: boolean;
  profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[] }>;
  bindings: Array<{ chatId: string; state: string; join?: { status: string; reason?: string }; removal?: Removal }>;
  announcements: Record<string, { kind: string; state: string }> };
type View = { version: number; teams: TeamView[]; preview: Record<string, string[]> };
type Edit = { id: string; teamName: string; responsibility: string; leader: TeamView["leader"];
  executorProfiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[] }>; groups: string[] };
/** The console's edit of a team as the team view shows it, changed by `change`. */
function editOf(view: View, id: string, change: (team: Edit) => Edit = (team) => team): Edit {
  const team = view.teams.find((candidate) => candidate.id === id)!;
  return change({ id, teamName: team.teamName, responsibility: team.responsibility, leader: { ...team.leader },
    executorProfiles: team.profiles.map(({ id: profileId, name, noun, instructions, hostTools }) => ({ id: profileId, name, noun, instructions, hostTools })),
    groups: team.bindings.filter(({ state }) => state !== "draining").map(({ chatId }) => chatId) });
}
async function viewUntil(running: Running, predicate: (view: View) => boolean): Promise<View> {
  let view!: View;
  await vi.waitFor(async () => { view = await running.get<View>("/api/teams"); expect(predicate(view)).toBe(true); }, { timeout: 15000, interval: 50 });
  return view;
}
const team = (view: View, id: string) => view.teams.find((candidate) => candidate.id === id)!;
const failedReply = (subject: string) => JSON.stringify({ message: "缺少日期，行程未完成。", results: [{ subject, status: "failed" }] });
const completedReply = (subject: string) => JSON.stringify({ message: "行程已规划好。", results: [{ subject, status: "completed" }] });
const CLARIFICATION = "我还不能确定这条消息需要如何处理，请说明希望完成的事务和结果。";
/** The owner's group message with a genuine mention of one application, as Feishu's message details report it. */
const mentioning = (messageId: string, text: string, appId: string, name: string, dispatchDecision: unknown) => ({
  event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
    message: { message_id: messageId, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
      mentions: [{ key: "@_user_0", id: { open_id: `ou_${name.toLowerCase()}view0` }, name }], content: JSON.stringify({ text: `@_user_0 ${text}` }) } },
  messageDetails: { message_id: messageId, chat_id: "oc_alpha", msg_type: "text", body: { content: JSON.stringify({ text }) },
    mentions: [{ key: "@_user_0", id: appId, id_type: "app_id", name }] },
  dispatchDecision,
});

it("gives a team whose bot cannot join the group no work there, and leaves it out of that group's preview", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-onboarding-blocked-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory, { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify({ chats: { oc_alpha: { add: "owner_only" } } }) });
    const { teamId } = await running.post<{ teamId: string }>("/api/teams/save", { basedOn: (await running.get<View>("/api/teams")).version, team: daisy() });
    const view = await viewUntil(running, (current) => team(current, teamId)?.bindings[0]?.join?.status === "action");
    expect(team(view, teamId).bindings).toEqual([{ chatId: "oc_alpha", state: "onboarding", join: expect.objectContaining({ status: "action", reason: "owner_only" }) }]);
    expect(view.preview.oc_alpha).toEqual(["alice", "bill", "jack"]);
    // A Coordinator decision naming the team is refused like an unknown agent: the clarification goes out, nothing is assigned.
    await running.post("/api/fixture/inbound", groupMessage("om_blocked_team", "帮我设计商品主图", decision(teamId, "设计商品主图")));
    const refused = await running.until((state) => (state.fixtureTextOutbox?.length ?? 0) === 1);
    console.log(JSON.stringify({ kind: "team_onboarding_blocked", command: "帮我设计商品主图", coordinator: refused.fixtureTextOutbox, jobs: refused.agentDispatch }));
    expect([refused.fixtureTextOutbox?.map(({ message }) => message), refused.agentDispatch?.jobs, refused.agentFixtureOutboxes?.[teamId]?.text ?? []])
      .toEqual([[CLARIFICATION], [], []]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("keeps a team accepting work when its join announcement is rejected, and never resends it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-announcement-failed-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "sam", textOutcomes: ["rejected"] } });
    const { teamId } = await running.post<{ teamId: string }>("/api/teams/save", { basedOn: (await running.get<View>("/api/teams")).version, team: daisy() });
    const failed = await viewUntil(running, (current) => team(current, teamId)?.announcements.oc_alpha?.state === "failed");
    expect(team(failed, teamId)).toMatchObject({ bindings: [{ chatId: "oc_alpha", state: "accepting" }], announcements: { oc_alpha: { kind: "join", state: "failed" } } });
    await running.close(); running = undefined;
    running = await start(directory);
    const after = await running.get<View>("/api/teams");
    console.log(JSON.stringify({ kind: "team_announcement_failed", announcements: team(after, teamId).announcements, outbox: (await running.state()).fixtureTextOutbox }));
    expect([team(after, teamId).announcements, announcements(await running.state()), after.preview.oc_alpha])
      .toEqual([{ oc_alpha: { kind: "join", state: "failed", text: "Daisy（设计团队）已加入本群，负责：视觉方案" } }, [], ["alice", "bill", "jack", teamId]]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 45000);

// Nothing of Alice's is left in the group, so the removal completes with the save (team-management::US-004/AC-02). Unbinding is a
// registry state: her application stays a member of the chat, so she can still be mentioned there, and the mention gives her
// no work (decision 2026-11-11 (g)).
it("unbinds an idle team from a group unchecked from it: Sam announces that it left, a mention of it gets no work and the Team Directory drops it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-removal-start-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    const view = await running.get<View>("/api/teams");
    await running.post("/api/teams/save", { basedOn: view.version, team: editOf(view, "alice", (alice) => ({ ...alice, groups: [] })) });
    const left = await running.until((state) => announcements(state).length === 1);
    expect(announcements(left)).toEqual(["Alice（运营团队）已离开本群，不再接新的事务；进行中的事务会做完。"]);
    expect(team(await running.get<View>("/api/teams"), "alice").bindings).toEqual([]);
    await running.post("/api/fixture/inbound", mentioning("om_after_leave", "帮我整理闲鱼商品描述", "cli_aaaaaaaaaaaaaaaa", "Alice", decision("alice", "整理闲鱼商品描述")));
    await running.until((state) => (state.fixtureTextOutbox?.length ?? 0) === 2);
    await running.post("/api/fixture/inbound", groupMessage("om_bill_after_leave", "帮我规划周末一日行程", decision("bill", "规划周末一日行程")));
    const result = await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 2);
    console.log(JSON.stringify({ kind: "team_removal_start", commands: ["uncheck Alice oc_alpha", "@Alice 帮我整理闲鱼商品描述", "帮我规划周末一日行程"],
      coordinator: result.fixtureTextOutbox, jobs: result.agentDispatch, leader: result.fixtureLeaderRequests }));
    expect(result.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["Alice（运营团队）已离开本群，不再接新的事务；进行中的事务会做完。", CLARIFICATION]);
    expect(result.agentDispatch?.jobs.map(({ agentId }) => agentId)).toEqual(["bill"]);
    expect(result.agentFixtureOutboxes?.alice?.text).toEqual([]);
    expect(result.fixtureLeaderRequests!.find(({ teamId, phase }) => teamId === "bill" && phase === "plan")!.input.directory!.map(({ name }) => name)).toEqual(["生活团队", "技术团队"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// Deleting a team (team-management::US-004/AC-01, AC-02, REQ-004/AC-01; agent-dispatch::REQ-015/AC-01, AC-03; agent-console::US-003/AC-02).
// The team stays in the definitions while its Assignment runs, so its Team Leader's closing goes out with its own application
// (decision 2026-11-11: a deleted team's last closing still goes out); only then does it leave the list.
it("deletes a team with a running Assignment: it stops taking work at once, is marked as being deleted, closes its work with its own application and then leaves the list", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-delete-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_bill_held", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelHold: true }));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "running" && (state.fixtureModelRequests?.length ?? 0) === 1);
    const { view: started } = await running.post<{ view: View }>("/api/teams/delete", { teamId: "bill" });
    expect(team(started, "bill")).toMatchObject({ deleting: true, bindings: [{ chatId: "oc_alpha", state: "draining", removal: { active: 1, awaitingRequester: 0, closing: 0, tasks: [], waiting: [] } }] });
    expect(started.teams.filter(({ deleting }) => deleting).map(({ id }) => id)).toEqual(["bill"]);
    const overview = await running.get<{ teams: Array<{ id: string; deleting: boolean }> }>("/api/overview");
    expect(overview.teams.map(({ id, deleting }) => [id, deleting])).toEqual([["alice", false], ["bill", true], ["jack", false]]);
    // A mention of the draining team's application gives it no work (decision 2026-11-11 (g)).
    await running.post("/api/fixture/inbound", mentioning("om_mention_draining", "再帮我订一家餐厅", "cli_bbbbbbbbbbbbbbbb", "Bill", decision("bill", "订一家餐厅")));
    const refused = await running.until((state) => (state.fixtureTextOutbox?.length ?? 0) === 2);
    expect(refused.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["Bill（生活团队）已离开本群，不再接新的事务；进行中的事务会做完。", CLARIFICATION]);
    expect(refused.agentDispatch?.jobs.map(({ agentId, status }) => [agentId, status])).toEqual([["bill", "running"]]);
    // Another team's next turn no longer lists the team being deleted.
    await running.post("/api/fixture/inbound", groupMessage("om_alice_after_delete", "帮我整理闲鱼商品描述", decision("alice", "整理闲鱼商品描述")));
    const routed = await running.until((state) => state.agentFixtureOutboxes?.alice?.text.length === 2);
    expect(routed.fixtureLeaderRequests!.find(({ teamId, phase }) => teamId === "alice" && phase === "plan")!.input.directory!.map(({ name }) => name)).toEqual(["运营团队", "技术团队"]);
    expect(team(await running.get<View>("/api/teams"), "bill").bindings[0]?.state).toBe("draining");
    await running.post("/api/fixture/inbound", { modelControl: { messageId: "om_bill_held", action: "release" } });
    const gone = await viewUntil(running, (current) => !current.teams.some(({ id }) => id === "bill"));
    expect(gone.teams.map(({ id }) => id)).toEqual(["alice", "jack"]);
    const closed = await running.state();
    console.log(JSON.stringify({ kind: "team_delete", commands: ["请帮我规划周末一日行程", "delete Bill", "@Bill 再帮我订一家餐厅", "帮我整理闲鱼商品描述", "release Bill's Executor"],
      coordinator: closed.fixtureTextOutbox, jobs: closed.agentDispatch, outboxes: closed.agentFixtureOutboxes }));
    // Bill's application is closed with the deletion, so its outbox is gone from the fixture state; the request's record shows
    // that the closing was accepted under Bill's identity, not cancelled for a sender that had left, and keeps that identity.
    const history = await running.get<{ agents: Record<string, { name: string; teamName: string }>; teams: Array<{ id: string }>;
      requests: Array<{ lead: string; status: string; posts: Array<{ agentId: string; text: string; state: string }> }> }>("/api/overview");
    expect(history.teams.map(({ id }) => id)).toEqual(["alice", "jack"]);
    expect(history.agents.bill).toEqual({ name: "Bill", teamName: "生活团队" });
    const record = history.requests.find(({ lead }) => lead === "bill")!;
    expect(record.posts.map(({ agentId, text, state }) => [agentId, text, state]))
      .toEqual([["bill", "我安排执行者 1（能力档 1）处理：规划周末一日行程。完成后会在本群汇报。", "accepted"], ["bill", "这是 fixture Codex 回复。", "accepted"]]);
    expect(closed.agentDispatch?.jobs.map(({ agentId, status }) => [agentId, status])).toEqual([["bill", "completed"], ["alice", "completed"]]);
    expect(announcements(closed)).toEqual(["Bill（生活团队）已离开本群，不再接新的事务；进行中的事务会做完。"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// Scheduled tasks that send with a team's identity hold its removal (team-management::US-004/AC-03, REQ-005). Each of the three
// tasks takes one of the ways out: moved to another team, deleted, or run. The last one's run is what completes the removal,
// with no console action after it.
it("holds a removal for the team's scheduled tasks: a moved one is sent by the other team, a deleted one is never sent, and the removal completes when the last one has run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-removal-tasks-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    // The tasks must fall due only after the removal steps below. Their due time is wall-clock time in another process, so it
    // leaves those steps a wide margin, and the case fails with a reason if they still outlast it.
    const due = Date.now() + 20_000, at = new Date(due).toISOString();
    const names = ["带伞提醒", "订票提醒", "对账提醒"], asked = (name: string) => `稍后在本群提醒，原文：${name}`;
    for (const [index, name] of names.entries()) {
      await running.post("/api/fixture/inbound", groupMessage(`om_bill_task_${index}`, asked(name), decision("bill", name), {
        modelToolCalls: [{ namespace: "schedules", tool: "create", arguments: { name, instruction: name, reminderText: name, reminderMode: "verbatim", at, sourceText: asked(name) } }] }));
      await running.until((state) => state.agentDispatch?.jobs[index]?.status === "completed");
    }
    const view = await running.get<View>("/api/teams");
    const { view: draining } = await running.post<{ view: View }>("/api/teams/save", { basedOn: view.version, team: editOf(view, "bill", (bill) => ({ ...bill, groups: [] })) });
    const held = team(draining, "bill").bindings[0]!;
    expect(held).toMatchObject({ chatId: "oc_alpha", state: "draining", removal: { active: 0, awaitingRequester: 0, closing: 0, waiting: [] } });
    // Tasks are listed in the order of their IDs, which are random.
    expect(held.removal!.tasks.map(({ name }) => name).sort()).toEqual([...names].sort());
    const taskId = (name: string) => held.removal!.tasks.find((task) => task.name === name)!.id;
    await running.post("/api/teams/tasks/move", { teamId: "bill", taskId: taskId("带伞提醒"), to: "alice" });
    const { view: left } = await running.post<{ view: View }>("/api/teams/tasks/delete", { teamId: "bill", taskId: taskId("订票提醒") });
    expect(team(left, "bill").bindings.map(({ state, removal }) => [state, removal!.tasks.map(({ name }) => name)])).toEqual([["draining", ["对账提醒"]]]);
    expect(Date.now(), "the removal steps outlasted the tasks' due time, so the tasks would run before they were moved or deleted").toBeLessThan(due - 2_000);
    const sent = (state: State, id: string) => (state.agentFixtureOutboxes?.[id]?.text ?? []).map(({ chatId, message }) => [chatId, message]);
    const ran = await running.until((state) => sent(state, "alice").length === 1 && sent(state, "bill").length === 7, Math.max(0, due - Date.now()) + processWaitLimitMs);
    expect(sent(ran, "alice")).toEqual([["oc_alpha", "带伞提醒"]]);
    expect(sent(ran, "bill").at(-1)).toEqual(["oc_alpha", "对账提醒"]);
    const unbound = await viewUntil(running, (current) => team(current, "bill").bindings.length === 0);
    const settled = await running.state();
    console.log(JSON.stringify({ kind: "team_removal_tasks", commands: [...names.map(asked), "uncheck Bill oc_alpha", "move 带伞提醒 to Alice", "delete 订票提醒"],
      coordinator: settled.fixtureTextOutbox, jobs: settled.agentDispatch, outboxes: settled.agentFixtureOutboxes, bill: team(unbound, "bill") }));
    expect(Object.values(settled.agentFixtureOutboxes ?? {}).flatMap((outbox) => outbox?.text ?? []).filter(({ message }) => message === "订票提醒")).toEqual([]);
    expect(announcements(settled)).toEqual(["Bill（生活团队）已离开本群，不再接新的事务；进行中的事务会做完。"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60000);

// Requests that wait for their requester hold a removal (team-management::US-004/AC-04). The owner sees whose answer each one
// waits for and what it waits on; the removal completes when both requesters have answered, with no console action.
it("holds a removal for requests waiting for their requesters, lists each with its requester and what it waits for, and completes when they end", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-removal-waiting-")), business = mkdtempSync(join(tmpdir(), "team-removal-waiting-files-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory, true);
    running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await allowNotes(running);
    const from = (sender: string, message: ReturnType<typeof groupMessage>) => ({ ...message, event: { ...message.event, sender: { sender_type: "user", sender_id: { open_id: sender } } } });
    const choose = { modelToolCalls: [
      { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query: "Agent", include: ["**/*.md"], kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 2 } },
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
        candidateRefs: [0, 1].map((index) => ({ $fixtureToolResult: { call: 0, path: ["entries", index, "fileRef"] } })) } }] };
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_owner_choice", "列出 Agent 笔记让我选发哪个", decision("alice", "选择并发送运营笔记"), choose));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "waiting");
    await running.post("/api/fixture/feishu/inbound", from("ou_colleague", groupMessage("om_member_choice", "也列出 Agent 笔记让我选", decision("alice", "为同事选择运营笔记"), choose)));
    const waiting = await running.until((state) => state.agentDispatch?.jobs.length === 2 && state.agentDispatch.jobs.every(({ status }) => status === "waiting"));
    const [mine, theirs] = waiting.agentDispatch!.jobs;
    const view = await running.get<View>("/api/teams");
    const { view: draining } = await running.post<{ view: View }>("/api/teams/save", { basedOn: view.version, team: editOf(view, "alice", (alice) => ({ ...alice, groups: [] })) });
    // A waiting Assignment is counted with the waiting requests, not with the Assignments still being worked on.
    expect(team(draining, "alice").bindings).toEqual([{ chatId: "oc_alpha", state: "draining", removal: { active: 0, awaitingRequester: 2, closing: 0, tasks: [], waiting: [
      { requestId: mine!.id, label: mine!.id.slice(0, 8), summary: "选择并发送运营笔记", requester: "owner", waitingFor: ["选择并发送运营笔记"] },
      { requestId: theirs!.id, label: theirs!.id.slice(0, 8), summary: "为同事选择运营笔记", requester: "member", waitingFor: ["为同事选择运营笔记"] }] } }]);
    const ignore = { kind: "ignore", agentId: null, requestId: null, summary: "", message: "" };
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_owner_cancel", "取消", ignore));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "cancelled");
    expect(team(await running.get<View>("/api/teams"), "alice").bindings.map(({ state, removal }) => [state, removal!.waiting.map(({ requestId }) => requestId)])).toEqual([["draining", [theirs!.id]]]);
    await running.post("/api/fixture/feishu/inbound", from("ou_colleague", groupMessage("om_member_cancel", "取消", ignore)));
    await viewUntil(running, (current) => team(current, "alice").bindings.length === 0);
    const settled = await running.state();
    console.log(JSON.stringify({ kind: "team_removal_waiting", commands: ["列出 Agent 笔记让我选发哪个", "ou_colleague: 也列出 Agent 笔记让我选", "uncheck Alice oc_alpha", "取消", "ou_colleague: 取消"],
      coordinator: settled.feishuFixtureTextOutbox, jobs: settled.agentDispatch, outboxes: settled.agentFixtureOutboxes }));
    expect(settled.agentDispatch?.jobs.map(({ agentId, status }) => [agentId, status])).toEqual([["alice", "cancelled"], ["alice", "cancelled"]]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 45000);

// Availability for new work follows the current roster, for a request admitted earlier too (agent-dispatch::REQ-017/AC-03,
// REQ-015/AC-01): a retry would give the removed team new work, so nothing is requeued and Sam says so (decision 2026-11-11 (a)).
// The case next to it in this file retries the same failed request with the team still accepting, and that one runs again.
it("does not rerun a failed request for a team removed from the group since: Sam answers that it cannot continue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-removed-retry-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_removed_first", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelReply: failedReply("规划周末一日行程") }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed" && state.agentFixtureOutboxes?.bill?.text.length === 2);
    const view = await running.get<View>("/api/teams");
    await running.post("/api/teams/save", { basedOn: view.version, team: editOf(view, "bill", (bill) => ({ ...bill, groups: [] })) });
    await viewUntil(running, (current) => team(current, "bill").bindings.length === 0);
    const requests = failed.fixtureModelRequests?.length;
    await running.post("/api/fixture/inbound", groupMessage("om_removed_retry", "重试", { kind: "retry", agentId: null, requestId: failed.agentDispatch!.jobs[0]!.id, summary: "", message: "" },
      { modelReply: completedReply("规划周末一日行程") }));
    const refused = await running.until((state) => (state.fixtureTextOutbox?.length ?? 0) === 2);
    console.log(JSON.stringify({ kind: "team_removed_retry", commands: ["请帮我规划周末一日行程", "uncheck Bill oc_alpha", "重试"], coordinator: refused.fixtureTextOutbox,
      jobs: refused.agentDispatch, outboxes: refused.agentFixtureOutboxes }));
    expect(refused.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["Bill（生活团队）已离开本群，不再接新的事务；进行中的事务会做完。", "无法继续这项请求，请说明需要处理的事务。"]);
    expect(refused.agentDispatch?.jobs.map(({ agentId, status, attempt }) => [agentId, status, attempt])).toEqual([["bill", "failed", 0]]);
    expect(refused.fixtureModelRequests?.length).toBe(requests);
    expect(refused.agentFixtureOutboxes?.bill?.text.length).toBe(2);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// A removal outlives the process (team-management::US-004/AC-02). The Assignment that held it is cut off by the shutdown, so
// nothing of the team's runs after the restart: its Team Leader reports the interruption with its own application, and the
// removal completes from the start-up alone, with no console action and no new message.
it("completes a removal held at shutdown after the restart: the team reports its interrupted work with its own application and is unbound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-removal-restart-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_restart_held", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelHold: true }));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "running" && (state.fixtureModelRequests?.length ?? 0) === 1);
    const view = await running.get<View>("/api/teams");
    const { view: draining } = await running.post<{ view: View }>("/api/teams/save", { basedOn: view.version, team: editOf(view, "bill", (bill) => ({ ...bill, groups: [] })) });
    expect(team(draining, "bill").bindings.map(({ state, removal }) => [state, removal!.active])).toEqual([["draining", 1]]);
    await running.close(); running = await start(directory);
    await viewUntil(running, (current) => team(current, "bill").bindings.length === 0);
    const settled = await running.state();
    console.log(JSON.stringify({ kind: "team_removal_restart", commands: ["请帮我规划周末一日行程", "uncheck Bill oc_alpha", "restart"], coordinator: settled.fixtureTextOutbox,
      jobs: settled.agentDispatch, outboxes: settled.agentFixtureOutboxes }));
    expect(settled.agentDispatch?.jobs.map(({ agentId, status, assignments }) => [agentId, status, assignments.map((assignment) => assignment.status)])).toEqual([["bill", "failed", ["interrupted"]]]);
    // The fixture outboxes start empty with each process: these are the posts made after the restart, and Sam announces nothing again.
    expect(settled.agentFixtureOutboxes?.bill?.text.map(({ chatId, message }) => [chatId, message])).toEqual([
      ["oc_alpha", "服务中断，执行者 1（能力档 1）的分工「规划周末一日行程」已中断，无法确认已完成的内容，不会自动重放。"], ["oc_alpha", "服务中断，本次处理已停止。"]]);
    expect(settled.fixtureTextOutbox).toEqual([]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 45000);

// A team can move to another application and back (ticket 11, decision D5). Going back used to fail the save after it was stored,
// because the old application's media route was still registered.
// Coverage gap: media sent after a team's secret is replaced is not driven here; it needs a media-sending workflow. Team media
// routes resolve the team's current application at each send, the same wiring this case's return to the old application uses.
it("lets a team go back to an application it used before, and posts with it again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-application-return-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    const { teamId } = await running.post<{ teamId: string }>("/api/teams/save", { basedOn: (await running.get<View>("/api/teams")).version, team: daisy() });
    const onApplication = (appId: string) => (current: View) => team(current, teamId)?.leader.appId === appId && team(current, teamId)?.bindings[0]?.state === "accepting";
    let view = await viewUntil(running, onApplication(DAISY_APP));
    const switchTo = (current: View, appId: string, secret: string) => ({ basedOn: current.version,
      team: { ...editOf(current, teamId, (edit) => ({ ...edit, leader: { ...edit.leader, appId } })), secret } });
    await running.post("/api/teams/save", switchTo(view, "cli_eeeeeeeeeeeeeeee", "daisy-other-secret"));
    view = await viewUntil(running, onApplication("cli_eeeeeeeeeeeeeeee"));
    const back = await running.send("/api/teams/save", switchTo(view, DAISY_APP, SECRET_SENTINEL));
    expect(back.status).toBe(200);
    await viewUntil(running, onApplication(DAISY_APP));
    await running.post("/api/fixture/inbound", groupMessage("om_daisy_back", "帮我设计商品主图", decision(teamId, "设计商品主图")));
    const posted = await running.until((state) => (state.agentFixtureOutboxes?.[teamId]?.text.length ?? 0) >= 2);
    console.log(JSON.stringify({ kind: "team_application_return", commands: ["save 设计团队", "switch application", "switch back", "帮我设计商品主图"],
      jobs: posted.agentDispatch, outboxes: posted.agentFixtureOutboxes }));
    expect(posted.agentFixtureOutboxes?.[teamId]?.text.map(({ message }) => message)[0]).toBe("我安排视觉执行者 1（视觉方案）处理：设计商品主图。完成后会在本群汇报。");
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 45000);

it("counts each team's active Assignments in the team view", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-active-count-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_active_count", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelHold: true }));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "running" && (state.fixtureModelRequests?.length ?? 0) === 1);
    const { teams } = await running.get<{ teams: Array<TeamView & { activeAssignments: number }> }>("/api/teams");
    expect(teams.map(({ id, activeAssignments }) => [id, activeAssignments])).toEqual([["alice", 0], ["bill", 1], ["jack", 0]]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// Dispatcher decision R5 (2026-11-08): a failed credentials check never moves an accepting team out of accepting, because a check
// outcome must not change routing by itself. While the team's application cannot post, the owner sees 需处理 on the page; the
// request fails, and its failure report goes through the same application (agent-dispatch::REQ-008/AC-04: no other identity),
// so nothing reaches the requester in the group.
it("keeps a team accepting work when its replaced secret fails the check, and reports nothing through another identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-secret-failed-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory, { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify({ applications: { cli_bbbbbbbbbbbbbbbb: "bad_credentials" } }) });
    const view = await running.get<View>("/api/teams");
    await running.post("/api/teams/save", { basedOn: view.version, team: { ...editOf(view, "bill"), secret: "bill-wrong-secret" } });
    const checked = await viewUntil(running, (current) => (team(current, "bill") as TeamView & { credentials?: { status: string } }).credentials?.status === "action");
    expect(team(checked, "bill")).toMatchObject({ credentials: { status: "action", reason: "bad_credentials" }, bindings: [{ chatId: "oc_alpha", state: "accepting" }] });
    expect(checked.preview.oc_alpha).toEqual(["alice", "bill", "jack"]);
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "bill", textOutcomes: ["rejected", "rejected"] } });
    await running.post("/api/fixture/inbound", groupMessage("om_secret_failed", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程")));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed");
    console.log(JSON.stringify({ kind: "team_secret_failed", command: "请帮我规划周末一日行程", jobs: failed.agentDispatch, outboxes: failed.agentFixtureOutboxes, coordinator: failed.fixtureTextOutbox }));
    expect(failed.agentDispatch?.jobs[0]?.result).toBe("接单通知未确认发送，本次尚未开始处理。请检查机器人是否可在本群发言后明确重试。");
    expect([failed.agentFixtureOutboxes?.bill?.text, failed.fixtureTextOutbox, failed.fixtureModelRequests ?? []]).toEqual([[], [], []]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("resumes onboarding at startup without checking the credentials again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-onboarding-resume-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory, { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify({ chats: { oc_alpha: { add: "owner_only" } } }) });
    const { teamId } = await running.post<{ teamId: string }>("/api/teams/save", { basedOn: (await running.get<View>("/api/teams")).version, team: daisy() });
    await viewUntil(running, (current) => team(current, teamId)?.bindings[0]?.join?.status === "action");
    await running.close(); running = undefined;
    // The group now lets Sam add the bot; the next start continues from the recorded outcomes.
    running = await start(directory);
    await viewUntil(running, (current) => team(current, teamId)?.bindings[0]?.state === "accepting");
    const resumed = await running.until((state) => announcements(state).length === 1);
    console.log(JSON.stringify({ kind: "team_onboarding_resumed", calls: resumed.fixtureOnboardingCalls, announcements: announcements(resumed) }));
    // Onboarding steps only; the page's group-name lookups are not part of onboarding.
    expect(resumed.fixtureOnboardingCalls?.filter(({ call }) => call !== "chat_name")).toEqual([{ call: "add", chatId: "oc_alpha", appId: DAISY_APP, as: "cli_0123456789abcdef" },
      { call: "in_chat", chatId: "oc_alpha", as: DAISY_APP }]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 45000);

it("applies a saved responsibility and instructions to new requests only, while a running request keeps its own", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-edit-running-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory, { WORKFLOW_FIXTURE_COORDINATION_RUNTIME: "1" });
    await running.post("/api/fixture/inbound", groupMessage("om_edit_first", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"),
      { modelReply: failedReply("规划周末一日行程"), leaderClosing: { message: "行程未完成。" } }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed");
    const view = await running.get<View>("/api/teams");
    await running.post("/api/teams/save", { basedOn: view.version, team: editOf(view, "bill", (bill) => ({ ...bill, responsibility: "生活新职责 N1",
      leader: { ...bill.leader, instructions: "负责人新规则 N1" }, executorProfiles: bill.executorProfiles.map((profile) => ({ ...profile, instructions: "执行新规则 N1" })) })) });
    // The retried request keeps the definitions it was admitted under, for its later Executor turn too (agent-dispatch::REQ-017/AC-01).
    await running.post("/api/fixture/inbound", groupMessage("om_edit_retry", "重试", { kind: "retry", agentId: null, requestId: failed.agentDispatch!.jobs[0]!.id, summary: "", message: "" },
      { modelReply: completedReply("规划周末一日行程"), leaderClosing: { message: "行程已规划好。" } }));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    await running.post("/api/fixture/inbound", groupMessage("om_edit_second", "再帮我规划周日行程", decision("bill", "规划周日行程"),
      { modelReply: completedReply("规划周日行程"), leaderClosing: { message: "周日行程已规划好。" } }));
    const result = await running.until((state) => state.agentDispatch?.jobs[1]?.status === "completed");
    console.log(JSON.stringify({ kind: "team_edit_running", commands: ["请帮我规划周末一日行程", "save Bill", "重试", "再帮我规划周日行程"], jobs: result.agentDispatch }));
    const executor = result.fixtureModelRequests!.map(({ input }) => JSON.stringify(input));
    expect(executor.map((input) => [input.includes("出行路线须逐段核对站名"), input.includes("执行新规则 N1")])).toEqual([[true, false], [true, false], [false, true]]);
    const turns = result.fixtureCoordinationRequests!.map(({ input }) => JSON.stringify(input));
    const coordinator = turns.filter((input) => input.includes("只协调和分派群聊任务"));
    // Every Coordinator turn after the save (classifying the retry, then the new request) lists the saved responsibility.
    expect(coordinator.map((input) => input.includes("生活新职责 N1"))).toEqual([false, true, true]);
    // The leader's instructions reach only that Team Leader, and only in turns of requests admitted after the save: the retried
    // request keeps its admitted instructions in every Team Leader turn, its closing after the save included (agent-dispatch::REQ-017/AC-01).
    expect(coordinator.some((input) => input.includes("负责人新规则 N1"))).toBe(false);
    // Bill's Team Leader turns of each request, in order: whether each carries the saved instructions.
    const leaderTurns = (brief: string) => turns.filter((input) => input.includes("生活团队的负责人") && input.includes(brief)).map((input) => input.includes("负责人新规则 N1"));
    expect(leaderTurns("请帮我规划周末一日行程")).toEqual([false, false, false]);
    expect(leaderTurns("再帮我规划周日行程")).toEqual([true, true]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 45000);

it("refuses a host tool removed from a profile at the next call of a request admitted before, and audits the refusal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-tool-revoked-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_revoke_first", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelReply: failedReply("规划周末一日行程") }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed");
    const view = await running.get<View>("/api/teams");
    await running.post("/api/teams/save", { basedOn: view.version, team: editOf(view, "bill", (bill) => ({ ...bill,
      executorProfiles: bill.executorProfiles.map((profile) => ({ ...profile, hostTools: profile.hostTools.filter((tool) => tool !== "files.find") })) })) });
    await running.post("/api/fixture/inbound", groupMessage("om_revoke_retry", "重试", { kind: "retry", agentId: null, requestId: failed.agentDispatch!.jobs[0]!.id, summary: "", message: "" },
      { modelToolCalls: [{ namespace: "files", tool: "find", arguments: { query: "行程", kind: "file", limit: 1 } }], modelReply: completedReply("规划周末一日行程") }));
    const result = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    const refused = readFileSync(join(directory, "console-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter(({ event }) => event === "host_tool_refused").map(({ team: refusedTeam, profile, tool }) => ({ team: refusedTeam, profile, tool }));
    console.log(JSON.stringify({ kind: "team_tool_revoked", commands: ["请帮我规划周末一日行程", "remove files.find", "重试"], jobs: result.agentDispatch, refused }));
    expect(refused).toEqual([{ team: "bill", profile: "executor-1", tool: "files.find" }]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// The dispatch-group form (agent-console::US-009) through real main: the file, the startup import and dispatch in the saved group.
it("enables a group from the console: the save writes it, and after a restart a request there reaches Sam alone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-groups-enable-"));
  const secret = "sam-secret-SENTINEL-30a1";
  const outputs: string[] = [];
  let running: Running | undefined;
  try {
    const configuration = config("feishu");
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...configuration,
      feishu: { ...configuration.feishu, appSecret: secret, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }] } }));
    running = await start(directory);
    expect(await running.get("/api/teams")).toEqual({ configured: false });
    const form = await running.get<{ basedOn: string; groups: unknown }>("/api/teams/dispatch-groups");
    expect(form.groups).toEqual([{ chatId: "oc_alpha", name: "oc_alpha" }]);
    const saved = await running.post("/api/teams/dispatch-groups", { groups: ["oc_alpha"], basedOn: form.basedOn });
    expect(saved).toMatchObject({ feishu: true, saved: ["oc_alpha"], running: [] });
    const responses = JSON.stringify([form, saved]);
    outputs.push(running.output());
    await running.close(); running = undefined;
    expect((JSON.parse(readFileSync(join(directory, "channel.json"), "utf8")) as { feishu: { dispatch: unknown } }).feishu.dispatch).toEqual({ groupChatIds: ["oc_alpha"] });

    running = await start(directory);
    const teams = await running.get<{ configured: boolean; coordinator: { name: string }; teams: unknown[]; groups: unknown }>("/api/teams");
    expect({ configured: teams.configured, coordinator: teams.coordinator.name, teams: teams.teams, groups: teams.groups })
      .toEqual({ configured: true, coordinator: "Sam", teams: [], groups: [{ chatId: "oc_alpha", name: "oc_alpha" }] });
    await running.post("/api/fixture/inbound", groupMessage("om_enabled_group", "帮我看看这件事",
      { kind: "clarify", agentId: null, requestId: null, summary: "", message: "请说明想完成的事情。" }));
    const result = await running.until((state) => (state.fixtureTextOutbox?.length ?? 0) > 0);
    console.log(JSON.stringify({ kind: "dispatch_groups_enabled_restart", command: "帮我看看这件事", saved, outbox: result.fixtureTextOutbox, agentDispatch: result.agentDispatch }));
    expect(result.fixtureTextOutbox?.map(({ message }) => message)).toEqual(["请说明想完成的事情。"]);
    outputs.push(running.output());
    await running.close(); running = undefined;
    const audit = readFileSync(join(directory, "console-audit.jsonl"), "utf8");
    expect(audit.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>).filter(({ event }) => event === "dispatch_groups_saved")
      .map(({ by, before, after }) => ({ by, before, after }))).toEqual([{ by: "browser", before: [], after: ["oc_alpha"] }]);
    expect([responses, ...outputs, audit].filter((text) => text.includes(secret))).toEqual([]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60000);

it("refuses to uncheck a dispatch group that has an unfinished request, and lists it, leaving the file unchanged", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-groups-unfinished-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    await running.post("/api/fixture/inbound", groupMessage("om_unfinished_proposal", "周末可能想去附近玩玩",
      { kind: "propose", agentId: "bill", requestId: null, summary: "安排周末出行", message: "" }));
    const proposed = (await running.until((state) => state.agentDispatch?.jobs.some(({ status }) => status === "proposed") === true)).agentDispatch!.jobs[0]!;
    const before = readFileSync(join(directory, "channel.json"));
    const form = await running.get<{ basedOn: string; running: string[] }>("/api/teams/dispatch-groups");
    expect(form.running).toEqual(["oc_alpha"]);
    expect(await running.send("/api/teams/dispatch-groups", { groups: [], basedOn: form.basedOn })).toEqual({ status: 409, body: { error: "无法保存",
      // Each listed request carries its ID, which links it to its record on the team overview (ticket 10).
      refusal: { kind: "unfinished", groups: [{ chatId: "oc_alpha", requests: [{ id: proposed.id, summary: "安排周末出行", status: "proposed" }] }] } } });
    expect(await running.send("/api/teams/dispatch-groups", { groups: ["oc_alpha", "oc_unlisted"], basedOn: form.basedOn }))
      .toEqual({ status: 400, body: { error: "无法保存", refusal: { kind: "invalid" } } });
    expect(readFileSync(join(directory, "channel.json")).equals(before)).toBe(true);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

// agent-dispatch failure-mode row: a request admitted in a group after the owner saved it unchecked, before the restart.
it("does not continue requests admitted in a group unchecked on the page before the restart, and posts nothing more there", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-groups-unchecked-"));
  let running: Running | undefined;
  try {
    const configuration = config("feishu");
    writeFileSync(join(directory, "channel.json"), JSON.stringify({ ...configuration, feishu: { ...configuration.feishu,
      groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner"] }],
      dispatch: { groupChatIds: ["oc_alpha", "oc_beta"], agents: [{ id: "sam" }, { id: "alice", appId: "cli_aaaaaaaaaaaaaaaa", appSecret: "fixture-alice" },
        { id: "bill", appId: "cli_bbbbbbbbbbbbbbbb", appSecret: "fixture-bill" }, { id: "jack", appId: "cli_cccccccccccccccc", appSecret: "fixture-jack" }] } } }));
    running = await start(directory);
    // oc_alpha has no request yet, so the save that leaves it out is accepted.
    const form = await running.get<{ basedOn: string }>("/api/teams/dispatch-groups");
    await running.post("/api/teams/dispatch-groups", { groups: ["oc_beta"], basedOn: form.basedOn });
    // Then two requests reach Bill in oc_alpha: the first holds at its start message, the second queues behind it.
    await running.post("/api/fixture/inbound", { applicationControl: { agentId: "bill", textOutcomes: ["held"] } });
    await running.post("/api/fixture/inbound", groupMessage("om_unchecked_first", "帮我规划周末一日行程", decision("bill", "规划周末一日行程")));
    await running.until((state) => state.agentFixtureOutboxes?.bill?.text.length === 1);
    await running.post("/api/fixture/inbound", groupMessage("om_unchecked_second", "再帮我订一家餐厅", decision("bill", "订餐厅")));
    const before = await running.until((state) => state.agentDispatch?.jobs.map(({ status }) => status).join() === "running,queued");
    await running.crash(); running = undefined;
    running = await start(directory);
    const after = await running.until((state) => state.agentDispatch?.jobs.every(({ status }) => !["queued", "running"].includes(status)) === true);
    console.log(JSON.stringify({ kind: "dispatch_groups_unchecked_restart", commands: ["帮我规划周末一日行程", "再帮我订一家餐厅"],
      before: before.agentDispatch, after: after.agentDispatch, outboxes: after.agentFixtureOutboxes, sam: after.fixtureTextOutbox }));
    // In admission order: the request that was running, then the one queued behind it.
    expect(after.agentDispatch?.jobs.map(({ status }) => status)).toEqual(["cancelled", "cancelled"]);
    // In a dispatch group the same crash makes Bill post 「接单通知未确认发送…」 at the restart (agent-dispatch.integration.test.ts);
    // here neither Bill nor Sam posts anything more.
    expect({ bill: after.agentFixtureOutboxes?.bill?.text, sam: after.fixtureTextOutbox }).toEqual({ bill: [], sam: [] });
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 60000);

it("answers the team API and the dispatch-group form without Feishu: not configured, and Feishu not paired", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-no-feishu-"));
  let running: Running | undefined;
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
    running = await start(directory);
    expect(await running.get("/api/teams")).toEqual({ configured: false });
    expect(await running.get("/api/teams/dispatch-groups")).toEqual({ feishu: false });
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);

it("refuses a team on Penny's application, read from Penny's configuration", async () => {
  const directory = mkdtempSync(join(tmpdir(), "team-penny-application-"));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    const penny = { appId: "cli_eeeeeeeeeeeeeeee", appSecret: "penny-secret", tenantKey: "penny-tenant", ownerOpenId: "ou_pennyowner", privateChatId: "oc_pennyprivate",
      webhook: { port: await freePort(), path: "/feishu/penny/events", verificationToken: "penny-token", encryptKey: "penny-key" } };
    writeFileSync(join(directory, "penny.json"), JSON.stringify(penny), { mode: 0o600 });
    running = await start(directory, { PENNY_CONFIG_PATH: join(directory, "penny.json") });
    const refused = await running.send("/api/teams/save", { basedOn: (await running.get<View>("/api/teams")).version,
      team: daisy({ leader: { name: "Daisy", appId: penny.appId, instructions: "" } }) });
    expect(refused).toEqual({ status: 400, body: { error: "无法保存", reasons: ["该飞书应用已用于 Penny，不能用于团队"] } });
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); }
}, 30000);
