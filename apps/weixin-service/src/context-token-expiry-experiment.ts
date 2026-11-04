import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { ChannelSnapshot, SendTextResult } from "./demo-service.js";

const HOUR_MS = 60 * 60 * 1000;
const FIRST_PROBE_HOUR = 23;
const CUTOFF_HOUR = 48;

export type ContextTokenExperimentStatus =
  | "inactive"
  | "scheduled"
  | "probing"
  | "expired"
  | "valid_through_cutoff"
  | "invalidated_by_inbound"
  | "auth_stale"
  | "rejected"
  | "unknown"
  | "unavailable";

export type ContextTokenProbeRecord = {
  sequence: number;
  scheduledHour: number;
  attemptedAt: number;
  elapsedMs: number;
  outcome: "accepted" | "context_stale" | "auth_stale" | "rejected" | "unknown" | "unavailable";
  retriedSegments: number;
  providerRet?: number;
  providerErrcode?: number;
};

export type ContextTokenExperimentState = {
  version: 1;
  status: ContextTokenExperimentStatus;
  accountId?: string;
  target?: string;
  baselineContextUpdatedAt?: number;
  firstProbeAt?: number;
  cutoffAt?: number;
  nextProbeAt?: number;
  attemptedProbes: number;
  acceptedProbes: number;
  probes: ContextTokenProbeRecord[];
  expiredAfterMs?: number;
  providerRet?: number;
  providerErrcode?: number;
  wakeLockAvailable?: boolean;
  updatedAt: number;
};

export type PublicContextTokenExperimentState = {
  status: ContextTokenExperimentStatus;
  baselineContextUpdatedAt: number | null;
  firstProbeAt: number | null;
  cutoffAt: number | null;
  nextProbeAt: number | null;
  attemptedProbes: number;
  acceptedProbes: number;
  latestAcceptedElapsedMs: number | null;
  expiredAfterMs: number | null;
  providerRet?: number;
  providerErrcode?: number;
  wakeLockAvailable: boolean;
  updatedAt: number | null;
};

export interface ContextTokenExperimentStore {
  load(): ContextTokenExperimentState;
  save(state: ContextTokenExperimentState): void;
}

export interface WakeLock {
  start(durationMs: number): boolean | void;
  stop(): void;
}

type ExperimentChannel = {
  getSnapshot(): ChannelSnapshot;
  onSnapshotChanged?(listener: (snapshot: ChannelSnapshot) => void): () => void;
  sendText(input: { accountId: string; target: string; message: string }): Promise<SendTextResult>;
};

type TimerHandle = unknown;

type Options = {
  channel: ExperimentChannel;
  store: ContextTokenExperimentStore;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  wakeLock: WakeLock;
  onTerminal?: (state: PublicContextTokenExperimentState) => void;
};

function inactiveState(now = 0): ContextTokenExperimentState {
  return {
    version: 1,
    status: "inactive",
    attemptedProbes: 0,
    acceptedProbes: 0,
    probes: [],
    updatedAt: now,
  };
}

function isFiniteTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseState(value: unknown): ContextTokenExperimentState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("context 实验状态格式无效");
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || typeof state.status !== "string" ||
    !Number.isSafeInteger(state.attemptedProbes) || !Number.isSafeInteger(state.acceptedProbes) ||
    !Array.isArray(state.probes) || !isFiniteTimestamp(state.updatedAt)
  ) throw new Error("context 实验状态格式无效");
  const allowed = new Set<ContextTokenExperimentStatus>([
    "inactive", "scheduled", "probing", "expired", "valid_through_cutoff",
    "invalidated_by_inbound", "auth_stale", "rejected", "unknown", "unavailable",
  ]);
  if (!allowed.has(state.status as ContextTokenExperimentStatus)) throw new Error("context 实验状态格式无效");
  return structuredClone(value) as ContextTokenExperimentState;
}

export class MemoryContextTokenExperimentStore implements ContextTokenExperimentStore {
  constructor(private state: ContextTokenExperimentState = inactiveState()) {}
  load(): ContextTokenExperimentState { return structuredClone(this.state); }
  save(state: ContextTokenExperimentState): void { this.state = parseState(state); }
}

export class FileContextTokenExperimentStore implements ContextTokenExperimentStore {
  constructor(private readonly filePath: string) {}

  load(): ContextTokenExperimentState {
    if (!fs.existsSync(this.filePath)) return inactiveState();
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error("context 实验状态文件权限不安全");
    }
    return parseState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
  }

  save(state: ContextTokenExperimentState): void {
    const normalized = parseState(state);
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporaryPath = path.join(directory, `.context-experiment-${crypto.randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(normalized), "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporaryPath); } catch { /* file may not exist */ }
      throw error;
    }
  }
}

export class CaffeinateWakeLock implements WakeLock {
  private child: ChildProcess | null = null;

  start(durationMs: number): boolean {
    this.stop();
    const seconds = Math.max(1, Math.ceil(durationMs / 1000));
    try {
      const child = spawn("/usr/bin/caffeinate", ["-i", "-t", String(seconds)], {
        stdio: "ignore",
      });
      child.once("exit", () => {
        if (this.child === child) this.child = null;
      });
      child.once("error", () => {
        if (this.child === child) this.child = null;
      });
      child.unref();
      this.child = child;
      return true;
    } catch {
      this.child = null;
      return false;
    }
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
}

function publicState(state: ContextTokenExperimentState): PublicContextTokenExperimentState {
  const latestAccepted = [...state.probes].reverse().find((probe) => probe.outcome === "accepted");
  return {
    status: state.status,
    baselineContextUpdatedAt: state.baselineContextUpdatedAt ?? null,
    firstProbeAt: state.firstProbeAt ?? null,
    cutoffAt: state.cutoffAt ?? null,
    nextProbeAt: state.nextProbeAt ?? null,
    attemptedProbes: state.attemptedProbes,
    acceptedProbes: state.acceptedProbes,
    latestAcceptedElapsedMs: latestAccepted?.elapsedMs ?? null,
    expiredAfterMs: state.expiredAfterMs ?? null,
    ...(state.providerRet !== undefined ? { providerRet: state.providerRet } : {}),
    ...(state.providerErrcode !== undefined ? { providerErrcode: state.providerErrcode } : {}),
    wakeLockAvailable: state.wakeLockAvailable ?? false,
    updatedAt: state.updatedAt || null,
  };
}

function outcomeFor(result: SendTextResult): ContextTokenProbeRecord["outcome"] {
  if (result.ok) return "accepted";
  if (result.reason === "context_stale") return "context_stale";
  if (result.reason === "auth_stale") return "auth_stale";
  if (result.reason === "rejected") return "rejected";
  if (result.reason === "unknown") return "unknown";
  return "unavailable";
}

function terminalStatus(outcome: ContextTokenProbeRecord["outcome"]): ContextTokenExperimentStatus {
  if (outcome === "context_stale") return "expired";
  if (outcome === "auth_stale") return "auth_stale";
  if (outcome === "rejected") return "rejected";
  if (outcome === "unknown") return "unknown";
  return "unavailable";
}

function withoutNextProbe(state: ContextTokenExperimentState): ContextTokenExperimentState {
  const clean = { ...state };
  delete clean.nextProbeAt;
  return clean;
}

export class ContextTokenExpiryExperiment {
  private state: ContextTokenExperimentState;
  private timer: TimerHandle | null = null;
  private started = false;
  private closed = false;
  private probing: Promise<void> | undefined;
  private unsubscribeSnapshot: () => void = () => {};

  constructor(private readonly options: Options) {
    this.state = options.store.load();
  }

  activate(input: { accountId: string; target: string; baselineContextUpdatedAt: number }): void {
    if (!isFiniteTimestamp(input.baselineContextUpdatedAt) || input.baselineContextUpdatedAt <= 0) {
      throw new Error("context 实验基准时间无效");
    }
    const now = this.now();
    const cutoffAt = input.baselineContextUpdatedAt + CUTOFF_HOUR * HOUR_MS;
    if (now > cutoffAt) throw new Error("context 实验基准已超过 48 小时窗口");
    this.state = {
      version: 1,
      status: "scheduled",
      accountId: input.accountId,
      target: input.target,
      baselineContextUpdatedAt: input.baselineContextUpdatedAt,
      firstProbeAt: input.baselineContextUpdatedAt + FIRST_PROBE_HOUR * HOUR_MS,
      cutoffAt,
      nextProbeAt: input.baselineContextUpdatedAt + FIRST_PROBE_HOUR * HOUR_MS,
      attemptedProbes: 0,
      acceptedProbes: 0,
      probes: [],
      updatedAt: now,
    };
    this.save();
    if (this.started) this.resume();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeSnapshot = this.options.channel.onSnapshotChanged?.((snapshot) => {
      if (this.state.status !== "scheduled") return;
      const candidate = snapshot.targets.find(
        (item) => item.accountId === this.state.accountId && item.target === this.state.target,
      );
      if (candidate && candidate.contextUpdatedAt !== this.state.baselineContextUpdatedAt) {
        this.finish("invalidated_by_inbound");
      }
    }) ?? (() => {});
    if (this.state.status === "probing") {
      this.finish("unknown");
      return;
    }
    this.resume();
  }

  getPublicState(): PublicContextTokenExperimentState {
    return publicState(this.state);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelTimer();
    this.unsubscribeSnapshot();
    this.unsubscribeSnapshot = () => {};
    this.options.wakeLock.stop();
    this.started = false;
    await this.probing;
  }

  private resume(): void {
    if (this.closed) return;
    this.cancelTimer();
    if (this.state.status !== "scheduled" || !this.state.cutoffAt || !this.state.nextProbeAt) return;
    const cutoffAt = this.state.cutoffAt;
    const nextProbeAt = this.state.nextProbeAt;
    const remaining = Math.max(1, cutoffAt - this.now());
    const available = this.options.wakeLock.start(remaining) !== false;
    if (this.state.wakeLockAvailable !== available) {
      this.state = { ...this.state, wakeLockAvailable: available, updatedAt: this.now() };
      this.save();
    }
    const delay = Math.max(0, nextProbeAt - this.now());
    if (delay === 0) {
      void this.runProbe();
      return;
    }
    this.timer = (this.options.setTimer ?? setTimeout)(() => {
      this.timer = null;
      void this.runProbe();
    }, delay);
  }

  private runProbe(): Promise<void> {
    if (this.closed) return Promise.resolve();
    const run = this.performProbe().finally(() => { if (this.probing === run) this.probing = undefined; });
    this.probing = run;
    return run;
  }

  private async performProbe(): Promise<void> {
    if (this.state.status !== "scheduled") return;
    const accountId = this.state.accountId;
    const target = this.state.target;
    const baseline = this.state.baselineContextUpdatedAt;
    const cutoffAt = this.state.cutoffAt;
    if (!accountId || !target || !baseline || !cutoffAt) {
      this.finish("unavailable");
      return;
    }
    const candidate = this.options.channel.getSnapshot().targets.find(
      (item) => item.accountId === accountId && item.target === target,
    );
    if (!candidate) {
      this.finish("unavailable");
      return;
    }
    if (candidate.contextUpdatedAt !== baseline) {
      this.finish("invalidated_by_inbound");
      return;
    }
    const attemptedAt = this.now();
    const scheduledHour = Math.min(
      CUTOFF_HOUR,
      Math.max(FIRST_PROBE_HOUR, Math.floor((attemptedAt - baseline) / HOUR_MS)),
    );
    const sequence = this.state.attemptedProbes + 1;
    this.state = {
      ...this.state,
      status: "probing",
      attemptedProbes: sequence,
      updatedAt: attemptedAt,
    };
    this.save();

    let result: SendTextResult;
    try {
      result = await this.options.channel.sendText({
        accountId,
        target,
        message: `Context token 时效实验：T+${scheduledHour}h 探针（第 ${sequence} 次）。`,
      });
    } catch {
      result = { ok: false, reason: "unknown" };
    }
    const elapsedMs = Math.max(0, this.now() - baseline);
    const outcome = outcomeFor(result);
    const probe: ContextTokenProbeRecord = {
      sequence,
      scheduledHour,
      attemptedAt,
      elapsedMs,
      outcome,
      retriedSegments: result.retriedSegments ?? 0,
      ...(result.providerRet !== undefined ? { providerRet: result.providerRet } : {}),
      ...(result.providerErrcode !== undefined ? { providerErrcode: result.providerErrcode } : {}),
    };
    const probes = [...this.state.probes, probe].slice(-32);
    if (result.ok) {
      if (scheduledHour >= CUTOFF_HOUR || this.now() >= cutoffAt) {
        const terminal = withoutNextProbe(this.state);
        this.state = {
          ...terminal,
          status: "valid_through_cutoff",
          acceptedProbes: this.state.acceptedProbes + 1,
          probes,
          updatedAt: this.now(),
        };
        this.save();
        this.stopTerminal();
        return;
      }
      const nextHour = Math.min(CUTOFF_HOUR, scheduledHour + 1);
      this.state = {
        ...this.state,
        status: "scheduled",
        acceptedProbes: this.state.acceptedProbes + 1,
        probes,
        nextProbeAt: baseline + nextHour * HOUR_MS,
        updatedAt: this.now(),
      };
      this.save();
      this.resume();
      return;
    }

    const status = terminalStatus(outcome);
    const terminal = withoutNextProbe(this.state);
    this.state = {
      ...terminal,
      status,
      probes,
      ...(status === "expired" ? { expiredAfterMs: elapsedMs } : {}),
      ...(result.providerRet !== undefined ? { providerRet: result.providerRet } : {}),
      ...(result.providerErrcode !== undefined ? { providerErrcode: result.providerErrcode } : {}),
      updatedAt: this.now(),
    };
    this.save();
    this.stopTerminal();
  }

  private finish(status: ContextTokenExperimentStatus): void {
    const terminal = withoutNextProbe(this.state);
    this.state = { ...terminal, status, updatedAt: this.now() };
    this.save();
    this.stopTerminal();
  }

  private stopTerminal(): void {
    this.cancelTimer();
    this.options.wakeLock.stop();
    this.options.onTerminal?.(this.getPublicState());
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    (this.options.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
  }

  private save(): void { this.options.store.save(this.state); }
  private now(): number { return (this.options.now ?? Date.now)(); }
}
