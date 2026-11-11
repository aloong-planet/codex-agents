import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { processWaitLimitMs } from "./support/process-wait.js";
import { config, decision, dispatchConfig, groupMessage, start, type State } from "./support/real-main.js";

// Real main composition (docs/specs/skill-library.md, Testing Decisions "Runtime boundary"): skills imported and selected through
// the console API, a group request through the fixture-only Feishu ingress, and each Executor's runtime home as it is when its
// turn runs. The model is the fixture App Server, which records the skills folder of the home it runs in; that a real App Server
// loads exactly that folder's skills is the opt-in case in isolated-model-runtime.test.ts. Library rules are in skill-library.test.ts.

type Running = Awaited<ReturnType<typeof start>>;
type TeamView = { version: number; teams: Array<{ id: string; teamName: string; responsibility: string; leader: { name: string; appId: string; instructions: string };
  bindings: Array<{ chatId: string; state: string }>; profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[]; skills: string[] }> }> };
type SkillsView = { skills: Array<{ id: string; name: string; state: { state: string; fingerprint?: string }; usedBy: Array<{ teamId: string; profile: string }> }> };

const skillMd = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
function folder(root: string, name: string, description: string): string {
  const source = join(root, name);
  mkdirSync(join(source, "references"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), skillMd(name, description, "body-v1"));
  writeFileSync(join(source, "references", "rules.md"), `${name} rules\n`);
  return source;
}
async function importSkill(running: Running, source: string): Promise<string> {
  const { preview } = await running.post<{ preview: { fingerprint: string } }>("/api/skills/read", { folder: source });
  return (await running.post<{ id: string }>("/api/skills/import", { folder: source, confirmed: preview.fingerprint })).id;
}
/** Bill's one profile checks the given skills, saved as the team page saves it. */
async function billSelects(running: Running, skills: string[]) {
  const view = await running.get<TeamView>("/api/teams");
  const bill = view.teams.find(({ id }) => id === "bill")!;
  await running.post("/api/teams/save", { basedOn: view.version, team: { id: "bill", teamName: bill.teamName, responsibility: bill.responsibility, leader: bill.leader,
    groups: bill.bindings.map(({ chatId }) => chatId),
    executorProfiles: bill.profiles.map(({ id, name, noun, instructions, hostTools }) => ({ id, name, noun, instructions, hostTools, skills })) } });
}
const BILL_USE = { teamId: "bill", leader: "Bill", teamName: "生活团队", profile: "能力档 1" };
const retry = (messageId: string, requestId: string, subject: string, extra: Record<string, unknown> = {}) => groupMessage(messageId, "重试", { kind: "retry", agentId: null, requestId, summary: "", message: "" },
  { modelReply: completedReply(subject), ...extra });
/** The Executor's model reads a file of a skill its profile selects, as a real model calls the tool: with no namespace. */
const readSkillFile = (skill: string, file: string) => ({ modelToolCalls: [{ namespace: "", tool: "read_skill_file", arguments: { skill, path: file } }] });
const failedReply = (subject: string) => JSON.stringify({ message: "缺少日期，行程未完成。", results: [{ subject, status: "failed" }] });
const completedReply = (subject: string) => JSON.stringify({ message: "行程已规划好。", results: [{ subject, status: "completed" }] });
const skillLines = (state: State, brief: string) => (state.fixtureLeaderRequests ?? []).filter(({ teamId, input }) => teamId === "bill" && input.brief.message === brief)
  .map(({ input }) => input.profiles!.flatMap(({ capabilities }) => capabilities.filter((line) => line.startsWith("技能"))));

it("gives each Executor exactly its profile's skills as its request was admitted with them: a re-import reaches new requests only, also when the earlier request is retried on a compacted home", async () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-library-main-")), sources = realpathSync(mkdtempSync(join(tmpdir(), "skill-library-sources-")));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    const tripSource = folder(sources, "trip-check", "逐段核对站名与换乘");
    const trip = await importSkill(running, tripSource);
    // A second skill of the library that no profile selects: it must reach no Executor.
    const meal = await importSkill(running, folder(sources, "meal-plan", "按预算安排菜单"));
    await billSelects(running, [trip]);
    expect((await running.get<SkillsView>("/api/skills")).skills.map(({ id, usedBy }) => [id, usedBy])).toEqual([[meal, []], [trip, [BILL_USE]]]);

    await running.post("/api/fixture/inbound", groupMessage("om_skill_first", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelReply: failedReply("规划周末一日行程") }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed");
    // Its runtime was released: the home was compacted to its rollout, and the skills went with everything else (ADR-0031).
    const runtimes = join(directory, "group-model-runtimes");
    const home = () => readdirSync(runtimes).filter((name) => /^dispatch-[0-9a-f]{64}$/u.test(name)).map((name) => join(runtimes, name, "codex-home"));
    await vi.waitFor(() => { expect(home()).toHaveLength(1); expect(readdirSync(home()[0]!)).toEqual(["sessions"]); }, { timeout: processWaitLimitMs, interval: 50 });

    // The owner edits the folder and imports it again while that request can still be retried.
    writeFileSync(join(tripSource, "SKILL.md"), skillMd("trip-check", "逐段核对站名、换乘与开放时间", "body-v2"));
    writeFileSync(join(tripSource, "references", "rules.md"), "trip-check rules v2\n");
    const changed = (await running.get<SkillsView>("/api/skills")).skills.find(({ id }) => id === trip)!.state;
    expect(changed.state).toBe("changed");
    await running.post(`/api/skills/${trip}/reimport`, { confirmed: changed.fingerprint });
    // The failed request can still be retried, so the version it was admitted with stays stored beside the new one.
    expect(readdirSync(join(directory, "skill-library", trip)).sort()).toEqual(["1", "2"]);

    // The retried request's Executor and the next request's each read the skill's reference file; Jack's preset selects no skill.
    await running.post("/api/fixture/inbound", retry("om_skill_retry", failed.agentDispatch!.jobs[0]!.id, "规划周末一日行程", readSkillFile("trip-check", "references/rules.md")));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    await running.post("/api/fixture/inbound", groupMessage("om_skill_second", "再帮我规划周日行程", decision("bill", "规划周日行程"),
      { modelReply: completedReply("规划周日行程"), ...readSkillFile("trip-check", "references/rules.md") }));
    await running.until((state) => state.agentDispatch?.jobs[1]?.status === "completed");
    await running.post("/api/fixture/inbound", groupMessage("om_skill_jack", "请帮我看一段代码", decision("jack", "看一段代码"),
      { modelReply: completedReply("看一段代码"), ...readSkillFile("trip-check", "references/rules.md") }));
    const result = await running.until((state) => state.agentDispatch?.jobs[2]?.status === "completed");
    const audit = readFileSync(join(directory, "console-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ event }) => String(event).startsWith("skill_")).map(({ event, skill, version, by }) => ({ event, skill, version, by }));
    console.log(JSON.stringify({ kind: "skill_library_main", commands: ["import trip-check", "import meal-plan", "Bill 能力档 1 selects trip-check", "请帮我规划周末一日行程", "re-import trip-check", "重试", "再帮我规划周日行程"],
      jobs: result.agentDispatch, coordinator: result.fixtureTextOutbox, outboxes: result.agentFixtureOutboxes,
      executorSkills: result.fixtureModelRequests?.map(({ skills }) => skills), skillFileReads: result.fixtureToolResults, leaderSkillLines: [skillLines(result, "请帮我规划周末一日行程"), skillLines(result, "再帮我规划周日行程")], audit }));

    // Each Executor turn, in order: the first attempt, its retry after the re-import, the request admitted afterwards, and Jack's.
    const loaded = (body: string, description: string) => [{ folder: trip, files: ["SKILL.md", "references/rules.md"], skillMd: skillMd("trip-check", description, body) }];
    expect(result.fixtureModelRequests!.map(({ skills }) => skills)).toEqual([loaded("body-v1", "逐段核对站名与换乘"), loaded("body-v1", "逐段核对站名与换乘"), loaded("body-v2", "逐段核对站名、换乘与开放时间"), []]);
    // Each of Bill's turns carries the skill as an input item that names its SKILL.md in that home: the App Server only lists a
    // skill, and the item is what puts its text before the Executor's model (agent-dispatch::REQ-016/AC-04).
    const carried = result.fixtureModelRequests!.map(({ input }) => (input as Array<{ type: string; name?: string; path?: string }>).filter(({ type }) => type === "skill"));
    expect(carried.map((items) => items.map(({ name }) => name))).toEqual([["trip-check"], ["trip-check"], ["trip-check"], []]);
    for (const [item] of carried.slice(0, 3)) expect(item!.path).toMatch(new RegExp(`/group-model-runtimes/dispatch-[0-9a-f]{64}/codex-home/skills/${trip}/SKILL\\.md$`, "u"));
    // Bill's Executors are offered the tool that reads their skills' files, and each read the reference file of its own
    // request's version: the retry the version it was admitted with, the later request the re-imported one. Jack's Executor,
    // whose preset selects no skill, is offered no such tool, and its call is refused (skill-library::REQ-003).
    const offered = (service: string) => result.fixtureThreadStarts!.filter(({ serviceName }) => serviceName === service).map(({ dynamicTools }) => (dynamicTools ?? []).includes("read_skill_file"));
    // Bill's two requests started a thread each; the retry resumed the first attempt's thread with the tools it was started with.
    expect(offered("feishu_agent_bill")).toEqual([true, true]);
    expect(offered("feishu_agent_jack")).toEqual([false]);
    expect(result.fixtureToolResults!.filter(({ tool }) => tool === "read_skill_file").map(({ success, result: read }) => ({ success, text: (read as { text?: string }).text })))
      .toEqual([{ success: true, text: "trip-check rules\n" }, { success: true, text: "trip-check rules v2\n" }, { success: false, text: undefined }]);
    // Bill's Team Leader is told what the skill gives its preset, in the version of each request (agent-dispatch::REQ-011/AC-01).
    const first = skillLines(result, "请帮我规划周末一日行程"), second = skillLines(result, "再帮我规划周日行程");
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect([...new Set(first.map((lines) => JSON.stringify(lines)))]).toEqual([JSON.stringify(["技能「trip-check」：逐段核对站名与换乘"])]);
    expect([...new Set(second.map((lines) => JSON.stringify(lines)))]).toEqual([JSON.stringify(["技能「trip-check」：逐段核对站名、换乘与开放时间"])]);
    // The earlier request has ended, so nothing needs version 1 any more.
    await vi.waitFor(() => expect(readdirSync(join(directory, "skill-library", trip))).toEqual(["2"]), { timeout: processWaitLimitMs, interval: 50 });
    expect(existsSync(join(directory, "skill-library", meal, "1", "files", "SKILL.md"))).toBe(true);
    expect(audit).toEqual([{ event: "skill_imported", skill: trip, version: 1, by: "browser" }, { event: "skill_imported", skill: meal, version: 1, by: "browser" },
      { event: "skill_reimported", skill: trip, version: 2, by: "browser" }]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(sources, { recursive: true, force: true }); }
}, 60000);

// A stored version that no longer holds what was imported, here a folder of it replaced by a link to an outside copy, is changed
// outside the service: the Executor's read is refused, and the service reports the skill on stderr with neither path nor content
// (skill-library::REQ-003, failure modes). The runtime is created all the same, because the copy written into its home matches.
it("refuses an Executor's read of a skill file whose stored folder was replaced by a link, and reports the skill without the path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-library-main-")), sources = realpathSync(mkdtempSync(join(tmpdir(), "skill-library-sources-")));
  let running: Running | undefined;
  try {
    dispatchConfig(directory);
    running = await start(directory);
    const trip = await importSkill(running, folder(sources, "trip-check", "逐段核对站名与换乘"));
    await billSelects(running, [trip]);
    const stored = join(directory, "skill-library", trip, "1", "files", "references"), outside = join(sources, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "rules.md"), "trip-check rules\n");
    rmSync(stored, { recursive: true });
    symlinkSync(outside, stored);

    await running.post("/api/fixture/inbound", groupMessage("om_skill_link", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"),
      { modelReply: completedReply("规划周末一日行程"), ...readSkillFile("trip-check", "references/rules.md") }));
    const result = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    const reads = result.fixtureToolResults!.filter(({ tool }) => tool === "read_skill_file").map(({ success, result: read }) => ({ success, read }));
    const reported = running.output().split("\n").filter((line) => line.includes("skill_file_integrity_failed"));
    console.log(JSON.stringify({ kind: "skill_file_integrity_main", commands: ["import trip-check", "Bill 能力档 1 selects trip-check", "replace stored references/ by a link", "请帮我规划周末一日行程"], reads, reported }));
    expect(reads).toEqual([{ success: false, read: { ok: false, error: { code: "skill_file_unavailable", message: "这个文件现在读不了。", retryable: false } } }]);
    expect(reported).toEqual([`skill_file_integrity_failed:${trip}`]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(sources, { recursive: true, force: true }); }
}, 60000);

// Unchecking every dispatch group turns dispatch off at the next start and leaves the teams stored for when it is enabled again
// (agent-console::US-009). No team management and no dispatch run meanwhile: the library reads which profiles select a skill
// from the stored definitions, and removes no version, because the requests that may need one cannot be read.
it("keeps what stored teams and requests need of the library while the service runs without dispatch, and removes what nothing needs once dispatch is back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-library-off-")), sources = realpathSync(mkdtempSync(join(tmpdir(), "skill-library-sources-")));
  let running: Running | undefined;
  const versions = (skill: string) => readdirSync(join(directory, "skill-library", skill)).sort();
  const dispatchGroups = async (service: Running, groups: string[]) => {
    const form = await service.get<{ basedOn: string }>("/api/teams/dispatch-groups");
    await service.post("/api/teams/dispatch-groups", { groups, basedOn: form.basedOn });
  };
  const reimport = async (service: Running, skill: string) => {
    const { state } = (await service.get<SkillsView>("/api/skills")).skills.find(({ id }) => id === skill)!;
    await service.post(`/api/skills/${skill}/reimport`, { confirmed: state.fingerprint });
  };
  try {
    dispatchConfig(directory);
    running = await start(directory);
    const source = folder(sources, "trip-check", "逐段核对站名与换乘");
    const trip = await importSkill(running, source);
    await billSelects(running, [trip]);
    await running.post("/api/fixture/inbound", groupMessage("om_off_first", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelReply: failedReply("规划周末一日行程") }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed");
    writeFileSync(join(source, "SKILL.md"), skillMd("trip-check", "逐段核对站名与换乘", "body-v2"));
    await reimport(running, trip);
    expect(versions(trip)).toEqual(["1", "2"]);
    // The owner unchecks every dispatch group and restarts: dispatch is off.
    await dispatchGroups(running, []);
    await running.close(); running = undefined;

    running = await start(directory);
    expect(await running.get("/api/teams")).toEqual({ configured: false });
    // The failed request's version is still there, and Bill's stored profile still counts as a use.
    expect(versions(trip)).toEqual(["1", "2"]);
    expect((await running.get<SkillsView>("/api/skills")).skills.map(({ id, usedBy }) => [id, usedBy])).toEqual([[trip, [BILL_USE]]]);
    expect(await running.send(`/api/skills/${trip}/delete`, {})).toEqual({ status: 409, body: { error: "被 1 个能力档使用。先在团队管理解绑，才能删除。", refusal: { kind: "in_use", uses: 1 } } });
    // A re-import while dispatch is off adds its version and removes none.
    writeFileSync(join(source, "SKILL.md"), skillMd("trip-check", "逐段核对站名与换乘", "body-v3"));
    await reimport(running, trip);
    expect(versions(trip)).toEqual(["1", "2", "3"]);
    // The owner checks the group again and restarts: dispatch is back, with the stored teams.
    await dispatchGroups(running, ["oc_alpha"]);
    await running.close(); running = undefined;

    running = await start(directory);
    // The start knows again what is needed: version 1 for the failed request, version 3 for Bill's profile, which followed the
    // re-import made while dispatch was off. Nothing names version 2 any more.
    await vi.waitFor(() => expect(versions(trip)).toEqual(["1", "3"]), { timeout: processWaitLimitMs, interval: 50 });
    await running.post("/api/fixture/inbound", retry("om_off_retry", failed.agentDispatch!.jobs[0]!.id, "规划周末一日行程"));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    await running.post("/api/fixture/inbound", groupMessage("om_off_second", "再帮我规划周日行程", decision("bill", "规划周日行程"), { modelReply: completedReply("规划周日行程") }));
    const result = await running.until((state) => state.agentDispatch?.jobs[1]?.status === "completed");
    console.log(JSON.stringify({ kind: "skill_library_dispatch_off", commands: ["import trip-check", "Bill 能力档 1 selects trip-check", "请帮我规划周末一日行程", "re-import", "uncheck every dispatch group, restart",
      "delete trip-check (refused)", "re-import", "check oc_alpha, restart", "重试", "再帮我规划周日行程"], jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes,
      executorSkills: result.fixtureModelRequests?.map(({ skills }) => skills?.map(({ skillMd: text }) => text.trim().split("\n").at(-1))) }));
    // The retried request's Executor got the version it was admitted with, and the new request's the one imported while dispatch was off.
    expect(result.fixtureModelRequests!.map(({ skills }) => skills!.map(({ folder: id, skillMd: text }) => [id, text]))).toEqual([
      [[trip, skillMd("trip-check", "逐段核对站名与换乘", "body-v1")]], [[trip, skillMd("trip-check", "逐段核对站名与换乘", "body-v3")]]]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(sources, { recursive: true, force: true }); }
}, 120000);

// A service that never had dispatch has no team registry file, and so no profile that could select a skill. One whose registry
// file cannot be opened does not need it to run either: it starts, and since it cannot tell the uses, it deletes no skill.
it("runs without dispatch with no team registry, where an unused skill can be deleted, and with one that cannot be opened, where none is deleted", async () => {
  const directory = mkdtempSync(join(tmpdir(), "skill-library-plain-")), sources = realpathSync(mkdtempSync(join(tmpdir(), "skill-library-sources-")));
  let running: Running | undefined;
  const listed = async (service: Running) => (await service.get<SkillsView>("/api/skills")).skills.map(({ id, usedBy }) => [id, usedBy]);
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("feishu")));
    running = await start(directory);
    expect(await running.get("/api/teams")).toEqual({ configured: false });
    expect(existsSync(join(directory, "team-registry.sqlite"))).toBe(false);
    const trip = await importSkill(running, folder(sources, "trip-check", "逐段核对站名与换乘"));
    const meal = await importSkill(running, folder(sources, "meal-plan", "按预算安排菜单"));
    expect(await listed(running)).toEqual([[meal, []], [trip, []]]);
    expect(await running.send(`/api/skills/${trip}/delete`, {})).toMatchObject({ status: 200, body: { deleted: trip } });
    expect(await listed(running)).toEqual([[meal, []]]);
    await running.close(); running = undefined;

    // A registry file that is not a database, as a damaged one is.
    writeFileSync(join(directory, "team-registry.sqlite"), "not a database");
    running = await start(directory);
    expect(running.output()).toContain("skill_library_stored_teams_unreadable");
    // The page shows what it shows for an unused skill; the deletion is what is refused.
    expect(await listed(running)).toEqual([[meal, []]]);
    expect(await running.send(`/api/skills/${meal}/delete`, {})).toEqual({ status: 409,
      body: { error: "读不了已保存的团队配置，无法确认是否还有能力档在使用它，暂时不能删除。", refusal: { kind: "uses_unknown" } } });
    expect(await listed(running)).toEqual([[meal, []]]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(sources, { recursive: true, force: true }); }
}, 60000);
