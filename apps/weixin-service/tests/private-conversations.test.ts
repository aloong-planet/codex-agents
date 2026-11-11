import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DispatchRecord } from "../src/agent-dispatch.js";
import { chatAgent, chatRecords, type CoordinatorRequestView, PrivateChatError, PrivateConversations, privateTurnInput, type PrivateReplier, type PrivateTurnInput } from "../src/private-conversations.js";
import type { TeamDefinitions } from "../src/team-registry.js";
import { closeDispatches, definitions, dispatchOn, event, one, scripted } from "./support/dispatch-records.js";

// The owner's private conversations (agent-console::US-006, REQ-002/AC-03, CON-002) at their public interface: who can be chatted
// with, which requests each selector lists, what each agent's reply turn is given, and how a message and its reply are kept.
// Requests are durable records a real AgentDispatch wrote (support/dispatch-records.ts). The reply turn is the model boundary: a
// replier passed in by the constructor stands in for it here. The production replier runs only in the opt-in real-model suite.

const directories: string[] = [];
const conversations: PrivateConversations[] = [];
afterEach(async () => {
  for (const opened of conversations.splice(0)) opened.close();
  await closeDispatches();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function directory() { const created = mkdtempSync(join(tmpdir(), "private-conversations-")); directories.push(created); return created; }

const scope = { groups: () => ["oc_alpha", "oc_beta"], owner: (senderId: string) => senderId === "ou_owner",
  chatIdOf: (_accountId: string, target: string) => target.startsWith("feishu.group.") ? target.slice("feishu.group.".length) : undefined };
const NAMES: Record<string, string> = { sam: "Sam", alice: "Alice", bill: "Bill" };
const names = { label: (id: string) => `#${id}`, group: (chatId: string) => ({ oc_alpha: "银河护卫队", oc_beta: "产品讨论组" }[chatId] ?? chatId), agent: (id: string) => NAMES[id] ?? id };

/**
 * Owner requests in oc_alpha: alice-lead, whose second part Bill takes as cross-team work; bill-own, Bill's alone; and requests
 * the selectors leave out: a member's, and one in a group the service does not dispatch in. Each is newer than the one before.
 */
async function requests(): Promise<DispatchRecord[]> {
  const dispatch = dispatchOn(directory(), scripted(), {
    plans: { "om_alice-lead:alice": { assignments: [one("整理文案")], decisions: [], help: [{ title: "自动上架脚本", brief: "只交付代码" }] },
      "om_alice-lead:bill": { assignments: [one("编写脚本")], decisions: [], help: [] } },
    placements: [{ part: 1, agentId: "bill", summary: "编写自动上架脚本" }] });
  await dispatch.start();
  const admitted: Array<[string, string, Record<string, unknown>]> = [["alice-lead", "oc_alpha", {}], ["bill-own", "oc_alpha", {}],
    ["alice-member", "oc_alpha", { senderId: "ou_member" }], ["alice-gamma", "oc_gamma", {}]];
  for (const [index, [key, chatId, extra]] of admitted.entries()) {
    dispatch.admit(event(key, chatId, { receivedAt: 1_700_000_000_000 + index * 1000, ...extra }));
    await vi.waitFor(() => expect(dispatch.records().find(({ job }) => job.id === key)?.job.status).toBe("completed"), { timeout: 5000, interval: 10 });
  }
  return dispatch.records();
}

describe("whom the owner can chat with", () => {
  // A team saved on 团队管理 whose application is not created yet and that is bound to no group.
  const dora = { id: "dora", teamName: "设计团队", responsibility: "视觉设计", leader: { name: "Dora", appId: "", method: "qr" as const, profile: { instructions: "只谈设计", hostTools: [] } },
    executorProfiles: [{ id: "executor-1", name: "海报", noun: "设计执行者", instructions: "", hostTools: [] }], bindings: [] };
  const defined: TeamDefinitions = { ...definitions, teams: [...definitions.teams, dora] };

  it("is the Coordinator and the Team Leader of each defined team, also before onboarding and while the team is being deleted", () => {
    expect(chatAgent(defined, "sam")).toMatchObject({ id: "sam", name: "Sam", role: "coordinator", responsibility: "协调、澄清和分派任务" });
    expect(chatAgent(defined, "alice")).toMatchObject({ id: "alice", name: "Alice", role: "leader", teamName: "运营团队", responsibility: "商品运营" });
    expect(chatAgent(defined, "eve")).toMatchObject({ name: "Eve", role: "leader" });
    expect(chatAgent(defined, "dora")).toMatchObject({ name: "Dora", role: "leader", instructions: "只谈设计" });
  });

  it.each(["penny", "执行者 1", "文案执行者", "alice-1:assignment:0:1", "executor-1", "unknown", ""])("is never %j", (agentId) => {
    expect(chatAgent(defined, agentId)).toBeUndefined();
  });
});

describe("the requests a conversation can select", () => {
  it("are every request of the owner for the Coordinator, and for a Team Leader those of the owner involving its team, newest first", async () => {
    const records = await requests();
    const ids = (agentId: string) => chatRecords(records, { id: agentId, role: agentId === "sam" ? "coordinator" : "leader" }, scope).map(({ job }) => job.id);
    expect(ids("sam")).toEqual(["bill-own", "alice-lead"]);
    expect(ids("alice")).toEqual(["alice-lead"]);
    // Bill holds only a cross-team Assignment of alice-lead.
    expect(ids("bill")).toEqual(["bill-own", "alice-lead"]);
    expect(ids("eve")).toEqual([]);
  });
});

describe("what a reply turn is given", () => {
  const conversation = { transcript: [{ from: "owner" as const, text: "上次说的文案呢" }, { from: "agent" as const, text: "在等 Alice 汇报" }], message: "进展如何？", selected: "alice-lead" };

  it("gives the Coordinator the state, teams and reports of the owner's requests, and never an Assignment, a Brief or an Executor's result", async () => {
    const records = await requests();
    const input = privateTurnInput(chatAgent(definitions, "sam")!, chatRecords(records, { id: "sam", role: "coordinator" }, scope), conversation, names);
    expect(input.transcript).toEqual(conversation.transcript);
    expect(input).toMatchObject({ message: "进展如何？", selected: "#alice-lead" });
    expect(input.requests.map((request) => request.id)).toEqual(["#bill-own", "#alice-lead"]);
    const lead = input.requests[1]!;
    expect(lead).toMatchObject({ group: "银河护卫队", summary: "alice-lead 的摘要", state: "completed", lead: "Alice", teams: ["Bill"] });
    expect(Object.keys(lead).sort()).toEqual(["group", "id", "lead", "reports", "state", "summary", "teams"]);
    // Every group post of the request, by who posted it, the cross-team closing included.
    const { reports } = lead as CoordinatorRequestView;
    expect(reports.map(({ from }) => from)).toEqual(["Alice", "Sam", "Bill", "Bill", "Alice"]);
    expect(reports.at(-1)!.text).toContain("ALICE_CLOSING");
    const text = JSON.stringify(input);
    // The Briefs the Executors got and their results stay out; so do the member's request and the one outside the dispatch groups.
    for (const absent of ["整理文案的交办", "编写脚本的交办", "已交付", "assignments", "alice-member", "alice-gamma"]) expect(text).not.toContain(absent);
  });

  it("gives a Team Leader its own team's Assignments with results and its own posts, and the lead the reports other teams sent back", async () => {
    const records = await requests();
    const input = (agentId: string) => privateTurnInput(chatAgent(definitions, agentId)!, chatRecords(records, { id: agentId, role: "leader" }, scope), conversation, names);
    const alice = input("alice").requests.find(({ id }) => id === "#alice-lead") as Record<string, unknown>;
    expect(alice).toMatchObject({ message: "alice-lead 的原始消息", summary: "alice-lead 的摘要", state: "completed", lead: "Alice",
      assignments: [{ title: "整理文案", executor: "文案执行者 1", profile: "商品文案", status: "completed", result: "整理文案：已交付" }] });
    expect((alice.posts as string[]).at(-1)).toContain("ALICE_CLOSING");
    expect(alice.reports).toEqual([{ team: "Bill", text: expect.stringContaining("BILL_CLOSING") }]);
    expect(JSON.stringify(alice)).not.toContain("编写脚本");
    const bill = input("bill").requests.find(({ id }) => id === "#alice-lead") as Record<string, unknown>;
    expect(bill).toMatchObject({ lead: "Alice", assignments: [{ title: "编写脚本", result: "编写脚本：已交付" }] });
    expect(bill.reports).toBeUndefined();
    expect(JSON.stringify(bill)).not.toMatch(/整理文案|ALICE_CLOSING/u);
  });

  it("keeps the selected request when the owner has more requests than a turn shows, and bounds the transcript to the latest messages", async () => {
    const records = await requests();
    const many = [...Array.from({ length: 25 }, (_, index) => ({ ...records.find(({ job }) => job.id === "bill-own")!, chatId: "oc_alpha",
      job: { ...records.find(({ job }) => job.id === "bill-own")!.job, id: `newer-${index}` } })),
    ...chatRecords(records, { id: "sam", role: "coordinator" }, scope)];
    const transcript = Array.from({ length: 30 }, (_, index) => ({ from: "owner" as const, text: `第 ${index} 条` }));
    const input = privateTurnInput(chatAgent(definitions, "sam")!, many, { transcript, message: "看看商品 D", selected: "alice-lead" }, names);
    expect(input.requests).toHaveLength(21);
    expect(input.requests.at(-1)!.id).toBe("#alice-lead");
    expect(input.transcript.map(({ text }) => text)).toEqual(Array.from({ length: 20 }, (_, index) => `第 ${index + 10} 条`));
  });
});

describe("a conversation", () => {
  /** A replier whose replies the case releases one at a time, recording every input. */
  function heldReplier() {
    const inputs: PrivateTurnInput[] = [];
    const releases: Array<(output: string | Error) => void> = [];
    const replier: PrivateReplier = { reply: (input) => {
      inputs.push(input);
      return new Promise<string>((resolve, reject) => { releases.push((output) => typeof output === "string" ? resolve(output) : reject(output)); });
    } };
    return { replier, inputs, release: (output: string | Error) => releases.shift()!(output) };
  }
  function open(path: string, replier: PrivateReplier, records: readonly DispatchRecord[] = []) {
    const opened = new PrivateConversations(join(path, "private-conversations.sqlite"), { definitions: () => definitions, records: () => records, scope, replier,
      names: { label: names.label, agent: names.agent, groups: async () => ({ oc_alpha: "银河护卫队" }) }, now: () => 1_700_000_000_000 });
    conversations.push(opened);
    return opened;
  }
  const states = (chat: PrivateConversations, agentId: string) => chat.view(agentId)!.messages.map(({ role, text, state, reason }) => ({ role, text, state, reason }));

  it("stores the owner's message, answers it with one reply turn at a time, and gives the next turn the conversation so far", async () => {
    const { replier, inputs, release } = heldReplier();
    const chat = open(directory(), replier);
    expect(chat.send("alice", { text: "  你好，Alice  " })).toMatchObject({ agent: { id: "alice", name: "Alice" }, pending: true,
      messages: [{ role: "owner", text: "你好，Alice", requestId: null, state: "pending" }] });
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    // While a reply is pending, the conversation takes no other message; other conversations are not held up.
    expect(() => chat.send("alice", { text: "还在吗" })).toThrow(expect.objectContaining({ status: 409 }));
    expect(chat.send("sam", { text: "Sam 在吗" }).pending).toBe(true);
    release(JSON.stringify({ message: "  **你好**，我是 Alice。  " }));
    await vi.waitFor(() => expect(chat.view("alice")!.pending).toBe(false));
    expect(states(chat, "alice")).toEqual([{ role: "owner", text: "你好，Alice", state: "answered", reason: undefined },
      { role: "agent", text: "**你好**，我是 Alice。", state: undefined, reason: undefined }]);
    expect(states(chat, "sam")).toEqual([{ role: "owner", text: "Sam 在吗", state: "pending", reason: undefined }]);

    chat.send("alice", { text: "今天的安排？" });
    await vi.waitFor(() => expect(inputs).toHaveLength(3));
    expect(inputs[2]).toMatchObject({ message: "今天的安排？", transcript: [{ from: "owner", text: "你好，Alice" }, { from: "agent", text: "**你好**，我是 Alice。" }] });
    expect(inputs[1]).toMatchObject({ agent: { id: "sam" }, message: "Sam 在吗", transcript: [] });
  });

  it("says why a reply did not come, and leaves a reply the service stopped during interrupted and not run again", async () => {
    const path = directory(), { replier, release } = heldReplier();
    const chat = open(path, replier);
    for (const [message, output, reason] of [["写个总结", "这不是 JSON", "回复格式无效"], ["再写一次", JSON.stringify({ message: "   " }), "回复格式无效"],
      ["换个说法", new Error("dispatch_model_unavailable"), "模型暂时不可用"], ["还是不行", new Error("app_server_closed"), "运行出错"]] as const) {
      chat.send("bill", { text: message });
      await vi.waitFor(() => expect(chat.view("bill")!.messages.at(-1)!.state).toBe("pending"));
      release(output);
      await vi.waitFor(() => expect(chat.view("bill")!.messages.at(-1)).toMatchObject({ role: "owner", text: message, state: "failed", reason }));
    }
    chat.send("bill", { text: "最后一条" });
    chat.close();
    const restarted = heldReplier(), reopened = open(path, restarted.replier);
    expect(reopened.view("bill")!.messages.at(-1)).toMatchObject({ text: "最后一条", state: "interrupted" });
    expect(reopened.view("bill")!.pending).toBe(false);
    expect(restarted.inputs).toHaveLength(0);
  });

  it("refuses anyone but the Coordinator and the Team Leaders, an empty or too long message and a request the agent's selector does not list, storing nothing", async () => {
    const records = await requests();
    const { replier, inputs } = heldReplier();
    const chat = open(directory(), replier, records);
    for (const agentId of ["penny", "执行者 1", "unknown"]) {
      expect(chat.view(agentId)).toBeUndefined();
      expect(() => chat.send(agentId, { text: "你好" })).toThrow(new PrivateChatError(404, "只能与 Sam 和各团队负责人私聊"));
    }
    expect(() => chat.send("alice", { text: "   " })).toThrow(expect.objectContaining({ status: 400, message: "消息不能为空" }));
    expect(() => chat.send("alice", { text: "长".repeat(4001) })).toThrow(expect.objectContaining({ status: 400 }));
    // bill-own does not involve Alice; a member's request is nobody's to select.
    for (const requestId of ["bill-own", "alice-member", 42]) {
      expect(() => chat.send("alice", { text: "这个呢", requestId })).toThrow(expect.objectContaining({ status: 400, message: "这项事务不在可关联的事务里，请重新选择。" }));
    }
    expect(chat.view("alice")).toMatchObject({ messages: [], requests: ["alice-lead"] });
    expect(chat.send("alice", { text: "长".repeat(4000), requestId: "alice-lead" }).messages).toEqual([expect.objectContaining({ requestId: "alice-lead", state: "pending" })]);
    await vi.waitFor(() => expect(inputs).toHaveLength(1));
    expect(inputs[0]!.selected).toBe("#alice-lead");
  });
});
