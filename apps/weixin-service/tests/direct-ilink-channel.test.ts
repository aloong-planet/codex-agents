import fs from "node:fs";
import { getEventListeners } from "node:events";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InboundTextEvent, TargetCandidate } from "../src/demo-service.js";
import { DirectIlinkChannel, type FetchLike } from "../src/direct-ilink-channel.js";
import { DurableInboundStore } from "../src/durable-inbound-store.js";
import { DurableEffectLedger, type EffectIntent, type EffectLedger, type EffectRecord, type EffectState } from "../src/durable-effect-ledger.js";
import { IlinkMediaStore } from "../src/ilink-media.js";
import type { LoginOutputEvent } from "../src/login-output.js";
import { PrivateStateStore } from "../src/private-state-store.js";

const tempDirs: string[] = [];

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function storeInTemp(): PrivateStateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-direct-channel-"));
  tempDirs.push(dir);
  return new PrivateStateStore(path.join(dir, "state.json"));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("DirectIlinkChannel login", () => {
  it("keeps the local page available but refuses login when private state is corrupt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-direct-corrupt-"));
    tempDirs.push(dir);
    fs.chmodSync(dir, 0o700);
    const filePath = path.join(dir, "state.json");
    fs.writeFileSync(filePath, "not-json", { mode: 0o600 });

    expect(() => {
      const channel = new DirectIlinkChannel({
        store: new PrivateStateStore(filePath),
        fetch: vi.fn() as FetchLike,
      });
      expect(() => channel.startLogin(vi.fn(), vi.fn())).toThrow(/私有状态不可用/);
    }).not.toThrow(/私有状态格式无效/);
  });

  it("requests a real iLink QR and persists credentials only after confirmed", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      if (requests.length === 1) {
        return response({
          qrcode: "opaque-login-id",
          qrcode_img_content: "https://weixin.qq.com/x/new-direct-channel",
        });
      }
      return response({
        status: "confirmed",
        bot_token: "new-private-token",
        ilink_bot_id: "new-direct-bot@im.bot",
        ilink_user_id: "owner@im.wechat",
        baseurl: "https://ilinkai.weixin.qq.com",
      });
    }) as FetchLike;
    const store = storeInTemp();
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const events: LoginOutputEvent[] = [];

    const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      channel.startLogin((event) => events.push(event), resolve);
    });

    expect(result).toEqual({ ok: true });
    expect(events).toEqual([
      { kind: "qr", url: "https://weixin.qq.com/x/new-direct-channel" },
      { kind: "connected" },
    ]);
    expect(requests[0]?.url).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ local_token_list: [] });
    expect(new Headers(requests[0]?.init?.headers).get("iLink-App-Id")).toBe("bot");
    expect(requests[1]?.url).toContain("/ilink/bot/get_qrcode_status?qrcode=");
    expect(store.load()).toMatchObject({
      accountId: "new-direct-bot@im.bot",
      token: "new-private-token",
      contextTokens: {},
    });
    await channel.close();
  });

  it("bridges an iLink number verification challenge without persisting the code", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      response({
        qrcode: "opaque-login-id",
        qrcode_img_content: "https://weixin.qq.com/x/verify-direct-channel",
      }),
      response({ status: "need_verifycode" }),
      response({
        status: "confirmed",
        bot_token: "verified-private-token",
        ilink_bot_id: "verified-direct-bot@im.bot",
        ilink_user_id: "owner@im.wechat",
      }),
    ];
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }) as FetchLike;
    const store = storeInTemp();
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const events: LoginOutputEvent[] = [];
    let handle!: ReturnType<DirectIlinkChannel["startLogin"]>;

    const resultPromise = new Promise<{ ok: boolean; message?: string }>((resolve) => {
      handle = channel.startLogin((event) => {
        events.push(event);
        if (event.kind === "pair_code_required") handle.submitPairCode("246810");
      }, resolve);
    });

    await expect(resultPromise).resolves.toEqual({ ok: true });
    expect(events.map((event) => event.kind)).toEqual([
      "qr",
      "pair_code_required",
      "connected",
    ]);
    expect(requests[2]?.url).toContain("verify_code=246810");
    expect(JSON.stringify(store.load())).not.toContain("246810");
    await channel.close();
  });

  it("accepts binded_redirect only when this direct Demo already owns private credentials", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "existing-direct-bot@im.bot",
      token: "existing-private-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "",
      contextTokens: {},
    });
    const responses = [
      response({
        qrcode: "opaque-login-id",
        qrcode_img_content: "https://weixin.qq.com/x/existing-direct-channel",
      }),
      response({ status: "binded_redirect" }),
    ];
    const fetchLike = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const events: LoginOutputEvent[] = [];

    const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      channel.startLogin((event) => events.push(event), resolve);
    });

    expect(result).toEqual({ ok: true });
    expect(events.map((event) => event.kind)).toEqual(["qr", "already_connected"]);
    expect(store.load()).toMatchObject({ token: "existing-private-token" });
    await channel.close();
  });

  it("refreshes an expired QR and continues the same login", async () => {
    const store = storeInTemp();
    const responses = [
      response({
        qrcode: "expired-login-id",
        qrcode_img_content: "https://weixin.qq.com/x/expired-direct-channel",
      }),
      response({ status: "expired" }),
      response({
        qrcode: "fresh-login-id",
        qrcode_img_content: "https://weixin.qq.com/x/fresh-direct-channel",
      }),
      response({
        status: "confirmed",
        bot_token: "fresh-private-token",
        ilink_bot_id: "fresh-direct-bot@im.bot",
      }),
    ];
    const fetchLike = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const events: LoginOutputEvent[] = [];

    const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      channel.startLogin((event) => events.push(event), resolve);
    });

    expect(result).toEqual({ ok: true });
    expect(events.filter((event) => event.kind === "qr")).toEqual([
      { kind: "qr", url: "https://weixin.qq.com/x/expired-direct-channel" },
      { kind: "qr", url: "https://weixin.qq.com/x/fresh-direct-channel" },
    ]);
    await channel.close();
  });

  it("follows only an iLink-provided safe Weixin HTTPS redirect while polling", async () => {
    const store = storeInTemp();
    const requests: string[] = [];
    const responses = [
      response({
        qrcode: "redirect-login-id",
        qrcode_img_content: "https://weixin.qq.com/x/redirect-direct-channel",
      }),
      response({ status: "scaned_but_redirect", redirect_host: "dc.weixin.qq.com" }),
      response({
        status: "confirmed",
        bot_token: "redirect-private-token",
        ilink_bot_id: "redirect-direct-bot@im.bot",
        baseurl: "https://dc.weixin.qq.com",
      }),
    ];
    const fetchLike = vi.fn(async (url: string | URL) => {
      requests.push(String(url));
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      channel.startLogin(vi.fn(), resolve);
    });

    expect(result).toEqual({ ok: true });
    expect(requests[2]).toMatch(/^https:\/\/dc\.weixin\.qq\.com\/ilink\/bot\/get_qrcode_status/);
    await channel.close();
  });

  it("rejects a QR-status redirect outside the Weixin HTTPS domain", async () => {
    const store = storeInTemp();
    const responses = [
      response({
        qrcode: "redirect-login-id",
        qrcode_img_content: "https://weixin.qq.com/x/redirect-direct-channel",
      }),
      response({ status: "scaned_but_redirect", redirect_host: "evil.example" }),
    ];
    const fetchLike = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      channel.startLogin(vi.fn(), resolve);
    });

    expect(result).toMatchObject({ ok: false });
    expect(store.load()).toBeNull();
    await channel.close();
  });

  it("does not accept binded_redirect without credentials owned by this Demo", async () => {
    const store = storeInTemp();
    const responses = [
      response({
        qrcode: "bound-login-id",
        qrcode_img_content: "https://weixin.qq.com/x/bound-direct-channel",
      }),
      response({ status: "binded_redirect" }),
    ];
    const fetchLike = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next;
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    const result = await new Promise<{ ok: boolean; message?: string }>((resolve) => {
      channel.startLogin(vi.fn(), resolve);
    });

    expect(result).toMatchObject({ ok: false });
    expect(store.load()).toBeNull();
    await channel.close();
  });

  it("aborts the old account long poll before rebinding credentials", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "old-direct-bot@im.bot",
      token: "old-private-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    let monitorSignal: AbortSignal | undefined;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates")) {
        monitorSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (value.includes("get_bot_qrcode")) {
        return response({
          qrcode: "rebind-login-id",
          qrcode_img_content: "https://weixin.qq.com/x/rebind-direct-channel",
        });
      }
      if (value.includes("get_qrcode_status")) {
        return response({
          status: "confirmed",
          bot_token: "new-private-token",
          ilink_bot_id: "new-direct-bot@im.bot",
        });
      }
      return response({ ret: 0 });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    await channel.start();
    await vi.waitFor(() => expect(monitorSignal).toBeDefined());

    const resultPromise = new Promise<{ ok: boolean; message?: string }>((resolve) => {
      channel.startLogin(vi.fn(), resolve);
    });

    expect(monitorSignal?.aborted).toBe(true);
    await expect(resultPromise).resolves.toEqual({ ok: true });
    await channel.close();
  });

  it("does not leak abort listeners while iLink remains in wait", async () => {
    vi.useFakeTimers();
    try {
      const store = storeInTemp();
      let statusSignal: AbortSignal | undefined;
      let statusCalls = 0;
      const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes("get_bot_qrcode")) {
          return response({
            qrcode: "waiting-login-id",
            qrcode_img_content: "https://weixin.qq.com/x/waiting-direct-channel",
          });
        }
        statusSignal = init?.signal ?? undefined;
        statusCalls += 1;
        if (statusCalls <= 12) return response({ status: "wait" });
        return response({
          status: "confirmed",
          bot_token: "waiting-private-token",
          ilink_bot_id: "waiting-direct-bot@im.bot",
        });
      }) as FetchLike;
      const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
      const result = new Promise<{ ok: boolean; message?: string }>((resolve) => {
        channel.startLogin(vi.fn(), resolve);
      });

      for (let index = 0; index < 12; index += 1) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      await expect(result).resolves.toEqual({ ok: true });
      expect(statusSignal).toBeDefined();
      expect(getEventListeners(statusSignal!, "abort")).toHaveLength(0);
      await channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an unconfirmed login after the configured overall timeout", async () => {
    vi.useFakeTimers();
    try {
      const store = storeInTemp();
      const fetchLike = vi.fn(async (url: string | URL) => {
        if (String(url).includes("get_bot_qrcode")) {
          return response({
            qrcode: "timeout-login-id",
            qrcode_img_content: "https://weixin.qq.com/x/timeout-direct-channel",
          });
        }
        return response({ status: "wait" });
      }) as FetchLike;
      const options = { store, fetch: fetchLike, loginTimeoutMs: 2000 };
      const channel = new DirectIlinkChannel(options);
      let exitResult: { ok: boolean; message?: string } | undefined;
      const handle = channel.startLogin(vi.fn(), (result) => {
        exitResult = result;
      });

      await vi.advanceTimersByTimeAsync(3000);

      expect(exitResult).toMatchObject({ ok: false });
      handle.terminate();
      await channel.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a transient QR-status network failure without requesting another login", async () => {
    vi.useFakeTimers();
    try {
      const store = storeInTemp();
      let statusCalls = 0;
      const fetchLike = vi.fn(async (url: string | URL) => {
        if (String(url).includes("get_bot_qrcode")) {
          return response({
            qrcode: "retry-login-id",
            qrcode_img_content: "https://weixin.qq.com/x/retry-direct-channel",
          });
        }
        statusCalls += 1;
        if (statusCalls === 1) throw new TypeError("temporary network failure");
        return response({
          status: "confirmed",
          bot_token: "retry-private-token",
          ilink_bot_id: "retry-direct-bot@im.bot",
        });
      }) as FetchLike;
      const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
      const result = new Promise<{ ok: boolean; message?: string }>((resolve) => {
        channel.startLogin(vi.fn(), resolve);
      });

      await vi.advanceTimersByTimeAsync(1000);

      await expect(result).resolves.toEqual({ ok: true });
      expect(statusCalls).toBe(2);
      await channel.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("DirectIlinkChannel inbound", () => {
  it("resumes getupdates from the durable cursor instead of a stale JSON projection", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-direct-resume-"));
    tempDirs.push(directory);
    const store = new PrivateStateStore(path.join(directory, "state.json"));
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "private-bot-token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "stale-json-cursor", contextTokens: {} });
    const inboundStore = new DurableInboundStore(path.join(directory, "inbound.sqlite"));
    inboundStore.ingestBatch({ accountId: "direct-bot@im.bot", nextCursor: "durable-cursor", contexts: [], envelopes: [] });
    let requestedCursor: string | undefined;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (String(url).endsWith("/getupdates")) {
        requestedCursor = JSON.parse(String(init?.body)).get_updates_buf;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return response({ ret: 0 });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, inboundStore, fetch: fetchLike });

    await channel.start();
    await vi.waitFor(() => expect(requestedCursor).toBe("durable-cursor"));

    await channel.close();
    inboundStore.close();
  });

  it("publishes from a committed durable inbox even when the legacy JSON projection fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-direct-durable-"));
    tempDirs.push(directory);
    const store = new PrivateStateStore(path.join(directory, "state.json"));
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    const inboundStore = new DurableInboundStore(path.join(directory, "inbound.sqlite"), () => 1_800_000_000_000);
    const originalSave = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation((state) => {
      if (state.getUpdatesBuf === "new-cursor") throw new Error("legacy projection unavailable");
      originalSave(state);
    });
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (String(url).endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "new-cursor",
          msgs: [{
            message_type: 1,
            message_id: "durable-message",
            from_user_id: "owner@im.wechat",
            context_token: "durable-private-context",
            create_time_ms: 1_799_999_999_000,
            item_list: [{ type: 1, text_item: { text: "不能丢失" } }],
          }],
        });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, inboundStore, fetch: fetchLike, now: () => 1_800_000_000_000 });
    const inbound: InboundTextEvent[] = [];
    channel.onInboundText((event) => inbound.push(event));
    channel.activateInboundDispatch();

    await channel.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    expect(inbound[0]).toMatchObject({ text: "不能丢失", target: "owner@im.wechat" });
    expect(inboundStore.checkpoint("direct-bot@im.bot")?.getUpdatesBuf).toBe("new-cursor");
    expect(store.load()?.getUpdatesBuf).toBe("old-cursor");
    await channel.close();
    inboundStore.close();
  });

  it("same_target_inbound_waits_fifo_without_merging", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-direct-dispatch-"));
    tempDirs.push(directory);
    const store = new PrivateStateStore(path.join(directory, "state.json"));
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    const inboundStore = new DurableInboundStore(path.join(directory, "inbound.sqlite"), () => 1_800_000_000_000);
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (String(url).endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "dispatch-cursor",
          msgs: [
            { message_type: 1, message_id: "first", from_user_id: "owner@im.wechat", context_token: "context-1", create_time_ms: 1_799_999_999_000, item_list: [{ type: 1, text_item: { text: "第一条" } }] },
            { message_type: 1, message_id: "second", from_user_id: "owner@im.wechat", context_token: "context-2", create_time_ms: 1_799_999_999_001, item_list: [{ type: 1, text_item: { text: "第二条" } }] },
          ],
        });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, inboundStore, fetch: fetchLike, now: () => 1_800_000_000_000 });
    await channel.start();
    await vi.waitFor(() => expect(inboundStore.peekQueued("direct-bot@im.bot", "owner@im.wechat")).toMatchObject({ text: "第一条" }));

    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const seen: string[] = [];
    channel.onInboundText(async (event) => {
      seen.push(event.text);
      if (event.text === "第一条") await firstPending;
    });

    await Promise.resolve();
    expect(seen).toEqual([]);
    channel.activateInboundDispatch();
    await vi.waitFor(() => expect(seen).toEqual(["第一条"]));
    releaseFirst();
    await vi.waitFor(() => expect(seen).toEqual(["第一条", "第二条"]));
    await channel.close();
    inboundStore.close();
  });

  it("does not complete a durable message when its command handler fails", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-direct-handler-failure-"));
    tempDirs.push(directory);
    const store = new PrivateStateStore(path.join(directory, "state.json"));
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "private-bot-token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "cursor", contextTokens: {} });
    const inboundStore = new DurableInboundStore(path.join(directory, "inbound.sqlite"), () => 1_800_000_000_000);
    inboundStore.ingestBatch({
      accountId: "direct-bot@im.bot", nextCursor: "cursor-2",
      contexts: [{ target: "owner@im.wechat", contextToken: "context", lastInboundAt: 1_799_999_999_000, contextUpdatedAt: 1_800_000_000_000 }],
      envelopes: [{ eventKey: "6".repeat(64), accountId: "direct-bot@im.bot", target: "owner@im.wechat", messageId: "handler-failure", kind: "message", source: "text", text: "立即重试日报", receivedAt: 1_799_999_999_000, observedAt: 1_800_000_000_000, contextToken: "context" }],
    });
    const channel = new DirectIlinkChannel({ store, inboundStore, fetch: vi.fn() as FetchLike, now: () => 1_800_000_000_000 });
    const normalListener = vi.fn();
    channel.onInboundCommand(async () => { throw new Error("handler failed"); });
    channel.onInboundText(normalListener);

    channel.activateInboundDispatch();
    await vi.waitFor(() => expect(inboundStore.peek("6".repeat(64))).toMatchObject({ state: "leased" }));

    expect(normalListener).not.toHaveBeenCalled();
    await channel.close();
    inboundStore.close();
  });

  it("lets an infrastructure command consume an inbound message before normal listeners", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (String(url).endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "new-cursor",
          msgs: [{
            message_type: 1,
            message_id: "retry-command",
            from_user_id: "owner@im.wechat",
            context_token: "fresh-context",
            create_time_ms: 1_723_456_789_000,
            item_list: [{ type: 1, text_item: { text: "立即重试日报" } }],
          }],
        });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const command = vi.fn<(event: InboundTextEvent) => boolean>(() => true);
    const normal = vi.fn();
    channel.onInboundCommand(command);
    channel.onInboundText(normal);

    await channel.start();
    await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());

    expect(command.mock.calls[0]?.[0].text).toBe("立即重试日报");
    expect(normal).not.toHaveBeenCalled();
    await channel.close();
  });

  it("binds getConfig and native typing to the inbound account, target, and context", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    let delivered = false;
    const configBodies: Record<string, unknown>[] = [];
    const typingBodies: Record<string, unknown>[] = [];
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "new-cursor",
          msgs: [{
            message_type: 1,
            message_id: "typing-message",
            from_user_id: "owner@im.wechat",
            context_token: "context-for-typing",
            create_time_ms: 1_723_456_789_000,
            item_list: [{ type: 1, text_item: { text: "Hi" } }],
          }],
        });
      }
      if (value.endsWith("/getconfig")) {
        configBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ ret: 0, typing_ticket: "typing-ticket" });
      }
      if (value.endsWith("/sendtyping")) {
        typingBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ ret: 0 });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const inbound: Parameters<Parameters<typeof channel.onInboundText>[0]>[0][] = [];
    channel.onInboundText((event) => inbound.push(event));
    await channel.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    await vi.waitFor(() => expect(configBodies).toHaveLength(1));

    const lease = await inbound[0]!.startTyping!();
    expect(lease.active).toBe(true);
    expect(configBodies).toEqual([expect.objectContaining({
      ilink_user_id: "owner@im.wechat",
      context_token: "context-for-typing",
    })]);
    expect(lease.diagnostics).toMatchObject({
      ticketCache: "hit",
      getConfig: { outcome: "skipped" },
    });
    expect(typingBodies[0]).toMatchObject({
      ilink_user_id: "owner@im.wechat",
      typing_ticket: "typing-ticket",
      status: 1,
    });

    await lease.stop();
    expect(typingBodies[1]).toMatchObject({ status: 2 });
    await channel.close();
  });

  it("warms typing tickets only for the three most recently updated persisted targets", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: {
        "oldest@im.wechat": "context-oldest",
        "older@im.wechat": "context-older",
        "newer@im.wechat": "context-newer",
        "newest@im.wechat": "context-newest",
      },
      targetMetadata: {
        "oldest@im.wechat": { contextUpdatedAt: 100 },
        "older@im.wechat": { contextUpdatedAt: 200 },
        "newer@im.wechat": { contextUpdatedAt: 300 },
        "newest@im.wechat": { contextUpdatedAt: 400 },
      },
    });
    const warmedTargets: string[] = [];
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getconfig")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        warmedTargets.push(String(body.ilink_user_id));
        return response({ ret: 0, typing_ticket: "typing-ticket" });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await channel.start();
    await vi.waitFor(() => expect(warmedTargets).toHaveLength(3));

    expect(warmedTargets).toEqual([
      "newest@im.wechat",
      "newer@im.wechat",
      "older@im.wechat",
    ]);
    await channel.close();
  });

  it("publishes only persisted USER text with a reply bound to that message context", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    const sendBodies: Record<string, unknown>[] = [];
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "new-cursor",
          msgs: [
            {
              message_type: 1,
              message_id: "message-1",
              seq: 7,
              client_id: "wechat-client-1",
              from_user_id: "owner@im.wechat",
              context_token: "context-for-message-1",
              create_time_ms: 1_723_456_789_000,
              item_list: [{ type: 1, text_item: { text: "Hi" } }],
            },
            {
              message_type: 2,
              message_id: "bot-message",
              from_user_id: "owner@im.wechat",
              context_token: "bot-context",
              item_list: [{ type: 1, text_item: { text: "echo" } }],
            },
          ],
        });
      }
      if (value.endsWith("/sendmessage")) {
        sendBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ ret: 0 });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    }) as FetchLike;
    const ledgerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-effect-inbound-"));
    tempDirs.push(ledgerDirectory);
    const effectLedger = new DurableEffectLedger(path.join(ledgerDirectory, "effects.sqlite"));
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike, effectLedger });
    const inbound: Parameters<Parameters<typeof channel.onInboundText>[0]>[0][] = [];
    channel.onInboundText((event) => inbound.push(event));

    await channel.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0]).toMatchObject({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      messageId: "message-1",
      source: "text",
      text: "Hi",
    });

    await expect(inbound[0]!.replyProgress?.({
      runId: "run-1",
      itemId: "tool-1",
      label: "搜索网页",
      phase: "start",
    })).resolves.toMatchObject({ ok: true });
    expect(sendBodies[0]).toMatchObject({
      msg: {
        to_user_id: "owner@im.wechat",
        context_token: "context-for-message-1",
        run_id: "run-1",
        item_list: [{
          type: 11,
          is_completed: false,
          tool_call_start_item: { tool_name: "搜索网页", tool_call_id: "tool-1" },
        }],
      },
    });

    await expect(inbound[0]!.replyProgress?.({
      runId: "run-1",
      itemId: "tool-1",
      label: "搜索网页",
      phase: "end",
      status: "completed",
    })).resolves.toMatchObject({ ok: true });
    expect(sendBodies[1]).toMatchObject({
      msg: {
        run_id: "run-1",
        item_list: [{
          type: 12,
          is_completed: true,
          tool_call_result_item: {
            tool_name: "搜索网页",
            tool_call_id: "tool-1",
            status: "completed",
          },
        }],
      },
    });

    await expect(inbound[0]!.replyText("来自 Codex 的回复")).resolves.toMatchObject({ ok: true });
    expect(sendBodies[2]).toMatchObject({
      msg: {
        to_user_id: "owner@im.wechat",
        context_token: "context-for-message-1",
        item_list: [{ type: 1, text_item: { text: "来自 Codex 的回复" } }],
      },
    });
    expect(effectLedger.listByCause(inbound[0]!.key).map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: "weixin_progress", state: "accepted" },
      { kind: "weixin_progress", state: "accepted" },
      { kind: "weixin_text", state: "accepted" },
    ]);
    await channel.close();
    effectLedger.close();
  });

  it("persists every media stage and omits the local path from the effect ledger", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-effect-media-"));
    tempDirs.push(directory);
    const mediaPath = path.join(directory, "private-local-name.png");
    fs.writeFileSync(mediaPath, Buffer.from("image bytes"));
    const effectLedger = new DurableEffectLedger(path.join(directory, "effects.sqlite"));
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "new-cursor",
          msgs: [{
            message_type: 1,
            message_id: "media-request",
            seq: 8,
            client_id: "wechat-client-media",
            from_user_id: "owner@im.wechat",
            context_token: "context-for-media",
            create_time_ms: 1_723_456_789_000,
            item_list: [{ type: 1, text_item: { text: "发图" } }],
          }],
        });
      }
      if (value.endsWith("/getuploadurl")) {
        return response({ ret: 0, upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload" });
      }
      if (value === "https://novac2c.cdn.weixin.qq.com/c2c/upload") {
        return new Response(null, { status: 200, headers: { "x-encrypted-param": "download-param" } });
      }
      if (value.endsWith("/sendmessage")) return response({ ret: 0 });
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike, effectLedger });
    const inbound: InboundTextEvent[] = [];
    channel.onInboundText((event) => inbound.push(event));

    await channel.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    await expect(inbound[0]!.replyMedia?.(mediaPath)).resolves.toMatchObject({ ok: true });

    const effects = effectLedger.listByCause(inbound[0]!.key);
    expect(effects.map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: "weixin_media_upload_url", state: "accepted" },
      { kind: "weixin_media_upload", state: "accepted" },
      { kind: "weixin_media_send", state: "accepted" },
    ]);
    expect(JSON.stringify(effects)).not.toContain("private-local-name.png");
    await channel.close();
    effectLedger.close();
  });

  it("sends workflow media with the latest context and reconciles the stable operation", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: { "owner@im.wechat": "latest-context" },
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-media-"));
    tempDirs.push(directory);
    const mediaPath = path.join(directory, "workflow.png");
    fs.writeFileSync(mediaPath, Buffer.from("image bytes"));
    const effectLedger = new DurableEffectLedger(path.join(directory, "effects.sqlite"));
    const fetchLike = vi.fn(async (url: string | URL) => {
      const value = String(url);
      if (value.endsWith("/getuploadurl")) return response({ ret: 0, upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload" });
      if (value === "https://novac2c.cdn.weixin.qq.com/c2c/upload") {
        return new Response(null, { status: 200, headers: { "x-encrypted-param": "download-param" } });
      }
      if (value.endsWith("/sendmessage")) return response({ ret: 0 });
      throw new Error("unexpected request");
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike, effectLedger });

    await expect(channel.sendImage({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      filePath: mediaPath,
      operationId: "workflow-operation:abc",
    })).resolves.toMatchObject({ ok: true });

    expect(effectLedger.listByOperation("workflow-operation:abc").map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: "weixin_media_upload_url", state: "accepted" },
      { kind: "weixin_media_upload", state: "accepted" },
      { kind: "weixin_media_send", state: "accepted" },
    ]);
    await expect(channel.reconcileMediaOperation("workflow-operation:abc")).resolves.toEqual({ status: "accepted" });
    expect(fetchLike).toHaveBeenCalledTimes(3);

    effectLedger.prepare({
      attemptId: "workflow-unknown-send",
      operationId: "workflow-operation:unknown",
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      kind: "weixin_media_send",
    });
    effectLedger.settle("workflow-unknown-send", "unknown");
    await expect(channel.reconcileMediaOperation("workflow-operation:unknown")).resolves.toEqual({
      status: "unknown",
      errorCode: "weixin_media_send_unknown",
    });
    expect(fetchLike).toHaveBeenCalledTimes(3);
    await channel.close();
    effectLedger.close();
  });

  it("sends a private snapshot under its trusted original file name", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: { "owner@im.wechat": "latest-context" },
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-file-"));
    tempDirs.push(directory);
    const snapshotPath = path.join(directory, "random-snapshot.md");
    fs.writeFileSync(snapshotPath, "private body");
    let sentBody: Record<string, unknown> | undefined;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/getuploadurl")) return response({ ret: 0, upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload" });
      if (value === "https://novac2c.cdn.weixin.qq.com/c2c/upload") {
        return new Response(null, { status: 200, headers: { "x-encrypted-param": "download-param" } });
      }
      if (value.endsWith("/sendmessage")) {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response({ ret: 0 });
      }
      throw new Error("unexpected request");
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await expect(channel.sendFile({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      filePath: snapshotPath,
      fileName: "Original Note.md",
      operationId: "workflow-operation:file-name",
    })).resolves.toMatchObject({ ok: true });

    expect(sentBody).toMatchObject({
      msg: { item_list: [{ type: 4, file_item: { file_name: "Original Note.md" } }] },
    });
    await channel.close();
  });

  it("stops media delivery when the CDN upload outcome is unknown", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-effect-media-unknown-"));
    tempDirs.push(directory);
    const mediaPath = path.join(directory, "photo.png");
    fs.writeFileSync(mediaPath, Buffer.from("image bytes"));
    const effectLedger = new DurableEffectLedger(path.join(directory, "effects.sqlite"));
    let delivered = false;
    let sendMessageCalls = 0;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "new-cursor",
          msgs: [{
            message_type: 1,
            message_id: "media-request-unknown",
            from_user_id: "owner@im.wechat",
            context_token: "context-for-media",
            item_list: [{ type: 1, text_item: { text: "发图" } }],
          }],
        });
      }
      if (value.endsWith("/getuploadurl")) {
        return response({ ret: 0, upload_full_url: "https://novac2c.cdn.weixin.qq.com/c2c/upload" });
      }
      if (value === "https://novac2c.cdn.weixin.qq.com/c2c/upload") {
        throw new Error("connection lost after upload");
      }
      if (value.endsWith("/sendmessage")) {
        sendMessageCalls += 1;
        return response({ ret: 0 });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike, effectLedger });
    const inbound: InboundTextEvent[] = [];
    channel.onInboundText((event) => inbound.push(event));

    await channel.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    await expect(inbound[0]!.replyMedia?.(mediaPath)).resolves.toMatchObject({
      ok: false,
      reason: "unknown",
    });

    expect(sendMessageCalls).toBe(0);
    expect(effectLedger.listByCause(inbound[0]!.key).map(({ kind, state }) => ({ kind, state }))).toEqual([
      { kind: "weixin_media_upload_url", state: "accepted" },
      { kind: "weixin_media_upload", state: "unknown" },
    ]);
    await channel.close();
    effectLedger.close();
  });

  it("publishes a Tencent voice transcript with its message-bound reply context", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    const sendBodies: Record<string, unknown>[] = [];
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "voice-cursor",
          msgs: [{
            message_type: 1,
            message_id: "voice-message-1",
            seq: 8,
            client_id: "wechat-voice-client-1",
            from_user_id: "owner@im.wechat",
            context_token: "context-for-voice-1",
            create_time_ms: 1_723_456_789_000,
            item_list: [{
              type: 3,
              voice_item: { playtime: 60_000, text: "帮我列出 demo Vault 的文件" },
            }],
          }],
        });
      }
      if (value.endsWith("/sendmessage")) {
        sendBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ ret: 0 });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const inbound: Parameters<Parameters<typeof channel.onInboundText>[0]>[0][] = [];
    channel.onInboundText((event) => inbound.push(event));

    await channel.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));
    expect(inbound[0]).toMatchObject({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      messageId: "voice-message-1",
      source: "voice",
      text: "帮我列出 demo Vault 的文件",
    });

    await expect(inbound[0]!.replyText("共有三个文件。")).resolves.toMatchObject({ ok: true });
    expect(sendBodies[0]).toMatchObject({
      msg: {
        to_user_id: "owner@im.wechat",
        context_token: "context-for-voice-1",
        item_list: [{ type: 1, text_item: { text: "共有三个文件。" } }],
      },
    });
    await channel.close();
  });

  it("uses a Tencent voice transcript without downloading the original voice", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "voice-cursor",
          msgs: [{
            message_type: 1,
            message_id: "voice-message-with-media",
            from_user_id: "owner@im.wechat",
            context_token: "context-for-voice-with-media",
            item_list: [{
              type: 3,
              voice_item: {
                playtime: 1_000,
                text: "只使用腾讯转写",
                media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/voice" },
              },
              ref_msg: {
                title: "引用语音",
                message_item: {
                  type: 3,
                  voice_item: {
                    playtime: 900,
                    media: { full_url: "https://novac2c.cdn.weixin.qq.com/c2c/quoted-voice" },
                  },
                },
              },
            }],
          }],
        });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as FetchLike;
    const mediaFetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    const mediaStore = new IlinkMediaStore(
      fs.mkdtempSync(path.join(os.tmpdir(), "weixin-voice-media-")),
      mediaFetch,
    );
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike, mediaStore });
    const inbound: InboundTextEvent[] = [];
    channel.onInboundText((event) => inbound.push(event));

    await channel.start();
    await vi.waitFor(() => expect(inbound).toHaveLength(1));

    expect(inbound[0]).toMatchObject({ source: "voice", text: "只使用腾讯转写" });
    expect(inbound[0]?.attachments).toBeUndefined();
    expect(inbound[0]?.quote).toEqual({ title: "引用语音", attachments: [] });
    expect(mediaFetch).not.toHaveBeenCalled();
    await channel.close();
  });

  it("rejects a voice longer than sixty seconds without publishing it as text", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    const sendBodies: Record<string, unknown>[] = [];
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "long-voice-cursor",
          msgs: [{
            message_type: 1,
            message_id: "long-voice-message",
            seq: 9,
            client_id: "wechat-long-voice-client",
            from_user_id: "owner@im.wechat",
            context_token: "context-for-long-voice",
            create_time_ms: 1_723_456_789_000,
            item_list: [{
              type: 3,
              voice_item: { playtime: 60_001, text: "这段内容不应交给 Codex" },
            }],
          }],
        });
      }
      if (value.endsWith("/sendmessage")) {
        sendBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response({ ret: 0 });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const inbound: Parameters<Parameters<typeof channel.onInboundText>[0]>[0][] = [];
    const rejected: Array<{
      reason: string;
      durationMs?: number;
      replyText(message: string): Promise<unknown>;
    }> = [];
    channel.onInboundText((event) => inbound.push(event));
    channel.onInboundRejected((event) => rejected.push(event));

    await channel.start();
    await vi.waitFor(() => expect(rejected).toHaveLength(1));
    expect(inbound).toEqual([]);
    expect(rejected[0]).toMatchObject({ reason: "voice_too_long", durationMs: 60_001 });

    await rejected[0]!.replyText("这条语音超过 60 秒，暂不处理。");
    expect(sendBodies[0]).toMatchObject({
      msg: {
        to_user_id: "owner@im.wechat",
        context_token: "context-for-long-voice",
      },
    });
    await channel.close();
  });

  it("classifies missing Tencent transcripts and invalid voice durations", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    let delivered = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !delivered) {
        delivered = true;
        return response({
          ret: 0,
          get_updates_buf: "rejected-voice-cursor",
          msgs: [
            {
              message_type: 1,
              message_id: "missing-transcript",
              from_user_id: "owner@im.wechat",
              context_token: "context-missing-transcript",
              item_list: [{ type: 3, voice_item: { playtime: 1_000 } }],
            },
            {
              message_type: 1,
              message_id: "zero-duration",
              from_user_id: "owner@im.wechat",
              context_token: "context-zero-duration",
              item_list: [{ type: 3, voice_item: { playtime: 0, text: "不应处理" } }],
            },
            {
              message_type: 1,
              message_id: "fractional-duration",
              from_user_id: "owner@im.wechat",
              context_token: "context-fractional-duration",
              item_list: [{ type: 3, voice_item: { playtime: 1.5, text: "不应处理" } }],
            },
          ],
        });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const inbound: unknown[] = [];
    const rejected: Array<{ messageId: string; reason: string; durationMs?: number }> = [];
    channel.onInboundText((event) => inbound.push(event));
    channel.onInboundRejected((event) => rejected.push(event));

    await channel.start();
    await vi.waitFor(() => expect(rejected).toHaveLength(3));

    expect(inbound).toEqual([]);
    expect(rejected).toMatchObject([
      { messageId: "missing-transcript", reason: "voice_transcript_missing", durationMs: 1_000 },
      { messageId: "zero-duration", reason: "voice_duration_invalid", durationMs: 0 },
      { messageId: "fractional-duration", reason: "voice_duration_invalid" },
    ]);
    expect(rejected[2]).not.toHaveProperty("durationMs");
    await channel.close();
  });

  it("marks the bot credential stale and stops polling on getupdates -14", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: {},
    });
    const urls: string[] = [];
    const fetchLike = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).endsWith("/msg/notifystart")) return response({ ret: 0 });
      return response({ ret: -14, errmsg: "stale bot credential" });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await channel.start();
    await vi.waitFor(() => {
      expect(channel.getSnapshot().accounts[0]?.credentialStatus).toBe("stale");
    });

    expect(urls.filter((url) => url.endsWith("/getupdates"))).toHaveLength(1);
    await channel.close();
  });

  it("does not start polling when notify-start reports stale bot credentials", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: {},
    });
    const urls: string[] = [];
    const fetchLike = vi.fn(async (url: string | URL) => {
      urls.push(String(url));
      return response({ errcode: -14, errmsg: "stale bot credential" });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await channel.start();

    expect(channel.getSnapshot().accounts[0]?.credentialStatus).toBe("stale");
    expect(urls).toEqual(["https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystart"]);
    await channel.close();
  });

  it("publishes already persisted targets immediately when subscribed", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "persisted@im.wechat": "private-context-token" },
    });
    const channel = new DirectIlinkChannel({ store, fetch: vi.fn() as FetchLike });
    const snapshots: TargetCandidate[][] = [];

    const unsubscribe = channel.onSnapshotChanged((snapshot) => snapshots.push(snapshot.targets));

    expect(snapshots).toEqual([
      [{ accountId: "direct-bot@im.bot", target: "persisted@im.wechat" }],
    ]);
    unsubscribe();
    await channel.close();
  });

  it("updates local aliases without changing routing IDs or credentials", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const channel = new DirectIlinkChannel({ store, fetch: vi.fn() as FetchLike });

    channel.updateLocalLabels({
      accountId: "direct-bot@im.bot",
      accountLabel: "  我的个人微信  ",
      target: "owner@im.wechat",
      targetLabel: "  Aloong  ",
    });

    expect(channel.getSnapshot()).toEqual({
      accounts: [
        {
          accountId: "direct-bot@im.bot",
          label: "我的个人微信",
          credentialStatus: "usable",
        },
      ],
      targets: [
        {
          accountId: "direct-bot@im.bot",
          target: "owner@im.wechat",
          label: "Aloong",
        },
      ],
    });
    expect(store.load()).toMatchObject({
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    await channel.close();
  });

  it("restores its private credential and persists target context from getupdates", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      userId: "owner@im.wechat",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    let call = 0;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      call += 1;
      if (call === 1) return response({ ret: 0 });
      if (call === 2) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          get_updates_buf: "old-cursor",
        });
        return response({
          ret: 0,
          get_updates_buf: "new-cursor",
          msgs: [
            {
              from_user_id: "owner@im.wechat",
              context_token: "new-private-context",
              create_time_ms: 1_723_456_789_000,
              item_list: [{ type: 1, text_item: { text: "secret inbound text" } }],
            },
          ],
        });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({
      store,
      fetch: fetchLike,
      now: () => 1_723_456_790_000,
    });
    const snapshots: TargetCandidate[][] = [];
    channel.onSnapshotChanged((snapshot) => snapshots.push(snapshot.targets));

    await channel.start();
    await vi.waitFor(async () => {
      expect(channel.getSnapshot().targets).toEqual([
        {
          accountId: "direct-bot@im.bot",
          target: "owner@im.wechat",
          lastInboundAt: 1_723_456_789_000,
          contextUpdatedAt: 1_723_456_790_000,
        },
      ]);
    });

    expect(store.load()).toMatchObject({
      getUpdatesBuf: "new-cursor",
      contextTokens: { "owner@im.wechat": "new-private-context" },
      targetMetadata: {
        "owner@im.wechat": {
          lastInboundAt: 1_723_456_789_000,
          contextUpdatedAt: 1_723_456_790_000,
        },
      },
    });
    expect(JSON.stringify(channel.getSnapshot())).not.toContain("secret inbound text");
    expect(snapshots).toEqual([
      [],
      [
        {
          accountId: "direct-bot@im.bot",
          target: "owner@im.wechat",
          lastInboundAt: 1_723_456_789_000,
          contextUpdatedAt: 1_723_456_790_000,
        },
      ],
    ]);
    await channel.close();
  });

  it("does not publish an inbound target when its context token cannot be persisted", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    const originalSave = store.save.bind(store);
    let attemptedSave = false;
    vi.spyOn(store, "save").mockImplementation((nextState) => {
      if (nextState.getUpdatesBuf === "new-cursor") {
        attemptedSave = true;
        throw new Error("disk unavailable");
      }
      originalSave(nextState);
    });
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !attemptedSave) {
        return response({
          ret: 0,
          get_updates_buf: "new-cursor",
          msgs: [
            {
              from_user_id: "owner@im.wechat",
              context_token: "must-not-publish",
            },
          ],
        });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    const snapshots: TargetCandidate[][] = [];
    channel.onSnapshotChanged((snapshot) => snapshots.push(snapshot.targets));

    await channel.start();
    await vi.waitFor(() => expect(attemptedSave).toBe(true));

    expect(snapshots).toEqual([[]]);
    await channel.close();
  });

  it("isolates failing target observers and honors unsubscription", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: {},
    });
    let updatesReturned = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !updatesReturned) {
        updatesReturned = true;
        return response({
          ret: 0,
          msgs: [
            {
              from_user_id: "owner@im.wechat",
              context_token: "private-context-token",
            },
          ],
        });
      }
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });
    channel.onSnapshotChanged(() => {
      throw new Error("presentation observer failed");
    });
    const snapshots: TargetCandidate[][] = [];
    const unsubscribe = channel.onSnapshotChanged((snapshot) => snapshots.push(snapshot.targets));
    unsubscribe();

    await channel.start();
    await vi.waitFor(async () => {
      expect(channel.getSnapshot().targets).toMatchObject([
        { accountId: "direct-bot@im.bot", target: "owner@im.wechat" },
      ]);
    });

    expect(snapshots).toEqual([[]]);
    await channel.close();
  });

  it("aborts its own long poll and sends a best-effort stop notification on close", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "",
      contextTokens: {},
    });
    const urls: string[] = [];
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      if (urls.length === 1 || urls.length === 3) return response({ ret: 0 });
      if (String(url).endsWith("/msg/notifystop")) return response({ ret: 0 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await channel.start();
    await channel.close();

    await vi.waitFor(() => {
      expect(urls).toContain("https://ilinkai.weixin.qq.com/ilink/bot/msg/notifystop");
    });
  });

  it("starts getupdates even when the optional start notification fails", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "",
      contextTokens: {},
    });
    const urls: string[] = [];
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      urls.push(value);
      if (value.endsWith("/msg/notifystart")) throw new Error("optional notification failed");
      if (value.endsWith("/getupdates")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return response({ ret: 0 });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await expect(channel.start()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(urls).toContain("https://ilinkai.weixin.qq.com/ilink/bot/getupdates");
    });
    await channel.close();
  });
});

describe("DirectIlinkChannel send", () => {
  it("persists and settles the text effect around the actual iLink request", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const order: string[] = [];
    const records = new Map<string, EffectRecord>();
    const ledger: EffectLedger = {
      prepare(intent: EffectIntent) {
        order.push("prepare");
        const record: EffectRecord = { ...intent, state: "prepared", createdAt: 1 };
        records.set(intent.attemptId, record);
        return record;
      },
      settle(attemptId: string, state: Exclude<EffectState, "prepared">, providerCode?: number) {
        order.push(`settle:${state}`);
        const prepared = records.get(attemptId)!;
        const record: EffectRecord = { ...prepared, state, ...(providerCode !== undefined ? { providerCode } : {}), settledAt: 2 };
        records.set(attemptId, record);
        return record;
      },
    };
    const channel = new DirectIlinkChannel({
      store,
      effectLedger: ledger,
      fetch: vi.fn(async () => {
        order.push("fetch");
        throw new Error("socket closed after request");
      }) as FetchLike,
    });

    await expect(channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "only metadata reaches the ledger",
    })).resolves.toMatchObject({ ok: false, reason: "unknown", retriedSegments: 0 });

    expect(order).toEqual(["prepare", "fetch", "settle:unknown"]);
    expect([...records.values()]).toMatchObject([{
      kind: "weixin_text",
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      state: "unknown",
      ordinal: 0,
    }]);
    expect(JSON.stringify([...records.values()])).not.toContain("only metadata");
    await channel.close();
  });

  it("does not call iLink when the durable effect intent cannot be persisted", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const fetchLike = vi.fn() as FetchLike;
    const channel = new DirectIlinkChannel({
      store,
      effectLedger: {
        prepare: () => { throw new Error("disk full"); },
        settle: () => { throw new Error("must not settle"); },
      },
      fetch: fetchLike,
    });

    await expect(channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "must not leave this process",
    })).resolves.toMatchObject({ ok: false, reason: "unavailable", retriedSegments: 0 });
    expect(fetchLike).not.toHaveBeenCalled();
    await channel.close();
  });

  it("reports sanitized preparation, request, response, and state-save timings", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    let clock = 1_800_000_000_000;
    const channel = new DirectIlinkChannel({
      store,
      fetch: vi.fn(async () => response({ ret: 0 })) as FetchLike,
      now: () => {
        clock += 5;
        return clock;
      },
    });

    const result = await channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "diagnose without exposing content",
    });

    expect(result.diagnostics).toEqual({
      prepare: { durationMs: expect.any(Number), outcome: "completed" },
      sendMessage: { durationMs: expect.any(Number), outcome: "completed" },
      responseRead: { durationMs: expect.any(Number), outcome: "completed" },
      stateSave: { durationMs: expect.any(Number), outcome: "completed" },
      requestCount: 1,
    });
    for (const step of Object.values(result.diagnostics!).filter((value) => typeof value === "object")) {
      expect(step.durationMs).toBeGreaterThan(0);
    }
    expect(JSON.stringify(result.diagnostics)).not.toContain("private-");
    await channel.close();
  });

  it("does not call iLink when the target has no inbound context token", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: {},
    });
    const fetchLike = vi.fn() as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await expect(
      channel.sendText({
        accountId: "direct-bot@im.bot",
        target: "owner@im.wechat",
        message: "must not send",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "context_missing" });
    expect(fetchLike).not.toHaveBeenCalled();
    await channel.close();
  });

  it("classifies sendmessage ret -2 as a stale context without exposing server text", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const fetchLike = vi.fn(async () => response({
      ret: -2,
      errcode: -2,
      errmsg: "must-not-be-public",
    })) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    const result = await channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "probe",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "context_stale",
      providerRet: -2,
      providerErrcode: -2,
      acceptedSegments: 0,
    });
    expect(JSON.stringify(result)).not.toContain("must-not-be-public");
    expect(channel.getSnapshot().accounts[0]?.credentialStatus).toBe("usable");
    await channel.close();
  });

  it("retries a rejected segment once with the same client id", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const bodies: Array<Record<string, unknown>> = [];
    const attempts: EffectRecord[] = [];
    const effectLedger: EffectLedger = {
      prepare(intent) {
        const record: EffectRecord = { ...intent, state: "prepared", createdAt: attempts.length + 1 };
        attempts.push(record);
        return record;
      },
      settle(attemptId, state, providerCode) {
        const index = attempts.findIndex((attempt) => attempt.attemptId === attemptId);
        const record: EffectRecord = { ...attempts[index]!, state, ...(providerCode !== undefined ? { providerCode } : {}), settledAt: 10 + index };
        attempts[index] = record;
        return record;
      },
    };
    const fetchLike = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ ret: bodies.length === 1 ? 40013 : 0 });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike, effectLedger });

    await expect(
      channel.sendText({
        accountId: "direct-bot@im.bot",
        target: "owner@im.wechat",
        message: "send once",
      }),
    ).resolves.toMatchObject({
      ok: true,
      totalSegments: 1,
      acceptedSegments: 1,
      retriedSegments: 1,
      duplicatePossible: false,
      diagnostics: {
        prepare: { outcome: "completed" },
        sendMessage: { outcome: "completed" },
        responseRead: { outcome: "completed" },
        stateSave: { outcome: "completed" },
        requestCount: 2,
      },
    });
    expect(fetchLike).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toMatchObject({ msg: { client_id: expect.any(String) } });
    expect(bodies[1]).toMatchObject({ msg: { client_id: expect.any(String) } });
    expect((bodies[0]?.msg as { client_id: string }).client_id).toBe(
      (bodies[1]?.msg as { client_id: string }).client_id,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ state: "rejected", providerCode: 40013 });
    expect(attempts[1]).toMatchObject({ state: "accepted" });
    expect(attempts[0]!.attemptId).not.toBe(attempts[1]!.attemptId);
    expect(attempts[0]!.operationId).toBe(attempts[1]!.operationId);
    expect(attempts[0]!.clientId).toBe(attempts[1]!.clientId);
    expect(channel.getSnapshot().accounts[0]?.credentialStatus).toBe("usable");
    await channel.close();
  });

  it("does not retry an unknown send result", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    let attempt = 0;
    const channel = new DirectIlinkChannel({
      store,
      fetch: vi.fn(async () => {
        attempt += 1;
        throw new Error("socket closed");
      }) as FetchLike,
    });

    await expect(channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "send once",
    })).resolves.toMatchObject({
      ok: false,
      reason: "unknown",
      retriedSegments: 0,
      duplicatePossible: false,
      diagnostics: {
        sendMessage: { outcome: "failed" },
        responseRead: { outcome: "skipped" },
        stateSave: { outcome: "skipped" },
        requestCount: 1,
      },
    });
    expect(attempt).toBe(1);
    await channel.close();
  });

  it("separates an invalid response body from a completed sendmessage request", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const channel = new DirectIlinkChannel({
      store,
      fetch: vi.fn(async () => new Response("not-json", { status: 200 })) as FetchLike,
    });

    await expect(channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "send once",
    })).resolves.toMatchObject({
      ok: false,
      reason: "unknown",
      retriedSegments: 0,
      diagnostics: {
        sendMessage: { outcome: "completed" },
        responseRead: { outcome: "failed" },
        stateSave: { durationMs: 0, outcome: "skipped" },
        requestCount: 1,
      },
    });
    await channel.close();
  });

  it("sends long text sequentially and reports every accepted segment", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const sentTexts: string[] = [];
    const fetchLike = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        msg: { item_list: Array<{ text_item: { text: string } }> };
      };
      sentTexts.push(body.msg.item_list[0]?.text_item.text ?? "");
      return response({ ret: 0 });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    const result = await channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "段".repeat(1_501),
    });

    expect(sentTexts).toHaveLength(2);
    expect(sentTexts[0]).toMatch(/^\[1\/2\]\n/);
    expect(sentTexts[1]).toMatch(/^\[2\/2\]\n/);
    expect(result).toMatchObject({
      ok: true,
      totalSegments: 2,
      acceptedSegments: 2,
      truncated: false,
      retriedSegments: 0,
      duplicatePossible: false,
    });
    expect(result.messageIds).toHaveLength(2);
    expect(result.messageId).toBe(result.messageIds?.[1]);
    await channel.close();
  });

  it("stops after the second failure of a segment and reports partial acceptance", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const bodies: Array<Record<string, unknown>> = [];
    const fetchLike = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ ret: bodies.length === 1 ? 0 : 40013 });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    const result = await channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "段".repeat(3_200),
    });

    expect(bodies).toHaveLength(3);
    expect((bodies[1]?.msg as { client_id: string }).client_id).toBe(
      (bodies[2]?.msg as { client_id: string }).client_id,
    );
    expect(result).toMatchObject({
      ok: false,
      totalSegments: 3,
      acceptedSegments: 1,
      retriedSegments: 1,
      duplicatePossible: false,
      reason: "rejected",
    });
    expect(result.messageIds).toHaveLength(1);
    await channel.close();
  });

  it("classifies send -14 as stale bot credentials and disables later sends", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const fetchLike = vi.fn(async () => response({ ret: -14 })) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await expect(
      channel.sendText({
        accountId: "direct-bot@im.bot",
        target: "owner@im.wechat",
        message: "send once",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "微信 bot 凭据已失效或暂停",
      reason: "auth_stale",
      acceptedSegments: 0,
      retriedSegments: 0,
    });
    await expect(
      channel.sendText({
        accountId: "direct-bot@im.bot",
        target: "owner@im.wechat",
        message: "must not send again",
      }),
    ).resolves.toMatchObject({ ok: false, reason: "auth_stale" });
    expect(fetchLike).toHaveBeenCalledTimes(1);
    expect(channel.getSnapshot().accounts[0]?.credentialStatus).toBe("stale");
    await channel.close();
  });

  it("sends one text with the matching private context token and explicit account", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push({ url: String(url), ...(init ? { init } : {}) });
      return response({ ret: 0 });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({
      store,
      fetch: fetchLike,
      now: () => 1_723_456_799_000,
    });

    const result = await channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "direct iLink test",
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toMatch(/^weixin-direct:/);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://ilinkai.weixin.qq.com/ilink/bot/sendmessage");
    expect(new Headers(requests[0]?.init?.headers).get("Authorization")).toBe(
      "Bearer private-bot-token",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      msg: {
        to_user_id: "owner@im.wechat",
        message_type: 2,
        message_state: 2,
        context_token: "private-context-token",
        item_list: [{ type: 1, text_item: { text: "direct iLink test" } }],
      },
      base_info: { bot_agent: "WeixinDirectDemo/0.1.0" },
    });
    expect(store.load()).toMatchObject({
      targetMetadata: {
        "owner@im.wechat": { lastSendAcceptedAt: 1_723_456_799_000 },
      },
    });
    await channel.close();
  });

  it("keeps an accepted send successful when only timestamp persistence fails", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "cursor",
      contextTokens: { "owner@im.wechat": "private-context-token" },
    });
    vi.spyOn(store, "save").mockImplementation(() => {
      throw new Error("disk unavailable after channel acceptance");
    });
    const fetchLike = vi.fn(async () => response({ ret: 0 })) as FetchLike;
    const channel = new DirectIlinkChannel({ store, fetch: fetchLike });

    await expect(
      channel.sendText({
        accountId: "direct-bot@im.bot",
        target: "owner@im.wechat",
        message: "accepted once",
      }),
    ).resolves.toMatchObject({
      ok: true,
      diagnostics: {
        stateSave: { outcome: "failed" },
        requestCount: 1,
      },
    });
    expect(fetchLike).toHaveBeenCalledTimes(1);
    await channel.close();
  });

  it("does not overwrite a newer inbound context when recording send acceptance", async () => {
    const store = storeInTemp();
    store.save({
      version: 1,
      accountId: "direct-bot@im.bot",
      token: "private-bot-token",
      baseUrl: "https://ilinkai.weixin.qq.com",
      getUpdatesBuf: "old-cursor",
      contextTokens: { "owner@im.wechat": "old-context-token" },
    });
    let resolveUpdates!: (value: Response) => void;
    let resolveSend!: (value: Response) => void;
    let updatesStarted = false;
    const fetchLike = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const value = String(url);
      if (value.endsWith("/msg/notifystart")) return response({ ret: 0 });
      if (value.endsWith("/getupdates") && !updatesStarted) {
        updatesStarted = true;
        return new Promise<Response>((resolve) => {
          resolveUpdates = resolve;
        });
      }
      if (value.endsWith("/getupdates")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (value.endsWith("/sendmessage")) {
        return new Promise<Response>((resolve) => {
          resolveSend = resolve;
        });
      }
      return response({ ret: 0 });
    }) as FetchLike;
    const channel = new DirectIlinkChannel({
      store,
      fetch: fetchLike,
      now: () => 1_723_456_799_000,
    });
    await channel.start();
    await vi.waitFor(() => expect(updatesStarted).toBe(true));

    const sending = channel.sendText({
      accountId: "direct-bot@im.bot",
      target: "owner@im.wechat",
      message: "accepted during inbound",
    });
    await vi.waitFor(() => expect(resolveSend).toBeTypeOf("function"));
    resolveUpdates(
      response({
        ret: 0,
        get_updates_buf: "new-cursor",
        msgs: [
          {
            from_user_id: "owner@im.wechat",
            context_token: "new-context-token",
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(store.load()?.getUpdatesBuf).toBe("new-cursor"));
    resolveSend(response({ ret: 0 }));
    await expect(sending).resolves.toMatchObject({ ok: true });

    expect(store.load()).toMatchObject({
      getUpdatesBuf: "new-cursor",
      contextTokens: { "owner@im.wechat": "new-context-token" },
      targetMetadata: {
        "owner@im.wechat": { lastSendAcceptedAt: 1_723_456_799_000 },
      },
    });
    await channel.close();
  });
});

describe("scheduled delivery binding recovery", () => {
  const network = vi.fn(async () => { throw new Error("unexpected real network in scheduled fixture"); });
  beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network); });
  afterEach(() => {
    try { expect(network).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
  it("does not let a late old send authentication failure invalidate a replacement binding", async () => {
    const store = storeInTemp();
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "old-token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: { "user@im.wechat": "old-context" } });
    let release!: () => void;
    const channel = new DirectIlinkChannel({ store, fetch: async (url) => {
      if (String(url).includes("/sendmessage")) {
        await new Promise<void>((resolve) => { release = resolve; });
        return response({ ret: -14 });
      }
      if (String(url).includes("/get_bot_qrcode")) return response({ qrcode: "login", qrcode_img_content: "https://weixin.qq.com/x/login" });
      if (String(url).includes("/get_qrcode_status")) return response({ status: "confirmed", bot_token: "new-token", ilink_bot_id: "direct-bot@im.bot" });
      throw new Error("unexpected request");
    } });
    try {
      const sending = channel.sendText({ accountId: "direct-bot@im.bot", target: "user@im.wechat", message: "cached reminder" });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const rebound = await new Promise<{ ok: boolean }>((resolve) => channel.startLogin(() => {}, resolve));
      expect(rebound.ok).toBe(true);
      release();
      expect(await sending).toMatchObject({ ok: false, reason: "auth_stale" });
      expect(channel.getSnapshot().accounts[0]?.credentialStatus).toBe("usable");
    } finally { channel.close(); }
  });
  it("ignores an old monitor-start authentication error after credentials were replaced", async () => {
    const store = storeInTemp();
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "old-token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: {} });
    let release!: () => void;
    const channel = new DirectIlinkChannel({ store, fetch: async (url) => {
      if (String(url).includes("/notifystart")) { await new Promise<void>((resolve) => { release = resolve; }); return response({ ret: -14 }); }
      if (String(url).includes("/get_bot_qrcode")) return response({ qrcode: "login", qrcode_img_content: "https://weixin.qq.com/x/login" });
      if (String(url).includes("/get_qrcode_status")) return response({ status: "confirmed", bot_token: "new-token", ilink_bot_id: "direct-bot@im.bot" });
      throw new Error("unexpected request");
    } });
    try {
      const starting = channel.start(); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(await new Promise<{ ok: boolean }>((resolve) => channel.startLogin(() => {}, resolve))).toMatchObject({ ok: true });
      release(); await starting;
      expect(channel.getSnapshot().accounts[0]?.credentialStatus).toBe("usable");
    } finally { channel.close(); }
  });

  it("rejects the old channel instance after another instance durably replaces the binding", async () => {
    const store = storeInTemp();
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "old-token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: { "user@im.wechat": "old-context" } });
    const old = new DirectIlinkChannel({ store, fetch: async () => response({ ret: 0 }) });
    const replacement = new DirectIlinkChannel({ store, fetch: async (url) => String(url).includes("/get_bot_qrcode")
      ? response({ qrcode: "login", qrcode_img_content: "https://weixin.qq.com/x/login" })
      : response({ status: "confirmed", bot_token: "new-token", ilink_bot_id: "direct-bot@im.bot" }) });
    try {
      expect(await new Promise<{ ok: boolean }>((resolve) => replacement.startLogin(() => {}, resolve))).toMatchObject({ ok: true });
      expect(old.getDeliveryContext("direct-bot@im.bot", "user@im.wechat")).toMatchObject({ credentialStatus: "stale", contextGeneration: null });
    } finally { old.close(); replacement.close(); }
  });

  it("does not restore the old durable context checkpoint after a replacement binding and restart", async () => {
    const store = storeInTemp();
    const inbox = new DurableInboundStore(path.join(tempDirs.at(-1)!, "inbox.sqlite"));
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "old-token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: {} });
    inbox.ingestBatch({ accountId: "direct-bot@im.bot", nextCursor: "old-cursor", contexts: [{ target: "user@im.wechat", contextToken: "old-context", lastInboundAt: 1000, contextUpdatedAt: 1000 }], envelopes: [] });
    const channel = new DirectIlinkChannel({ store, inboundStore: inbox, fetch: async (url) => String(url).includes("/get_bot_qrcode")
      ? response({ qrcode: "login", qrcode_img_content: "https://weixin.qq.com/x/login" })
      : response({ status: "confirmed", bot_token: "new-token", ilink_bot_id: "direct-bot@im.bot" }) });
    try {
      expect(channel.getSnapshot().targets).toHaveLength(1);
      await new Promise<void>((resolve) => channel.startLogin(() => {}, () => resolve()));
      channel.close();
      const restarted = new DirectIlinkChannel({ store, inboundStore: inbox, fetch: async () => response({ ret: 0 }) });
      try { expect(restarted.getSnapshot().targets).toEqual([]); }
      finally { restarted.close(); }
    } finally { channel.close(); inbox.close(); }
  });

  it("distinguishes new contexts at the same timestamp and persists their identity across restart", async () => {
    const store = storeInTemp();
    const inbox = new DurableInboundStore(path.join(tempDirs.at(-1)!, "inbox.sqlite"));
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: {} });
    let polls = 0, release!: () => void;
    const channel = new DirectIlinkChannel({ store, inboundStore: inbox, now: () => 1000, fetch: async (url, init) => {
      if (!String(url).includes("getupdates")) return response({ ret: 0 });
      polls += 1;
      if (polls === 2) await new Promise<void>((resolve) => { release = resolve; });
      if (polls > 2) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return response({ ret: 0, get_updates_buf: `cursor-${polls}`, msgs: [{ message_id: polls, from_user_id: "user@im.wechat", to_user_id: "direct-bot@im.bot", message_type: 1, message_state: 2, context_token: "same-token", create_time_ms: 1000, item_list: [{ type: 1, text_item: { text: "刷新" } }] }] });
    } });
    try {
      await channel.start();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const first = channel.getDeliveryContext("direct-bot@im.bot", "user@im.wechat");
      expect(first.contextGeneration).toBeTypeOf("string");
      release(); await vi.waitFor(() => expect(polls).toBe(3));
      const second = channel.getDeliveryContext("direct-bot@im.bot", "user@im.wechat");
      expect(second.contextGeneration).not.toBe(first.contextGeneration);
      channel.close();
      const restarted = new DirectIlinkChannel({ store, inboundStore: inbox, fetch: async () => response({ ret: 0 }) });
      try { expect(restarted.getDeliveryContext("direct-bot@im.bot", "user@im.wechat")).toEqual(second); }
      finally { restarted.close(); }
    } finally { channel.close(); inbox.close(); }
  });

  it("does not treat a duplicate provider event as a new recovery context", async () => {
    const store = storeInTemp();
    const inbox = new DurableInboundStore(path.join(tempDirs.at(-1)!, "inbox.sqlite"));
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: {} });
    let polls = 0, release!: () => void;
    const channel = new DirectIlinkChannel({ store, inboundStore: inbox, now: () => 1000, fetch: async (url, init) => {
      if (!String(url).includes("getupdates")) return response({ ret: 0 });
      polls += 1;
      if (polls === 2) await new Promise<void>((resolve) => { release = resolve; });
      if (polls > 2) return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return response({ ret: 0, get_updates_buf: `cursor-${polls}`, msgs: [{ message_id: "same-message", from_user_id: "user@im.wechat", to_user_id: "direct-bot@im.bot", message_type: 1, message_state: 2, context_token: "same-token", create_time_ms: 1000, item_list: [{ type: 1, text_item: { text: "刷新" } }] }] });
    } });
    try {
      await channel.start();
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const first = channel.getDeliveryContext("direct-bot@im.bot", "user@im.wechat");
      expect(first.contextGeneration).toBeTypeOf("string");
      release(); await vi.waitFor(() => expect(polls).toBe(3));
      const second = channel.getDeliveryContext("direct-bot@im.bot", "user@im.wechat");
      expect(second.contextGeneration).toBe(first.contextGeneration);
      channel.close();
      const restarted = new DirectIlinkChannel({ store, inboundStore: inbox, fetch: async () => response({ ret: 0 }) });
      try { expect(restarted.getDeliveryContext("direct-bot@im.bot", "user@im.wechat")).toEqual(second); }
      finally { restarted.close(); }
    } finally { channel.close(); inbox.close(); }
  });

  it("preserves scheduled part bytes, checks its live guard and never retries a rejected part", async () => {
    const store = storeInTemp();
    store.save({ version: 1, accountId: "direct-bot@im.bot", token: "token", baseUrl: "https://ilinkai.weixin.qq.com", getUpdatesBuf: "", contextTokens: { "user@im.wechat": "context" } });
    const bodies: string[] = [];
    const channel = new DirectIlinkChannel({ store, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body.msg.item_list[0].text_item.text);
      return response({ ret: 123 });
    } });
    try {
      const input = { accountId: "direct-bot@im.bot", target: "user@im.wechat", message: "  完整段落\n", scheduled: { operationId: "scheduled-part-1", beforeSubmit: () => true } };
      expect(await channel.sendText(input)).toMatchObject({ ok: false, reason: "rejected" });
      expect(bodies).toEqual(["  完整段落\n"]);
      await channel.sendText({ ...input, scheduled: { operationId: "scheduled-part-2", beforeSubmit: () => false } });
      expect(bodies).toHaveLength(1);
    } finally { channel.close(); }
  });

});
