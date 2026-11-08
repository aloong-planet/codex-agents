// Test seam: the installed Codex App Server, started exactly as production starts an isolated runtime, with its model
// requests routed to a loopback fake Responses endpoint. No real model is contacted. Cases that use it are opt-in
// (CODEX_ISOLATED_RUNTIME_TEST=1) because CI has no Codex executable.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AppServerMessage } from "../../src/codex-app-server-client.js";
import { ISOLATED_MODEL_DISABLED_FEATURES, type IsolatedModelRuntime } from "../../src/isolated-model-runtime.js";
import { resolveCodexExecutable, spawnStdioAppServer } from "../../src/stdio-app-server-transport.js";

export const runsInstalledAppServer = process.env.CODEX_ISOLATED_RUNTIME_TEST === "1";

export type FakeModelRequest = { url: string; authorization: string | undefined; body: Record<string, unknown> };
/** A Responses API output item, for example an assistant message or a tool call. */
export type FakeOutputItem = Record<string, unknown>;
export type FakeModelScript = (request: FakeModelRequest, index: number) => FakeOutputItem[];

export const assistantMessage = (text: string): FakeOutputItem =>
  ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

/** Loopback stand-in for the model provider. Records every request and answers with scripted output items. */
export class FakeResponsesEndpoint {
  readonly requests: FakeModelRequest[] = [];
  private script: FakeModelScript = () => [assistantMessage("fake-model-reply")];

  private constructor(private readonly server: http.Server, private readonly port: number) {}

  static async start(): Promise<FakeResponsesEndpoint> {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake_responses_port_unavailable");
    const endpoint = new FakeResponsesEndpoint(server, address.port);
    server.on("request", (request: http.IncomingMessage, response: http.ServerResponse) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => endpoint.answer(request, body, response));
    });
    return endpoint;
  }

  /** Sets the output items returned for every later model request. */
  respondWith(script: FakeModelScript): void { this.script = script; }

  /** The production runtime with its model requests routed here; nothing else is changed. `model` is the default model
   * slug; a thread or turn that names its own model (such as a runtime profile's) still uses that one. */
  route(runtime: IsolatedModelRuntime, model = "gpt-5.6-luna"): IsolatedModelRuntime {
    return { ...runtime, configOverrides: [...runtime.configOverrides,
      'model_provider="fake"', 'model_providers.fake.name="fake"',
      `model_providers.fake.base_url="http://127.0.0.1:${this.port}/v1"`, 'model_providers.fake.wire_api="responses"',
      "model_providers.fake.requires_openai_auth=true", "model_providers.fake.supports_websockets=false", `model=${JSON.stringify(model)}`] };
  }

  /** Model requests received after `requests.length` was `from`. */
  modelRequestsSince(from: number): FakeModelRequest[] {
    return this.requests.slice(from).filter((request) => request.url.endsWith("/responses"));
  }

  close(): Promise<void> {
    return new Promise((resolve) => { this.server.closeAllConnections(); this.server.close(() => resolve()); });
  }

  private answer(request: http.IncomingMessage, raw: string, response: http.ServerResponse): void {
    const recorded: FakeModelRequest = { url: request.url ?? "", authorization: request.headers.authorization,
      body: raw ? JSON.parse(raw) as Record<string, unknown> : {} };
    this.requests.push(recorded);
    if (request.method !== "POST" || !recorded.url.endsWith("/responses")) {
      response.writeHead(404, { "content-type": "application/json" }).end("{}");
      return;
    }
    const index = this.requests.length;
    const items = this.script(recorded, index).map((item, position) => ({ id: `item_${index}_${position}`, ...item }));
    const events = [
      { type: "response.created", response: { id: `resp_${index}` } },
      ...items.map((item) => ({ type: "response.output_item.done", item })),
      { type: "response.completed", response: { id: `resp_${index}`, usage: {
        input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } },
    ];
    response.writeHead(200, { "content-type": "text/event-stream" })
      .end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  }
}

/** Writes `<directory>/<name>/SKILL.md` with the front matter and body shape of a real skill. */
export function plantSkill(directory: string, name: string, bodyMarker: string): string {
  const file = path.join(directory, name, "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: Probe skill ${name}.\n---\n\n# ${name}\n\n${bodyMarker}\n`);
  return file;
}

/** The serialized model input, where skill catalogs and injected skill bodies appear. */
export function modelInputText(request: FakeModelRequest): string {
  return JSON.stringify(request.body.input ?? []);
}

/** Skill names in the request's `<skills_instructions>` catalog, or undefined when the request has no catalog. */
export function skillCatalog(request: FakeModelRequest): string[] | undefined {
  const texts = (Array.isArray(request.body.input) ? request.body.input : []).flatMap((item) =>
    Array.isArray((item as { content?: unknown }).content) ? (item as { content: Array<{ text?: unknown }> }).content : [])
    .flatMap((content) => typeof content.text === "string" ? [content.text] : []);
  const block = texts.find((text) => text.includes("<skills_instructions>"));
  if (block === undefined) return undefined;
  const catalog = block.slice(block.lastIndexOf("### Available skills"), block.indexOf("</skills_instructions>"));
  return catalog.split("\n").slice(1).flatMap((line) => /^- ([^:\s]+):/u.exec(line)?.[1] ?? []);
}

export type ListedSkill = { name: string; scope: string; path: string };

/** A raw JSON-RPC session on the production stdio transport, for protocol inputs the host itself never sends. */
export class AppServerSession {
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: AppServerMessage) => void>();
  private constructor(private readonly transport: ReturnType<typeof spawnStdioAppServer>) {
    transport.onMessage((message) => {
      if (message.id !== undefined && !message.method) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
        else waiter?.resolve(message.result);
      } else if (message.id !== undefined) {
        transport.send({ id: message.id, error: { code: -32601, message: "not supported by the probe" } });
      }
      for (const listener of this.listeners) listener(message);
    });
    transport.onExit((error) => {
      for (const waiter of this.pending.values()) waiter.reject(error ?? new Error("app_server_exited"));
      this.pending.clear();
    });
  }

  /** Starts the App Server with the production executable, disabled features, cwd, environment and overrides. */
  static async open(runtime: IsolatedModelRuntime): Promise<AppServerSession> {
    const session = new AppServerSession(spawnStdioAppServer(resolveCodexExecutable(process.env), ISOLATED_MODEL_DISABLED_FEATURES, runtime));
    // The same handshake as the production client (codex-conversation-client.ts).
    await session.request("initialize", { clientInfo: { name: "isolated_runtime_probe", title: "Isolated runtime probe", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false } });
    session.transport.send({ method: "initialized", params: {} });
    return session;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}_timed_out`)); }, 30_000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.transport.send({ id, method, params });
    });
  }

  async listSkills(cwd: string): Promise<ListedSkill[]> {
    const listed = await this.request("skills/list", { cwds: [cwd], forceReload: true }) as { data: Array<{ skills: ListedSkill[] }> };
    return listed.data.flatMap((entry) => entry.skills.map(({ name, scope, path: file }) => ({ name, scope, path: file })));
  }

  /** Starts a turn and resolves with its final status once `turn/completed` arrives. */
  async turn(threadId: string, input: Array<Record<string, unknown>>): Promise<string> {
    let listener!: (message: AppServerMessage) => void;
    const completed = new Promise<string>((resolve) => {
      listener = (message) => {
        const params = message.params as { threadId?: string; turn?: { status?: string } } | undefined;
        if (message.method === "turn/completed" && params?.threadId === threadId) resolve(params.turn?.status ?? "unknown");
      };
      this.listeners.add(listener);
    });
    try {
      await this.request("turn/start", { threadId, input });
      return await completed;
    } finally { this.listeners.delete(listener); }
  }

  close(): void { this.transport.close(); }
}
