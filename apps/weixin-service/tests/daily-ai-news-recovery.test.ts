import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DailyAiNewsScheduler } from "../src/daily-ai-news-scheduler.js";
import { DailyAiNewsFileStore } from "../src/daily-ai-news-store.js";
import type { SendTextResult } from "../src/demo-service.js";
import { DurableInboundStore } from "../src/durable-inbound-store.js";
import { FixturePort } from "../src/fixture-port.js";

// Real iLink login and phone receipt remain manual acceptance; this suite uses the
// durable fixture inbound entry, file persistence, and a simulated send boundary.
class RecoveryChannel extends FixturePort {
  result: SendTextResult = { ok: false, reason: "auth_stale", providerRet: -14 };
  usable = true;
  hasOriginalTarget = true;
  beforeSend?: () => Promise<void>;
  readonly attempts: string[] = [];

  override getSnapshot() {
    const snapshot = super.getSnapshot();
    for (const account of snapshot.accounts) account.credentialStatus = this.usable ? "usable" : "stale";
    if (!this.hasOriginalTarget) snapshot.targets = [];
    snapshot.accounts.push({ accountId: "another-bot", credentialStatus: "usable" });
    snapshot.targets.push({ accountId: "another-bot", target: "another-user@im.wechat" });
    return snapshot;
  }

  override async sendText(input: { accountId: string; target: string; message: string }): Promise<SendTextResult> {
    this.attempts.push(input.message);
    await this.beforeSend?.();
    if (!this.result.ok) return this.result;
    return super.sendText(input);
  }
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup(beforeResearch?: (date: string) => Promise<void>, brief?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daily-news-recovery-"));
  fs.chmodSync(directory, 0o700);
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inbox = new DurableInboundStore(path.join(directory, "inbound.sqlite"));
  cleanups.push(() => inbox.close());
  const channel = new RecoveryChannel(inbox);
  cleanups.push(() => channel.close());
  const store = new DailyAiNewsFileStore(path.join(directory, "news.json"));
  let now = Date.parse("2026-10-10T04:00:00Z");
  const generated: string[] = [];
  const notifications: string[] = [];
  const archived: string[] = [];
  const archivedSummaries: string[] = [];
  const create = (newsStore = store) => new DailyAiNewsScheduler({
    channel,
    store: newsStore,
    now: () => now,
    notifyLocal: (_title, body) => { notifications.push(body); },
    researcher: {
      generate: async ({ date }) => {
        generated.push(date);
        await beforeResearch?.(date);
        return {
          date, generatedAt: now,
          items: [{ title: `缓存日报 ${date}`, summary: "本地模拟新闻，仅验证缓存恢复和发送顺序。", ...(brief ? { brief } : {}), source: "Fixture", url: `https://example.com/${date}`, publishedAt: new Date(now).toISOString() }],
        };
      },
    },
    archive: { archive: async (digest) => { archived.push(digest.date); archivedSummaries.push(digest.items[0]!.summary); } },
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const scheduler = create();
  cleanups.push(() => scheduler.close());
  channel.activateInboundDispatch();
  return { scheduler, channel, inbox, store, notifications, generated, archived, archivedSummaries, directory, create, setDate: (date: string) => { now = Date.parse(`${date}T04:00:00Z`); } };
}

describe("Daily news recovery through durable fixture ingress", () => {
  it("explains the blocked backlog and updates its count without sending repeated notices on unrelated snapshots", async () => {
    const { scheduler, channel, notifications, setDate } = setup();
    channel.result = { ok: false, reason: "context_stale" };
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    setDate("2026-10-11");
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    expect(scheduler.getPublicState().notice).toBe(
      "已缓存 2 份日报，最早为 2026-10-10。请从原微信会话发送一条新消息，恢复后按日期顺序续发。",
    );
    expect(notifications.at(-1)).toBe(
      "已缓存 2 份日报，最早为 2026-10-10。请从原微信会话发送一条新消息，恢复后按日期顺序续发。",
    );
    const count = notifications.length;
    channel.updateLocalLabels({ accountId: "fixture-bot", accountLabel: "新备注" });
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    expect(notifications).toHaveLength(count);
    channel.usable = false;
    await channel.emitFixtureInbound("刷新日报会话");
    expect(scheduler.getPublicState().notice).toContain("重新绑定原微信账户");
    expect(channel.getFixtureTextOutbox()).toEqual([]);
  });

  it("asks for a fresh message rather than rebinding again after credentials recover", async () => {
    const { scheduler, channel } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    channel.usable = false;
    channel.updateLocalLabels({ accountId: "fixture-bot", accountLabel: "绑定失效" });
    expect(scheduler.getPublicState().notice).toContain("重新绑定原微信账户");
    channel.usable = true;
    channel.updateLocalLabels({ accountId: "fixture-bot", accountLabel: "已重新绑定" });
    await vi.waitFor(() => expect(scheduler.getPublicState().notice).toBe(
      "已缓存 1 份日报，最早为 2026-10-10。请从原微信会话发送一条新消息，恢复后按日期顺序续发。",
    ));
    expect(channel.attempts).toHaveLength(1);
  });

  it("reconciles a context refreshed before restart and drains the saved backlog without another message", async () => {
    const { scheduler, channel, create, setDate, generated, store } = setup();
    channel.result = { ok: false, reason: "context_stale", providerRet: -2 };
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    setDate("2026-10-11");
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    scheduler.close();
    // The previous service consumed the message but did not recover historical reports.
    const ordinaryChat = channel.onInboundText(() => {});
    await channel.emitFixtureInbound("会话已经恢复");
    ordinaryChat();
    channel.result = { ok: true };
    const restarted = create();
    cleanups.push(() => restarted.close());
    await restarted.start();
    expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual([
      "2026-10-10 AI 新闻", "2026-10-11 AI 新闻",
    ]);
    expect(store.load().runs.map((run) => run.status)).toEqual(["accepted", "accepted"]);
    expect(generated).toEqual(["2026-10-10", "2026-10-11"]);
    expect(restarted.getPublicState().notice).not.toContain("刷新会话");
  });

  it("does not retry the same rejected context again after another restart", async () => {
    const { scheduler, channel, create, generated } = setup();
    channel.result = { ok: false, reason: "context_stale", providerRet: -2 };
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    scheduler.close();
    const ordinaryChat = channel.onInboundText(() => {});
    await channel.emitFixtureInbound("会话已经恢复");
    ordinaryChat();
    const firstRestart = create();
    cleanups.push(() => firstRestart.close());
    await firstRestart.start();
    expect(channel.attempts).toHaveLength(2);
    firstRestart.close();
    const secondRestart = create();
    cleanups.push(() => secondRestart.close());
    await secondRestart.start();
    expect(channel.attempts).toHaveLength(2);
    expect(channel.getFixtureTextOutbox()).toEqual([]);
    expect(generated).toEqual(["2026-10-10"]);
  });

  it("recovers a refreshed channel even when another command consumes the inbound", async () => {
    const { scheduler, channel, generated } = setup();
    channel.result = { ok: false, reason: "context_stale" };
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    const consume = channel.onInboundCommand(() => true);
    cleanups.push(consume);
    channel.result = { ok: true };
    await channel.emitFixtureInbound("更新会话但由其他命令处理");
    await vi.waitFor(() => expect(channel.getFixtureTextOutbox()).toHaveLength(1));
    expect(generated).toEqual(["2026-10-10"]);
    channel.updateLocalLabels({ accountId: "fixture-bot", accountLabel: "新备注" });
    expect(channel.attempts).toHaveLength(2);
  });

  it("recovers legacy cached failures only after context newer than their failure time", async () => {
    const { scheduler, channel, store, create, directory, generated } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    scheduler.close();
    // Earlier service versions did not persist the attempt-context checkpoint.
    const legacy = store.load();
    for (const run of legacy.runs) delete run.deliveryContextUpdatedAt;
    const legacyStore = new DailyAiNewsFileStore(path.join(directory, "legacy.json"));
    legacyStore.save(legacy);
    const restarted = create(legacyStore);
    cleanups.push(() => restarted.close());
    await restarted.start();
    expect(channel.attempts).toHaveLength(1);
    channel.result = { ok: true };
    await channel.emitFixtureInbound("刷新旧版日报会话");
    expect(legacyStore.load().runs[0]?.status).toBe("accepted");
    expect(channel.getFixtureTextOutbox()).toHaveLength(1);
    expect(generated).toEqual(["2026-10-10"]);
  });

  it("uses a refresh during a rejected attempt for recovery and shows the current action", async () => {
    const { scheduler, channel, store, inbox, generated } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    channel.result = { ok: false, reason: "context_stale" };
    let release!: () => void;
    channel.beforeSend = () => new Promise<void>((resolve) => { release = resolve; });
    const first = channel.emitFixtureInbound("刷新日报会话");
    await vi.waitFor(() => expect(channel.attempts).toHaveLength(2));
    expect(scheduler.getPublicState().notice).toBe("会话已恢复，正在按日期顺序续发 2026-10-10 日报。");
    const second = channel.emitFixtureInbound("再次刷新日报会话");
    await vi.waitFor(() => expect(inbox.checkpoint("fixture-bot")?.getUpdatesBuf).toBe("fixture-cursor-2"));
    // The first request fails using its original context; the next request succeeds.
    channel.beforeSend = async () => { channel.result = { ok: true }; };
    release();
    await Promise.all([first, second]);
    expect(store.load().runs[0]?.status).toBe("accepted");
    expect(channel.attempts).toHaveLength(3);
    expect(channel.getFixtureTextOutbox()).toHaveLength(1);
    expect(scheduler.getPublicState().notice).toContain("按日期顺序被微信渠道接受");
    expect(generated).toEqual(["2026-10-10"]);
  });

  it("retains the complete short summary across restart and sends the exact cached body through inbound", async () => {
    const { scheduler, channel, create, archivedSummaries, generated } = setup(undefined,
      "研究建议核验工具证据；所测任务中的错误减少，但结果不能推广到所有场景。");
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    expect(scheduler.getPublicState().lastRun?.status).toBe("auth_relogin_required");
    scheduler.close();
    const restarted = create();
    cleanups.push(() => restarted.close());
    await restarted.start();
    expect(restarted.getPublicState().previewMessage).toContain("研究建议核验工具证据；所测任务中的错误减少，但结果不能推广到所有场景。");
    channel.result = { ok: true };
    await channel.emitFixtureInbound("刷新日报会话");
    expect(restarted.getPublicState().lastRun?.status).toBe("accepted");
    expect(channel.getFixtureTextOutbox().map((item) => item.message)).toEqual([
      "2026-10-10 AI 新闻\n\nAI 新闻\n\n1. 缓存日报 2026-10-10\n研究建议核验工具证据；所测任务中的错误减少，但结果不能推广到所有场景。\n来源：Fixture",
    ]);
    expect(archivedSummaries).toEqual(["本地模拟新闻，仅验证缓存恢复和发送顺序。", "本地模拟新闻，仅验证缓存恢复和发送顺序。"]);
    expect(generated).toEqual(["2026-10-10"]);
  });

  it("resumes a cached auth failure after the same account regains credentials and receives fresh inbound", async () => {
    const { scheduler, channel, store, generated, archived } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    expect(store.load().runs[0]?.status).toBe("auth_relogin_required");
    channel.usable = false;
    await channel.emitFixtureInbound("刷新日报会话");
    expect(channel.attempts).toHaveLength(1);

    channel.usable = true;
    channel.result = { ok: true };
    await channel.emitFixtureInbound("刷新日报会话");

    expect(channel.getFixtureTextOutbox().map((item) => item.message)).toEqual([
      "2026-10-10 AI 新闻\n\nAI 新闻\n\n1. 缓存日报 2026-10-10\n本地模拟新闻，仅验证缓存恢复和发送顺序。\n来源：Fixture",
    ]);
    expect(store.load().runs[0]?.status).toBe("accepted");
    expect(generated).toEqual(["2026-10-10"]);
    expect(archived).toEqual(["2026-10-10"]);
  });

  it("drains every persisted report oldest first after restart even when storage update order differs", async () => {
    const { scheduler, channel, store, generated, setDate, create } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    setDate("2026-10-12");
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    setDate("2026-10-11");
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    scheduler.close();
    const restarted = create();
    cleanups.push(() => restarted.close());
    await restarted.start();
    channel.result = { ok: true };

    await channel.emitFixtureInbound("刷新日报会话");

    expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual([
      "2026-10-10 AI 新闻", "2026-10-11 AI 新闻", "2026-10-12 AI 新闻",
    ]);
    expect(generated).toEqual(["2026-10-10", "2026-10-12", "2026-10-11"]);
    expect(store.load().runs.map((run) => run.status)).toEqual(["accepted", "accepted", "accepted"]);
  });

  it("keeps a new automatic report behind the backlog and preserves both across restart", async () => {
    const { scheduler, channel, store, generated, setDate, create } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    setDate("2026-10-11");
    channel.result = { ok: true };
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    expect(channel.getFixtureTextOutbox()).toEqual([]);
    expect(store.load().runs.map((run) => run.status)).toEqual(["auth_relogin_required", "ready"]);
    scheduler.close();
    const restarted = create();
    cleanups.push(() => restarted.close());
    await restarted.start();

    await channel.emitFixtureInbound("刷新日报会话");

    expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual([
      "2026-10-10 AI 新闻", "2026-10-11 AI 新闻",
    ]);
    expect(generated).toEqual(["2026-10-10", "2026-10-11"]);
  });

  it.each<{ result: SendTextResult; status: string; throws?: boolean }>([
    { result: { ok: false, reason: "unknown" }, status: "unknown" },
    { result: { ok: false, reason: "unknown" }, status: "unknown", throws: true },
    { result: { ok: false, reason: "context_stale", acceptedSegments: 1, totalSegments: 2 }, status: "partial" },
    { result: { ok: false, reason: "rejected" }, status: "rejected" },
  ])("stops a drain on $status (throws=$throws) and never resubmits that report on later inbound", async ({ result, status, throws }) => {
    const { scheduler, channel, store, generated, setDate } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    setDate("2026-10-11");
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    channel.result = result;
    if (throws) channel.beforeSend = async () => { throw new Error("simulated network failure"); };

    await channel.emitFixtureInbound("刷新日报会话");
    expect(store.load().runs.find((run) => run.runKey === "2026-10-10")?.status).toBe(status);
    expect(store.load().runs.find((run) => run.runKey === "2026-10-11")?.status).toBe("ready");
    expect(channel.attempts.map((message) => message.split("\n")[0])).toEqual([
      "2026-10-10 AI 新闻", "2026-10-10 AI 新闻",
    ]);

    channel.result = { ok: true };
    delete channel.beforeSend;
    await channel.emitFixtureInbound("刷新日报会话");
    await channel.emitFixtureInbound("刷新日报会话");
    expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual(["2026-10-11 AI 新闻"]);
    expect(channel.attempts).toHaveLength(3);
    expect(generated).toEqual(["2026-10-10", "2026-10-11"]);
  });

  it("retains a second context failure and resumes the same cached content on later inbound", async () => {
    const { scheduler, channel, store, generated } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    channel.result = { ok: false, reason: "context_stale", providerRet: -2 };
    await channel.emitFixtureInbound("刷新日报会话");
    expect(store.load().runs[0]?.status).toBe("context_refresh_required");
    channel.result = { ok: true };
    await channel.emitFixtureInbound("刷新日报会话");
    expect(store.load().runs[0]?.status).toBe("accepted");
    expect(channel.getFixtureTextOutbox()).toHaveLength(1);
    expect(generated).toEqual(["2026-10-10"]);
  });

  it("stops after an in-flight report when disabled, including concurrently queued inbound", async () => {
    const { scheduler, channel, inbox, store, setDate } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    setDate("2026-10-11");
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    channel.result = { ok: true };
    let release!: () => void;
    channel.beforeSend = () => new Promise<void>((resolve) => { release = resolve; });
    const first = channel.emitFixtureInbound("刷新日报会话");
    await vi.waitFor(() => expect(channel.attempts).toHaveLength(2));
    const second = channel.emitFixtureInbound("刷新日报会话");
    await vi.waitFor(() => expect(inbox.checkpoint("fixture-bot")?.getUpdatesBuf).toBe("fixture-cursor-2"));
    scheduler.disable();
    delete channel.beforeSend;
    release();
    await Promise.all([first, second]);
    expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual(["2026-10-10 AI 新闻"]);
    expect(store.load().runs.find((run) => run.runKey === "2026-10-11")?.status).toBe("ready");

    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    await Promise.all([channel.emitFixtureInbound("刷新日报会话"), channel.emitFixtureInbound("刷新日报会话")]);
    expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual([
      "2026-10-10 AI 新闻", "2026-10-11 AI 新闻",
    ]);
  });

  it("resumes cached reports when the fresh inbound is the reserved retry command", async () => {
    const { scheduler, channel, generated } = setup();
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    channel.result = { ok: true };
    await channel.emitFixtureInbound("立即重试日报");
    expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual(["2026-10-10 AI 新闻"]);
    expect(generated).toEqual(["2026-10-10"]);
  });

  it.each(["account change", "missing target", "credentials stale", "close"])(
    "stops a queued backlog after %s during an in-flight submission",
    async (change) => {
      const { scheduler, channel, store, setDate } = setup();
      await scheduler.start();
      await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
      setDate("2026-10-11");
      await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
      channel.result = { ok: true };
      let release!: () => void;
      channel.beforeSend = () => new Promise<void>((resolve) => { release = resolve; });
      const inbound = channel.emitFixtureInbound("刷新日报会话");
      await vi.waitFor(() => expect(channel.attempts).toHaveLength(2));
      if (change === "account change") await scheduler.enable("another-bot", "another-user@im.wechat");
      if (change === "missing target") channel.hasOriginalTarget = false;
      if (change === "credentials stale") channel.usable = false;
      if (change === "close") scheduler.close();
      delete channel.beforeSend;
      release();
      await inbound;
      expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual(["2026-10-10 AI 新闻"]);
      expect(store.load().runs.find((run) => run.runKey === "2026-10-11")?.status).toBe("ready");
    },
  );

  it("treats a persisted in-flight submission as unknown after restart", async () => {
    const { scheduler, channel, store, directory, create, generated } = setup();
    await scheduler.start();
    let release!: () => void;
    channel.beforeSend = () => new Promise<void>((resolve) => { release = resolve; });
    const enabling = scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    await vi.waitFor(() => expect(store.load().runs[0]?.status).toBe("sending"));
    // Capture the state that a crash would leave, reached through public generation.
    const crashedStore = new DailyAiNewsFileStore(path.join(directory, "crash-snapshot.json"));
    crashedStore.save(store.load());
    scheduler.close();
    delete channel.beforeSend;
    release();
    await enabling;
    const restarted = create(crashedStore);
    cleanups.push(() => restarted.close());
    await restarted.start();
    channel.result = { ok: true };
    await channel.emitFixtureInbound("刷新日报会话");
    expect(crashedStore.load().runs[0]?.status).toBe("unknown");
    expect(channel.getFixtureTextOutbox()).toEqual([]);
    expect(channel.attempts).toHaveLength(1);
    expect(generated).toEqual(["2026-10-10"]);
  });

  it("serializes fresh inbound with new-day research without duplicate or out-of-order delivery", async () => {
    let release!: () => void;
    const { scheduler, channel, inbox, setDate, generated } = setup(async (date) => {
      if (date === "2026-10-11") await new Promise<void>((resolve) => { release = resolve; });
    });
    await scheduler.start();
    await scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    setDate("2026-10-11");
    channel.result = { ok: true };
    const generation = scheduler.enable("fixture-bot", "fixture-user@im.wechat");
    await vi.waitFor(() => expect(generated).toEqual(["2026-10-10", "2026-10-11"]));
    const first = channel.emitFixtureInbound("刷新日报会话");
    const second = channel.emitFixtureInbound("刷新日报会话");
    await vi.waitFor(() => expect(inbox.checkpoint("fixture-bot")?.getUpdatesBuf).toBe("fixture-cursor-2"));
    expect(channel.getFixtureTextOutbox()).toEqual([]);
    release();
    await Promise.all([generation, first, second]);
    expect(channel.getFixtureTextOutbox().map((item) => item.message.split("\n")[0])).toEqual([
      "2026-10-10 AI 新闻", "2026-10-11 AI 新闻",
    ]);
    expect(channel.attempts).toHaveLength(3);
  });
});
