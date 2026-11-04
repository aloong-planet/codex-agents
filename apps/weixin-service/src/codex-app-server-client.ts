export type AppServerMessage = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export interface AppServerTransport {
  send(message: AppServerMessage): void;
  onMessage(listener: (message: AppServerMessage) => void): () => void;
  onExit(listener: (error?: Error) => void): () => void;
  close(): void;
}

type RunTurnInput = {
  threadId: string;
  text: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedRecord(value: unknown, key: string): Record<string, unknown> | null {
  return asRecord(asRecord(value)?.[key]);
}

export class CodexAppServerClient {
  constructor(
    private readonly transport: AppServerTransport,
    private readonly timeoutMs = 30_000,
  ) {}

  runTurn(input: RunTurnInput): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let turnId: string | null = null;
      let reply = "";
      let unsubscribeMessage: () => void = () => {};
      let unsubscribeExit: () => void = () => {};

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeMessage();
        unsubscribeExit();
        this.transport.close();
        if (error) reject(error);
        else resolve(reply.trim());
      };

      const onResponseError = (message: AppServerMessage, stage: string): boolean => {
        if (!message.error) return false;
        finish(new Error(`${stage}失败：${message.error.message ?? "未知 App Server 错误"}`));
        return true;
      };

      const timer = setTimeout(() => {
        finish(new Error("Codex App Server 探针超时"));
      }, this.timeoutMs);

      unsubscribeMessage = this.transport.onMessage((message) => {
        if (settled) return;

        if (message.method && message.id !== undefined) {
          this.transport.send({ id: message.id, result: { decision: "decline" } });
          finish(new Error(`探针拒绝了 App Server 请求：${message.method}`));
          return;
        }

        if (message.id === 1) {
          if (onResponseError(message, "App Server 初始化")) return;
          this.transport.send({ method: "initialized", params: {} });
          this.transport.send({
            method: "thread/resume",
            id: 2,
            params: { threadId: input.threadId },
          });
          return;
        }

        if (message.id === 2) {
          if (onResponseError(message, "恢复 Codex 任务")) return;
          const resumedId = nestedRecord(message.result, "thread")?.id;
          if (resumedId !== input.threadId) {
            finish(new Error("App Server 恢复的任务与请求任务不一致"));
            return;
          }
          this.transport.send({
            method: "turn/start",
            id: 3,
            params: {
              threadId: input.threadId,
              input: [{ type: "text", text: input.text }],
            },
          });
          return;
        }

        if (message.id === 3) {
          if (onResponseError(message, "启动 Codex turn")) return;
          const receivedTurnId = nestedRecord(message.result, "turn")?.id;
          if (typeof receivedTurnId !== "string" || !receivedTurnId) {
            finish(new Error("App Server 未返回有效 turn ID"));
            return;
          }
          turnId = receivedTurnId;
          return;
        }

        if (message.method === "item/agentMessage/delta") {
          if (message.params?.threadId !== input.threadId || message.params.turnId !== turnId) return;
          if (typeof message.params.delta === "string") reply += message.params.delta;
          return;
        }

        if (message.method === "turn/completed") {
          const completedTurn = asRecord(message.params?.turn);
          if (message.params?.threadId !== input.threadId || completedTurn?.id !== turnId) return;
          if (completedTurn.status !== "completed") {
            finish(new Error(`Codex turn 未完成：${String(completedTurn.status ?? "unknown")}`));
            return;
          }
          if (!reply.trim()) {
            finish(new Error("Codex turn 已完成但没有返回文本"));
            return;
          }
          finish();
        }
      });
      unsubscribeExit = this.transport.onExit((error) => {
        finish(error ?? new Error("Codex App Server 提前退出"));
      });

      this.transport.send({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "weixin_direct_demo_probe",
            title: "Weixin Direct Demo Probe",
            version: "0.1.0",
          },
        },
      });
    });
  }
}
