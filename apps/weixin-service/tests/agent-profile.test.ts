import { describe, expect, it } from "vitest";
import { effectiveHostTools, memoryAccountId, ProfileToolHost, resolveAgentProfile } from "../src/agent-profile.js";
import type { TeamDefinitions } from "../src/team-registry.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { WorkflowToolHost, type TrustedWorkflowTurn, type WorkflowToolRequest } from "../src/workflow-tool-host.js";
import { PRODUCTION_TOOL_IDS } from "./support/production-tools.js";

// Resolution and host-tool boundary seams. The shared host is the real WorkflowToolHost over the production catalog,
// with its gateway and inline executor injected as in workflow-tool-host.test.ts. Executor wiring in real main is in agent-dispatch.integration.test.ts,
// which also drives main's Coordinator wiring: its runtime and tools in "builds the Coordinator's and the Team Leader's runtimes …", and its
// memory scope in "gives the Coordinator the group memory, …".
const definitions: TeamDefinitions = {
  coordinator: { id: "sam", name: "Sam", teamName: "总协调", responsibility: "协调", appId: "cli_0123456789abcdef",
    profile: { instructions: "协调规则", hostTools: ["files.read"] } },
  dispatchGroups: ["oc_alpha"],
  teams: [{ id: "bill", teamName: "生活团队", responsibility: "生活", leader: { name: "Bill", appId: "cli_2222222222222222", profile: { instructions: "负责人规则", hostTools: ["files.write"] } },
    executorProfiles: [{ id: "executor-1", name: "能力档 1", instructions: "行程规则", hostTools: ["files.write", "files.read", "unknown.tool"] }],
    bindings: [{ chatId: "oc_alpha", state: "accepting" }] }],
};
const trusted: TrustedWorkflowTurn = { eventKey: "event-1", accountId: "account-1", target: "target-1", occurredAt: 1_788_200_000_000, originalTextRef: "text-ref-1", attachmentRefs: [] };
function sharedHost() {
  const reached: string[] = [];
  const catalog = createProductionWorkflowToolCatalog({ files: false, media: true, directFiles: true, delivery: true, schedules: true });
  const host = new WorkflowToolHost(catalog, { submit: async () => { throw new Error("gateway_not_expected"); } },
    { execute: async (request: WorkflowToolRequest) => { reached.push(request.toolId); return { entries: [] }; } });
  return { catalog, host, reached };
}
const offered = (tools: ProfileToolHost) => tools.definitions().flatMap((namespace) => "tools" in namespace ? namespace.tools.map(({ name }) => `${namespace.name}.${name}`) : []);

describe("agent profile resolution", () => {
  it.each([
    ["the Coordinator with no host tools and the group memory, even when its profile lists tools", { role: "coordinator" } as const, PRODUCTION_TOOL_IDS,
      { instructions: "协调规则", hostTools: [], memoryScope: { kind: "group" } }],
    ["a Team Leader with its own instructions, no host tools and its own memory, even when its profile lists tools", { role: "leader", teamId: "bill" } as const, PRODUCTION_TOOL_IDS,
      { instructions: "负责人规则", hostTools: [], memoryScope: { kind: "leader", teamId: "bill" } }],
    ["an Executor's host tools as its allowlist intersected with the catalog, and its profile's memory", { role: "executor", teamId: "bill", profileId: "executor-1" } as const,
      ["files.read", "schedules.create", "files.write"], { instructions: "行程规则", hostTools: ["files.read", "files.write"], memoryScope: { kind: "profile", teamId: "bill", profileId: "executor-1" } }],
  ])("resolves %s", (_case, agent, catalog, expected) => {
    expect(resolveAgentProfile(definitions, agent, catalog)).toEqual(expected);
  });

  it.each([["an unknown team", "nobody", "executor-1"], ["an unknown Executor profile", "bill", "missing"]])("refuses %s", (_case, teamId, profileId) => {
    expect(() => resolveAgentProfile(definitions, { role: "executor", teamId, profileId }, PRODUCTION_TOOL_IDS)).toThrow(/^agent_profile_unknown$/);
  });
});

describe("agent memory accounts", () => {
  const leader = (teamId: string) => ({ kind: "leader", teamId }) as const;
  const profile = (teamId: string, profileId: string) => ({ kind: "profile", teamId, profileId }) as const;
  it("keeps the group memory in the group's own account", () => {
    expect(memoryAccountId("feishu.group.a", { kind: "group" })).toBe("feishu.group.a");
  });

  it.each([
    ["the same leader in the same group", true, ["feishu.group.a", leader("alice")], ["feishu.group.a", leader("alice")]],
    ["the same profile in the same group", true, ["feishu.group.a", profile("alice", "executor-1")], ["feishu.group.a", profile("alice", "executor-1")]],
    ["one leader in two groups", false, ["feishu.group.a", leader("alice")], ["feishu.group.b", leader("alice")]],
    ["two leaders in one group", false, ["feishu.group.a", leader("alice")], ["feishu.group.a", leader("bill")]],
    ["one profile in two groups", false, ["feishu.group.a", profile("alice", "executor-1")], ["feishu.group.b", profile("alice", "executor-1")]],
    ["two teams' profiles with the same profile ID", false, ["feishu.group.a", profile("alice", "executor-1")], ["feishu.group.a", profile("bill", "executor-1")]],
    ["two profiles of one team", false, ["feishu.group.a", profile("alice", "executor-1")], ["feishu.group.a", profile("alice", "writer")]],
    ["a leader and its team's profile", false, ["feishu.group.a", leader("alice")], ["feishu.group.a", profile("alice", "executor-1")]],
  ] as const)("gives %s a shared account: %s", (_case, same, left, right) => {
    const [a, b] = [memoryAccountId(left[0], left[1]), memoryAccountId(right[0], right[1])];
    for (const account of [a, b]) expect(account).toMatch(/^feishu\.dispatch\.[0-9a-f]{64}$/);
    expect(a === b).toBe(same);
    expect([a, b]).not.toContain(left[0]);
    expect([a, b]).not.toContain(right[0]);
  });
});

describe("profile tool host", () => {
  it("offers only the allowed tools and refuses another call before the shared host", async () => {
    const { catalog, host, reached } = sharedHost();
    const tools = new ProfileToolHost(host, catalog, ["files.find", "schedules.list"]);
    expect(offered(tools)).toEqual(["files.find", "schedules.list"]);
    const binding = host.bind("profile-thread", trusted);
    try {
      const refused = await tools.execute("read", { fileRef: "file-ref" }, { threadId: "profile-thread", turnId: "turn", namespace: "files" });
      expect(JSON.parse(refused.contentItems[0]!.text)).toEqual({ ok: false, error: { code: "agent_profile_tool_refused", retryable: false, action: "stop" } });
      expect(reached).toEqual([]);
      await tools.execute("find", { kind: "file", limit: 1 }, { threadId: "profile-thread", turnId: "turn", namespace: "files" });
      expect(reached).toEqual(["files.find"]);
    } finally { await binding.release(); }
  });

  it("keeps the shared contract hash when every tool is allowed and changes it when narrowed", () => {
    const { catalog, host } = sharedHost();
    expect(new ProfileToolHost(host, catalog, PRODUCTION_TOOL_IDS).contractHash()).toBe(host.contractHash());
    expect(new ProfileToolHost(host, catalog, PRODUCTION_TOOL_IDS.filter((id) => id !== "files.edit")).contractHash()).not.toBe(host.contractHash());
  });
});

// team-management::US-003/AC-02: the effective tools are the checked tools intersected with module permissions. The expected
// tables come from the gates themselves, enumerated in docs/.workings/agent-teams/ticket-11-logs/tool-permission-gates.log:
// find, grep, read and send_files need read; write needs write; edit needs read and write on one scope; media.send and the
// schedule tools have no module gate.
describe("effective host tools", () => {
  const READ = ["files.find", "files.grep", "files.read", "weixin.send_files"];
  const UNGATED = ["media.send", "schedules.create", "schedules.delete", "schedules.disable", "schedules.edit", "schedules.enable", "schedules.inspect",
    "schedules.list", "schedules.read_text", "schedules.retry_news", "schedules.run_now"];
  it.each([
    ["no saved scope", [], UNGATED, [...READ, "files.write", "files.edit"]],
    ["a read-only scope", [{ read: true, write: false }], [...READ, ...UNGATED], ["files.write", "files.edit"]],
    ["a write-only scope", [{ read: false, write: true }], ["files.write", ...UNGATED], [...READ, "files.edit"]],
    ["a read-only scope and a write-only scope", [{ read: true, write: false }, { read: false, write: true }], [...READ, "files.write", ...UNGATED], ["files.edit"]],
    ["a read-and-write scope", [{ read: true, write: true }], PRODUCTION_TOOL_IDS, []],
  ] as const)("with %s offers exactly the granted checked tools", (_case, scopes, offeredTools, ungranted) => {
    const result = effectiveHostTools(PRODUCTION_TOOL_IDS, scopes);
    expect([[...result.offered].sort(), [...result.ungranted].sort()]).toEqual([[...offeredTools].sort(), [...ungranted].sort()]);
  });

  it("offers nothing that is not checked, and treats a tool with no known gate as not granted", () => {
    expect(effectiveHostTools(["files.read", "unknown.tool"], [{ read: true, write: true }])).toEqual({ offered: ["files.read"], ungranted: ["unknown.tool"] });
  });
});

// agent-dispatch::REQ-017/AC-02: a host tool removed from a profile's allowlist is refused at the next call, also in a request
// admitted before the removal, and the refused call is audited.
describe("revocation at the profile tool boundary", () => {
  it("refuses a call once its tool leaves the profile's current allowlist, and every call once the profile is gone", async () => {
    const { catalog, host, reached } = sharedHost();
    let current: readonly string[] | undefined = ["files.find", "files.read"];
    const refused: string[] = [];
    const tools = new ProfileToolHost(host, catalog, ["files.find", "files.read"], { current: () => current, refused: (tool) => refused.push(tool) });
    const binding = host.bind("revocation-thread", trusted);
    const call = (tool: string, args: unknown) => tools.execute(tool, args, { threadId: "revocation-thread", turnId: "turn", namespace: "files" });
    const code = (result: Awaited<ReturnType<typeof call>>) => result.success === false ? JSON.parse(result.contentItems[0]!.text).error.code : "reached";
    try {
      expect(code(await call("find", { kind: "file", limit: 1 }))).toBe("reached");
      current = ["files.find"];
      expect(code(await call("read", { fileRef: "file-ref" }))).toBe("agent_profile_tool_refused");
      current = undefined;
      expect(code(await call("find", { kind: "file", limit: 1 }))).toBe("agent_profile_tool_refused");
      expect([reached, refused]).toEqual([["files.find"], ["files.read", "files.find"]]);
    } finally { await binding.release(); }
  });
});

