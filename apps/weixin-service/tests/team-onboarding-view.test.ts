// What the 团队管理 page's onboarding block shows for a team (team-management::US-002/AC-01, AC-03, AC-04, AC-06 to AC-09), as the
// page's own script decides it: src/public/console/team-onboarding-view.js, a classic script that publishes itself on globalThis
// and is imported here for that effect.
// Where the expected texts come from: the team management spec and the prototype the owner confirmed, except five that neither
// holds. Those five are the page's wording as it was before QR creation, pinned here so that moving the rules did not change
// it: the note for a missing App Secret, and the joining notes for a pending approval, a refused add, a bot that is not in the
// group afterwards, and a group that has not been tried.
// That the page draws what these rules return, as text, and sends what its buttons promise is covered by e2e/team-management.spec.ts.
import { describe, expect, it } from "vitest";
import "../src/public/console/team-onboarding-view.js";

type Outcome = { status: string; reason?: string };
/** A team of the service's view, with the fields the onboarding block reads; an outcome that was not recorded is absent or undefined. */
type Team = { id: string; teamName: string; method: "qr" | "existing"; leader: { name: string; appId: string };
  creation?: { status: string; reason?: string; appId?: string; codeExpiresAt?: number } | undefined; configure?: Outcome | undefined; publish?: Outcome | undefined;
  credentials?: Outcome | undefined; bindings: Array<{ chatId: string; state: string; join?: Outcome }>; tests: Record<string, { status: string }>; testMessage: string };
type Row = { group: string; state: string; note: string };
type Shown = { qr: boolean; area: null | { created: string } | { image: boolean; box: string | null; text: string; refresh: "plain" | "main" | null };
  steps: Array<{ state: string; title: string; note: string; rows: Row[] }>; recheck: boolean; test: boolean; confirm: string | null };
const { onboardingView } = (globalThis as unknown as { TeamOnboardingView: {
  onboardingView(input: { fixed: boolean; team?: Team; method: "qr" | "existing"; groups: Array<{ chatId: string; name: string }>; confirming: boolean }): Shown } }).TeamOnboardingView;

const GROUPS = [{ chatId: "oc_alpha", name: "银河护卫队" }, { chatId: "oc_beta", name: "产品讨论组" }];
const CREATED_APP = "cli_c0de000000000001";
const DONE = { status: "done" };
/** Daisy's team as the service reports it once the scan has created its application and every step is done. */
const daisy = (changes: Partial<Team> = {}): Team => ({ id: "team-1", teamName: "设计团队", method: "qr", leader: { name: "Daisy", appId: CREATED_APP },
  creation: { status: "done", appId: CREATED_APP }, configure: DONE, publish: DONE, credentials: DONE,
  bindings: [{ chatId: "oc_alpha", state: "accepting", join: DONE }, { chatId: "oc_beta", state: "accepting", join: DONE }],
  tests: {}, testMessage: "这是 Daisy（设计团队）的测试消息，用来确认可以在本群发言。", ...changes });
const show = (team: Team | undefined, changes: Partial<Parameters<typeof onboardingView>[0]> = {}) =>
  onboardingView({ fixed: false, ...(team ? { team } : {}), method: team?.method ?? "qr", groups: GROUPS, confirming: false, ...changes });
const step = (shown: Shown, title: string) => shown.steps.find((candidate) => candidate.title === title)!;
const TITLES = ["扫码创建应用", "配置权限与机器人能力", "发布版本", "校验凭证并读取机器人信息", "加入所绑定的群", "发送测试消息"];

describe("the QR area and the creation step", () => {
  const SCAN_NOTE = "用飞书扫码并确认，创建一个新的智能体应用；不会选中已有应用，凭证自动回填。";
  const EXPIRED = { image: false, box: "二维码已过期", text: "这个二维码已过期，或扫码没有完成。刷新后重新扫码即可，不会创建重复的应用。", refresh: "main" };
  const EXPIRED_NOTE = "二维码已过期，或扫码没有完成。请刷新二维码后重新扫码。";
  // Each team here still takes work with an application it had before, and has every later outcome recorded: until the scan
  // has created the new application, none of that is shown (US-002/AC-03).
  it.each([
    ["the code is being fetched", { status: "waiting" }, { image: false, box: "正在生成", text: "正在向飞书取二维码。", refresh: null }, "active", SCAN_NOTE],
    ["the code waits for its scan", { status: "waiting", codeExpiresAt: 601_000 },
      { image: true, box: null, text: "用飞书扫码，在手机上确认创建。创建完成后，App ID 与 App Secret 自动回填，你不需要复制任何凭证。", refresh: "plain" }, "active", SCAN_NOTE],
    ["the code ran out", { status: "action", reason: "expired" }, EXPIRED, "blocked", EXPIRED_NOTE],
    ["the owner declined on the phone", { status: "action", reason: "denied" }, EXPIRED, "blocked", EXPIRED_NOTE],
    ["Feishu refused the scan", { status: "action", reason: "failed" }, EXPIRED, "blocked", EXPIRED_NOTE],
    ["the connection dropped after the code was shown", { status: "action", reason: "connection_lost" }, EXPIRED, "blocked", EXPIRED_NOTE],
    ["the service restarted while the code waited", { status: "action", reason: "interrupted" }, EXPIRED, "blocked", EXPIRED_NOTE],
    ["the created application may not be used", { status: "action", reason: "unusable" }, EXPIRED, "blocked", EXPIRED_NOTE],
    ["Feishu gave no code", { status: "action", reason: "unreachable" },
      { image: false, box: "未取得二维码", text: "暂时连不上飞书，没有取得二维码。稍后点「刷新二维码」再试。", refresh: "main" }, "blocked", "暂时连不上飞书，没有取得二维码。稍后点「刷新二维码」。"],
  ])("when %s", (_case, creation, area, state, note) => {
    const shown = show(daisy({ creation, tests: { oc_alpha: { status: "accepted" } } }), { confirming: true });
    expect([shown.qr, shown.area, shown.steps.map(({ title }) => title)]).toEqual([true, area, TITLES]);
    expect(shown.steps.map(({ state: stepState, rows }) => [stepState, rows.map((row) => row.state)]))
      .toEqual([[state, []], ["todo", []], ["todo", []], ["todo", []], ["todo", ["todo", "todo"]], ["todo", []]]);
    expect([step(shown, "扫码创建应用").note, shown.recheck, shown.test, shown.confirm]).toEqual([note, false, false, null]);
  });

  it("shows the created application in place of the code once the scan has created it", () => {
    const shown = show(daisy());
    expect([shown.area, step(shown, "扫码创建应用").state, step(shown, "扫码创建应用").note, shown.recheck]).toEqual([{ created: CREATED_APP }, "done", SCAN_NOTE, true]);
  });

  // US-002/AC-06, AC-07: nothing is asked of Feishu before the save that chooses QR creation.
  it.each([
    ["a team that is not saved yet", undefined, "保存团队后，这里显示二维码；用飞书扫码即可创建应用。"],
    ["a team saved with an application, naming the application the scan will replace", daisy({ method: "existing", creation: undefined, leader: { name: "Daisy", appId: "cli_dddddddddddddddd" } }),
      "保存团队后，这里显示二维码；用飞书扫码即可创建应用。扫码创建的新应用会替换现在的应用 cli_dddddddddddddddd，替换后团队在各群重新接入。"],
  ])("promises the code after the save for %s", (_case, team, text) => {
    const shown = show(team, { method: "qr" });
    expect([shown.area, step(shown, "扫码创建应用").state, shown.recheck, shown.test]).toEqual([{ image: false, box: "保存后显示", text, refresh: null }, "todo", false, false]);
  });
});

describe("the steps of an application", () => {
  const CONFIGURE = "自动申请发送消息、读取群信息等所需权限，并开启机器人能力。";
  const PUBLISH = "自动提交发布，企业管理员审核通过后生效；管理员开启免审可跳过审核。";
  const LATER = "暂时连不上飞书，稍后点「重新检查」。";
  // US-002/AC-08: a refused automatic call says what to do by hand in the developer console.
  it.each([
    ["neither has run", undefined, undefined, ["todo", CONFIGURE], ["todo", PUBLISH]],
    ["both are done", DONE, DONE, ["done", CONFIGURE], ["done", PUBLISH]],
    ["the release awaits the admin's review", DONE, { status: "review", reason: "submitted" }, ["done", CONFIGURE], ["review", "已提交发布，等待企业管理员审核。审核通过后点「重新检查」。"]],
    ["Feishu refused the configuration", { status: "action", reason: "refused" }, undefined,
      ["blocked", "飞书没有接受自动配置。请在飞书开发者后台为这个应用开启机器人能力，并开通发送消息、读取群信息等权限，完成后点「重新检查」。"], ["todo", PUBLISH]],
    ["the configuration got no answer", { status: "action", reason: "unreachable" }, undefined, ["blocked", LATER], ["todo", PUBLISH]],
    ["Feishu refused the release", DONE, { status: "action", reason: "refused" }, ["done", CONFIGURE],
      ["blocked", "飞书没有接受自动提交发布。请在飞书开发者后台为这个应用创建版本并提交发布，完成后点「重新检查」。"]],
    ["the release got no answer", DONE, { status: "action", reason: "unreachable" }, ["done", CONFIGURE], ["blocked", LATER]],
  ])("shows steps 2 and 3 of a created application when %s", (_case, configure, publish, second, third) => {
    const shown = show(daisy({ configure, publish }));
    expect([[step(shown, "配置权限与机器人能力").state, step(shown, "配置权限与机器人能力").note], [step(shown, "发布版本").state, step(shown, "发布版本").note]]).toEqual([second, third]);
  });

  it.each([
    ["not checked yet", undefined, "todo", "确认凭证可用，读取机器人名称。"],
    ["done", DONE, "done", "确认凭证可用，读取机器人名称。"],
    ["waiting for the application to be enabled", { status: "review", reason: "not_enabled" }, "review", "应用版本尚未发布，或还没有被企业管理员启用。审核通过后点「重新检查」。"],
    ["refused for its credentials", { status: "action", reason: "bad_credentials" }, "blocked", "凭证校验没有通过：App ID 与 App Secret 不匹配。请替换 App Secret 后保存。"],
    ["missing its secret", { status: "action", reason: "secret_missing" }, "blocked", "还没有填写 App Secret。填写后保存，会自动开始检查。"],
    ["unanswered", { status: "action", reason: "unreachable" }, "blocked", LATER],
  ])("shows the credential check as %s", (_case, credentials, state, note) => {
    const checked = step(show(daisy({ credentials, bindings: [{ chatId: "oc_alpha", state: "onboarding" }] })), "校验凭证并读取机器人信息");
    expect([checked.state, checked.note]).toEqual([state, note]);
  });

  // US-002/AC-04: each group's row says why the bot is not in it, by the group's name.
  it.each([
    ["the bot is in the group", DONE, "done", "机器人已在群里。"],
    ["only the group's owner and admins may add members", { status: "action", reason: "owner_only" }, "blocked", "产品讨论组只允许群主和管理员添加成员，Sam 无法拉入。请在飞书调整群设置，或由群主手动添加。"],
    ["the group approves its members", { status: "action", reason: "pending_approval" }, "blocked", "产品讨论组开启了入群审批，Sam 的添加申请正等待群主或管理员批准；批准后点「重新检查」。"],
    ["Feishu refused the add", { status: "action", reason: "refused" }, "blocked", "飞书没有接受把机器人加入产品讨论组。请确认应用已开启机器人能力，再点「重新检查」。"],
    ["the bot is not in the group after the add", { status: "action", reason: "not_joined" }, "blocked", "机器人还不在产品讨论组里。请把机器人加入该群后点「重新检查」。"],
    ["the add got no answer", { status: "action", reason: "unreachable" }, "blocked", LATER],
    ["the group has not been tried", undefined, "todo", "尚未检查，可点「重新检查」。"],
  ])("shows a group's joining row when %s", (_case, join, state, note) => {
    const joining = step(show(daisy({ bindings: [{ chatId: "oc_alpha", state: "accepting", join: DONE }, { chatId: "oc_beta", state: "onboarding", ...(join ? { join } : {}) }] })), "加入所绑定的群");
    // With the other group joined, the step as a whole is in the state of this group's row.
    expect([joining.state, joining.note, joining.rows]).toEqual([state, "由 Sam 把机器人拉进每个绑定的群。",
      [{ group: "银河护卫队", state: "done", note: "机器人已在群里。" }, { group: "产品讨论组", state, note }]]);
  });

  it("waits with the groups until the credential check is done, leaves out a group the team is leaving, and asks for a group when none is checked", () => {
    const waiting = step(show(daisy({ credentials: { status: "action", reason: "bad_credentials" },
      bindings: [{ chatId: "oc_alpha", state: "onboarding" }, { chatId: "oc_beta", state: "draining", join: DONE }] })), "加入所绑定的群");
    expect([waiting.state, waiting.rows]).toEqual(["todo", [{ group: "银河护卫队", state: "todo", note: "等待前面的步骤完成。" }]]);
    const none = step(show(daisy({ bindings: [] })), "加入所绑定的群");
    expect([none.state, none.note, none.rows]).toEqual(["todo", "先在下面勾选所属群。", []]);
  });

  // A binding that accepts work without recorded checks, as one imported from the local configuration, has passed them.
  it("counts a team that accepts work in a group as checked and joined there", () => {
    const shown = show(daisy({ method: "existing", creation: undefined, configure: undefined, publish: undefined, credentials: undefined,
      bindings: [{ chatId: "oc_alpha", state: "accepting" }, { chatId: "oc_beta", state: "onboarding" }] }));
    expect([shown.qr, shown.area, shown.steps.map(({ title, state }) => [title, state])]).toEqual([false, null,
      [["校验凭证并读取机器人信息", "done"], ["加入所绑定的群", "todo"], ["发送测试消息", "todo"]]]);
    expect(step(shown, "加入所绑定的群").rows.map(({ state }) => state)).toEqual(["done", "todo"]);
  });

  // The editor's choice decides the block: a team saved in QR creation that is switched to an existing application shows the
  // three steps of one, before the save.
  it("shows three steps and no QR area once the editor chooses an existing application", () => {
    const shown = show(daisy(), { method: "existing" });
    expect([shown.qr, shown.area, shown.steps.map(({ title }) => title)]).toEqual([false, null, TITLES.slice(3)]);
  });

  it("shows Sam's steps as done in every dispatch group, with no action", () => {
    const shown = onboardingView({ fixed: true, method: "existing", groups: GROUPS, confirming: true });
    expect(shown.steps.map(({ title, state, rows }) => [title, state, rows])).toEqual([["校验凭证并读取机器人信息", "done", []],
      ["加入所绑定的群", "done", [{ group: "银河护卫队", state: "done", note: "机器人已在群里。" }, { group: "产品讨论组", state: "done", note: "机器人已在群里。" }]], ["发送测试消息", "done", []]]);
    expect([shown.qr, shown.area, shown.recheck, shown.test, shown.confirm]).toEqual([false, null, false, false, null]);
  });
});

// US-002/AC-09 and the owner's decision of 2026-11-11: the test message is offered where the team accepts work, sent only from
// the confirmation, and each group shows how its send ended.
describe("the test message", () => {
  const NOTE = "可选：向所绑定的群发一条测试消息，发送前需你确认；不发也不影响接单。";
  it.each([
    ["no message was sent", {}, "todo", []],
    ["every group accepted it", { oc_alpha: "accepted", oc_beta: "accepted" }, "done",
      [{ group: "银河护卫队", state: "done", note: "飞书已接收" }, { group: "产品讨论组", state: "done", note: "飞书已接收" }]],
    ["a send failed", { oc_alpha: "accepted", oc_beta: "failed" }, "blocked",
      [{ group: "银河护卫队", state: "done", note: "飞书已接收" }, { group: "产品讨论组", state: "blocked", note: "发送失败 · 不会自动重发" }]],
    ["a send's result is unknown", { oc_alpha: "unknown" }, "blocked", [{ group: "银河护卫队", state: "blocked", note: "发送结果未知 · 不会自动重发" }]],
    ["a send is under way", { oc_alpha: "failed", oc_beta: "sending" }, "active",
      [{ group: "银河护卫队", state: "blocked", note: "发送失败 · 不会自动重发" }, { group: "产品讨论组", state: "active", note: "正在发送" }]],
  ])("shows its step when %s", (_case, statuses, state, rows) => {
    const tested = step(show(daisy({ tests: Object.fromEntries(Object.entries(statuses).map(([chatId, status]) => [chatId, { status }])) })), "发送测试消息");
    expect([tested.state, tested.note, tested.rows]).toEqual([state, NOTE, rows]);
  });

  it("leaves out the result of a group the team is leaving", () => {
    const tested = step(show(daisy({ bindings: [{ chatId: "oc_alpha", state: "accepting", join: DONE }, { chatId: "oc_beta", state: "draining", join: DONE }],
      tests: { oc_alpha: { status: "accepted" }, oc_beta: { status: "failed" } } })), "发送测试消息");
    expect([tested.state, tested.rows]).toEqual(["done", [{ group: "银河护卫队", state: "done", note: "飞书已接收" }]]);
  });

  const MESSAGE = "「这是 Daisy（设计团队）的测试消息，用来确认可以在本群发言。」";
  it.each([
    ["one group", [{ chatId: "oc_alpha", state: "accepting", join: DONE }, { chatId: "oc_beta", state: "onboarding" }], `将以 Daisy（设计团队）的机器人向银河护卫队发一条测试消息，群里的成员都会看到：${MESSAGE}`],
    ["several groups", [{ chatId: "oc_alpha", state: "accepting", join: DONE }, { chatId: "oc_beta", state: "accepting", join: DONE }],
      `将以 Daisy（设计团队）的机器人向银河护卫队、产品讨论组各发一条测试消息，群里的成员都会看到：${MESSAGE}`],
  ])("is offered to a team that accepts work in %s, and confirmed with the groups and the exact text", (_case, bindings, confirm) => {
    expect([show(daisy({ bindings })).confirm, show(daisy({ bindings })).test, show(daisy({ bindings }), { confirming: true }).confirm]).toEqual([null, true, confirm]);
  });

  it("is not offered to a team that accepts work in no group, which can still be checked again", () => {
    const shown = show(daisy({ bindings: [{ chatId: "oc_alpha", state: "onboarding" }] }), { confirming: true });
    expect([shown.recheck, shown.test, shown.confirm]).toEqual([true, false, null]);
  });
});
