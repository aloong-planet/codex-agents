import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppServerMessage, AppServerTransport } from "./codex-app-server-client.js";
import type { CodexUserInput } from "./codex-conversation.js";
import { frontMatter } from "./skill-library.js";

export type FixtureModelToolCall = {
  namespace: string;
  tool: string;
  arguments: unknown;
};

export interface FixtureModelToolCallQueue {
  takeFixtureModelToolCall(threadId?: string): FixtureModelToolCall | undefined;
  takeFixtureModelCompletion?(threadId?: string): Promise<string> | undefined;
}

type FixtureTurn = {
  threadId: string;
  turnId: string;
  input: CodexUserInput[];
  calls: FixtureModelToolCall[];
  results: unknown[];
  callIndex: number;
  completion?: Promise<string>;
};

/** Explicit fixture mode only: replaces the external protocol peer, never tool execution. */
export class FixtureAppServerTransport implements AppServerTransport {
  private messageListener: (message: AppServerMessage) => void = () => {};
  private exitListener: (error?: Error) => void = () => {};
  private closed = false;
  private turnSequence = 0;
  private requestSequence = 0;
  private readonly turns = new Map<string, FixtureTurn>();
  private readonly requests = new Map<string | number, { turn: FixtureTurn; item: Record<string, unknown> }>();

  constructor(
    private readonly toolCalls: FixtureModelToolCallQueue,
    private readonly finalResponse: (results: unknown[]) => string | Error = () => JSON.stringify({ message: "这是 fixture Codex 回复。", results: [] }),
    private readonly observeTurn?: (input: { threadId: string; input: unknown }) => void,
    private readonly turnIdPrefix = "fixture-turn",
    /** Sees each started thread's service name and offered dynamic tool names, so cases can check what a runtime was given. */
    private readonly observeThreadStart?: (start: { threadId: string; serviceName: unknown; dynamicTools: string[] | null }) => void,
    /** A Codex home in which each started thread gets a rollout file named as the App Server names it, so homes compact as in
     * production, and whose `skills` folder `skills/list` lists. Resuming does not read it. */
    private readonly rolloutHome?: string,
    /** Sees what each dynamic tool call answered, as the model receives it, so cases can check what a tool gave a runtime's model. */
    private readonly observeToolResult?: (call: { threadId: string; namespace: unknown; tool: unknown; success: boolean; result: unknown }) => void,
  ) {}
  private readonly rollouts = new Map<string, string>();

  /** Appends a line to the thread's rollout: a thread this transport started, in its runtime's Codex home. */
  private record(threadId: string, line: unknown): void {
    if (!this.rolloutHome) return;
    let file = this.rollouts.get(threadId);
    if (!file) {
      if ((line as { type?: unknown }).type !== "session_meta") return;
      const now = new Date().toISOString(), [date] = now.split("T");
      file = path.join(this.rolloutHome, "sessions", ...date!.split("-"), `rollout-${now.slice(0, 19).replaceAll(":", "-")}-${threadId}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.rollouts.set(threadId, file);
    }
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  }

  send(message: AppServerMessage): void {
    if (this.closed) throw new Error("fixture_app_server_closed");
    this.schedule(() => this.receive(message));
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.messageListener = listener;
    return () => { if (this.messageListener === listener) this.messageListener = () => {}; };
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListener = listener;
    return () => { if (this.exitListener === listener) this.exitListener = () => {}; };
  }

  close(): void {
    this.closed = true;
    this.turns.clear();
    this.requests.clear();
  }

  private schedule(action: () => void): void {
    queueMicrotask(() => {
      if (this.closed) return;
      try { action(); }
      catch (error) {
        this.close();
        this.exitListener(error instanceof Error ? error : new Error("fixture_protocol_script_failed"));
      }
    });
  }

  private emit(message: AppServerMessage): void {
    if (!this.closed) this.messageListener(message);
  }

  private receive(message: AppServerMessage): void {
    if (!message.method) {
      const pending = message.id === undefined ? undefined : this.requests.get(message.id);
      if (!pending) throw new Error("fixture_tool_response_id_unknown");
      this.requests.delete(message.id!);
      const { turn, item } = pending;
      if (!this.turns.has(turn.turnId)) return;
      // Both domain errors and success:false are observations, not model termination.
      // The explicit model script chooses its next call; the host never retries.
      turn.results.push(parseFixtureToolResult(message.result));
      this.observeToolResult?.({ threadId: turn.threadId, namespace: item.namespace, tool: item.tool,
        success: (message.result as { success?: boolean } | undefined)?.success !== false, result: structuredClone(turn.results.at(-1)) });
      this.emit({ method: "item/completed", params: {
        threadId: turn.threadId, turnId: turn.turnId,
        item: { ...item, status: (message.result as { success?: boolean } | undefined)?.success === false ? "failed" : "completed" },
      } });
      this.schedule(() => this.advance(turn));
      return;
    }
    const { id, method, params = {} } = message;
    if (method === "initialized") return;
    if (id === undefined) throw new Error("fixture_request_id_missing");
    if (method === "initialize") {
      this.emit({ id, result: { userAgent: "fixture-app-server" } });
    } else if (method === "thread/start" || method === "thread/resume") {
      const threadId = method === "thread/resume" ? String(params.threadId) : randomUUID();
      if (method === "thread/start") {
        this.observeThreadStart?.({ threadId, serviceName: params.serviceName, dynamicTools: dynamicToolNames(params.dynamicTools) });
        this.record(threadId, { type: "session_meta", payload: { id: threadId } });
      }
      this.emit({ id, result: { thread: { id: threadId } } });
    } else if (method === "turn/start") {
      this.observeTurn?.({ threadId: String(params.threadId), input: structuredClone(params.input) });
      this.record(String(params.threadId), { type: "turn_input", payload: params.input });
      const calls: FixtureModelToolCall[] = [];
      let call = this.toolCalls.takeFixtureModelToolCall(String(params.threadId));
      while (call) { calls.push(call); call = this.toolCalls.takeFixtureModelToolCall(String(params.threadId)); }
      const completion = this.toolCalls.takeFixtureModelCompletion?.(String(params.threadId));
      const turn: FixtureTurn = {
        threadId: String(params.threadId), turnId: `${this.turnIdPrefix}-${++this.turnSequence}`,
        input: params.input as CodexUserInput[], calls, results: [], callIndex: 0,
        ...(completion ? { completion } : {}),
      };
      this.turns.set(turn.turnId, turn);
      this.emit({ id, result: { turn: { id: turn.turnId } } });
      this.schedule(() => {
        if (!this.turns.has(turn.turnId)) return;
        const identity = { threadId: turn.threadId, turnId: turn.turnId };
        const item = { id: `${turn.turnId}-reasoning`, type: "reasoning" };
        this.emit({ method: "item/started", params: { ...identity, item } });
        this.emit({ method: "item/completed", params: { ...identity, item } });
        this.advance(turn);
      });
    } else if (method === "skills/list") {
      const cwds = Array.isArray(params.cwds) ? params.cwds.map(String) : [];
      this.emit({ id, result: { data: cwds.map((cwd) => ({ cwd, ...listHomeSkills(this.rolloutHome) })) } });
    } else if (method === "turn/interrupt") {
      const turn = this.turns.get(String(params.turnId));
      this.emit({ id, result: {} });
      if (turn && turn.threadId === params.threadId) {
        this.turns.delete(turn.turnId);
        this.emit({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "interrupted" } } });
      }
    } else {
      this.emit({ id, error: { code: -32601, message: "fixture_method_not_supported" } });
    }
  }

  private advance(turn: FixtureTurn): void {
    if (!this.turns.has(turn.turnId)) return;
    const identity = { threadId: turn.threadId, turnId: turn.turnId };
    const call = turn.calls[turn.callIndex++];
    if (call) {
      const item = { id: `${turn.turnId}-tool-${turn.callIndex}`, type: "dynamicToolCall",
        namespace: call.namespace, tool: call.tool,
        arguments: resolveFixtureArguments(call.arguments, turn.input, turn.results) };
      const sequence = ++this.requestSequence;
      const id = sequence % 2 === 1 ? 1_000_000 + sequence : `fixture-request-${item.id}`;
      this.requests.set(id, { turn, item });
      this.emit({ method: "item/started", params: { ...identity, item } });
      this.emit({ id, method: "item/tool/call", params: { ...identity,
        callId: item.id, namespace: call.namespace, tool: call.tool, arguments: item.arguments } });
      return;
    }
    if (turn.completion) {
      void turn.completion.then((text) => this.finish(turn, text), (error) => { this.close(); this.exitListener(error); });
      return;
    }
    this.finish(turn, this.finalResponse(structuredClone(turn.results)));
  }

  private finish(turn: FixtureTurn, text: string | Error): void {
    if (!this.turns.has(turn.turnId)) return;
    const identity = { threadId: turn.threadId, turnId: turn.turnId };
    if (text instanceof Error) {
      this.close();
      this.exitListener(text);
      return;
    }
    const item = { id: `${turn.turnId}-answer`, type: "agentMessage", phase: "final_answer", text };
    this.emit({ method: "item/started", params: { ...identity, item } });
    this.emit({ method: "item/agentMessage/delta", params: { ...identity, itemId: item.id, delta: text } });
    this.emit({ method: "item/completed", params: { ...identity, item } });
    this.turns.delete(turn.turnId);
    this.emit({ method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.turnId, status: "completed" } } });
  }
}

/**
 * The skills of a Codex home's `skills` folder, one per folder with a SKILL.md, each by the real path of that file, as the App
 * Server lists them. A SKILL.md whose front matter repeats a key is refused with the message the installed App Server gives that
 * shape; no other refusal is modelled.
 */
function listHomeSkills(codexHome: string | undefined): { skills: unknown[]; errors: unknown[] } {
  const root = codexHome === undefined ? undefined : path.join(codexHome, "skills");
  const skills: unknown[] = [], errors: unknown[] = [];
  if (root === undefined || !fs.existsSync(root)) return { skills, errors };
  for (const folder of fs.readdirSync(root).sort()) {
    const file = path.join(root, folder, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const real = fs.realpathSync(file), text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/u), end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
    const keys = lines.slice(1, Math.max(end, 1)).flatMap((line) => /^([^\s:#][^:]*):/u.exec(line)?.[1] ?? []);
    const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
    if (repeated !== undefined) { errors.push({ path: real, message: `invalid YAML: duplicate field \`${repeated}\`` }); continue; }
    const { name = "", description = "" } = frontMatter(text);
    skills.push({ name, description, path: real, scope: "user", enabled: true, pluginId: null });
  }
  return { skills, errors };
}

function dynamicToolNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((namespace: { name?: unknown; tools?: Array<{ name?: unknown }> }) =>
    Array.isArray(namespace?.tools) ? namespace.tools.map((tool) => `${String(namespace.name)}.${String(tool?.name)}`) : [String(namespace?.name)]);
}

function parseFixtureToolResult(result: unknown): unknown {
  const items = (result as { contentItems?: Array<{ type: string; text?: string }> } | undefined)?.contentItems;
  const text = items?.find((item) => item.type === "inputText")?.text;
  if (text === undefined) return result;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const envelope = parsed as Record<string, unknown>;
  return envelope.ok === true && Object.hasOwn(envelope, "data") ? envelope.data : parsed;
}

function resolveFixtureArguments(
  value: unknown,
  input: string | CodexUserInput[],
  results: unknown[],
): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveFixtureArguments(item, input, results));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && record.$fixtureScopeLabel !== undefined) {
    if (typeof record.$fixtureScopeLabel !== "string") throw new Error("fixture_model_scope_reference_invalid");
    return scopeReference(input, record.$fixtureScopeLabel);
  }
  if (Object.keys(record).length === 1 && record.$fixtureToolResult !== undefined) {
    return toolResultReference(results, record.$fixtureToolResult);
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [
    key,
    resolveFixtureArguments(item, input, results),
  ]));
}

function scopeReference(input: string | CodexUserInput[], label: string): string {
  const prompt = typeof input === "string"
    ? input
    : input.find((item): item is Extract<CodexUserInput, { type: "text" }> => item.type === "text")?.text ?? "";
  const matches = [...prompt.matchAll(/^(scoperef_[a-f0-9]{32}): (.+?)（(?:可读|不可读)/gmu)];
  const match = matches.find((candidate) => candidate[2] === label);
  if (!match?.[1]) throw new Error("fixture_model_scope_reference_missing");
  return match[1];
}

function toolResultReference(results: unknown[], descriptor: unknown): unknown {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("fixture_model_tool_result_reference_invalid");
  }
  const call = (descriptor as Record<string, unknown>).call;
  const path = (descriptor as Record<string, unknown>).path;
  if (!Number.isSafeInteger(call) || (call as number) < 0 || !Array.isArray(path) ||
      path.some((part) => typeof part !== "string" && !Number.isSafeInteger(part))) {
    throw new Error("fixture_model_tool_result_reference_invalid");
  }
  let current = results[call as number];
  for (const part of path) {
    if (current === null || current === undefined || typeof current !== "object") {
      throw new Error("fixture_model_tool_result_reference_missing");
    }
    current = (current as Record<string | number, unknown>)[part as string | number];
  }
  if (current === undefined) throw new Error("fixture_model_tool_result_reference_missing");
  return structuredClone(current);
}
