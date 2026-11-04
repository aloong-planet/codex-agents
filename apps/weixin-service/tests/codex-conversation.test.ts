import { describe, expect, it, vi } from "vitest";

import {
  CodexConversation,
  type AppServerTransportFactory,
} from "../src/codex-conversation.js";
import type {
  AppServerMessage,
  AppServerTransport,
} from "../src/codex-app-server-client.js";
import type { DynamicToolHost } from "../src/dynamic-tool-host.js";

class ConversationTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];
  private listener: (message: AppServerMessage) => void = () => {};
  private exitListener: (error?: Error) => void = () => {};

  constructor(
    private readonly resumedThreadId?: string,
    private readonly resumeMissing = false,
    private readonly toolOnly = false,
  ) {}

  send(message: AppServerMessage): void {
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.method === "initialize") {
        this.listener({ id: message.id ?? -1, result: {} });
      } else if (message.method === "thread/start") {
        this.listener({ id: message.id ?? -1, result: { thread: { id: "thread-new" } } });
      } else if (message.method === "thread/resume") {
        if (this.resumeMissing) {
          this.listener({ id: message.id ?? -1, error: { message: "no rollout found for thread id" } });
        } else {
          this.listener({ id: message.id ?? -1, result: { thread: { id: this.resumedThreadId ?? "" } } });
        }
      } else if (message.method === "model/list") {
        this.listener({ id: message.id ?? -1, result: { data: [{ model: "gpt-5.6-luna", displayName: "Luna", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }], defaultReasoningEffort: "low" }], nextCursor: null } });
      } else if (message.method === "turn/start") {
        this.listener({ id: message.id ?? -1, result: { turn: { id: "turn-1" } } });
        if (!this.toolOnly) {
          this.listener({
            method: "item/agentMessage/delta",
            params: { threadId: this.resumedThreadId ?? "thread-new", turnId: "turn-1", delta: "你好，" },
          });
          this.listener({
            method: "item/agentMessage/delta",
            params: { threadId: this.resumedThreadId ?? "thread-new", turnId: "turn-1", delta: "收到。" },
          });
          this.listener({
            method: "item/completed",
            params: {
              threadId: this.resumedThreadId ?? "thread-new",
              turnId: "turn-1",
              item: { id: "agent-message", type: "agentMessage", phase: "final_answer", text: "你好，收到。" },
            },
          });
        }
        this.listener({
          method: "turn/completed",
          params: {
            threadId: this.resumedThreadId ?? "thread-new",
            turn: { id: "turn-1", status: "completed" },
          },
        });
      }
    });
  }

  requestApproval(): void {
    this.listener({ id: "approval-1", method: "item/commandExecution/requestApproval", params: {} });
  }

  emit(message: AppServerMessage): void {
    this.listener(message);
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.listener = listener;
    return () => { this.listener = () => {}; };
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListener = listener;
    return () => { this.exitListener = () => {}; };
  }

  close(): void {
    this.exitListener = () => {};
  }
}

class ParallelConversationTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];
  private listener: (message: AppServerMessage) => void = () => {};
  private nextThread = 1;

  send(message: AppServerMessage): void {
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.method === "initialize") {
        this.listener({ id: message.id ?? -1, result: {} });
      } else if (message.method === "thread/start") {
        this.listener({
          id: message.id ?? -1,
          result: { thread: { id: `thread-${this.nextThread++}` } },
        });
      } else if (message.method === "turn/start") {
        const threadId = String(message.params?.threadId);
        this.listener({
          id: message.id ?? -1,
          result: { turn: { id: `turn-${threadId}` } },
        });
      } else if (message.method === "turn/interrupt") {
        const threadId = String(message.params?.threadId);
        const turnId = String(message.params?.turnId);
        this.listener({ id: message.id ?? -1, result: {} });
        this.listener({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "interrupted" } },
        });
      }
    });
  }

  complete(threadId: string, reply: string): void {
    const turnId = `turn-${threadId}`;
    this.listener({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, delta: reply },
    });
    this.listener({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: `agent-${threadId}`, type: "agentMessage", phase: "final_answer", text: reply },
      },
    });
    this.listener({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });
  }

  emit(message: AppServerMessage): void {
    this.listener(message);
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.listener = listener;
    return () => { this.listener = () => {}; };
  }

  onExit(): () => void {
    return () => {};
  }

  close(): void {}
}

class StalledTurnStartTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];
  private listener: (message: AppServerMessage) => void = () => {};

  send(message: AppServerMessage): void {
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.method === "initialize") {
        this.listener({ id: message.id ?? -1, result: {} });
      } else if (message.method === "thread/start") {
        this.listener({ id: message.id ?? -1, result: { thread: { id: "thread-stalled" } } });
      }
    });
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.listener = listener;
    return () => { this.listener = () => {}; };
  }

  onExit(): () => void {
    return () => {};
  }

  close(): void {}
}

class HangingInitializeTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];

  send(message: AppServerMessage): void {
    this.sent.push(message);
  }

  onMessage(): () => void {
    return () => {};
  }

  onExit(): () => void {
    return () => {};
  }

  close(): void {}
}

class AcceptedButUnacknowledgedTurnTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];
  private listener: (message: AppServerMessage) => void = () => {};

  send(message: AppServerMessage): void {
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.method === "initialize") {
        this.listener({ id: message.id ?? -1, result: {} });
      } else if (message.method === "thread/start") {
        this.listener({ id: message.id ?? -1, result: { thread: { id: "thread-unacknowledged" } } });
      } else if (message.method === "turn/start") {
        this.listener({
          method: "turn/started",
          params: {
            threadId: "thread-unacknowledged",
            turn: { id: "turn-unacknowledged" },
          },
        });
      }
    });
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.listener = listener;
    return () => { this.listener = () => {}; };
  }

  onExit(): () => void {
    return () => {};
  }

  close(): void {}
}

function factoryFor(transport: AppServerTransport): AppServerTransportFactory {
  return () => transport;
}

describe("CodexConversation", () => {
  it("app_server_initialization_budget: bounds initialization independently from the request failsafe", async () => {
    vi.useFakeTimers();
    try {
      const transport = new HangingInitializeTransport();
      const conversation = new CodexConversation(factoryFor(transport), 600_000);
      let settled = false;
      const outcome = conversation.startOrResume(undefined, "/workspace").then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );

      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(settled).toBe(true);
      await expect(outcome).resolves.toMatchObject({
        message: "Codex App Server 请求超时：initialize",
      });
      expect(transport.sent).toContainEqual(expect.objectContaining({ method: "initialize" }));
      await conversation.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports cold initialization and thread creation separately, then marks a warm initialization as skipped", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    const cold: unknown[] = [];
    const warm: unknown[] = [];

    await conversation.startOrResume(undefined, "/workspace", [], (event) => cold.push(event));
    await conversation.startOrResume(undefined, "/workspace", [], (event) => warm.push(event));

    expect(cold).toEqual([
      { kind: "app_server_initialize", phase: "start" },
      { kind: "app_server_initialize", phase: "end", outcome: "succeeded" },
      { kind: "thread_start", phase: "start" },
      { kind: "thread_start", phase: "end", outcome: "succeeded" },
    ]);
    expect(warm).toEqual([
      { kind: "app_server_initialize", phase: "start" },
      { kind: "app_server_initialize", phase: "end", outcome: "skipped" },
      { kind: "thread_start", phase: "start" },
      { kind: "thread_start", phase: "end", outcome: "succeeded" },
    ]);
  });

  it("creates a fresh App Server transport after the isolated host is closed", async () => {
    const first = new ConversationTransport();
    const second = new ConversationTransport();
    const transports = [first, second];
    const factory = vi.fn(() => transports.shift()!);
    const conversation = new CodexConversation(factory, 1_000);

    await expect(conversation.startOrResume(undefined, "/workspace")).resolves.toBe("thread-new");
    await conversation.close();
    await expect(conversation.startOrResume(undefined, "/workspace")).resolves.toBe("thread-new");

    expect(factory).toHaveBeenCalledTimes(2);
    expect(first.sent.some((message) => message.method === "initialize")).toBe(true);
    expect(second.sent.some((message) => message.method === "initialize")).toBe(true);
  });

  it("lists sanitized models and applies a frozen model to turn/start", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    const threadId = await conversation.startOrResume(undefined, "/workspace");

    await expect(conversation.listModels()).resolves.toEqual([{ model: "gpt-5.6-luna", displayName: "Luna", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low" }]);
    await conversation.reply(threadId, "hello", undefined, undefined, { model: "gpt-5.6-luna", effort: "low" });

    expect(transport.sent.find((message) => message.method === "turn/start")?.params).toMatchObject({ model: "gpt-5.6-luna", effort: "low" });
    await conversation.close();
  });

  it("rejects an explicitly unsupported structured main turn before submitting it", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000, undefined, undefined, 1_000,
      { structuredOutputSupported: false });
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    await expect(conversation.reply(threadId, "hello", undefined, undefined, {
      model: "gpt-5.6-luna", effort: "low", outputSchema: { type: "object" },
    })).rejects.toThrow("main_reply_schema_unsupported");
    expect(transport.sent.some((message) => message.method === "turn/start")).toBe(false);
    await conversation.close();
  });

  it("reports a redacted turn lifecycle around App Server, model activity, and final generation", async () => {
    const transport = new ParallelConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const events: unknown[] = [];

    const reply = conversation.reply(threadId, "answer directly", undefined, (event) => {
      events.push(event);
    });
    await vi.waitFor(() => {
      expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true);
    });
    transport.emit({
      method: "turn/started",
      params: { threadId, turn: { id: `turn-${threadId}`, status: "inProgress" } },
    });
    transport.emit({
      method: "item/started",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        item: { id: "reasoning-1", type: "reasoning", summary: ["private"] },
      },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        item: { id: "reasoning-1", type: "reasoning", summary: ["private"] },
      },
    });
    transport.complete(threadId, "done");

    await expect(reply).resolves.toBe("done");
    expect(events).toEqual([
      { kind: "turn_submitted" },
      { kind: "turn_accepted" },
      { kind: "model_activity", activity: "reasoning" },
      { kind: "reasoning", itemId: "reasoning-1", phase: "start" },
      { kind: "reasoning", itemId: "reasoning-1", phase: "end" },
      { kind: "model_activity", activity: "agent_message" },
      { kind: "agent_message_delta" },
      { kind: "turn_cleanup", phase: "start" },
      { kind: "turn_cleanup", phase: "end" },
      { kind: "turn_completed", status: "completed" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("done");
    await conversation.close();
  });

  it("app_server_final_message_precedence: returns the last completed final answer instead of commentary or deltas", async () => {
    const transport = new ParallelConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    const threadId = await conversation.startOrResume(undefined, "/workspace");

    const reply = conversation.reply(threadId, "answer with one final message");
    await vi.waitFor(() => {
      expect(transport.sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
    });
    const turnId = `turn-${threadId}`;
    transport.emit({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, itemId: "commentary-1", delta: "不要把这段过程发给用户。" },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "commentary-1", type: "agentMessage", phase: "commentary", text: "内部过程。" },
      },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "fallback-1", type: "agentMessage", text: "兼容候选。" },
      },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "final-1", type: "agentMessage", phase: "final_answer", text: "这是较早的最终答案。" },
      },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "final-2", type: "agentMessage", phase: "final_answer", text: "这是权威最终答案。" },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });

    await expect(reply).resolves.toBe("这是权威最终答案。");
    await conversation.close();
  });

  it("app_server_turn_completion_state_machine: rejects a completed model-owned turn without an authoritative reply", async () => {
    const transport = new ParallelConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const events: unknown[] = [];

    const reply = conversation.reply(threadId, "do not expose commentary", undefined, (event) => events.push(event));
    await vi.waitFor(() => {
      expect(transport.sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
    });
    const turnId = `turn-${threadId}`;
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "commentary-only", type: "agentMessage", phase: "commentary", text: "内部过程。" },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });

    await expect(reply).rejects.toThrow("Codex turn 已完成但没有权威文本回复");
    expect(events).toContainEqual({ kind: "turn_completed", status: "failed" });
    await conversation.close();
  });

  it("app_server_turn_completion_state_machine: closes the permission snapshot on a failed turn", async () => {
    const transport = new ParallelConversationTransport();
    const guard = { request: vi.fn(async () => ({})), complete: vi.fn() };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, undefined, guard);
    const threadId = await conversation.startOrResume(undefined, "/workspace");

    const reply = conversation.reply(threadId, "fail after a write");
    await vi.waitFor(() => {
      expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true);
    });
    transport.emit({
      method: "turn/completed",
      params: { threadId, turn: { id: `turn-${threadId}`, status: "failed" } },
    });

    await expect(reply).rejects.toThrow("Codex turn 未完成：failed");
    expect(guard.complete).toHaveBeenCalledOnce();
    expect(guard.complete).toHaveBeenCalledWith(threadId, `turn-${threadId}`);
    await conversation.close();
  });

  it("app_server_turn_completion_state_machine: preserves a permission snapshot failure when turn/start times out", async () => {
    vi.useFakeTimers();
    try {
      const transport = new AcceptedButUnacknowledgedTurnTransport();
      const guard = {
        request: vi.fn(async () => ({})),
        complete: vi.fn(() => { throw new Error("snapshot failed"); }),
      };
      const conversation = new CodexConversation(factoryFor(transport), 100, undefined, guard, 1_000);
      const threadId = await conversation.startOrResume(undefined, "/workspace");
      const outcome = conversation.reply(threadId, "fail while closing the snapshot").then(
        () => "resolved",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(100);

      await expect(outcome).resolves.toMatchObject({
        message: "写入可能已完成，但本地变更记录失败；请检查快照后再继续",
      });
      expect(guard.complete).toHaveBeenCalledOnce();
      await conversation.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports fixed safe labels for supported tool lifecycle events without exposing raw details", async () => {
    const transport = new ParallelConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const progress: unknown[] = [];

    const reply = conversation.reply(threadId, "run a command", undefined, (event) => {
      progress.push(event);
    });
    await vi.waitFor(() => {
      expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true);
    });

    transport.emit({
      method: "item/started",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        item: {
          id: "item-1",
          type: "commandExecution",
          command: "cat /private/secret",
          cwd: "/private",
          status: "inProgress",
        },
      },
    });
    transport.emit({
      method: "item/started",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        item: { id: "reasoning-1", type: "reasoning", text: "private chain" },
      },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        item: {
          id: "item-1",
          type: "commandExecution",
          command: "cat /private/secret",
          cwd: "/private",
          status: "failed",
        },
      },
    });
    transport.complete(threadId, "done");

    await expect(reply).resolves.toBe("done");
    expect(progress).toEqual(expect.arrayContaining([
      { kind: "tool", itemId: "item-1", label: "执行本地命令", phase: "start" },
      { kind: "tool", itemId: "item-1", label: "执行本地命令", phase: "end", status: "failed" },
    ]));
    expect(JSON.stringify(progress)).not.toContain("secret");
    expect(JSON.stringify(progress)).not.toContain("/private");
  });

  it("runs different target threads concurrently without mixing their replies", async () => {
    const transport = new ParallelConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);

    const firstThread = await conversation.startOrResume(undefined, "/workspace", ["/workspace", "/vault"]);
    const secondThread = await conversation.startOrResume(undefined, "/workspace", ["/workspace", "/vault"]);
    expect(firstThread).toBe("thread-1");
    expect(secondThread).toBe("thread-2");

    const firstReply = conversation.reply(firstThread, "first target");
    const secondReply = conversation.reply(secondThread, "second target");
    await vi.waitFor(() => {
      expect(transport.sent.filter((message) => message.method === "turn/start")).toHaveLength(2);
    });

    transport.complete(secondThread, "second reply");
    transport.complete(firstThread, "first reply");

    await expect(firstReply).resolves.toBe("first reply");
    await expect(secondReply).resolves.toBe("second reply");
    expect(transport.sent.filter((message) => message.method === "initialize")).toHaveLength(1);
  });

  it("keeps a tool turn alive beyond the short protocol request timeout", async () => {
    const transport = new ParallelConversationTransport();
    const conversation = new CodexConversation(
      factoryFor(transport),
      20,
      undefined,
      undefined,
      100,
    );
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "long tool task");
    const assertion = expect(reply).resolves.toBe("completed after request budget");
    await new Promise((resolve) => setTimeout(resolve, 40));
    transport.complete(threadId, "completed after request budget");

    await assertion;
  });

  it("allows a dedicated turn to run without a total-turn deadline", async () => {
    vi.useFakeTimers();
    try {
      const transport = new ParallelConversationTransport();
      const conversation = new CodexConversation(
        factoryFor(transport),
        1_000,
        undefined,
        undefined,
        null,
      );
      const threadId = await conversation.startOrResume(undefined, "/workspace");
      const reply = conversation.reply(threadId, "long progressing task");
      await vi.waitFor(() => {
        expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true);
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000);
      transport.complete(threadId, "completed without a wall clock deadline");

      await expect(reply).resolves.toBe("completed without a wall clock deadline");
      await conversation.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("app_server_no_progress_watchdog: refreshes the idle deadline for continuing protocol progress", async () => {
    vi.useFakeTimers();
    try {
      const transport = new ParallelConversationTransport();
      const conversation = new CodexConversation(
        factoryFor(transport),
        1_000,
        undefined,
        undefined,
        100,
      );
      const threadId = await conversation.startOrResume(undefined, "/workspace");
      const outcome = conversation.reply(threadId, "keep progressing").then(
        (value) => value,
        (error: unknown) => error,
      );
      await vi.waitFor(() => {
        expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true);
      });

      for (let index = 0; index < 3; index += 1) {
        await vi.advanceTimersByTimeAsync(80);
        transport.emit({
          method: "item/reasoning/textDelta",
          params: { threadId, turnId: `turn-${threadId}`, delta: `private-${index}` },
        });
      }
      transport.emit({
        method: "item/completed",
        params: {
          threadId,
          turnId: `turn-${threadId}`,
          item: { id: "final-1", type: "agentMessage", phase: "final_answer", text: "still alive" },
        },
      });
      transport.emit({
        method: "turn/completed",
        params: { threadId, turn: { id: `turn-${threadId}`, status: "completed" } },
      });

      await expect(outcome).resolves.toBe("still alive");
      await conversation.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("app_server_no_progress_watchdog: refreshes on both a tool request and its response", async () => {
    vi.useFakeTimers();
    try {
      const transport = new ParallelConversationTransport();
      let finishTool: (() => void) | undefined;
      const host: DynamicToolHost = {
        definitions: () => [],
        execute: async () => {
          await new Promise<void>((resolve) => { finishTool = resolve; });
          return { success: true, contentItems: [{ type: "inputText", text: "done" }] };
        },
      };
      const conversation = new CodexConversation(factoryFor(transport), 1_000, host, undefined, 100);
      const threadId = await conversation.startOrResume(undefined, "/workspace");
      const outcome = conversation.reply(threadId, "run the tool").then(
        (value) => value,
        (error: unknown) => error,
      );
      await vi.waitFor(() => {
        expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true);
      });

      await vi.advanceTimersByTimeAsync(80);
      transport.emit({
        id: "slow-tool",
        method: "item/tool/call",
        params: { threadId, turnId: `turn-${threadId}`, tool: "find", arguments: {} },
      });
      await vi.advanceTimersByTimeAsync(80);
      finishTool?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(transport.sent.some((message) => message.id === "slow-tool" && message.result)).toBe(true);
      await vi.advanceTimersByTimeAsync(80);
      transport.emit({
        method: "item/completed",
        params: {
          threadId,
          turnId: `turn-${threadId}`,
          item: { id: "final-1", type: "agentMessage", phase: "final_answer", text: "tool completed" },
        },
      });
      transport.emit({
        method: "turn/completed",
        params: { threadId, turn: { id: `turn-${threadId}`, status: "completed" } },
      });

      await expect(outcome).resolves.toBe("tool completed");
      await conversation.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("app_server_no_progress_watchdog: fails a turn that produces no progress", async () => {
    vi.useFakeTimers();
    try {
      const transport = new ParallelConversationTransport();
      const conversation = new CodexConversation(factoryFor(transport), 1_000, undefined, undefined, 100);
      const threadId = await conversation.startOrResume(undefined, "/workspace");
      const reply = conversation.reply(threadId, "stall");
      const assertion = expect(reply).rejects.toThrow("Codex 回合无进展超时");
      await vi.waitFor(() => {
        expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true);
      });

      await vi.advanceTimersByTimeAsync(101);

      await assertion;
      await conversation.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("app_server_no_progress_watchdog: closes a stalled turn/start before the request failsafe", async () => {
    vi.useFakeTimers();
    try {
      const transport = new StalledTurnStartTransport();
      const conversation = new CodexConversation(factoryFor(transport), 1_000, undefined, undefined, 100);
      const threadId = await conversation.startOrResume(undefined, "/workspace");
      const reply = conversation.reply(threadId, "stall before acceptance");
      const assertion = expect(reply).rejects.toThrow("Codex 回合无进展超时");
      await vi.waitFor(() => {
        expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true);
      });

      await vi.advanceTimersByTimeAsync(1_001);

      await assertion;
      await conversation.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports allowlisted streaming notifications as turn progress", async () => {
    const transport = new ParallelConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000, undefined, undefined, null);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const events: string[] = [];
    const reply = conversation.reply(threadId, "streaming task", undefined, (event) => {
      events.push(event.kind);
    });
    await vi.waitFor(() => {
      expect(events).toContain("turn_accepted");
    });

    for (const method of [
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "item/mcpToolCall/progress",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/textDelta",
      "item/plan/delta",
    ]) {
      transport.emit({
        method,
        params: { threadId, turnId: `turn-${threadId}` },
      });
    }
    transport.emit({
      method: "error",
      params: { threadId, turnId: `turn-${threadId}`, willRetry: true },
    });
    transport.complete(threadId, "done");

    await expect(reply).resolves.toBe("done");
    expect(events.filter((kind) => kind === "protocol_progress")).toHaveLength(7);
    await conversation.close();
  });

  it("interrupts an active turn and waits for its terminal event before releasing the thread", async () => {
    const transport = new ParallelConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000, undefined, undefined, null);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    let accepted = false;
    const reply = conversation.reply(threadId, "stalled task", undefined, (event) => {
      if (event.kind === "turn_accepted") accepted = true;
    }).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(accepted).toBe(true);
    });

    await expect(conversation.interruptThread(threadId)).resolves.toBeUndefined();
    await expect(reply).resolves.toEqual(expect.objectContaining({
      message: "Codex turn 未完成：interrupted",
    }));
    expect(transport.sent).toContainEqual(expect.objectContaining({
      method: "turn/interrupt",
      params: { threadId, turnId: `turn-${threadId}` },
    }));
    expect(() => conversation.releaseThread(threadId)).not.toThrow();
    await conversation.close();
  });

  it("starts a fresh persistent thread and returns streamed replies", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);

    await expect(conversation.startOrResume(undefined, "/workspace")).resolves.toBe("thread-new");
    await expect(conversation.reply("微信用户说：Hi")).resolves.toBe("你好，收到。");

    expect(transport.sent).toContainEqual(expect.objectContaining({
      method: "initialize",
      params: expect.objectContaining({
        capabilities: expect.objectContaining({ experimentalApi: true }),
      }),
    }));
    expect(transport.sent).toContainEqual(expect.objectContaining({
      method: "thread/start",
      params: expect.objectContaining({
        cwd: "/workspace",
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        runtimeWorkspaceRoots: ["/workspace"],
        config: { web_search: "live" },
        serviceName: "weixin_direct_demo",
      }),
    }));
  });

  it("starts a specialized service with live web search disabled", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(
      factoryFor(transport),
      1_000,
      undefined,
      undefined,
      1_000,
      {
        serviceName: "weixin_memory_curator",
        webSearch: "disabled",
        runtimeProfile: {
          model: "gpt-5.6-terra",
          reasoningEffort: "low",
          baseInstructions: "只执行账户记忆整理。",
          outputSchema: {
            type: "object",
            required: ["decisions"],
            properties: { decisions: { type: "array" } },
          },
        },
      },
    );

    await conversation.startOrResume(undefined, "/private/curator", []);

    expect(transport.sent).toContainEqual(expect.objectContaining({
      method: "thread/start",
      params: expect.objectContaining({
        cwd: "/private/curator",
        runtimeWorkspaceRoots: [],
        config: { web_search: "disabled" },
        serviceName: "weixin_memory_curator",
        model: "gpt-5.6-terra",
        baseInstructions: "只执行账户记忆整理。",
      }),
    }));
    const threadStart = transport.sent.find((message) => message.method === "thread/start");
    expect(threadStart?.params).not.toHaveProperty("developerInstructions");
    expect(threadStart?.params).not.toHaveProperty("dynamicTools");

    await conversation.reply("thread-new", "整理账户记忆", {
      revision: 0,
      approvalPolicy: "never",
      permissions: ":read-only",
    });
    expect(transport.sent).toContainEqual(expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({
        model: "gpt-5.6-terra",
        effort: "low",
        outputSchema: {
          type: "object",
          required: ["decisions"],
          properties: { decisions: { type: "array" } },
        },
      }),
    }));
  });

  it("does not change the normal conversation runtime when no specialized profile is configured", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);

    await conversation.startOrResume(undefined, "/workspace");
    await conversation.reply("thread-new", "普通聊天");

    const threadStart = transport.sent.find((message) => message.method === "thread/start");
    expect(threadStart?.params).not.toHaveProperty("model");
    expect(threadStart?.params).not.toHaveProperty("baseInstructions");
    expect(threadStart?.params).not.toHaveProperty("developerInstructions");
    const turnStart = transport.sent.find((message) => message.method === "turn/start");
    expect(turnStart?.params).not.toHaveProperty("model");
    expect(turnStart?.params).not.toHaveProperty("effort");
    expect(turnStart?.params).not.toHaveProperty("outputSchema");
  });

  it("applies the frozen restricted permission snapshot to every configured turn", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    await conversation.startOrResume(undefined, "/workspace");

    await conversation.reply("thread-new", "读取授权目录", {
      revision: 4,
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
        access: {
          type: "restricted",
          includePlatformDefaults: true,
          readableRoots: ["/workspace", "/vault"],
        },
        networkAccess: false,
      },
    });

    expect(transport.sent).toContainEqual(expect.objectContaining({
      method: "turn/start",
      params: expect.objectContaining({
        threadId: "thread-new",
        approvalPolicy: "untrusted",
        sandboxPolicy: {
          type: "readOnly",
          access: {
            type: "restricted",
            includePlatformDefaults: true,
            readableRoots: ["/workspace", "/vault"],
          },
          networkAccess: false,
        },
      }),
    }));
  });

  it("uses the current named read-only permissions profile without sending legacy permission fields", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    await conversation.startOrResume(undefined, "/private/curator", []);

    await conversation.reply("thread-new", "整理账户记忆", {
      revision: 0,
      approvalPolicy: "never",
      permissions: ":read-only",
    });

    const request = transport.sent.find((message) => message.method === "turn/start");
    expect(request).toEqual(expect.objectContaining({
      params: expect.objectContaining({
        approvalPolicy: "never",
        permissions: ":read-only",
      }),
    }));
    expect(request?.params).not.toHaveProperty("permissionProfile");
    expect(request?.params).not.toHaveProperty("sandboxPolicy");
  });

  it("allows a specialized tool-only turn to complete without assistant text", async () => {
    const transport = new ConversationTransport(undefined, false, true);
    const conversation = new CodexConversation(
      factoryFor(transport),
      1_000,
      undefined,
      undefined,
      1_000,
      { allowEmptyReply: true },
    );
    await conversation.startOrResume(undefined, "/private/curator", []);

    await expect(conversation.reply("thread-new", "只调用工具")).resolves.toBe("");
  });

  it("resumes only its saved dedicated thread", async () => {
    const transport = new ConversationTransport("thread-saved");
    const conversation = new CodexConversation(factoryFor(transport), 1_000);

    await expect(conversation.startOrResume("thread-saved", "/workspace")).resolves.toBe("thread-saved");
    expect(transport.sent).toContainEqual(expect.objectContaining({
      method: "thread/resume",
      params: expect.objectContaining({ threadId: "thread-saved" }),
    }));
    expect(transport.sent.some((message) => message.method === "thread/start")).toBe(false);
  });

  it("starts a replacement when a never-used saved thread has no rollout", async () => {
    const transport = new ConversationTransport("thread-missing", true);
    const conversation = new CodexConversation(factoryFor(transport), 1_000);

    await expect(conversation.startOrResume("thread-missing", "/workspace")).resolves.toBe("thread-new");
    expect(transport.sent.filter((message) => message.method === "thread/resume")).toHaveLength(1);
    expect(transport.sent.filter((message) => message.method === "thread/start")).toHaveLength(1);
  });

  it("declines App Server approval requests without ending the conversation", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    await conversation.startOrResume(undefined, "/workspace");

    transport.requestApproval();
    await Promise.resolve();

    expect(transport.sent).toContainEqual({ id: "approval-1", result: { decision: "decline" } });
  });

  it("app_server_non_tool_server_requests_remain_bounded: uses protocol-correct safe replies", async () => {
    const transport = new ConversationTransport();
    const conversation = new CodexConversation(factoryFor(transport), 1_000);
    await conversation.startOrResume(undefined, "/workspace");

    transport.emit({ id: "input-1", method: "item/tool/requestUserInput", params: {} });
    transport.emit({ id: "mcp-1", method: "mcpServer/elicitation/request", params: {} });
    transport.emit({ id: "tool-1", method: "item/tool/call", params: {} });
    transport.emit({ id: "permissions-1", method: "item/permissions/requestApproval", params: {} });

    expect(transport.sent).toContainEqual({ id: "input-1", result: { answers: {} } });
    expect(transport.sent).toContainEqual({
      id: "mcp-1",
      result: { action: "decline", content: null, _meta: null },
    });
    expect(transport.sent).toContainEqual({
      id: "tool-1",
      result: { contentItems: [], success: false },
    });
    expect(transport.sent).toContainEqual({
      id: "permissions-1",
      error: { code: -32000, message: "request declined" },
    });
  });

  it("routes native write permission through the turn guard and grants only its response", async () => {
    const transport = new ParallelConversationTransport();
    const guard = {
      request: vi.fn(async () => ({
        permissions: { fileSystem: { write: ["/workspace"] }, network: { enabled: false } },
        scope: "turn",
      })),
      complete: vi.fn(),
    };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, undefined, guard);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "use the tool");
    const params = {
      threadId,
      turnId: `turn-${threadId}`,
      permissions: { fileSystem: { write: ["/workspace"] }, network: { enabled: false } },
    };
    transport.emit({ id: "permissions-2", method: "item/permissions/requestApproval", params });
    await vi.waitFor(() => expect(guard.request).toHaveBeenCalledWith(params));
    expect(transport.sent).toContainEqual({
      id: "permissions-2",
      result: {
        permissions: { fileSystem: { write: ["/workspace"] }, network: { enabled: false } },
        scope: "turn",
      },
    });
    transport.complete(threadId, "done");
    await expect(reply).resolves.toBe("done");
    await conversation.close();
  });

  it("advertises and dispatches only the supplied dynamic tool host", async () => {
    const transport = new ParallelConversationTransport();
    const host: DynamicToolHost = {
      definitions: () => [{
        type: "function",
        name: "obsidian_read_markdown",
        description: "read",
        inputSchema: { type: "object" },
      }],
      execute: async (tool, argumentsValue) => ({
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify({ tool, argumentsValue }) }],
      }),
    };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, host);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "use the tool");

    expect(transport.sent).toContainEqual(expect.objectContaining({
      method: "thread/start",
      params: expect.objectContaining({ dynamicTools: host.definitions() }),
    }));
    transport.emit({
      id: "tool-real-1",
      method: "item/tool/call",
      params: { threadId, turnId: `turn-${threadId}`, namespace: null, tool: "obsidian_read_markdown", arguments: { path: "Demo.md" } },
    });
    await vi.waitFor(() => expect(transport.sent).toContainEqual({
      id: "tool-real-1",
      result: {
        success: true,
        contentItems: [{
          type: "inputText",
          text: JSON.stringify({
            tool: "obsidian_read_markdown",
            argumentsValue: { path: "Demo.md" },
          }),
        }],
      },
    }));
    transport.complete(threadId, "done");
    await expect(reply).resolves.toBe("done");
    await conversation.close();
  });

  it("app_server_turn_driver_stays_in_one_turn: continues zero, one, or multiple tool calls without another turn/start", async () => {
    const transport = new ParallelConversationTransport();
    const execute = vi.fn(async (tool: string) => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: JSON.stringify({ tool }) }],
    }));
    const host: DynamicToolHost = {
      definitions: () => [],
      execute,
    };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, host);
    const threadId = await conversation.startOrResume(undefined, "/workspace");

    const reply = conversation.reply(threadId, "use two tools, then answer");
    await vi.waitFor(() => {
      expect(transport.sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
    });
    const turnId = `turn-${threadId}`;
    transport.emit({
      id: "tool-call-1",
      method: "item/tool/call",
      params: { threadId, turnId, namespace: "files", tool: "find", arguments: { query: "alpha" } },
    });
    await vi.waitFor(() => {
      expect(transport.sent.filter((message) => message.id === "tool-call-1" && message.result)).toHaveLength(1);
    });
    transport.emit({
      id: "tool-call-2",
      method: "item/tool/call",
      params: { threadId, turnId, namespace: "files", tool: "read", arguments: { reference: "opaque-1" } },
    });
    await vi.waitFor(() => {
      expect(transport.sent.filter((message) => message.id === "tool-call-2" && message.result)).toHaveLength(1);
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "final-after-tools", type: "agentMessage", phase: "final_answer", text: "done" },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });

    await expect(reply).resolves.toBe("done");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(transport.sent.filter((message) => message.method === "turn/start")).toHaveLength(1);
    expect(transport.sent.some((message) => message.method === "turn/steer")).toBe(false);
    await conversation.close();
  });

  it("dynamic_tool_request_correlation_and_exactly_once_response: executes and answers one server request id once", async () => {
    const transport = new ParallelConversationTransport();
    let finishTool: ((result: Awaited<ReturnType<DynamicToolHost["execute"]>>) => void) | undefined;
    const execute = vi.fn(() => new Promise<Awaited<ReturnType<DynamicToolHost["execute"]>>>((resolve) => {
      finishTool = resolve;
    }));
    const host: DynamicToolHost = { definitions: () => [], execute };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, host);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "run one tool");
    await vi.waitFor(() => expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true));

    const request: AppServerMessage = {
      id: "tool-duplicate-1",
      method: "item/tool/call",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        namespace: "files",
        tool: "find",
        arguments: { query: "alpha" },
      },
    };
    transport.emit(request);
    transport.emit(structuredClone(request));

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    finishTool?.({
      success: true,
      contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true }) }],
    });
    await vi.waitFor(() => {
      expect(transport.sent.filter((message) => message.id === "tool-duplicate-1")).toHaveLength(1);
    });

    transport.emit(structuredClone(request));
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(transport.sent.filter((message) => message.id === "tool-duplicate-1")).toHaveLength(1);

    transport.complete(threadId, "done");
    await expect(reply).resolves.toBe("done");
    await conversation.close();
  });

  it("dynamic tool request correlation keeps reverse-order concurrent results on their original ids", async () => {
    const transport = new ParallelConversationTransport();
    const finish = new Map<string, (result: Awaited<ReturnType<DynamicToolHost["execute"]>>) => void>();
    const execute = vi.fn((tool: string, argumentsValue: unknown) =>
      new Promise<Awaited<ReturnType<DynamicToolHost["execute"]>>>((resolve) => {
        const query = (argumentsValue as { query: string }).query;
        finish.set(query, resolve);
      }));
    const host: DynamicToolHost = { definitions: () => [], execute };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, host);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "run two tools concurrently");
    await vi.waitFor(() => expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true));
    const turnId = `turn-${threadId}`;

    transport.emit({
      id: "tool-a",
      method: "item/tool/call",
      params: { threadId, turnId, namespace: "files", tool: "find", arguments: { query: "a" } },
    });
    transport.emit({
      id: "tool-b",
      method: "item/tool/call",
      params: { threadId, turnId, namespace: "files", tool: "find", arguments: { query: "b" } },
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));

    finish.get("b")?.({ success: true, contentItems: [{ type: "inputText", text: "result-b" }] });
    await vi.waitFor(() => expect(transport.sent.some((message) => message.id === "tool-b")).toBe(true));
    finish.get("a")?.({ success: true, contentItems: [{ type: "inputText", text: "result-a" }] });
    await vi.waitFor(() => expect(transport.sent.some((message) => message.id === "tool-a")).toBe(true));

    expect(transport.sent.filter((message) => message.id === "tool-a")).toEqual([{
      id: "tool-a",
      result: { success: true, contentItems: [{ type: "inputText", text: "result-a" }] },
    }]);
    expect(transport.sent.filter((message) => message.id === "tool-b")).toEqual([{
      id: "tool-b",
      result: { success: true, contentItems: [{ type: "inputText", text: "result-b" }] },
    }]);

    transport.complete(threadId, "done");
    await expect(reply).resolves.toBe("done");
    await conversation.close();
  });

  it("dynamic tool watchdog completes and releases a pending server request correlation", async () => {
    const transport = new ParallelConversationTransport();
    let finishTool: ((result: Awaited<ReturnType<DynamicToolHost["execute"]>>) => void) | undefined;
    const host: DynamicToolHost = {
      definitions: () => [],
      execute: () => new Promise((resolve) => { finishTool = resolve; }),
    };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, host, undefined, 20);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "run stalled tool");
    await vi.waitFor(() => expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true));
    transport.emit({
      id: "tool-stalled-1",
      method: "item/tool/call",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        namespace: "files",
        tool: "find",
        arguments: { query: "alpha" },
      },
    });

    const outcome = reply.catch((error: unknown) => error);
    await vi.waitFor(() => expect(transport.sent.filter((message) => message.id === "tool-stalled-1")).toEqual([{
      id: "tool-stalled-1",
      result: { contentItems: [], success: false },
    }]));

    finishTool?.({ success: true, contentItems: [{ type: "inputText", text: "late" }] });
    await expect(outcome).resolves.toMatchObject({ message: "Codex 回合无进展超时" });
    await Promise.resolve();
    expect(transport.sent.filter((message) => message.id === "tool-stalled-1")).toHaveLength(1);
    await conversation.close();
  });

  it("dynamic tool turn completion closes a still-pending server request correlation", async () => {
    const transport = new ParallelConversationTransport();
    let finish!: (result: Awaited<ReturnType<DynamicToolHost["execute"]>>) => void;
    const host: DynamicToolHost = {
      definitions: () => [],
      execute: () => new Promise((resolve) => { finish = resolve; }),
    };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, host);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "complete while a tool is pending");
    await vi.waitFor(() => expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true));
    const turnId = `turn-${threadId}`;
    transport.emit({
      id: "tool-pending-at-completion",
      method: "item/tool/call",
      params: { threadId, turnId, namespace: "files", tool: "find", arguments: { query: "alpha" } },
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: { id: "final-1", type: "agentMessage", phase: "final_answer", text: "done" },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });

    expect(transport.sent.filter((message) => message.id === "tool-pending-at-completion")).toEqual([{
      id: "tool-pending-at-completion",
      result: { contentItems: [], success: false },
    }]);
    finish({ success: true, contentItems: [] });
    await expect(reply).resolves.toBe("done");
    await conversation.close();
  });

  it("F1 specialized reply rejects unexpected workflow ownership without returning an empty sentinel", async () => {
    const transport = new ParallelConversationTransport();
    const host: DynamicToolHost = {
      definitions: () => [],
      turnOwner: () => "workflow",
      execute: async () => ({
        success: true,
        contentItems: [{
          type: "inputText",
          text: JSON.stringify({
            ok: true,
            data: { status: "workflow_claimed", finalReplyOwner: "workflow" },
            meta: {},
          }),
        }],
      }),
    };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, host);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "send the selected file");
    await vi.waitFor(() => expect(transport.sent.some((message) => message.method === "turn/start")).toBe(true));
    const turnId = `turn-${threadId}`;
    transport.emit({
      id: "tool-claim-1",
      method: "item/tool/call",
      params: { threadId, turnId, namespace: "weixin", tool: "send_files", arguments: {} },
    });
    await vi.waitFor(() => {
      expect(transport.sent.filter((message) => message.id === "tool-claim-1")).toHaveLength(1);
    });
    transport.emit({
      method: "item/completed",
      params: {
        threadId,
        turnId,
        item: {
          id: "model-tail-after-claim",
          type: "agentMessage",
          phase: "final_answer",
          text: "内部模型尾部文本，不应返回。",
        },
      },
    });
    transport.emit({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "completed" } },
    });

    await expect(reply).rejects.toThrow("model_only_turn_workflow_owned");
    expect(transport.sent.some((message) => message.method === "turn/interrupt")).toBe(false);
    await conversation.close();
  });

  it("preserves namespace bindings when dispatching a namespaced dynamic tool", async () => {
    const transport = new ParallelConversationTransport();
    const execute = vi.fn(async () => ({
      success: true,
      contentItems: [{ type: "inputText" as const, text: "accepted" }],
    }));
    const host: DynamicToolHost = {
      definitions: () => [{
        type: "namespace",
        name: "files",
        description: "Authorized file operations",
        tools: [{
          type: "function",
          name: "send",
          description: "Send one file",
          inputSchema: { type: "object" },
        }],
      }],
      execute,
    };
    const conversation = new CodexConversation(factoryFor(transport), 1_000, host);
    const threadId = await conversation.startOrResume(undefined, "/workspace");
    const reply = conversation.reply(threadId, "use the tool");

    transport.emit({
      id: "tool-namespace-1",
      method: "item/tool/call",
      params: {
        threadId,
        turnId: `turn-${threadId}`,
        namespace: "files",
        tool: "send",
        arguments: { query: "sample.md" },
      },
    });

    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(
      "send",
      { query: "sample.md" },
      { threadId, turnId: `turn-${threadId}`, namespace: "files" },
    ));
    expect(transport.sent).toContainEqual({
      id: "tool-namespace-1",
      result: { success: true, contentItems: [{ type: "inputText", text: "accepted" }] },
    });
    transport.complete(threadId, "done");
    await expect(reply).resolves.toBe("done");
    await conversation.close();
  });
});
