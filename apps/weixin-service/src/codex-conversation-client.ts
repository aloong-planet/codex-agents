import type { AppServerMessage, AppServerTransport } from "./codex-app-server-client.js";
import { ModelConnectionError, ModelProtocolError } from "./model-recovery.js";

export type ServerRequestHandle = {
  readonly message: AppServerMessage;
  isPending(): boolean;
  respond(response: AppServerMessage): boolean;
};

type Waiter = {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

type Connection = {
  transport: AppServerTransport;
  ready: boolean;
  closed: boolean;
  initializing: Promise<void> | null;
  pending: Map<string | number, Waiter>;
  serverRequests: Map<string | number, ServerRequestHandle>;
  unsubscribeMessage: () => void;
  unsubscribeExit: () => void;
};

/** Connection-scoped protocol mechanics; no turn, tool or workflow decisions. */
export class CodexConversationClient {
  private connection: Connection | null = null;
  private nextId = 1;

  constructor(
    private readonly createTransport: () => AppServerTransport,
    private readonly callbacks: {
      notification(message: AppServerMessage): void;
      serverRequest(handle: ServerRequestHandle): void;
      failure(error: Error): void;
    },
    private readonly timeoutMs = 600_000,
    private readonly initializationTimeoutMs = 20_000,
  ) {}

  get ready(): boolean { return this.connection?.ready === true; }

  async initialize(timeoutMs?: number): Promise<void> {
    if (this.connection?.ready) return;
    if (this.connection) return this.connection.initializing!;
    const connection: Connection = {
      transport: this.createTransport(), ready: false, closed: false, initializing: null,
      pending: new Map(), serverRequests: new Map(),
      unsubscribeMessage: () => {}, unsubscribeExit: () => {},
    };
    this.connection = connection;
    connection.unsubscribeMessage = connection.transport.onMessage((message) => this.receive(connection, message));
    connection.unsubscribeExit = connection.transport.onExit((error) => {
      this.fail(connection, error ?? new Error("Codex App Server 已退出"));
    });
    connection.initializing = Promise.resolve().then(async () => {
      try {
        await this.requestOn(connection, "initialize", {
          clientInfo: { name: "weixin_direct_demo", title: "Weixin Direct Demo", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }, timeoutMs);
        if (connection.closed) throw new Error("Codex App Server 已关闭");
        connection.transport.send({ method: "initialized", params: {} });
        connection.ready = true;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("Codex App Server 初始化失败");
        this.fail(connection, failure);
        throw failure;
      }
    });
    return connection.initializing;
  }

  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (!this.connection) return Promise.reject(new Error("Codex App Server 未启动"));
    return this.requestOn(this.connection, method, params, timeoutMs);
  }

  private requestOn(connection: Connection, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    if (connection.closed) return Promise.reject(new Error("Codex App Server 已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        const error = new Error(`Codex App Server 请求超时：${method}`);
        reject(method === "initialize" ? new ModelConnectionError(error) : error);
      }, Math.min(timeoutMs ?? this.timeoutMs, method === "initialize" ? this.initializationTimeoutMs : this.timeoutMs));
      connection.pending.set(id, { resolve, reject, timer });
      try { connection.transport.send({ id, method, params }); }
      catch (error) {
        this.fail(connection, error instanceof Error ? error : new Error("Codex App Server 请求发送失败"));
      }
    });
  }

  private receive(connection: Connection, message: AppServerMessage): void {
    if (connection.closed || this.connection !== connection) return;
    if (message.method && message.id !== undefined) {
      const id = message.id;
      if (connection.serverRequests.has(id)) return;
      let responded = false;
      const handle: ServerRequestHandle = {
        message: structuredClone(message),
        isPending: () => !connection.closed && !responded,
        respond: (response) => {
          if (connection.closed || responded) return false;
          // Retain the tombstone even when delivery fails: an effect may already exist.
          responded = true;
          try { connection.transport.send({ ...response, id }); }
          catch (error) {
            this.fail(connection, error instanceof Error ? error : new Error("Codex App Server 响应发送失败"));
            return false;
          }
          return true;
        },
      };
      connection.serverRequests.set(id, handle);
      this.callbacks.serverRequest(handle);
      return;
    }
    if (message.id !== undefined) {
      const waiter = connection.pending.get(message.id);
      if (!waiter) return;
      connection.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new ModelProtocolError(message.error.message ?? "Codex App Server 请求失败"));
      else waiter.resolve(message.result);
      return;
    }
    this.callbacks.notification(message);
  }

  finishServerRequests(
    threadId: string,
    turnId: string | null,
    finish: (handle: ServerRequestHandle) => void,
  ): void {
    for (const handle of this.connection?.serverRequests.values() ?? []) {
      const params = handle.message.params;
      if (!handle.isPending() || params?.threadId !== threadId ||
          (turnId !== null && params.turnId !== undefined && params.turnId !== turnId)) continue;
      finish(handle);
    }
  }

  close(): void {
    if (this.connection) this.fail(this.connection, new Error("Codex App Server 已关闭"));
  }

  private fail(connection: Connection, error: Error): void {
    if (connection.closed) return;
    error = error instanceof ModelConnectionError || error instanceof ModelProtocolError ? error : new ModelConnectionError(error);
    connection.closed = true;
    connection.ready = false;
    if (this.connection === connection) this.connection = null;
    connection.unsubscribeMessage();
    connection.unsubscribeExit();
    for (const waiter of connection.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    connection.pending.clear();
    connection.serverRequests.clear();
    try { this.callbacks.failure(error); }
    finally { connection.transport.close(); }
  }
}
