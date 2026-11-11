// Whole-application cases for file grants: a grant never reaches the service's own state, configuration and
// credentials, on any entry, nor a scope that is saved closed below it. Driven through the fixture Weixin and Feishu
// inbound routes of the real main process.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { config, decision, dispatchConfig, groupMessage, start, type State } from "./support/real-main.js";

it("protects main-owned state and configuration under broad grants and rechecks persisted group candidates", async () => {
  const business = mkdtempSync(join(tmpdir(), "channel-group-boundaries-"));
  const vault = join(business, "demo-vault"), directory = join(vault, "state");
  const ownerHome = join(vault, "owner-home"), futureHome = join(vault, "future-home");
  // The service's HOME and diagnostics directory also sit inside the grant, so the members derived from them are exercised.
  const userHome = join(vault, "user-home"), diagnostics = join(vault, "diagnostics");
  const channelPath = join(vault, "Boundary C.json");
  const pennyPath = join(vault, "Boundary D.json");
  for (const folder of [directory, ownerHome, futureHome, userHome, diagnostics, join(vault, ".obsidian")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(directory, "Boundary A.md"), "PRIVATE_STATE_SENTINEL");
  writeFileSync(join(ownerHome, "Boundary B.md"), "PRIVATE_CODEX_SENTINEL");
  writeFileSync(join(vault, "Boundary Z.md"), "PUBLIC_BUSINESS_SENTINEL");
  writeFileSync(pennyPath, '{"appSecret":"PRIVATE_PENNY_CONFIG_SENTINEL"}', { mode: 0o600 });
  writeFileSync(join(futureHome, "Candidate A.md"), "PREVIOUSLY_ALLOWED_CANDIDATE");
  writeFileSync(join(vault, "Candidate Z.md"), "BUSINESS_CANDIDATE");
  const configuration = config("weixin");
  writeFileSync(channelPath, JSON.stringify({ ...configuration, channel: undefined, enabledChannels: ["weixin", "feishu"],
    feishu: { ...configuration.feishu, groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_alice"] }] } }));
  const env = { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business, CHANNEL_CONFIG_PATH: channelPath, PENNY_CONFIG_PATH: pennyPath, CODEX_HOME: ownerHome,
    HOME: userHome, WEIXIN_OTEL_DIRECTORY: diagnostics };
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const send = (id: string, text: string, modelToolCalls?: unknown[], privateChat = false) => running!.post("/api/fixture/feishu/inbound", {
    event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: privateChat ? "ou_owner" : "ou_alice" } },
      message: { message_id: id, create_time: String(Date.now()), chat_id: privateChat ? "oc_private" : "oc_alpha",
        chat_type: privateChat ? "p2p" : "group", message_type: "text",
        mentions: privateChat ? [] : [{ key: "@_user_1", id: { open_id: "ou_fixturebot" }, name: "Agent" }],
        content: JSON.stringify({ text: privateChat ? text : `@_user_1 ${text}` }) } },
    ...(modelToolCalls ? { modelToolCalls } : {}),
  });
  const result = (call: number, path: (string | number)[]) => ({ $fixtureToolResult: { call, path } });
  const find = (query: string) => ({ namespace: "files", tool: "find", arguments: {
    scopeRefs: [{ $fixtureScopeLabel: "demo-vault" }], query, kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 20,
  } });
  const copyAndSend = (name: string) => [find("Boundary"),
    { namespace: "files", tool: "read", arguments: { fileRef: result(0, ["entries", 0, "fileRef"]) } },
    { namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath: name, content: result(1, ["content"]), overwrite: false } },
    { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [result(2, ["fileRef"])] } },
  ];
  try {
    running = await start(directory, env);
    await running.until((s) => s.channels?.feishu?.ready === true && s.codex.enabledTargets.length === 3);
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
    await send("om_private_boundary", "读取第一个 Boundary 文件并发回", copyAndSend("private-result.txt"), true);
    const personal = await running.until((s) => s.feishuFixtureTextOutbox?.at(-1)?.message === "文件已发送，请查收。");
    // The owner's private chat is held to the same boundary: the state, Codex home and both configuration files sort
    // before Boundary Z.md, so the first readable Boundary file is the business one.
    expect(personal.feishuFixtureMediaOutbox).toEqual([expect.objectContaining({ chatId: "oc_private", bytesBase64: Buffer.from("PUBLIC_BUSINESS_SENTINEL").toString("base64") })]);
    await send("om_group_boundary", "读取第一个 Boundary 文件并发回", copyAndSend("group-result.txt"));
    const group = await running.until((s) => s.feishuFixtureMediaOutbox?.length === 2 && s.feishuFixtureTextOutbox?.at(-1)?.message === "文件已发送，请查收。");
    expect(group.feishuFixtureMediaOutbox?.[1]).toMatchObject({ chatId: "oc_alpha", bytesBase64: Buffer.from("PUBLIC_BUSINESS_SENTINEL").toString("base64") });
    const groupRuntimes = readdirSync(join(directory, "group-model-runtimes")).filter((name) => name.startsWith("feishu.group."));
    expect(groupRuntimes).toHaveLength(1);
    const runtimeRoot = join(directory, "group-model-runtimes", groupRuntimes[0]!), skillRoots = [["workspace", ".agents", "skills"], ["codex-home", "skills"], ["home", ".agents", "skills"]];
    const protectedTargets = [...skillRoots.map((parts) => ["state", "group-model-runtimes", groupRuntimes[0]!, ...parts, "planted", "SKILL.md"].join("/")),
      "state/state.json", "owner-home/blocked.md", "Boundary C.json", "Boundary D.json",
      "user-home/.agents/skills/planted/SKILL.md", "user-home/Library/LaunchAgents/com.local.codex-weixin.plist", "diagnostics/planted.jsonl"];
    const stateFile = join(directory, "state.json"), stateBefore = existsSync(stateFile) ? readFileSync(stateFile) : undefined;
    // A fixture Weixin turn takes at most 16 tool calls, so each entry attempts the targets in two turns.
    const batches = [protectedTargets.slice(0, 7), protectedTargets.slice(7)].map((targets, batch) => targets.map((relativePath, offset) => ({ relativePath, index: batch * 7 + offset })));
    const protectedWrites = (chat: string, targets: Array<{ relativePath: string; index: number }>) => [
      ...targets.map(({ relativePath }) => ({ namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath, content: "planted", overwrite: false } })),
      ...targets.map(({ index }, call) => ({ namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" },
        relativePath: `denied-${chat}-${index}.txt`, content: result(call, ["error", "code"]), overwrite: false } })),
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: targets.map((_, call) => result(targets.length + call, ["fileRef"])) } },
    ];
    expect(batches.flat()).toHaveLength(protectedTargets.length);
    // The Weixin entry, as the project's Weixin regressions require: the same copy and the same protected writes.
    const weixinTurns: unknown[] = [];
    for (const [text, calls, sentNames] of [
      ["读取第一个 Boundary 文件并发回", copyAndSend("wx-private-result.txt"), ["wx-private-result.txt"]],
      ...batches.map((targets) => ["尝试写入受保护位置并返回结果", protectedWrites("weixin", targets), targets.map(({ index }) => `denied-weixin-${index}.txt`)] as const),
    ] as const) {
      const before = await running.state();
      await running.post("/api/fixture/workflow/inbound", { text, modelToolCalls: calls });
      const after = await running.until((s) => (s.weixinFixtureReplies?.length ?? 0) > (before.weixinFixtureReplies?.length ?? 0) &&
        (s.fixtureOutbox?.length ?? 0) === (before.fixtureOutbox?.length ?? 0) + sentNames.length);
      expect(after.weixinFixtureReplies?.at(-1)?.message).toBe("文件已发送，请查收。");
      expect(after.fixtureOutbox!.slice(before.fixtureOutbox?.length ?? 0).map((item) => item.fileName)).toEqual(sentNames);
      const runs = after.workflows!.runs.filter((run) => !before.workflows?.runs.some((earlier) => earlier.runRef === run.runRef));
      expect(runs.map((run) => ({ workflowId: run.workflowId, status: run.status }))).toEqual([{ workflowId: "weixin.send-files", status: "succeeded" }]);
      weixinTurns.push({ command: text, reply: after.weixinFixtureReplies?.at(-1)?.message, run: runs[0], outbox: after.fixtureOutbox!.slice(before.fixtureOutbox?.length ?? 0) });
    }
    expect(readFileSync(join(vault, "wx-private-result.txt"), "utf8")).toBe("PUBLIC_BUSINESS_SENTINEL");
    for (const [index] of protectedTargets.entries()) expect(readFileSync(join(vault, `denied-weixin-${index}.txt`), "utf8")).toBe("local_file_permission_denied");
    for (const [chat, privateChat] of [["private", true], ["group", false]] as const) {
      const before = (await running.state()).feishuFixtureMediaOutbox?.length ?? 0;
      for (const [batch, targets] of batches.entries()) {
        const sentBefore = (await running.state()).feishuFixtureMediaOutbox?.length ?? 0;
        await send(`om_protected_${chat}_${batch}`, "尝试写入受保护位置并返回结果", protectedWrites(chat, targets), privateChat);
        await running.until((s) => s.feishuFixtureMediaOutbox?.length === sentBefore + targets.length && s.feishuFixtureTextOutbox?.at(-1)?.message === "文件已发送，请查收。");
      }
      const sent = (await running.state()).feishuFixtureMediaOutbox!.slice(before);
      expect(sent).toHaveLength(10);
      for (const item of sent) expect(item).toMatchObject({ chatId: privateChat ? "oc_private" : "oc_alpha", bytesBase64: Buffer.from("local_file_permission_denied").toString("base64") });
    }
    for (const parts of skillRoots) expect(existsSync(join(runtimeRoot, ...parts, "planted")), parts.join("/")).toBe(false);
    for (const planted of [join(userHome, ".agents"), join(userHome, "Library", "LaunchAgents", "com.local.codex-weixin.plist"), join(diagnostics, "planted.jsonl")]) {
      expect(existsSync(planted), planted).toBe(false);
    }
    expect(existsSync(stateFile) ? readFileSync(stateFile) : undefined).toEqual(stateBefore);
    await send("om_pending_boundary", "列出 Candidate 文件让我选", [find("Candidate"),
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
        candidateRefs: [result(0, ["entries", 0, "fileRef"]), result(0, ["entries", 1, "fileRef"])] } },
    ]);
    const waiting = await running.until((s) => s.workflows?.runs.some((run) => run.status === "needs_input") === true && s.feishuFixtureTextOutbox?.at(-1)?.message.includes("Candidate A.md") === true);
    const pending = waiting.workflows!.runs.find((run) => run.status === "needs_input")!;
    expect(pending.effects).toEqual([]);
    await running.close(); running = await start(directory, { ...env, CODEX_HOME: futureHome });
    await running.until((s) => s.channels?.feishu?.ready === true);
    await send("om_pending_now_private", "1");
    const denied = await running.until((s) => s.workflows?.runs.find((run) => run.runRef === pending.runRef)?.status === "failed" &&
      s.feishuFixtureTextOutbox?.at(-1)?.message === "文件发送失败，请稍后重试。");
    expect(denied.workflows?.runs.find((run) => run.runRef === pending.runRef)).toMatchObject({ status: "failed", errorCode: "local_file_permission_denied", effects: [] });
    expect(denied.feishuFixtureMediaOutbox).toEqual([]);
    console.log(JSON.stringify({ kind: "feishu_group_protected_main", weixinTurns, commands: ["private Boundary read/send", "group Boundary read/send", "weixin Boundary read/send", "weixin protected writes", "private protected writes", "group protected writes", "Candidate choice", "restart with newly protected home", "1"],
      initialOutbox: waiting.feishuFixtureMediaOutbox, pending, transcript: denied.codex.transcript, workflows: denied.workflows?.runs, outbox: denied.feishuFixtureMediaOutbox }));
  } finally { await running?.close(); rmSync(business, { recursive: true, force: true }); }
}, 60000);

// The main model's turns use the same file tools as a dispatch Executor's. The fixture vault's directory and its label are both
// demo-vault, as a production grant's label is its directory's name.
it("saves a private Weixin turn's file addressed by the grant's name at the grant's root, and reports where it landed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grant-name-main-")), business = mkdtempSync(join(tmpdir(), "grant-name-main-files-"));
  const vault = join(business, "demo-vault"), command = "在授权目录 demo-vault 里的 notes 下新建 by-name.md，写上「按名称保存」，然后发给我";
  let running: Awaited<ReturnType<typeof start>> | undefined;
  const write = (relativePath: string, content: unknown) => ({ namespace: "files", tool: "write", arguments: { scopeRef: { $fixtureScopeLabel: "demo-vault" }, relativePath, content, overwrite: false } });
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
    running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
    await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
      scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: true, write: true })) });
    const before = await running.state();
    await running.post("/api/fixture/workflow/inbound", { text: command, modelToolCalls: [
      write("demo-vault/notes/by-name.md", "按名称保存"),
      // What the model is told about the first write: the path below the root.
      write("landed.txt", { $fixtureToolResult: { call: 0, path: ["relativePath"] } }),
      { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [{ $fixtureToolResult: { call: 0, path: ["fileRef"] } }] } },
    ] });
    const sent = await running.until((s) => s.weixinFixtureReplies?.at(-1)?.message === "文件已发送，请查收。" && (s.fixtureOutbox?.length ?? 0) > 0);
    expect(readFileSync(join(vault, "notes", "by-name.md"), "utf8")).toBe("按名称保存");
    expect(existsSync(join(vault, "demo-vault"))).toBe(false);
    expect(readFileSync(join(vault, "landed.txt"), "utf8")).toBe("notes/by-name.md");
    expect(sent.fixtureOutbox?.map(({ fileName }) => fileName)).toEqual(["by-name.md"]);
    const runs = sent.workflows!.runs.filter((run) => !before.workflows?.runs.some((earlier) => earlier.runRef === run.runRef));
    expect(runs.map(({ workflowId, status }) => ({ workflowId, status }))).toEqual([{ workflowId: "weixin.send-files", status: "succeeded" }]);
    console.log(JSON.stringify({ kind: "grant_name_main_weixin", command, reply: sent.weixinFixtureReplies?.at(-1)?.message, runs, outbox: sent.fixtureOutbox }));
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(business, { recursive: true, force: true }); }
}, 30000);

// Production's layout: the notes vault lies under the Documents folder that local media grants (failure mode 4). The fixture
// keeps its media folders under <business>/fixture-media-home, so the business directory is named Documents and
// fixture-media-home links to its parent. The granted Documents folder is then the vault's parent by real paths.
function vaultUnderDocuments(prefix: string) {
  const home = mkdtempSync(join(tmpdir(), prefix)), business = join(home, "Documents"), vault = join(business, "demo-vault");
  for (const folder of [join(vault, ".obsidian"), join(vault, "notes"), join(home, "Downloads"), join(home, "Pictures")]) mkdirSync(folder, { recursive: true });
  symlinkSync(home, join(business, "fixture-media-home"), "dir");
  // The vault's files sort before the ones beside it, by name and by path: a search that enters the vault returns them first.
  writeFileSync(join(vault, "notes", "secret plan.md"), "vault plan");
  writeFileSync(join(vault, "notes", "aa needle.md"), "NESTED_NEEDLE in the vault");
  writeFileSync(join(business, "zz plan.md"), "documents plan");
  writeFileSync(join(business, "zz notes.md"), "NESTED_NEEDLE in documents");
  return { home, business };
}
// The first hit of a search by name and of a search by content, sent to the chat: what was sent shows what the searches saw.
const documentsScope = { $fixtureScopeLabel: "Documents" };
const sendFirstHits = [
  { namespace: "files", tool: "find", arguments: { scopeRefs: [documentsScope], query: "plan", kind: "file", match: "fuzzy", sort: { field: "name", direction: "asc" }, limit: 20 } },
  { namespace: "files", tool: "grep", arguments: { scopeRefs: [documentsScope], pattern: "NESTED_NEEDLE" } },
  { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected",
    fileRefs: [{ $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } }, { $fixtureToolResult: { call: 1, path: ["matches", 0, "fileRef"] } }] } },
];
/** Switches the vault's reading and writing off, as the owner would on the permissions page. */
async function closeVault(running: Awaited<ReturnType<typeof start>>) {
  const notes = (await running.state()).workflowModulePermissions!.modules.find((module) => module.moduleId === "notes")!;
  await running.post("/api/workflows/module-permissions/configure", { moduleId: "notes", expectedRevision: notes.revision, confirmed: true,
    scopes: notes.scopes.map((scope) => ({ scopeId: scope.scopeId, read: false, write: false })) });
}
/** The grants the last model turn was offered, by name. */
const offeredGrants = (state: State) => [...JSON.stringify(state.fixtureModelRequests?.at(-1)?.input).matchAll(/scoperef_[a-f0-9]{32}: (.+?)（/gu)].map((match) => match[1]).sort();

it("keeps a closed vault under the granted Documents folder out of a private Weixin turn's searches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nested-scope-main-")), { home, business } = vaultUnderDocuments("nested-scope-main-home-");
  const command = "在 Documents 里找名字带 plan 的文件和内容带 NESTED_NEEDLE 的文件，各取第一个发给我";
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    writeFileSync(join(directory, "channel.json"), JSON.stringify(config("weixin")));
    running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await closeVault(running);
    const before = await running.state();
    await running.post("/api/fixture/workflow/inbound", { text: command, modelToolCalls: sendFirstHits });
    const sent = await running.until((s) => s.weixinFixtureReplies?.at(-1)?.message === "文件已发送，请查收。" && (s.fixtureOutbox?.length ?? 0) === 2);
    const runs = sent.workflows!.runs.filter((run) => !before.workflows?.runs.some((earlier) => earlier.runRef === run.runRef));
    console.log(JSON.stringify({ kind: "nested_scope_main_weixin", command, reply: sent.weixinFixtureReplies?.at(-1)?.message, offered: offeredGrants(sent), runs, outbox: sent.fixtureOutbox }));
    expect(offeredGrants(sent)).toEqual(["Documents", "Downloads", "Pictures"]);
    expect(sent.fixtureOutbox?.map(({ fileName }) => fileName)).toEqual(["zz plan.md", "zz notes.md"]);
    expect(runs.map(({ workflowId, status }) => ({ workflowId, status }))).toEqual([{ workflowId: "weixin.send-files", status: "succeeded" }]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}, 30000);

it("keeps a closed vault under the granted Documents folder out of an Executor's searches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nested-scope-executor-")), { home, business } = vaultUnderDocuments("nested-scope-executor-home-");
  const command = "在 Documents 里找名字带 plan 的文件和内容带 NESTED_NEEDLE 的文件，各取第一个发到群里";
  let running: Awaited<ReturnType<typeof start>> | undefined;
  try {
    dispatchConfig(directory, true); running = await start(directory, { WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: business });
    await running.until((state) => state.channels?.feishu?.ready === true);
    await closeVault(running);
    await running.post("/api/fixture/feishu/inbound", groupMessage("om_nested_scope", command, decision("jack", "找出两个文件并发到群里"), { modelToolCalls: sendFirstHits }));
    const result = await running.until((state) => state.agentDispatch?.jobs[0]?.status === "completed" && (state.agentFixtureOutboxes?.jack?.media.length ?? 0) === 2);
    const runs = result.workflows?.runs.filter(({ workflowId }) => workflowId === "weixin.send-files") ?? [];
    console.log(JSON.stringify({ kind: "nested_scope_executor", command, offered: offeredGrants(result), jobs: result.agentDispatch, outboxes: result.agentFixtureOutboxes, runs }));
    expect(offeredGrants(result)).toEqual(["Documents", "Downloads", "Pictures"]);
    expect(result.agentFixtureOutboxes?.jack?.media.map((item) => (item as { fileName: string }).fileName)).toEqual(["zz plan.md", "zz notes.md"]);
    expect(runs.map(({ status }) => status)).toEqual(["succeeded"]);
  } finally { await running?.close(); rmSync(directory, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}, 30000);
