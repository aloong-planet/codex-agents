import { describe, expect, it, vi } from "vitest";

import {
  CodexPendingResponseRouter,
  FixturePendingResponseRouter,
  PENDING_RESPONSE_OUTPUT_SCHEMA,
  type PendingResponseRouterAgent,
} from "../src/workflow-pending-response-router.js";

describe("CodexPendingResponseRouter", () => {
  it("uses the App Server-compatible flat object output contract", () => {
    expect(PENDING_RESPONSE_OUTPUT_SCHEMA).toEqual({
      type: "object",
      required: ["kind", "requestRef", "choiceRefs", "goal"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["respond", "cancel", "new_goal", "clarify", "ordinary_message"] },
        requestRef: {
          anyOf: [{ type: "string", pattern: "^[a-f0-9]{12}$" }, { type: "null" }],
        },
        choiceRefs: {
          type: "array",
          items: { type: "string", pattern: "^[a-f0-9]{12}$" },
          maxItems: 100,
        },
        goal: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
  });

  it("parses only a choice reference from the constrained model output", async () => {
    const agent: PendingResponseRouterAgent = {
      startOrResume: vi.fn(async () => "router-thread"),
      reply: vi.fn(async () => JSON.stringify({
        kind: "respond",
        requestRef: "111111111111",
        choiceRefs: ["bbbbbbbbbbbb"],
        goal: null,
      })),
      releaseThread: vi.fn(),
    };
    const router = new CodexPendingResponseRouter(agent, "/isolated/router");

    await expect(router.route({
      userText: "合照那张",
      requests: [{
        requestRef: "111111111111",
        choices: [
          { choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "证件照.jpg" },
          { choiceRef: "bbbbbbbbbbbb", ordinal: 2, label: "聚会合照.jpg" },
        ],
      }],
    })).resolves.toEqual({ kind: "respond", requestRef: "111111111111", choiceRefs: ["bbbbbbbbbbbb"] });
    expect(agent.startOrResume).toHaveBeenCalledWith(undefined, "/isolated/router", []);
    expect(agent.releaseThread).toHaveBeenCalledWith("router-thread");
  });

  it("accepts multiple choices from the same pending request", async () => {
    const agent: PendingResponseRouterAgent = {
      startOrResume: vi.fn(async () => "multi-router-thread"),
      reply: vi.fn(async () => JSON.stringify({
        kind: "respond",
        requestRef: "111111111111",
        choiceRefs: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
        goal: null,
      })),
      releaseThread: vi.fn(),
    };
    const router = new CodexPendingResponseRouter(agent, "/isolated/router");

    await expect(router.route({
      userText: "两张都要",
      requests: [{
        requestRef: "111111111111",
        choices: [
          { choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "证件照.jpg" },
          { choiceRef: "bbbbbbbbbbbb", ordinal: 2, label: "聚会合照.jpg" },
        ],
      }],
    })).resolves.toEqual({
      kind: "respond",
      requestRef: "111111111111",
      choiceRefs: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
    });
  });

  it("accepts a model-semantic cancellation without host keyword matching", async () => {
    const agent: PendingResponseRouterAgent = {
      startOrResume: vi.fn(async () => "cancel-router-thread"),
      reply: vi.fn(async () => JSON.stringify({
        kind: "cancel",
        requestRef: "111111111111",
        choiceRefs: [],
        goal: null,
      })),
      releaseThread: vi.fn(),
    };
    const router = new CodexPendingResponseRouter(agent, "/isolated/router");

    await expect(router.route({
      userText: "我改主意了，这个就先放着吧",
      requests: [{
        requestRef: "111111111111",
        choices: [{ choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "证件照.jpg" }],
      }],
    })).resolves.toEqual({ kind: "cancel", requestRef: "111111111111" });
  });

  it("recognizes an independently understandable new goal without selecting a business intent id", async () => {
    const agent: PendingResponseRouterAgent = {
      startOrResume: vi.fn(async () => "new-goal-thread"),
      reply: vi.fn(async () => JSON.stringify({
        kind: "new_goal",
        requestRef: null,
        choiceRefs: [],
        goal: "在用户授权的 Pictures 目录中查找与王林相关的图片，并发送到当前微信会话",
      })),
      releaseThread: vi.fn(),
    };
    const router = new CodexPendingResponseRouter(agent, "/isolated/router");

    await expect(router.route({
      userText: "把 Pictures 里的王林图片发给我",
      requests: [{
        requestRef: "111111111111",
        choices: [
          { choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "旧照片-a.jpg" },
          { choiceRef: "bbbbbbbbbbbb", ordinal: 2, label: "旧照片-b.jpg" },
        ],
      }],
    })).resolves.toEqual({
      kind: "new_goal",
      goal: "在用户授权的 Pictures 目录中查找与王林相关的图片，并发送到当前微信会话",
    });
  });

  it("repairs one invalid response without changing the pending request", async () => {
    const reply = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        kind: "respond", requestRef: "invented", choiceRefs: ["invented"], goal: null,
      }))
      .mockResolvedValueOnce(JSON.stringify({
        kind: "respond",
        requestRef: "111111111111",
        choiceRefs: ["bbbbbbbbbbbb"],
        goal: null,
      }));
    const agent: PendingResponseRouterAgent = {
      startOrResume: vi.fn(async () => "repair-thread"),
      reply,
      releaseThread: vi.fn(),
    };
    const router = new CodexPendingResponseRouter(agent, "/isolated/router");
    const input = {
      userText: "第二张",
      requests: [{
        requestRef: "111111111111",
        choices: [
          { choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "证件照.jpg" },
          { choiceRef: "bbbbbbbbbbbb", ordinal: 2, label: "聚会合照.jpg" },
        ],
      }],
    };

    await expect(router.route(input)).resolves.toEqual({
      kind: "respond", requestRef: "111111111111", choiceRefs: ["bbbbbbbbbbbb"],
    });
    expect(reply).toHaveBeenCalledTimes(2);
    expect(JSON.parse(reply.mock.calls[1]![1] as string)).toMatchObject({
      task: "repair_output_contract",
      originalInput: { userText: "第二张" },
    });
  });

  it("interrupts the isolated router thread when model output times out", async () => {
    const cancelThread = vi.fn();
    const close = vi.fn();
    const agent: PendingResponseRouterAgent = {
      startOrResume: vi.fn(async () => "timeout-thread"),
      reply: vi.fn(async () => new Promise<string>(() => undefined)),
      cancelThread,
      close,
      releaseThread: vi.fn(),
    };
    const router = new CodexPendingResponseRouter(agent, "/isolated/router", 5);

    await expect(router.route({
      userText: "合照那张",
      requests: [{
        requestRef: "111111111111",
        choices: [{ choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "聚会合照.jpg" }],
      }],
    })).rejects.toThrow("pending_response_router_timeout");
    expect(cancelThread).toHaveBeenCalledWith("timeout-thread");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the isolated transport when thread startup fails before a thread id exists", async () => {
    const close = vi.fn();
    const agent: PendingResponseRouterAgent = {
      startOrResume: vi.fn(async () => {
        throw new Error("unsupported turn/start permissions contract");
      }),
      reply: vi.fn(),
      close,
    };
    const router = new CodexPendingResponseRouter(agent, "/isolated/router");

    await expect(router.route({
      userText: "两张都要",
      requests: [{
        requestRef: "111111111111",
        choices: [{ choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "聚会合照.jpg" }],
      }],
    })).rejects.toThrow("unsupported turn/start permissions contract");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("FixturePendingResponseRouter", () => {
  it("maps a Chinese ordinal to the matching safe choice reference", async () => {
    const router = new FixturePendingResponseRouter();

    await expect(router.route({
      userText: "第二张",
      requests: [{
        requestRef: "111111111111",
        choices: [
          { choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "album-a.png" },
          { choiceRef: "bbbbbbbbbbbb", ordinal: 2, label: "album-b.png" },
        ],
      }],
    })).resolves.toEqual({
      kind: "respond",
      requestRef: "111111111111",
      choiceRefs: ["bbbbbbbbbbbb"],
    });
  });

  it("simulates selecting every displayed choice for fixture end-to-end tests", async () => {
    const router = new FixturePendingResponseRouter();
    await expect(router.route({
      userText: "两张都要",
      requests: [{
        requestRef: "111111111111",
        choices: [
          { choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "album-a.png" },
          { choiceRef: "bbbbbbbbbbbb", ordinal: 2, label: "album-b.png" },
        ],
      }],
    })).resolves.toEqual({
      kind: "respond",
      requestRef: "111111111111",
      choiceRefs: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
    });
  });

  it("does not claim an unrelated independently understandable request", async () => {
    const router = new FixturePendingResponseRouter();

    await expect(router.route({
      userText: "把 Pictures 里的王林图片发给我",
      requests: [{
        requestRef: "111111111111",
        choices: [
          { choiceRef: "aaaaaaaaaaaa", ordinal: 1, label: "旧照片-a.jpg" },
          { choiceRef: "bbbbbbbbbbbb", ordinal: 2, label: "旧照片-b.jpg" },
        ],
      }],
    })).resolves.toEqual({ kind: "ordinary_message" });
  });
});
