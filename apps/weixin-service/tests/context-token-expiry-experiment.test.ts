import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ContextTokenExpiryExperiment,
  FileContextTokenExperimentStore,
  MemoryContextTokenExperimentStore,
} from "../src/context-token-expiry-experiment.js";
import type { ChannelSnapshot, SendTextResult } from "../src/demo-service.js";

const HOUR = 60 * 60 * 1000;
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function channelFixture() {
  const baseline = Date.parse("2026-08-19T14:07:08.213Z");
  const snapshot: ChannelSnapshot = {
    accounts: [{ accountId: "bot-a", credentialStatus: "usable" }],
    targets: [{
      accountId: "bot-a",
      target: "owner@im.wechat",
      contextUpdatedAt: baseline,
    }],
  };
  const channel = {
    snapshot,
    sent: [] as Array<{ accountId: string; target: string; message: string }>,
    result: { ok: true, acceptedSegments: 1 } as SendTextResult,
    snapshotListeners: new Set<(snapshot: ChannelSnapshot) => void>(),
    getSnapshot() { return structuredClone(this.snapshot); },
    onSnapshotChanged(listener: (snapshot: ChannelSnapshot) => void) {
      this.snapshotListeners.add(listener);
      listener(this.getSnapshot());
      return () => this.snapshotListeners.delete(listener);
    },
    publishSnapshot() {
      for (const listener of this.snapshotListeners) listener(this.getSnapshot());
    },
    async sendText(input: { accountId: string; target: string; message: string }) {
      this.sent.push(input);
      return this.result;
    },
  };
  return { baseline, channel };
}

describe("ContextTokenExpiryExperiment", () => {
  it("waits until T+23h, sends one visible probe, and schedules T+24h", async () => {
    const { baseline, channel } = channelFixture();
    let now = baseline;
    let scheduled: (() => void) | undefined;
    const store = new MemoryContextTokenExperimentStore();
    const wakeLock = { start: vi.fn(), stop: vi.fn() };
    const experiment = new ContextTokenExpiryExperiment({
      channel,
      store,
      now: () => now,
      setTimer: vi.fn((callback: () => void) => { scheduled = callback; return 1; }),
      clearTimer: vi.fn(),
      wakeLock,
    });

    experiment.activate({
      accountId: "bot-a",
      target: "owner@im.wechat",
      baselineContextUpdatedAt: baseline,
    });
    experiment.start();

    expect(channel.sent).toHaveLength(0);
    expect(experiment.getPublicState()).toMatchObject({
      status: "scheduled",
      baselineContextUpdatedAt: baseline,
      nextProbeAt: baseline + 23 * HOUR,
      attemptedProbes: 0,
    });
    expect(wakeLock.start).toHaveBeenCalledWith(48 * HOUR);

    now = baseline + 23 * HOUR;
    scheduled?.();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));

    expect(channel.sent[0]?.message).toMatch(/T\+23h.*第 1 次/u);
    expect(experiment.getPublicState()).toMatchObject({
      status: "scheduled",
      acceptedProbes: 1,
      attemptedProbes: 1,
      latestAcceptedElapsedMs: 23 * HOUR,
      nextProbeAt: baseline + 24 * HOUR,
    });
    expect(JSON.stringify(experiment.getPublicState())).not.toContain("owner@im.wechat");
  });

  it("records first ret -2 as expired and stops without another retry", async () => {
    const { baseline, channel } = channelFixture();
    let now = baseline + 23 * HOUR;
    channel.result = {
      ok: false,
      reason: "context_stale",
      providerRet: -2,
      providerErrcode: -2,
      acceptedSegments: 0,
    };
    const wakeLock = { start: vi.fn(), stop: vi.fn() };
    const experiment = new ContextTokenExpiryExperiment({
      channel,
      store: new MemoryContextTokenExperimentStore(),
      now: () => now,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      wakeLock,
    });
    experiment.activate({
      accountId: "bot-a",
      target: "owner@im.wechat",
      baselineContextUpdatedAt: baseline,
    });

    experiment.start();
    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));

    expect(experiment.getPublicState()).toMatchObject({
      status: "expired",
      attemptedProbes: 1,
      acceptedProbes: 0,
      expiredAfterMs: 23 * HOUR,
      providerRet: -2,
      providerErrcode: -2,
      nextProbeAt: null,
    });
    expect(wakeLock.stop).toHaveBeenCalledOnce();
    now += HOUR;
    expect(channel.sent).toHaveLength(1);
  });

  it("invalidates the run before sending when a new inbound context replaced the baseline", async () => {
    const { baseline, channel } = channelFixture();
    const wakeLock = { start: vi.fn(), stop: vi.fn() };
    const experiment = new ContextTokenExpiryExperiment({
      channel,
      store: new MemoryContextTokenExperimentStore(),
      now: () => baseline + 23 * HOUR,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      wakeLock,
    });
    experiment.activate({
      accountId: "bot-a",
      target: "owner@im.wechat",
      baselineContextUpdatedAt: baseline,
    });
    channel.snapshot.targets[0]!.contextUpdatedAt = baseline + 10;

    experiment.start();
    await vi.waitFor(() => expect(experiment.getPublicState().status).toBe("invalidated_by_inbound"));

    expect(channel.sent).toHaveLength(0);
    expect(wakeLock.stop).toHaveBeenCalledOnce();
  });

  it("invalidates immediately when the active target receives another inbound", () => {
    const { baseline, channel } = channelFixture();
    const wakeLock = { start: vi.fn(), stop: vi.fn() };
    const experiment = new ContextTokenExpiryExperiment({
      channel,
      store: new MemoryContextTokenExperimentStore(),
      now: () => baseline + HOUR,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      wakeLock,
    });
    experiment.activate({
      accountId: "bot-a", target: "owner@im.wechat", baselineContextUpdatedAt: baseline,
    });
    experiment.start();

    channel.snapshot.targets[0]!.contextUpdatedAt = baseline + HOUR;
    channel.publishSnapshot();

    expect(experiment.getPublicState().status).toBe("invalidated_by_inbound");
    expect(wakeLock.stop).toHaveBeenCalledOnce();
    expect(channel.sent).toHaveLength(0);
  });

  it("finishes after an accepted T+48h probe and reports a lower bound", async () => {
    const { baseline, channel } = channelFixture();
    const experiment = new ContextTokenExpiryExperiment({
      channel,
      store: new MemoryContextTokenExperimentStore(),
      now: () => baseline + 48 * HOUR,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      wakeLock: { start: vi.fn(), stop: vi.fn() },
    });
    experiment.activate({
      accountId: "bot-a", target: "owner@im.wechat", baselineContextUpdatedAt: baseline,
    });
    experiment.start();

    await vi.waitFor(() => expect(experiment.getPublicState().status).toBe("valid_through_cutoff"));
    expect(experiment.getPublicState()).toMatchObject({
      latestAcceptedElapsedMs: 48 * HOUR,
      attemptedProbes: 1,
      acceptedProbes: 1,
      nextProbeAt: null,
    });
  });

  it("persists only safe experiment metadata in a mode-0600 file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "context-experiment-"));
    tempDirs.push(directory);
    const filePath = path.join(directory, "state.json");
    const store = new FileContextTokenExperimentStore(filePath);
    const { baseline, channel } = channelFixture();
    const experiment = new ContextTokenExpiryExperiment({
      channel,
      store,
      now: () => baseline,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      wakeLock: { start: vi.fn(), stop: vi.fn() },
    });

    experiment.activate({
      accountId: "bot-a", target: "owner@im.wechat", baselineContextUpdatedAt: baseline,
    });

    const raw = fs.readFileSync(filePath, "utf8");
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(raw).not.toContain("private-context-token");
    expect(raw).not.toContain("messageId");
  });

  it("marks an interrupted in-flight probe unknown instead of sending it again", () => {
    const { baseline, channel } = channelFixture();
    const store = new MemoryContextTokenExperimentStore({
      version: 1,
      status: "probing",
      accountId: "bot-a",
      target: "owner@im.wechat",
      baselineContextUpdatedAt: baseline,
      firstProbeAt: baseline + 23 * HOUR,
      cutoffAt: baseline + 48 * HOUR,
      nextProbeAt: baseline + 23 * HOUR,
      attemptedProbes: 1,
      acceptedProbes: 0,
      probes: [],
      updatedAt: baseline + 23 * HOUR,
    });
    const experiment = new ContextTokenExpiryExperiment({
      channel,
      store,
      now: () => baseline + 23 * HOUR + 1000,
      setTimer: vi.fn(() => 1),
      clearTimer: vi.fn(),
      wakeLock: { start: vi.fn(), stop: vi.fn() },
    });

    experiment.start();

    expect(channel.sent).toHaveLength(0);
    expect(experiment.getPublicState()).toMatchObject({ status: "unknown", nextProbeAt: null });
  });
});
