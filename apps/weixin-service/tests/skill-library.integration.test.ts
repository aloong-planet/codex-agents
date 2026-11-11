import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { processWaitLimitMs } from "./support/process-wait.js";
import { decision, dispatchConfig, groupMessage, start, type State } from "./support/real-main.js";

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
    const view = await running.get<TeamView>("/api/teams");
    const bill = view.teams.find(({ id }) => id === "bill")!;
    await running.post("/api/teams/save", { basedOn: view.version, team: { id: "bill", teamName: bill.teamName, responsibility: bill.responsibility, leader: bill.leader,
      groups: bill.bindings.map(({ chatId }) => chatId),
      executorProfiles: bill.profiles.map(({ id, name, noun, instructions, hostTools }) => ({ id, name, noun, instructions, hostTools, skills: [trip] })) } });
    expect((await running.get<SkillsView>("/api/skills")).skills.map(({ id, usedBy }) => [id, usedBy])).toEqual([[meal, []], [trip, [{ teamId: "bill", leader: "Bill", teamName: "生活团队", profile: "能力档 1" }]]]);

    await running.post("/api/fixture/inbound", groupMessage("om_skill_first", "请帮我规划周末一日行程", decision("bill", "规划周末一日行程"), { modelReply: failedReply("规划周末一日行程") }));
    const failed = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "failed");
    // Its runtime was released: the home was compacted to its rollout, and the skills went with everything else (ADR-0031).
    const runtimes = join(directory, "group-model-runtimes");
    const home = () => readdirSync(runtimes).filter((name) => /^dispatch-[0-9a-f]{64}$/u.test(name)).map((name) => join(runtimes, name, "codex-home"));
    await vi.waitFor(() => { expect(home()).toHaveLength(1); expect(readdirSync(home()[0]!)).toEqual(["sessions"]); }, { timeout: processWaitLimitMs, interval: 50 });

    // The owner edits the folder and imports it again while that request can still be retried.
    writeFileSync(join(tripSource, "SKILL.md"), skillMd("trip-check", "逐段核对站名、换乘与开放时间", "body-v2"));
    const changed = (await running.get<SkillsView>("/api/skills")).skills.find(({ id }) => id === trip)!.state;
    expect(changed.state).toBe("changed");
    await running.post(`/api/skills/${trip}/reimport`, { confirmed: changed.fingerprint });
    // The failed request can still be retried, so the version it was admitted with stays stored beside the new one.
    expect(readdirSync(join(directory, "skill-library", trip)).sort()).toEqual(["1", "2"]);

    await running.post("/api/fixture/inbound", groupMessage("om_skill_retry", "重试", { kind: "retry", agentId: null, requestId: failed.agentDispatch!.jobs[0]!.id, summary: "", message: "" },
      { modelReply: completedReply("规划周末一日行程") }));
    await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed");
    await running.post("/api/fixture/inbound", groupMessage("om_skill_second", "再帮我规划周日行程", decision("bill", "规划周日行程"), { modelReply: completedReply("规划周日行程") }));
    const result = await running.until((state) => state.agentDispatch?.jobs[1]?.status === "completed");
    const audit = readFileSync(join(directory, "console-audit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(({ event }) => String(event).startsWith("skill_")).map(({ event, skill, version, by }) => ({ event, skill, version, by }));
    console.log(JSON.stringify({ kind: "skill_library_main", commands: ["import trip-check", "import meal-plan", "Bill 能力档 1 selects trip-check", "请帮我规划周末一日行程", "re-import trip-check", "重试", "再帮我规划周日行程"],
      jobs: result.agentDispatch, executorSkills: result.fixtureModelRequests?.map(({ skills }) => skills), leaderSkillLines: [skillLines(result, "请帮我规划周末一日行程"), skillLines(result, "再帮我规划周日行程")], audit }));

    // Each Executor turn, in order: the first attempt, its retry after the re-import, and the request admitted afterwards.
    const loaded = (body: string, description: string) => [{ folder: trip, files: ["SKILL.md", "references/rules.md"], skillMd: skillMd("trip-check", description, body) }];
    expect(result.fixtureModelRequests!.map(({ skills }) => skills)).toEqual([loaded("body-v1", "逐段核对站名与换乘"), loaded("body-v1", "逐段核对站名与换乘"), loaded("body-v2", "逐段核对站名、换乘与开放时间")]);
    // Each of those turns carries the skill as an input item that names its SKILL.md in that home: the App Server only lists a
    // skill, and the item is what puts its text before the Executor's model (agent-dispatch::REQ-016/AC-04).
    const carried = result.fixtureModelRequests!.map(({ input }) => (input as Array<{ type: string; name?: string; path?: string }>).filter(({ type }) => type === "skill"));
    expect(carried.map((items) => items.map(({ name }) => name))).toEqual([["trip-check"], ["trip-check"], ["trip-check"]]);
    for (const [item] of carried) expect(item!.path).toMatch(new RegExp(`/group-model-runtimes/dispatch-[0-9a-f]{64}/codex-home/skills/${trip}/SKILL\\.md$`, "u"));
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
