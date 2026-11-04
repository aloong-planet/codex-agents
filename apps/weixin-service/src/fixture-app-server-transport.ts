import { randomUUID } from "node:crypto";
import type { AppServerMessage, AppServerTransport } from "./codex-app-server-client.js";
import type { CodexUserInput } from "./codex-conversation.js";

export type FixtureModelToolCall = {
  namespace: string;
  tool: string;
  arguments: unknown;
};

export interface FixtureModelToolCallQueue {
  takeFixtureModelToolCall(threadId?: string): FixtureModelToolCall | undefined;
}

type FixtureTurn = {
  threadId: string;
  turnId: string;
  input: CodexUserInput[];
  calls: FixtureModelToolCall[];
  results: unknown[];
  callIndex: number;
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
  ) {}

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
      this.emit({ id, result: { thread: { id: method === "thread/resume" ? params.threadId : randomUUID() } } });
    } else if (method === "turn/start") {
      this.observeTurn?.({ threadId: String(params.threadId), input: structuredClone(params.input) });
      const calls: FixtureModelToolCall[] = [];
      let call = this.toolCalls.takeFixtureModelToolCall(String(params.threadId));
      while (call) { calls.push(call); call = this.toolCalls.takeFixtureModelToolCall(String(params.threadId)); }
      const turn: FixtureTurn = {
        threadId: String(params.threadId), turnId: `${this.turnIdPrefix}-${++this.turnSequence}`,
        input: params.input as CodexUserInput[], calls, results: [], callIndex: 0,
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
    const text = this.finalResponse(structuredClone(turn.results));
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
