import type { ManagedTaskMemorySource } from "./account-memory-tool-host.js";
import { SCHEDULE_SETTINGS_AUTHORITY } from "./scheduled-task-tools.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { selectPlannedEventCandidates } from "./account-event-resolver.js";
import { AccountMemoryStore, renderEventPanel, renderEventTimeline, shanghaiLocalDate, type AccountMemorySnapshot, type MemoryCommitReceipt } from "./account-memory-store.js";
import { resolveMemoryTarget, type MemorySearchCandidate } from "./account-memory-resolver.js";
import type { AccountMemoryEmbeddingStatus } from "./account-memory-search-index.js";

export type MemoryTurnEntry = {
  source?: { eventKey: string; target: string; senderAccountId?: string };
  id: string;
  text: string;
  createdAt: number;
  status?: string;
};

export type CompletedMemoryTurn = {
  accountId: string;
  target?: string;
  userEntry: MemoryTurnEntry;
  assistantEntry?: MemoryTurnEntry;
};

export type MemoryTrigger = "automatic" | "periodic" | "explicit_remember" | "explicit_correction" | "explicit_forget" | "explicit_upsert";

export type MemoryMutationPolicy =
  | { mode: "free_add" }
  | { mode: "reconcile" }
  | { mode: "single_update"; targetId: string; replacement: string; evidenceEntryId: string }
  | { mode: "single_remove"; targetId: string; evidenceEntryId: string };

export type MemoryCurationInput = {
  jobId: string;
  batchId: string;
  accountId: string;
  basedOnRevision: number;
  candidateEntries: AccountMemorySnapshot["entries"];
  managedTasks?: ManagedTaskMemorySource[];
  candidateEvents?: AccountMemorySnapshot["events"];
  reminderContext?: { batchId: string; plans: Array<{ ordinal: number; planId: string; summary: string }> };
  trigger: MemoryTrigger;
  mutationPolicy: MemoryMutationPolicy;
  turns: Array<{ userEntry: MemoryTurnEntry; assistantEntry?: MemoryTurnEntry }>;
};

export type MemoryCurationResult =
  | { status: "noop" }
  | { status: "committed"; receipt: MemoryCommitReceipt }
  | { status: "needs_clarification"; reason: "target_missing" | "target_ambiguous" | "outcome_ambiguous"; candidateIds: string[] };

export interface AccountMemoryCurator {
  curate(input: MemoryCurationInput): Promise<MemoryCurationResult>;
  cancelAccount?(accountId: string): void;
  close(): void | Promise<void>;
}

export interface AccountPlanReminderMonitor {
  start(accountIds: () => string[]): void;
  runNow(accountIds: string[]): Promise<void>;
  close(): void | Promise<void>;
}

export type MemoryAttemptDiagnostic = {
  attempt: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  stage: "snapshot" | "resolve_policy" | "curate";
  outcome: "committed" | "noop" | "needs_clarification" | "failed";
  errorCode?: string;
  retryScheduledAt?: number;
};

export type PublicMemoryAttemptDiagnostic = Omit<MemoryAttemptDiagnostic, "errorCode"> & {
  errorMessage?: string;
};

type MemoryJob = {
  id: string;
  batchId: string;
  accountId: string;
  status: "pending" | "curating" | "retry_wait" | "committed" | "noop" | "needs_clarification" | "dead_letter";
  trigger: MemoryTrigger;
  turns: MemoryCurationInput["turns"];
  reminderContext?: MemoryCurationInput["reminderContext"];
  attempt: number;
  attemptDiagnostics: MemoryAttemptDiagnostic[];
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  error?: string;
  receipt?: Pick<MemoryCommitReceipt, "added" | "updated" | "removed" | "revision" | "eventsAdded" | "eventsUpdated" | "eventsRemoved">;
  clarificationReason?: "target_missing" | "target_ambiguous" | "outcome_ambiguous";
  candidateIds?: string[];
};

type MemorySystemState = {
  version: 5;
  knownAccounts: string[];
  enabledAccounts: string[];
  disabledAccounts: string[];
  collected: Record<string, MemoryCurationInput["turns"]>;
  jobs: MemoryJob[];
};

export type AccountMemorySystemOptions = {
  managedTasks?: (accountId: string, targets: string[]) => ManagedTaskMemorySource[];
  store: AccountMemoryStore;
  curator: AccountMemoryCurator;
  statePath: string;
  retryDelaysMs?: number[];
  now?: () => number;
  search?: {
    search(accountId: string, query: string): Promise<MemorySearchCandidate[]>;
    prepare?(accountId: string): Promise<void>;
    getStatus?(accountId: string): AccountMemoryEmbeddingStatus;
  };
  searchTimeoutMs?: number;
  reminderMonitor?: AccountPlanReminderMonitor;
};

export type PublicAccountMemoryState = {
  available: true;
  accounts: Array<{
    accountId: string;
    enabled: boolean;
    status: "disabled" | "idle" | "pending" | "curating" | "needs_clarification" | "failed";
    pendingCount: number;
    entryCount: number;
    memory: string;
    eventCount: number;
    displayedEventCount: number;
    events: string;
    lastUpdatedAt?: number;
    nextAttemptAt?: number;
    lastMutation?: Pick<MemoryCommitReceipt, "added" | "updated" | "removed" | "revision" | "eventsAdded" | "eventsUpdated" | "eventsRemoved">;
    lastError?: string;
    clarificationReason?: "target_missing" | "target_ambiguous" | "outcome_ambiguous";
    candidateIds?: string[];
    recentAttempts: PublicMemoryAttemptDiagnostic[];
    planFollowUp: { targetConfirmed: boolean; reminderTarget?: string; dueCount: number; unknownCount: number };
    embedding?: AccountMemoryEmbeddingStatus;
  }>;
};

export class AccountMemorySystem {
  private readonly managedTasks: AccountMemorySystemOptions["managedTasks"];
  private readonly store: AccountMemoryStore;
  private readonly curator: AccountMemoryCurator;
  private readonly statePath: string;
  private readonly retryDelaysMs: number[];
  private readonly now: () => number;
  private readonly search?: AccountMemorySystemOptions["search"];
  private readonly searchTimeoutMs: number;
  private readonly reminderMonitor: AccountPlanReminderMonitor | undefined;
  private state: MemorySystemState;
  private started = false;
  private running = false;
  private draining: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(options: AccountMemorySystemOptions) {
    this.managedTasks = options.managedTasks;
    this.store = options.store;
    this.curator = options.curator;
    this.statePath = options.statePath;
    this.retryDelaysMs = options.retryDelaysMs ?? [60_000, 300_000, 1_800_000];
    this.now = options.now ?? Date.now;
    this.search = options.search;
    this.searchTimeoutMs = options.searchTimeoutMs ?? 15_000;
    this.reminderMonitor = options.reminderMonitor;
    this.state = this.load();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const deadLetterBodyCutoff = this.now() - 7 * 24 * 60 * 60 * 1_000;
    this.state = {
      ...this.state,
      jobs: this.state.jobs.map((job) => {
        if (job.status === "curating") {
          return { ...job, status: "pending" as const, attempt: job.attempt ?? 0, updatedAt: this.now() };
        }
        if (job.status === "dead_letter" && job.updatedAt <= deadLetterBodyCutoff && job.turns.length > 0) {
          return { ...job, turns: [] };
        }
        return job;
      }),
    };
    this.persist();
    this.schedule();
    this.reminderMonitor?.start(() => [...this.state.enabledAccounts]);
    for (const accountId of this.state.enabledAccounts) this.prepareSearch(accountId);
  }

  registerAccount(accountId: string): void {
    if (this.state.knownAccounts.includes(accountId)) return;
    const enabled = !this.state.disabledAccounts.includes(accountId);
    this.state = {
      ...this.state,
      knownAccounts: [...this.state.knownAccounts, accountId],
      enabledAccounts: enabled
        ? [...this.state.enabledAccounts, accountId]
        : this.state.enabledAccounts,
    };
    this.persist();
    if (enabled) {
      this.schedule();
      void this.reminderMonitor?.runNow([accountId]).catch(() => {});
      this.prepareSearch(accountId);
    }
  }

  enable(accountId: string): void {
    if (this.state.enabledAccounts.includes(accountId) && !this.state.disabledAccounts.includes(accountId)) return;
    this.state = {
      ...this.state,
      knownAccounts: this.state.knownAccounts.includes(accountId)
        ? this.state.knownAccounts
        : [...this.state.knownAccounts, accountId],
      enabledAccounts: this.state.enabledAccounts.includes(accountId)
        ? this.state.enabledAccounts
        : [...this.state.enabledAccounts, accountId],
      disabledAccounts: this.state.disabledAccounts.filter((id) => id !== accountId),
    };
    this.persist();
    this.schedule();
    void this.reminderMonitor?.runNow([accountId]).catch(() => {});
    this.prepareSearch(accountId);
  }

  confirmNotificationTarget(accountId: string, target: string): void {
    this.store.confirmNotificationTarget(accountId, target, this.now());
    if (this.state.enabledAccounts.includes(accountId)) void this.reminderMonitor?.runNow([accountId]).catch(() => {});
  }

  disable(accountId: string): void {
    this.state = {
      ...this.state,
      knownAccounts: this.state.knownAccounts.includes(accountId)
        ? this.state.knownAccounts
        : [...this.state.knownAccounts, accountId],
      enabledAccounts: this.state.enabledAccounts.filter((id) => id !== accountId),
      disabledAccounts: this.state.disabledAccounts.includes(accountId)
        ? this.state.disabledAccounts
        : [...this.state.disabledAccounts, accountId],
    };
    this.persist();
    this.curator.cancelAccount?.(accountId);
  }

  retryLatestFailed(accountId: string): boolean {
    if (!this.state.enabledAccounts.includes(accountId)) throw new Error("memory_account_disabled");
    let index = -1;
    for (let candidate = this.state.jobs.length - 1; candidate >= 0; candidate -= 1) {
      const job = this.state.jobs[candidate]!;
      if (job.accountId === accountId && job.status === "dead_letter" && job.turns.length > 0) {
        index = candidate;
        break;
      }
    }
    if (index === -1) return false;
    const now = this.now();
    const clean = withoutRetryFields(this.state.jobs[index]!);
    this.replaceJob(index, { ...clean, status: "pending", updatedAt: now });
    this.schedule();
    return true;
  }

  async captureTurn(turn: CompletedMemoryTurn): Promise<{ queued: boolean; jobId?: string }> {
    if (!this.state.enabledAccounts.includes(turn.accountId)) return { queued: false };
    const completedTurn = {
      userEntry: { ...turn.userEntry },
      ...(turn.assistantEntry ? { assistantEntry: { ...turn.assistantEntry } } : {}),
    };
    const trigger = classifyMemoryTrigger(turn.userEntry.text, this.safeEntries(turn.accountId));
    const reminderContext = turn.target
      ? this.store.latestReminderContext(turn.accountId, turn.target)
      : undefined;

    const now = this.now();
    const shortTurnNoop = !reminderContext && isAtMostThreeGraphemes(turn.userEntry.text);
    const job: MemoryJob = {
      id: crypto.randomUUID(),
      batchId: crypto.randomUUID(),
      accountId: turn.accountId,
      status: shortTurnNoop ? "noop" : "pending",
      trigger,
      turns: shortTurnNoop ? [] : [completedTurn],
      ...(reminderContext ? { reminderContext } : {}),
      attempt: 0,
      attemptDiagnostics: shortTurnNoop ? [{
        attempt: 1,
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        stage: "curate",
        outcome: "noop",
      }] : [],
      createdAt: now,
      updatedAt: now,
    };
    this.state = {
      ...this.state,
      collected: { ...this.state.collected, [turn.accountId]: [] },
      jobs: trimJobHistory([...this.state.jobs, job]),
    };
    this.persist();
    this.schedule();
    return { queued: true, jobId: job.id };
  }

  recall(accountId: string, currentUserText = ""): string {
    if (!this.state.enabledAccounts.includes(accountId)) return "";
    const snapshot = this.store.read(accountId, currentUserText);
    const eventTimeline = renderEventTimeline(snapshot.events, shanghaiLocalDate(this.now()));
    const historical = snapshot.events.length > 0 ? `${snapshot.markdown.trimEnd()}\n\n${eventTimeline}` : snapshot.markdown;
    return `${SCHEDULE_SETTINGS_AUTHORITY}\n以下仅为历史资料（账户记忆版本 ${snapshot.revision}）；各项最后更新时间：${JSON.stringify(snapshot.entries.map(({ id, updatedAt }) => ({ id, updatedAt })))}\n${historical}`;
  }

  getPublicState(): PublicAccountMemoryState {
    return {
      available: true,
      accounts: this.state.knownAccounts.map((accountId) => {
        const enabled = this.state.enabledAccounts.includes(accountId);
        const jobs = this.state.jobs.filter((job) => job.accountId === accountId);
        const last = jobs.at(-1);
        const active = jobs.find((job) => job.status === "curating")
          ?? jobs.find((job) => job.status === "pending");
        let snapshot: Pick<AccountMemorySnapshot, "entries" | "events" | "eventCount" | "markdown"> = { entries: [], events: [], eventCount: 0, markdown: "" };
        let storeError: string | undefined;
        try {
          snapshot = this.store.read(accountId);
        } catch (error) {
          storeError = error instanceof Error ? error.message : "memory_read_failed";
        }
        const status = storeError
          ? "failed" as const
          : !enabled
          ? "disabled" as const
          : last?.status === "retry_wait" || last?.status === "dead_letter"
          ? "failed" as const
          : last?.status === "needs_clarification"
            ? "needs_clarification" as const
          : active?.status === "curating"
            ? "curating" as const
            : active
              ? "pending" as const
              : "idle" as const;
        const lastErrorCode = storeError ?? last?.error;
        const lastError = lastErrorCode
          ? publicMemoryErrorMessage(lastErrorCode, last?.nextAttemptAt !== undefined)
          : undefined;
        const recentAttempts = jobs
          .flatMap((job) => job.attemptDiagnostics ?? [])
          .sort((left, right) => left.finishedAt - right.finishedAt)
          .slice(-10)
          .map(({ errorCode, ...attempt }) => ({
            ...attempt,
            ...(errorCode ? {
              errorMessage: publicMemoryErrorMessage(errorCode, attempt.retryScheduledAt !== undefined),
            } : {}),
          }));
        return {
          accountId,
          enabled,
          status,
          pendingCount: jobs.filter((job) => ["pending", "curating", "retry_wait"].includes(job.status)).length,
          entryCount: snapshot.entries.length,
          memory: snapshot.markdown,
          eventCount: snapshot.eventCount,
          displayedEventCount: snapshot.events.length,
          events: renderEventPanel(snapshot.events, this.now()),
          ...(last ? { lastUpdatedAt: last.updatedAt } : {}),
          ...(last?.nextAttemptAt ? { nextAttemptAt: last.nextAttemptAt } : {}),
          ...(last?.receipt ? { lastMutation: last.receipt } : {}),
          ...(lastError ? { lastError } : {}),
          ...(last?.clarificationReason ? { clarificationReason: last.clarificationReason } : {}),
          ...(last?.candidateIds ? { candidateIds: [...last.candidateIds] } : {}),
          recentAttempts,
          planFollowUp: this.store.planReminderState(accountId, this.now()),
          ...(this.search?.getStatus ? { embedding: this.search.getStatus(accountId) } : {}),
        };
      }),
    };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.closing = (async () => {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => this.reminderMonitor?.close()),
        Promise.resolve().then(() => this.curator.close()),
      ]);
      await this.draining;
      const errors = outcomes.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "memory_cleanup_failed");
    })();
    return this.closing;
  }

  private schedule(): void {
    if (!this.started || this.closed || this.running) return;
    this.running = true;
    this.draining = Promise.resolve().then(() => this.drain());
    void this.draining.catch(() => {});
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        this.promoteDueRetries();
        const index = findRunnableJobIndex(this.state.jobs, this.state.enabledAccounts);
        if (index === -1) break;
        const job = this.state.jobs[index]!;
        const startedAt = this.now();
        let stage: MemoryAttemptDiagnostic["stage"] = "snapshot";
        this.replaceJob(index, { ...job, status: "curating", updatedAt: startedAt });
        try {
          const eventQuery = [
            ...job.turns.map((turn) => turn.userEntry.text),
            ...(job.reminderContext?.plans.map((plan) => plan.summary) ?? []),
          ].join(" ");
          const snapshot = this.store.read(job.accountId, eventQuery);
          stage = "resolve_policy";
          const policy = await this.resolveMutationPolicy(job, snapshot);
          if ("clarificationReason" in policy) {
            const currentIndex = this.state.jobs.findIndex((candidate) => candidate.id === job.id);
            if (currentIndex !== -1) {
              const clean = withoutRetryFields(this.state.jobs[currentIndex]!);
              const finishedAt = this.now();
              this.replaceJob(currentIndex, {
                ...clean,
                status: "needs_clarification",
                turns: [],
                clarificationReason: policy.clarificationReason,
                candidateIds: policy.candidateIds,
                attemptDiagnostics: appendAttemptDiagnostic(clean, {
                  attempt: nextAttemptNumber(clean),
                  startedAt,
                  finishedAt,
                  durationMs: Math.max(0, finishedAt - startedAt),
                  stage,
                  outcome: "needs_clarification",
                }),
                updatedAt: finishedAt,
              });
            }
            continue;
          }
          stage = "curate";
          const targets = [...new Set(job.turns.flatMap((turn) => turn.userEntry.source ? [turn.userEntry.source.target] : []))];
          const managedTasks = this.managedTasks?.(job.accountId, targets) ?? [];
          // The store bounds all active memories to 200 entries / 12,000 characters.
          // Review the complete bounded set when ownership context exists, including legacy unlinked settings.
          const candidateEntries = managedTasks.length ? snapshot.entries : await this.selectCandidateEntries(job, snapshot, policy);
          if (this.closed) throw new Error("memory_system_closed");
          const rankedEvents = selectPlannedEventCandidates(eventQuery, snapshot.events, 20, ["pending", "occurred", "cancelled", "unfulfilled"]);
          const candidateEvents = mergeReminderEvents(rankedEvents, snapshot.events, job.reminderContext);
          const result = await this.curator.curate({
            jobId: job.id,
            batchId: job.batchId,
            accountId: job.accountId,
            basedOnRevision: snapshot.revision,
            candidateEntries,
            managedTasks,
            candidateEvents,
            ...(job.reminderContext ? { reminderContext: structuredClone(job.reminderContext) } : {}),
            trigger: job.trigger,
            mutationPolicy: policy,
            turns: job.turns.map((turn) => structuredClone(turn)),
          });
          const currentIndex = this.state.jobs.findIndex((candidate) => candidate.id === job.id);
          if (currentIndex !== -1) {
            const current = this.state.jobs[currentIndex]!;
            const clean = withoutRetryFields(current);
            const finishedAt = this.now();
            this.replaceJob(currentIndex, {
              ...clean,
              status: result.status,
              turns: [],
              ...(result.status === "committed" ? { receipt: {
                added: result.receipt.added,
                updated: result.receipt.updated,
                removed: result.receipt.removed,
                revision: result.receipt.revision,
                ...(result.receipt.eventsAdded ? { eventsAdded: result.receipt.eventsAdded } : {}),
                ...(result.receipt.eventsUpdated ? { eventsUpdated: result.receipt.eventsUpdated } : {}),
                ...(result.receipt.eventsRemoved ? { eventsRemoved: result.receipt.eventsRemoved } : {}),
              } } : {}),
              ...(result.status === "needs_clarification" ? {
                clarificationReason: result.reason,
                candidateIds: [...result.candidateIds],
              } : {}),
              attemptDiagnostics: appendAttemptDiagnostic(clean, {
                attempt: nextAttemptNumber(clean),
                startedAt,
                finishedAt,
                durationMs: Math.max(0, finishedAt - startedAt),
                stage,
                outcome: result.status,
              }),
              updatedAt: finishedAt,
            });
            if (result.status === "committed") this.prepareSearch(job.accountId);
          }
        } catch (error) {
          const currentIndex = this.state.jobs.findIndex((candidate) => candidate.id === job.id);
          if (currentIndex !== -1) {
            const current = this.state.jobs[currentIndex]!;
            const finishedAt = this.now();
            const execution = nextAttemptNumber(current);
            const errorCode = classifyMemoryAttemptError(error);
            if (!this.state.enabledAccounts.includes(job.accountId)) {
              const clean = withoutRetryFields(current);
              this.replaceJob(currentIndex, {
                ...clean,
                status: "pending",
                attemptDiagnostics: appendAttemptDiagnostic(clean, {
                  attempt: execution,
                  startedAt,
                  finishedAt,
                  durationMs: Math.max(0, finishedAt - startedAt),
                  stage,
                  outcome: "failed",
                  errorCode,
                }),
                updatedAt: finishedAt,
              });
              continue;
            }
            const attempt = (current.attempt ?? 0) + 1;
            const delay = this.retryDelaysMs[attempt - 1];
            const retryScheduledAt = delay === undefined ? undefined : finishedAt + delay;
            this.replaceJob(currentIndex, {
              ...current,
              status: delay === undefined ? "dead_letter" : "retry_wait",
              attempt,
              error: errorCode,
              ...(retryScheduledAt === undefined ? {} : { nextAttemptAt: retryScheduledAt }),
              attemptDiagnostics: appendAttemptDiagnostic(current, {
                attempt: execution,
                startedAt,
                finishedAt,
                durationMs: Math.max(0, finishedAt - startedAt),
                stage,
                outcome: "failed",
                errorCode,
                ...(retryScheduledAt === undefined ? {} : { retryScheduledAt }),
              }),
              updatedAt: finishedAt,
            });
          }
        }
      }
    } finally {
      this.running = false;
      if (!this.closed) {
        this.promoteDueRetries();
        if (findRunnableJobIndex(this.state.jobs, this.state.enabledAccounts) !== -1) this.schedule();
        else this.armRetry();
      }
    }
  }

  private replaceJob(index: number, job: MemoryJob): void {
    const jobs = [...this.state.jobs];
    jobs[index] = job;
    this.state = { ...this.state, jobs };
    this.persist();
  }

  private promoteDueRetries(): void {
    const now = this.now();
    let changed = false;
    const jobs = this.state.jobs.map((job) => {
      if (job.status !== "retry_wait" || (job.nextAttemptAt ?? Number.POSITIVE_INFINITY) > now) return job;
      changed = true;
      const rest = withoutRetryFields(job);
      return { ...rest, status: "pending" as const, updatedAt: now };
    });
    if (changed) {
      this.state = { ...this.state, jobs };
      this.persist();
    }
  }

  private armRetry(): void {
    if (this.retryTimer || this.closed) return;
    const next = this.state.jobs
      .filter((job) => job.status === "retry_wait"
        && job.nextAttemptAt !== undefined
        && this.state.enabledAccounts.includes(job.accountId))
      .map((job) => job.nextAttemptAt!)
      .sort((left, right) => left - right)[0];
    if (next === undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.promoteDueRetries();
      this.schedule();
    }, Math.max(0, next - this.now()));
  }

  private load(): MemorySystemState {
    if (!fs.existsSync(this.statePath)) {
      return { version: 5, knownAccounts: [], enabledAccounts: [], disabledAccounts: [], collected: {}, jobs: [] };
    }
    const state = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Omit<MemorySystemState, "version" | "disabledAccounts"> & {
      version?: number;
      disabledAccounts?: string[];
    };
    const migratedAt = this.now();
    const knownAccounts = state.knownAccounts ?? [...new Set([
      ...state.enabledAccounts,
      ...state.jobs.map((job) => job.accountId),
      ...Object.keys(state.collected),
    ])];
    const migratedCollectedJobs: MemoryJob[] = Object.entries(state.collected ?? {})
      .filter(([, turns]) => turns.length > 0)
      .map(([accountId, turns]) => ({
        id: crypto.randomUUID(), batchId: crypto.randomUUID(), accountId,
        status: "pending", trigger: "automatic", turns, attempt: 0, attemptDiagnostics: [],
        createdAt: turns[0]?.userEntry.createdAt ?? migratedAt,
        updatedAt: migratedAt,
      }));
    return {
      ...state,
      knownAccounts,
      version: 5,
      disabledAccounts: state.disabledAccounts
        ?? knownAccounts.filter((accountId) => !state.enabledAccounts.includes(accountId)),
      collected: Object.fromEntries(Object.keys(state.collected ?? {}).map((accountId) => [accountId, []])),
      jobs: [
        ...state.jobs.map((job) => ({
          ...job,
          trigger: !job.trigger || job.trigger === "periodic" ? "automatic" as const : job.trigger,
          attempt: job.attempt ?? 0,
          attemptDiagnostics: (job.attemptDiagnostics ?? []).slice(-5),
        })),
        ...migratedCollectedJobs,
      ],
    };
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }

  private async resolveMutationPolicy(
    job: MemoryJob,
    snapshot: AccountMemorySnapshot,
  ): Promise<MemoryMutationPolicy | { clarificationReason: "target_missing" | "target_ambiguous"; candidateIds: string[] }> {
    if (job.trigger === "automatic" || job.trigger === "periodic") return { mode: "reconcile" };
    if (job.trigger === "explicit_remember") return { mode: "free_add" };
    const evidence = job.turns.at(-1)?.userEntry;
    if (!evidence) return { clarificationReason: "target_missing", candidateIds: [] };
    let resolution = resolveMemoryTarget(evidence.text, snapshot.entries, []);
    if (resolution.status === "needs_clarification" && resolution.reason === "target_missing" && this.search) {
      const candidates = await withTimeout(
        this.search.search(job.accountId, evidence.text),
        this.searchTimeoutMs,
      ).catch(() => []);
      resolution = resolveMemoryTarget(evidence.text, snapshot.entries, candidates);
    }
    if (resolution.status === "needs_clarification") {
      if (job.trigger === "explicit_upsert" && resolution.reason === "target_missing") return { mode: "free_add" };
      return { clarificationReason: resolution.reason, candidateIds: resolution.candidateIds };
    }
    return job.trigger === "explicit_forget"
      ? { mode: "single_remove", targetId: resolution.targetId, evidenceEntryId: evidence.id }
      : { mode: "single_update", targetId: resolution.targetId, replacement: resolution.replacement, evidenceEntryId: evidence.id };
  }

  private async selectCandidateEntries(
    job: MemoryJob,
    snapshot: AccountMemorySnapshot,
    policy: MemoryMutationPolicy,
  ): Promise<AccountMemorySnapshot["entries"]> {
    const candidateIds: string[] = [];
    if (policy.mode === "single_update" || policy.mode === "single_remove") candidateIds.push(policy.targetId);
    if (this.search) {
      const rankedLists = await Promise.all(job.turns.map((turn) => withTimeout(
        this.search!.search(job.accountId, turn.userEntry.text),
        this.searchTimeoutMs,
      ).catch(() => [])));
      for (const ranked of rankedLists) {
        for (const candidate of ranked) candidateIds.push(candidate.id);
      }
    }
    const entriesById = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    const selected: AccountMemorySnapshot["entries"] = [];
    for (const id of new Set(candidateIds)) {
      const entry = entriesById.get(id);
      if (!entry) continue;
      selected.push(structuredClone(entry));
      if (selected.length === 20) break;
    }
    return selected;
  }

  private safeEntries(accountId: string): AccountMemorySnapshot["entries"] {
    try { return this.store.read(accountId).entries; }
    catch { return []; }
  }

  private prepareSearch(accountId: string): void {
    void this.search?.prepare?.(accountId).catch(() => {});
  }
}

function classifyMemoryTrigger(text: string, entries: AccountMemorySnapshot["entries"]): MemoryTrigger {
  if (/(?:有则更新|存在则更新).{0,20}(?:无则新增|没有则新增|否则新增)/u.test(text)) return "explicit_upsert";
  if (/(?:请?忘记|不要再记|删除.{0,12}记忆)/u.test(text)) return "explicit_forget";
  if (/(?:不是.{0,80}而是|更正|纠正|改成|改为|更新)/u.test(text)) {
    const hasMemoryCue = /(?:记忆|长期|偏好|习惯|约束|决定|以后|默认)/u.test(text);
    const hasStrongExistingTarget = resolveMemoryTarget(text, entries, []).status !== "needs_clarification";
    if (hasMemoryCue || hasStrongExistingTarget) return "explicit_correction";
  }
  if (/(?:请?记住|以后都|我的偏好是)/u.test(text)) return "explicit_remember";
  return "automatic";
}

function isAtMostThreeGraphemes(text: string): boolean {
  const normalized = text.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
  const graphemeCount = [...new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(normalized)].length;
  return graphemeCount <= 3;
}

function mergeReminderEvents(
  ranked: AccountMemorySnapshot["events"],
  available: AccountMemorySnapshot["events"],
  context?: MemoryCurationInput["reminderContext"],
): AccountMemorySnapshot["events"] {
  const byId = new Map(available.map((event) => [event.id, event]));
  const selected: AccountMemorySnapshot["events"] = [];
  for (const plan of context?.plans ?? []) {
    const event = byId.get(plan.planId);
    if (event) selected.push(structuredClone(event));
  }
  for (const event of ranked) {
    if (!selected.some((candidate) => candidate.id === event.id)) selected.push(structuredClone(event));
    if (selected.length === 20) break;
  }
  return selected;
}

function withoutRetryFields(job: MemoryJob): MemoryJob {
  const clean = { ...job };
  delete clean.error;
  delete clean.nextAttemptAt;
  return clean;
}

function appendAttemptDiagnostic(job: MemoryJob, diagnostic: MemoryAttemptDiagnostic): MemoryAttemptDiagnostic[] {
  return [...(job.attemptDiagnostics ?? []), diagnostic].slice(-5);
}

function nextAttemptNumber(job: MemoryJob): number {
  return Math.max(job.attempt ?? 0, job.attemptDiagnostics.at(-1)?.attempt ?? 0) + 1;
}

function publicMemoryErrorMessage(errorCode: string, willRetry: boolean): string {
  const cause = errorCode === "codex_timeout"
    ? "记忆整理服务响应超时"
    : ["curator_output_invalid", "memory_arguments_invalid", "memory_policy_violation"].includes(errorCode)
      ? "记忆整理结果格式不符合要求"
      : errorCode === "memory_event_date_mismatch"
        ? "计划日期解析结果不一致"
        : [
          "memory_event_evidence_invalid",
          "memory_event_outcome_evidence_invalid",
          "memory_event_completion_link_missing",
          "memory_event_not_active_plan",
        ].includes(errorCode)
          ? "没有唯一匹配到要更新的计划"
          : "记忆整理暂时失败";
  return `${cause}，${willRetry ? "系统将自动重试" : "请手动重试"}。`;
}

const safeMemoryErrorCodes = new Set([
  "curator_output_invalid",
  "curator_missing_tool_receipt",
  "memory_arguments_invalid",
  "memory_budget_exceeded",
  "memory_confidence_invalid",
  "memory_duplicate_value",
  "memory_embedding_dimensions_invalid",
  "memory_entry_exists",
  "memory_entry_id_invalid",
  "memory_entry_missing",
  "memory_event_date_mismatch",
  "memory_event_completion_link_missing",
  "memory_event_duplicate",
  "memory_event_evidence_invalid",
  "memory_event_exists",
  "memory_event_invalid",
  "memory_event_missing",
  "memory_event_not_active_plan",
  "memory_event_outcome_evidence_invalid",
  "memory_event_plan_invalid",
  "memory_evidence_invalid",
  "memory_integrity_error",
  "memory_policy_evidence_invalid",
  "memory_policy_violation",
  "memory_remove_evidence_invalid",
  "memory_revision_conflict",
  "memory_scope_locked",
  "memory_scope_unsafe",
  "memory_search_timeout",
  "memory_sensitive_value",
  "memory_value_invalid",
  "memory_task_authority_invalid",
  "memory_task_retained_value_invalid",
]);

function classifyMemoryAttemptError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (safeMemoryErrorCodes.has(message)) return message;
  if (/(?:timed? out|timeout|超时)/iu.test(message)) return "codex_timeout";
  if (/(?:App Server 已退出|app server.+exited)/iu.test(message)) return "codex_app_server_exited";
  if (/(?:App Server (?:transport )?已关闭|app server.+closed|transport closed)/iu.test(message)) return "codex_transport_closed";
  if (/(?:App Server 未启动|app server.+not started)/iu.test(message)) return "codex_app_server_not_started";
  if (/(?:找不到本机 Codex 可执行文件|codex executable.+not found)/iu.test(message)) return "codex_executable_missing";
  if (/(?:未返回有效.+(?:任务|turn).+ID|恢复了错误的任务|invalid message)/iu.test(message)) return "codex_protocol_invalid";
  if (/(?:专用任务尚未启动|thread.+not started)/iu.test(message)) return "codex_thread_not_started";
  if (/(?:正在处理上一条消息|专用任务仍在运行|turn.+(?:busy|active))/iu.test(message)) return "codex_turn_busy";
  if (/(?:turn 未完成|turn.+incomplete)/iu.test(message)) return "codex_turn_incomplete";
  if (/(?:turn 已完成但没有文本回复|turn.+no text)/iu.test(message)) return "codex_empty_reply";
  if (/(?:写入已完成，但本地变更记录失败|local change.+failed)/iu.test(message)) return "codex_local_change_capture_failed";
  return "curator_unexpected_error";
}

function trimJobHistory(jobs: MemoryJob[], maximum = 200): MemoryJob[] {
  const unfinished = jobs.filter((job) => ["pending", "curating", "retry_wait"].includes(job.status));
  const terminalBudget = Math.max(0, maximum - unfinished.length);
  const terminal = terminalBudget === 0
    ? []
    : jobs.filter((job) => !unfinished.includes(job)).slice(-terminalBudget);
  const retained = new Set([...unfinished, ...terminal]);
  return jobs.filter((job) => retained.has(job));
}

function findRunnableJobIndex(jobs: MemoryJob[], enabledAccounts: string[]): number {
  return jobs.findIndex((job, jobIndex) =>
    job.status === "pending"
    && enabledAccounts.includes(job.accountId)
    && !jobs.slice(0, jobIndex).some((older) =>
      older.accountId === job.accountId
      && ["pending", "curating", "retry_wait"].includes(older.status)));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("memory_search_timeout")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
