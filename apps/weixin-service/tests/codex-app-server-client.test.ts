import { describe, expect, it } from "vitest";

import {
  CodexAppServerClient,
  type AppServerMessage,
  type AppServerTransport,
} from "../src/codex-app-server-client.js";

class SuccessfulTransport implements AppServerTransport {
  readonly sent: AppServerMessage[] = [];
  private messageListener: (message: AppServerMessage) => void = () => {};
  private exitListener: (error?: Error) => void = () => {};

  send(message: AppServerMessage): void {
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.method === "initialize") {
        this.messageListener({ id: message.id ?? -1, result: { userAgent: "test" } });
      } else if (message.method === "thread/resume") {
        this.messageListener({
          id: message.id ?? -1,
          result: { thread: { id: "thread-current" } },
        });
      } else if (message.method === "turn/start") {
        this.messageListener({
          id: message.id ?? -1,
          result: { turn: { id: "turn-probe", status: "inProgress" } },
        });
        this.messageListener({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-current", turnId: "turn-probe", delta: "APP_SERVER_" },
        });
        this.messageListener({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-current", turnId: "turn-probe", delta: "BRIDGE_OK" },
        });
        this.messageListener({
          method: "turn/completed",
          params: {
            threadId: "thread-current",
            turn: { id: "turn-probe", status: "completed" },
          },
        });
      }
    });
  }

  onMessage(listener: (message: AppServerMessage) => void): () => void {
    this.messageListener = listener;
    return () => {
      this.messageListener = () => {};
    };
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exitListener = listener;
    return () => {
      this.exitListener = () => {};
    };
  }

  close(): void {
    this.exitListener = () => {};
  }
}

describe("CodexAppServerClient", () => {
  it("resumes the requested thread and returns its streamed reply", async () => {
    const transport = new SuccessfulTransport();
    const client = new CodexAppServerClient(transport, 1_000);

    await expect(
      client.runTurn({
        threadId: "thread-current",
        text: "fixed probe",
      }),
    ).resolves.toBe("APP_SERVER_BRIDGE_OK");

    expect(transport.sent).toContainEqual({ method: "initialized", params: {} });
    expect(transport.sent).toContainEqual(
      expect.objectContaining({
        method: "thread/resume",
        params: { threadId: "thread-current" },
      }),
    );
    expect(transport.sent).toContainEqual(
      expect.objectContaining({
        method: "turn/start",
        params: {
          threadId: "thread-current",
          input: [{ type: "text", text: "fixed probe" }],
        },
      }),
    );
  });

  it("rejects a server-initiated request instead of approving probe tools", async () => {
    class ApprovalTransport extends SuccessfulTransport {
      override send(message: AppServerMessage): void {
        if (message.method === "turn/start") {
          queueMicrotask(() => {
            const listener = Reflect.get(this, "messageListener") as (
              message: AppServerMessage,
            ) => void;
            listener({
              id: "approval-1",
              method: "item/commandExecution/requestApproval",
              params: { threadId: "thread-current", turnId: "turn-probe" },
            });
          });
        }
        super.send(message);
      }
    }
    const transport = new ApprovalTransport();
    const client = new CodexAppServerClient(transport, 1_000);

    await expect(
      client.runTurn({ threadId: "thread-current", text: "fixed probe" }),
    ).rejects.toThrow("探针拒绝了 App Server 请求");
    expect(transport.sent).toContainEqual({
      id: "approval-1",
      result: { decision: "decline" },
    });
  });
});
