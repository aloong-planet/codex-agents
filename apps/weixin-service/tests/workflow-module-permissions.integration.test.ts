// Whole-application cases for file grants: a grant never reaches the service's own state, configuration and
// credentials, on any entry. Driven through the fixture Weixin and Feishu inbound routes of the real main process.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { config, start } from "./support/real-main.js";

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
