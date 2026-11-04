import type {
  TypingInitializationDiagnostics,
  TypingInitializationDiagnosticStep,
} from "./demo-service.js";

export type IlinkTypingContext = {
  accountId: string;
  target: string;
  contextToken: string;
};

export type IlinkTypingLease = {
  active: boolean;
  diagnostics: TypingInitializationDiagnostics;
  stop(): Promise<void>;
};

export type IlinkTypingApi = {
  getConfig(context: IlinkTypingContext): Promise<{ ret: number; typingTicket: string }>;
  sendTyping(context: IlinkTypingContext, typingTicket: string, status: 1 | 2): Promise<void>;
};

type CacheEntry = {
  ticket: string;
  nextFetchAt: number;
  retryDelayMs: number;
  contextToken: string;
  getConfig: TypingInitializationDiagnosticStep;
};

type TicketResolution = {
  ticket: string;
  cache: "hit" | "miss";
  getConfig: TypingInitializationDiagnosticStep;
};

type InFlightRequest = {
  contextToken: string;
  promise: Promise<TicketResolution>;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const INITIAL_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60 * 60 * 1000;
const KEEPALIVE_MS = 5_000;

export class IlinkTypingManager {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly latestContexts = new Map<string, IlinkTypingContext>();
  private readonly activeStops = new Set<() => Promise<void>>();
  private generation = 0;

  constructor(
    private readonly api: IlinkTypingApi,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {}

  prefetch(context: IlinkTypingContext): void {
    this.latestContexts.set(this.key(context), context);
    void this.resolveTicket(context).catch(() => {});
  }

  async start(context: IlinkTypingContext): Promise<IlinkTypingLease> {
    const resolved = await this.resolveTicket(context);
    const diagnostics: TypingInitializationDiagnostics = {
      ticketCache: resolved.cache,
      getConfig: resolved.getConfig,
      sendStart: { durationMs: 0, outcome: "skipped" },
    };
    if (!resolved.ticket) return { active: false, diagnostics, async stop() {} };
    const sendStartedAt = this.now();
    try {
      await this.api.sendTyping(context, resolved.ticket, 1);
      diagnostics.sendStart = {
        durationMs: Math.max(0, this.now() - sendStartedAt),
        outcome: "completed",
      };
    } catch {
      this.invalidate(context);
      diagnostics.sendStart = {
        durationMs: Math.max(0, this.now() - sendStartedAt),
        outcome: "failed",
      };
      return { active: false, diagnostics, async stop() {} };
    }

    let stopped = false;
    const timer = setInterval(() => {
      void this.api.sendTyping(context, resolved.ticket, 1).catch(() => {});
    }, KEEPALIVE_MS);
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.activeStops.delete(stop);
      await this.api.sendTyping(context, resolved.ticket, 2).catch(() => {});
    };
    this.activeStops.add(stop);
    return { active: true, diagnostics, stop };
  }

  close(): void {
    this.generation += 1;
    for (const stop of [...this.activeStops]) void stop();
    this.activeStops.clear();
    this.cache.clear();
    this.inFlight.clear();
    this.latestContexts.clear();
  }

  private async resolveTicket(
    context: IlinkTypingContext,
    allowNewerContextRetry = true,
  ): Promise<TicketResolution> {
    const key = this.key(context);
    this.latestContexts.set(key, context);
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && now < cached.nextFetchAt) {
      if (!cached.ticket) {
        if (cached.contextToken !== context.contextToken) {
          this.cache.delete(key);
        } else {
          return { ticket: "", cache: "miss", getConfig: cached.getConfig };
        }
      } else {
        return {
          ticket: cached.ticket,
          cache: "hit",
          getConfig: { durationMs: 0, outcome: "skipped" },
        };
      }
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      const resolved = await pending.promise;
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
      return this.retryWithNewerContextAfterFailure(
        key,
        pending.contextToken,
        resolved,
        allowNewerContextRetry,
      );
    }

    const generation = this.generation;
    const request: InFlightRequest = {
      contextToken: context.contextToken,
      promise: this.fetchTicket(key, context, cached, generation),
    };
    this.inFlight.set(key, request);
    let resolved: TicketResolution;
    try {
      resolved = await request.promise;
    } finally {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    }
    return this.retryWithNewerContextAfterFailure(
      key,
      context.contextToken,
      resolved,
      allowNewerContextRetry,
    );
  }

  private async fetchTicket(
    key: string,
    context: IlinkTypingContext,
    cached: CacheEntry | undefined,
    generation: number,
  ): Promise<TicketResolution> {
    const now = this.now();
    const startedAt = this.now();
    try {
      const response = await this.api.getConfig(context);
      if (response.ret !== 0 || !response.typingTicket) throw new Error("typing unavailable");
      if (generation !== this.generation) {
        return {
          ticket: "",
          cache: "miss",
          getConfig: { durationMs: Math.max(0, this.now() - startedAt), outcome: "failed" },
        };
      }
      const getConfig: TypingInitializationDiagnosticStep = {
        durationMs: Math.max(0, this.now() - startedAt),
        outcome: "completed",
      };
      this.cache.set(key, {
        ticket: response.typingTicket,
        nextFetchAt: now + this.random() * CACHE_TTL_MS,
        retryDelayMs: INITIAL_RETRY_MS,
        contextToken: context.contextToken,
        getConfig,
      });
      return {
        ticket: response.typingTicket,
        cache: "miss",
        getConfig,
      };
    } catch {
      const retryDelayMs = Math.min(
        (cached?.retryDelayMs ?? INITIAL_RETRY_MS) * 2,
        MAX_RETRY_MS,
      );
      const getConfig: TypingInitializationDiagnosticStep = {
        durationMs: Math.max(0, this.now() - startedAt),
        outcome: "failed",
      };
      if (generation === this.generation) {
        this.cache.set(key, {
          ticket: "",
          nextFetchAt: now + retryDelayMs,
          retryDelayMs,
          contextToken: context.contextToken,
          getConfig,
        });
      }
      return {
        ticket: "",
        cache: "miss",
        getConfig,
      };
    }
  }

  private async retryWithNewerContextAfterFailure(
    key: string,
    requestContextToken: string,
    resolved: TicketResolution,
    allowRetry: boolean,
  ): Promise<TicketResolution> {
    if (resolved.ticket || !allowRetry) return resolved;
    const latest = this.latestContexts.get(key);
    if (!latest || latest.contextToken === requestContextToken) return resolved;
    this.cache.delete(key);
    return this.resolveTicket(latest, false);
  }

  private invalidate(context: IlinkTypingContext): void {
    this.cache.set(this.key(context), {
      ticket: "",
      nextFetchAt: this.now() + INITIAL_RETRY_MS,
      retryDelayMs: INITIAL_RETRY_MS,
      contextToken: context.contextToken,
      getConfig: { durationMs: 0, outcome: "failed" },
    });
  }

  private key(context: IlinkTypingContext): string {
    return `${context.accountId}\n${context.target}`;
  }
}
