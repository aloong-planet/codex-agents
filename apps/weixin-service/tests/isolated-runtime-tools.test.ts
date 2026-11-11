// What an isolated runtime's model is offered and what its calls do, on the installed Codex App Server with a loopback
// fake model (tests/fixtures/isolated-runtime-probe.ts). Opt-in (CODEX_ISOLATED_RUNTIME_TEST=1, `pnpm test:isolated-runtime`)
// because CI has no Codex executable; rerun after every Codex upgrade.
// Gap: a real code_mode_only model calling host tools directly, and real web search results, need real model turns; they
// are the owner's acceptance checks (ADR-0030), not covered here.
// Gap: that `request_user_input` sends no server request to the host is seen only through its refused output; the
// production turn driver's answer to a server request is not observable through CodexConversation.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CodexConversation } from "../src/codex-conversation.js";
import { ConsoleAudit } from "../src/console-audit.js";
import type { DynamicToolDefinition, DynamicToolHost } from "../src/dynamic-tool-host.js";
import { type IsolatedModelRuntime, spawnIsolatedAppServer } from "../src/isolated-model-runtime.js";
import { createIsolatedRuntime, type IsolatedConversationKind, isolatedConversationOptions, ISOLATED_RUNTIME_KINDS } from "../src/isolated-runtime-kinds.js";
import { McpCatalog } from "../src/mcp-catalog.js";
import { McpProxyToolHost } from "../src/mcp-proxy-tools.js";
import { resolveCodexExecutable } from "../src/stdio-app-server-transport.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { createScheduledResearch } from "../src/scheduled-research.js";
import { AppServerSession, assistantMessage, FakeResponsesEndpoint, type FakeModelRequest, type FakeOutputItem, isolatedConversationPlacements,
  runsInstalledAppServer } from "./fixtures/isolated-runtime-probe.js";
import { testServerArgs, testServerFiles, writeTools } from "./fixtures/mcp-test-server-control.js";
import { processWaitLimitMs } from "./support/process-wait.js";

describe.skipIf(!runsInstalledAppServer)("tool surface of isolated runtimes on the installed Codex App Server", () => {
  let work: string, environment: NodeJS.ProcessEnv, model: FakeResponsesEndpoint, bundledCatalog: string;
  const executable = () => resolveCodexExecutable(process.env);

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-runtime-tools-"));
    const hostCodexHome = path.join(work, "host-codex-home"); fs.mkdirSync(hostCodexHome);
    fs.writeFileSync(path.join(hostCodexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-synthetic-ticket23" }));
    environment = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(work, "host-home"), CODEX_HOME: hostCodexHome };
    model = await FakeResponsesEndpoint.start();
    // The catalog the binary ships, unchanged. A runtime given it is offered the same code-mode tool list that runtimes were
    // offered before the fix (compare the unfixed run in the ticket's evidence with the positive control below).
    const scratch = fs.mkdtempSync(path.join(work, "dump-"));
    const dump = spawnSync(executable(), ["debug", "models", "--bundled"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: scratch, CODEX_HOME: scratch } });
    expect(dump.status, dump.stderr).toBe(0);
    bundledCatalog = path.join(work, "bundled-catalog.json"); fs.writeFileSync(bundledCatalog, dump.stdout);
  });
  afterAll(async () => { await model?.close(); fs.rmSync(work, { recursive: true, force: true }); });

  const media = (name: string) => { const directory = path.join(work, "media", name); fs.mkdirSync(directory, { recursive: true }); return directory; };
  const placements = isolatedConversationPlacements(media);
  // What main.ts grants its host-tool runtimes (main.ts's createProductionWorkflowToolCatalog flags).
  const hostCatalog = createProductionWorkflowToolCatalog({ files: false, media: true, directFiles: true, delivery: true, schedules: true });
  const hostTools: DynamicToolHost = { definitions: () => hostCatalog.definitions(),
    execute: async () => ({ contentItems: [{ type: "inputText", text: "host tool reached" }], success: true }) };
  const names = (tools: Array<Record<string, unknown>>, prefix = ""): string[] => tools.flatMap((tool) => tool.type === "namespace"
    ? names((tool.tools ?? []) as Array<Record<string, unknown>>, `${String(tool.name)}.`) : [`${prefix}${String(tool.name ?? tool.type)}`]);
  const granted = () => {
    const grant = names(hostCatalog.definitions() as unknown as Array<Record<string, unknown>>);
    expect(grant.length).toBeGreaterThan(0);
    return ["web.run", ...grant].sort();
  };
  const toolSurface = (request: FakeModelRequest) => ({
    topLevel: names((request.body.tools ?? []) as Array<Record<string, unknown>>),
    additional: ((request.body.input ?? []) as Array<Record<string, unknown>>).filter((item) => item.type === "additional_tools")
      .map((item) => names((item.tools ?? []) as Array<Record<string, unknown>>).sort()),
  });
  /** Reproduces the tool list a runtime was offered before the fix: the binary's own catalog, with sub-agents and user input on. */
  const beforeTheFix = (runtime: IsolatedModelRuntime): IsolatedModelRuntime => ({ ...runtime, configOverrides: [...runtime.configOverrides,
    `model_catalog_json=${JSON.stringify(bundledCatalog)}`, "agents.enabled=true", "tools.experimental_request_user_input.enabled=true"] });

  /** A runtime of `kind` created as main.ts creates it, in its own state directory. */
  function place(kind: IsolatedConversationKind) {
    const { agentId, ...location } = placements[kind]();
    return { runtime: createIsolatedRuntime(kind, { stateDirectory: fs.mkdtempSync(path.join(work, `${kind}-`)), ...location, environment }), agentId };
  }
  /** A conversation on that runtime, started as main.ts starts it; `configure` changes only what the App Server is given. */
  function converse(kind: IsolatedConversationKind, placed: ReturnType<typeof place>, slug: string,
    configure: (runtime: IsolatedModelRuntime) => IsolatedModelRuntime = (runtime) => runtime) {
    const { runtime, agentId } = placed;
    return new CodexConversation(() => spawnIsolatedAppServer(executable(), model.route(configure(runtime), slug)), 60_000,
      ISOLATED_RUNTIME_KINDS[kind].hostTools ? hostTools : undefined, undefined, 60_000,
      isolatedConversationOptions(kind, runtime, { structuredOutputSupported: true, ...(agentId !== undefined ? { agentId } : {}) }));
  }
  function start(kind: IsolatedConversationKind, slug: string, configure?: (runtime: IsolatedModelRuntime) => IsolatedModelRuntime) {
    const placed = place(kind);
    return { runtime: placed.runtime, conversation: converse(kind, placed, slug, configure) };
  }

  // Owner-selectable kinds run on every model track; the pending router and the memory curator use their profile's model.
  const rows: Array<[IsolatedConversationKind, string]> = [
    ...(["feishuGroup", "dispatchAgent", "dispatchCoordinator", "dispatchLeader", "penny"] as const).flatMap((kind) =>
      ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].map((slug): [IsolatedConversationKind, string] => [kind, slug])),
    ["pendingRouter", "gpt-5.6-luna"], ["groupMemoryCurator", "gpt-5.6-terra"],
  ];
  it.each(rows)("%s on %s is offered exactly its granted tools", async (kind, slug) => {
    model.respondWith(() => [assistantMessage("fake-model-reply")]);
    const { runtime, conversation } = start(kind, slug);
    try {
      const threadId = await conversation.startOrResume(undefined, runtime.cwd);
      const from = model.requests.length;
      await conversation.reply(threadId, "hello");
      const request = model.modelRequestsSince(from).at(-1)!;
      expect(request.body.model).toBe(slug);
      const surface = toolSurface(request);
      expect(surface.topLevel).toEqual([]);
      expect(surface.additional).toEqual(ISOLATED_RUNTIME_KINDS[kind].hostTools ? [granted()] : []);
    } finally { await conversation.close(); }
  }, 60_000);

  /** Calls to every tool the App Server supplies on its own, in one model response. */
  function hiddenCalls(outside: string): FakeOutputItem[] {
    const patch = (file: string) => `*** Begin Patch\n*** Add File: ${file}\n+probe\n*** End Patch\n`;
    const custom = (call_id: string, name: string, input: string) => ({ type: "custom_tool_call", call_id, name, input });
    const call = (call_id: string, name: string, args: unknown, namespace?: string) =>
      ({ type: "function_call", call_id, name, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}) });
    const attempt = (expression: string) => `try { text(await ${expression}); } catch (error) { text("threw: " + String(error)); }`;
    return [
      custom("hidden-exec", "exec", [attempt(`tools.apply_patch(${JSON.stringify(patch("exec-probe.txt"))})`),
        attempt(`tools.apply_patch(${JSON.stringify(patch(path.join(outside, "exec-probe.txt")))})`),
        attempt(`tools.multi_agent_v1__spawn_agent({ message: "probe child" })`)].join("\n")),
      custom("hidden-apply-patch", "apply_patch", patch("direct-probe.txt")),
      call("hidden-user-input", "request_user_input", { questions: [{ id: "probe", header: "Probe", question: "Pick one",
        options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] }] }),
      call("hidden-wait", "wait", { cell_id: "1" }),
      call("hidden-list-resources", "list_mcp_resources", {}),
      call("hidden-read-resource", "read_mcp_resource", { server: "x", uri: "file:///etc/hosts" }),
      call("hidden-spawn-v2", "spawn_agent", { task_name: "probe_child", message: "probe child", fork_turns: "none" }, "collaboration"),
      call("hidden-wait-agent", "wait_agent", { timeout_ms: 15_000 }, "collaboration"),
      call("hidden-spawn-v1", "spawn_agent", { message: "probe child" }, "multi_agent_v1"),
    ];
  }
  const outputs = (request: FakeModelRequest) => Object.fromEntries(((request.body.input ?? []) as Array<Record<string, unknown>>)
    .filter((item) => typeof item.type === "string" && item.type.endsWith("_output"))
    .map((item) => [String(item.call_id), typeof item.output === "string" ? item.output : JSON.stringify(item.output)]));
  /** Sub-agent bookkeeping, read from a copy of the state database with its write-ahead log (an immutable read misses it). */
  function subAgents(runtime: IsolatedModelRuntime) {
    const home = runtime.env.CODEX_HOME!, copy = fs.mkdtempSync(path.join(work, "state-copy-"));
    for (const suffix of ["", "-wal", "-shm"]) {
      if (fs.existsSync(path.join(home, `state_5.sqlite${suffix}`))) fs.copyFileSync(path.join(home, `state_5.sqlite${suffix}`), path.join(copy, `state_5.sqlite${suffix}`));
    }
    const database = new DatabaseSync(path.join(copy, "state_5.sqlite"));
    try {
      const count = (sql: string) => (database.prepare(sql).get() as { n: number }).n;
      return { spawnEdges: count("select count(*) as n from thread_spawn_edges"), subAgentThreads: count("select count(*) as n from threads where thread_source = 'subagent'") };
    } finally { database.close(); }
  }
  const rollouts = (runtime: IsolatedModelRuntime): number => {
    const walk = (directory: string): number => !fs.existsSync(directory) ? 0 : fs.readdirSync(directory, { withFileTypes: true })
      .reduce((total, entry) => total + (entry.isDirectory() ? walk(path.join(directory, entry.name)) : entry.name.startsWith("rollout-") ? 1 : 0), 0);
    return walk(path.join(runtime.env.CODEX_HOME!, "sessions"));
  };
  const refused = /^unsupported (?:custom tool )?call/u;

  /** One turn whose model calls every hidden tool once, then answers. Returns the follow-up request and the turn's request count. */
  async function hiddenCallTurn(conversation: CodexConversation, threadId: string, outside: string) {
    let served = false;
    model.respondWith(() => { if (served) return [assistantMessage("fake-model-reply")]; served = true; return hiddenCalls(outside); });
    const from = model.requests.length;
    await conversation.reply(threadId, "use your tools");
    const requests = model.modelRequestsSince(from);
    // The parent's request that answers the calls; a sub-agent's own requests (if one was spawned) carry none of them.
    const followUp = requests.find((request) => "hidden-exec" in outputs(request));
    expect(followUp, "no request carried the hidden calls' outputs").toBeDefined();
    return { followUp: followUp!, requestCount: requests.length };
  }

  const hiddenRows: Array<[IsolatedConversationKind, string]> = [
    ["feishuGroup", "gpt-5.6-terra"], ["dispatchAgent", "gpt-5.6-terra"], ["dispatchCoordinator", "gpt-5.6-terra"], ["dispatchLeader", "gpt-5.6-terra"], ["penny", "gpt-5.6-terra"],
    ["pendingRouter", "gpt-5.6-luna"], ["groupMemoryCurator", "gpt-5.6-terra"],
  ];
  it.each(hiddenRows)("a hidden tool call in %s on %s is refused and has no effect", async (kind, slug) => {
    const { runtime, conversation } = start(kind, slug);
    const outside = fs.mkdtempSync(path.join(work, "outside-"));
    try {
      const threadId = await conversation.startOrResume(undefined, runtime.cwd);
      const { followUp, requestCount } = await hiddenCallTurn(conversation, threadId, outside);
      const answered = outputs(followUp);
      expect(Object.keys(answered).sort()).toEqual(hiddenCalls(outside).map((item) => String(item.call_id)).sort());
      for (const [callId, output] of Object.entries(answered)) expect(output, callId).toMatch(refused);
      // A spawned child would add model requests of its own.
      expect(requestCount).toBe(2);
    } finally { await conversation.close(); }
    for (const file of [path.join(runtime.cwd, "exec-probe.txt"), path.join(runtime.cwd, "direct-probe.txt")]) expect(fs.existsSync(file), file).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(subAgents(runtime)).toEqual({ spawnEdges: 0, subAgentThreads: 0 });
    expect(rollouts(runtime)).toBe(1);
  }, 90_000);

  // Positive control for the checks above, and the record of what these calls did before the fix. Row 2 makes the
  // workspace writable so the file checks are seen to find a file that does get written.
  it.each([["as configured", false], ["with a writable workspace", true]] as const)(
    "before the fix the same calls ran: exec reached apply_patch and spawn_agent created a sub-agent (%s)", async (_label, writable) => {
    const placed = place("dispatchCoordinator");
    if (writable) {
      const config = path.join(placed.runtime.env.CODEX_HOME!, "config.toml");
      const workspace = `${JSON.stringify(fs.realpathSync(placed.runtime.cwd))} = "read"`;
      expect(fs.readFileSync(config, "utf8")).toContain(workspace);
      fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(workspace, workspace.replace('"read"', '"write"')));
    }
    const conversation = converse("dispatchCoordinator", placed, "gpt-5.6-terra", beforeTheFix);
    const outside = fs.mkdtempSync(path.join(work, "outside-"));
    try {
      const threadId = await conversation.startOrResume(undefined, placed.runtime.cwd);
      const from = model.requests.length;
      const { followUp, requestCount } = await hiddenCallTurn(conversation, threadId, outside);
      expect(toolSurface(model.modelRequestsSince(from)[0]!).additional.flat())
        .toEqual(expect.arrayContaining(["functions.exec", "functions.wait", "functions.request_user_input", "collaboration.spawn_agent"]));
      const answered = outputs(followUp);
      expect(answered["hidden-exec"]).not.toMatch(refused);
      if (!writable) expect(answered["hidden-exec"]).toContain("patch rejected");
      expect(requestCount).toBeGreaterThan(2);
    } finally { await conversation.close(); }
    expect(subAgents(placed.runtime)).toEqual({ spawnEdges: 1, subAgentThreads: 1 });
    expect(rollouts(placed.runtime)).toBe(2);
    expect(fs.existsSync(path.join(placed.runtime.cwd, "exec-probe.txt"))).toBe(writable);
  }, 90_000);

  // Decision (a): a thread saved before the fix keeps the old tool list in its history and sends it again on resume, but
  // none of those tools exists any more. Host-tool runtimes are offered their current grant next to it.
  it.each([["dispatchCoordinator", "gpt-5.6-terra"], ["feishuGroup", "gpt-5.6-luna"]] as const)(
    "a thread of %s on %s saved before the fix gets no tool back when resumed", async (kind, slug) => {
    const placed = place(kind);
    const before = converse(kind, placed, slug, beforeTheFix);
    let threadId: string;
    try {
      model.respondWith(() => [assistantMessage("fake-model-reply")]);
      threadId = await before.startOrResume(undefined, placed.runtime.cwd);
      await before.reply(threadId, "hello before the fix");
    } finally { await before.close(); }
    const after = converse(kind, placed, slug);
    const outside = fs.mkdtempSync(path.join(work, "outside-"));
    try {
      expect(await after.startOrResume(threadId!, placed.runtime.cwd)).toBe(threadId!);
      const from = model.requests.length;
      const { followUp, requestCount } = await hiddenCallTurn(after, threadId!, outside);
      const answered = outputs(followUp);
      expect(Object.keys(answered).sort()).toEqual(hiddenCalls(outside).map((item) => String(item.call_id)).sort());
      for (const [callId, output] of Object.entries(answered)) expect(output, callId).toMatch(refused);
      expect(requestCount).toBe(2);
      if (ISOLATED_RUNTIME_KINDS[kind].hostTools) expect(toolSurface(model.modelRequestsSince(from)[0]!).additional.at(-1)).toEqual(granted());
    } finally { await after.close(); }
    expect(fs.existsSync(path.join(placed.runtime.cwd, "exec-probe.txt"))).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(subAgents(placed.runtime)).toEqual({ spawnEdges: 0, subAgentThreads: 0 });
    expect(rollouts(placed.runtime)).toBe(1);
  }, 90_000);

  // mcp-catalog Implementation Decisions (proxy tools): the App Server keeps `mcp` and every name that begins with `mcp__` for its
  // own MCP client, and refuses a thread that is offered a tool whose name or input schema it cannot take. The proxy boundary
  // therefore offers a server's tools as a namespace `mcp-<server>`, with names and schemas the App Server takes.
  it("an Executor runtime is offered an attached MCP server's tools as a namespace and its call reaches the server", async () => {
    const state = fs.mkdtempSync(path.join(work, "mcp-state-")), home = fs.mkdtempSync(path.join(work, "mcp-home-"));
    const audit = new ConsoleAudit({ directory: state });
    const catalog = new McpCatalog({ stateDirectory: state, homeDirectory: home, audit, retryMs: 0, refreshMs: 0 });
    const { runtime, agentId } = place("dispatchAgent");
    let conversation: CodexConversation | undefined;
    try {
      const files = testServerFiles(state, "amap");
      // A dotted name and a tuple written as a list in `items`: forms real servers use and the App Server refuses as they are.
      writeTools(files.tools, [{ name: "admin.tools.list", description: "Lists.", inputSchema: { type: "object" } },
        { name: "drag", description: "Drags.", inputSchema: { type: "object", properties: { from: { type: "array", items: [{ type: "number" }, { type: "number" }] } } } }]);
      const server = { name: "amap", command: process.execPath, args: testServerArgs(files) };
      catalog.register(server, { confirmed: catalog.preview(server).launchLine, actor: {} });
      await vi.waitFor(() => expect(catalog.viewServer("amap").state).toBe("connected"), { timeout: processWaitLimitMs, interval: 50 });
      const proxy = new McpProxyToolHost({ definitions: () => hostCatalog.definitions(), execute: hostTools.execute, contractHash: () => hostCatalog.contractHash() }, catalog,
        { snapshot: ["amap"], current: () => ["amap"], agent: { team: "alice", profile: "executor-1", executor: "执行者 1", request: "request-1" }, audit });
      const open = (tools: DynamicToolHost) => new CodexConversation(() => spawnIsolatedAppServer(executable(), model.route(runtime, "gpt-5.6-terra")), 60_000, tools, undefined, 60_000,
        isolatedConversationOptions("dispatchAgent", runtime, { structuredOutputSupported: true, ...(agentId !== undefined ? { agentId } : {}) }));
      conversation = open(proxy);
      const threadId = await conversation.startOrResume(undefined, runtime.cwd);
      const written = path.join(state, "written.txt");
      let served = false;
      model.respondWith(() => {
        if (served) return [assistantMessage("fake-model-reply")];
        served = true;
        return [{ type: "function_call", call_id: "mcp-write", name: "write_file", namespace: "mcp-amap", arguments: JSON.stringify({ path: written, text: "from the runtime" }) },
          { type: "function_call", call_id: "mcp-dotted", name: "admin_tools_list", namespace: "mcp-amap", arguments: "{}" }];
      });
      const from = model.requests.length;
      await conversation.reply(threadId, "use the server");
      const requests = model.modelRequestsSince(from);
      expect(toolSurface(requests[0]!).additional.at(-1)).toEqual([...granted(), "mcp-amap.env", "mcp-amap.whoami", "mcp-amap.read_file", "mcp-amap.write_file", "mcp-amap.admin_tools_list", "mcp-amap.drag"].sort());
      expect(fs.readFileSync(written, "utf8")).toBe("from the runtime");
      const answered = outputs(requests.find((request) => "mcp-write" in outputs(request))!);
      expect([JSON.parse(answered["mcp-write"]!), JSON.parse(answered["mcp-dotted"]!)]).toEqual([{ text: "written" }, { text: "called admin.tools.list" }]);
      await conversation.close(); conversation = undefined;

      // The names this boundary avoids: a thread offered any of them does not start.
      const drag = proxy.definitions().flatMap((definition) => definition.type === "namespace" && definition.name === "mcp-amap" ? definition.tools : []).find(({ name }) => name === "drag")!;
      const refusedForms: Array<[DynamicToolDefinition, RegExp]> = [
        [{ type: "namespace", name: "mcp__amap", description: "MCP", tools: [drag] }, /dynamic tool namespace is reserved: mcp__amap/u],
        [{ ...drag, name: "mcp__amap__drag" }, /dynamic tool name is reserved: mcp__amap__drag/u],
        [{ type: "namespace", name: "mcp-amap", description: "MCP", tools: [{ ...drag, name: "admin.tools.list" }] }, /dynamic tool name must match/u],
        [{ type: "namespace", name: "mcp-amap", description: "MCP", tools: [{ ...drag, inputSchema: { type: "object", properties: { from: { type: "array", items: [{ type: "number" }] } } } }] }, /input schema is not supported for drag/u],
      ];
      for (const [definition, refusal] of refusedForms) {
        const refused = open({ definitions: () => [definition], execute: hostTools.execute });
        try { await expect(refused.startOrResume(undefined, runtime.cwd)).rejects.toThrow(refusal); } finally { await refused.close(); }
      }
    } finally { await conversation?.close(); await catalog.close(); }
  }, 120_000);

  it("group research through codex exec is offered only web search, still counts its searches and refuses hidden calls", async () => {
    const runtime = createIsolatedRuntime("research", { stateDirectory: fs.mkdtempSync(path.join(work, "research-")), instance: "feishu.group.probe", environment });
    const outside = fs.mkdtempSync(path.join(work, "outside-"));
    const search = (call_id: string, command: unknown) => ({ type: "function_call", call_id, name: "run", namespace: "web", arguments: JSON.stringify(command) });
    const hidden = hiddenCalls(outside).filter((item) => ["hidden-exec", "hidden-apply-patch", "hidden-spawn-v2"].includes(String(item.call_id)));
    let served = false;
    model.respondWith(() => {
      if (served) return [assistantMessage(JSON.stringify({ body: "Fake report.", sources: [{ title: "Example", url: "https://example.com/" }] }))];
      served = true;
      return [search("search-query", { search_query: [{ q: "probe" }] }), search("search-open", { open: [{ ref_id: "https://example.com/" }] }), ...hidden];
    });
    const research = createScheduledResearch({ executable: executable(), timeoutMs: 60_000, groupRuntime: () => model.route(runtime) });
    const from = model.requests.length;
    await expect(research({ signal: new AbortController().signal, destination: { accountId: "feishu.bot.probe", target: "feishu.group.probe" }, name: "Probe research",
      instruction: "Research the probe.", plannedAt: "2026-11-08T09:00:00.000Z", timezone: "Asia/Shanghai" }))
      .resolves.toBe("Fake report.\n\n来源：\n[1] Example：https://example.com/");
    const requests = model.modelRequestsSince(from);
    // A spawned child would add model requests of its own.
    expect(requests).toHaveLength(2);
    expect(toolSurface(requests[0]!)).toEqual({ topLevel: [], additional: [["web.run"]] });
    const answered = outputs(requests[1]!);
    expect(Object.keys(answered).sort()).toEqual(["hidden-apply-patch", "hidden-exec", "hidden-spawn-v2", "search-open", "search-query"]);
    for (const callId of ["hidden-apply-patch", "hidden-exec", "hidden-spawn-v2"]) expect(answered[callId], callId).toMatch(refused);
    for (const file of [path.join(runtime.cwd, "exec-probe.txt"), path.join(runtime.cwd, "direct-probe.txt")]) expect(fs.existsSync(file), file).toBe(false);
    expect(fs.readdirSync(outside)).toEqual([]);
  }, 90_000);

  it("an isolated runtime whose catalog file is missing does not start", async () => {
    const { runtime } = place("dispatchCoordinator");
    const missing = path.join(runtime.env.CODEX_HOME!, "absent-model-catalog.json");
    await expect(AppServerSession.open(model.route({ ...runtime, configOverrides: [...runtime.configOverrides, `model_catalog_json=${JSON.stringify(missing)}`] })))
      .rejects.toThrow(/已退出（code=1/u);
  }, 60_000);
});
