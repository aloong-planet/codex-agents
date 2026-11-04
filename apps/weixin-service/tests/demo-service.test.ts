import { describe, expect, it, vi } from "vitest";

import {
  DemoService,
  type ChannelSnapshot,
  type InboundTextEvent,
  type LocalLabelUpdate,
  type SendTextResult,
  type WeixinChannel,
} from "../src/demo-service.js";
import type { LoginOutputEvent } from "../src/login-output.js";

class FakePort implements WeixinChannel {
  loginListener?: (event: LoginOutputEvent) => void;
  exitListener?: (result: { ok: boolean; message?: string }) => void;
  sent: Array<{ accountId: string; target: string; message: string }> = [];
  sendResult: SendTextResult = {
    ok: true,
    messageId: "msg-1",
  };
  sendGate?: Promise<SendTextResult>;
  snapshot: ChannelSnapshot = {
    accounts: [{ accountId: "bot-a", credentialStatus: "usable" }],
    targets: [{ accountId: "bot-a", target: "user@im.wechat" }],
  };
  snapshotListener?: (snapshot: ChannelSnapshot) => void;
  inboundListener?: (event: InboundTextEvent) => void;
  unsubscribeSnapshot = vi.fn();
  unsubscribeInbound = vi.fn();
  labelUpdates: LocalLabelUpdate[] = [];

  async start(): Promise<void> {}

  startLogin(
    onEvent: (event: LoginOutputEvent) => void,
    onExit: (result: { ok: boolean; message?: string }) => void,
  ) {
    this.loginListener = onEvent;
    this.exitListener = onExit;
    return {
      submitPairCode: vi.fn(),
      terminate: vi.fn(),
    };
  }

  async sendText(input: { accountId: string; target: string; message: string }) {
    this.sent.push(input);
    return this.sendGate ?? this.sendResult;
  }

  publishTargets(targets: Array<{ accountId: string; target: string }>): void {
    this.snapshot = { ...this.snapshot, targets };
    this.snapshotListener?.(this.snapshot);
  }

  getSnapshot(): ChannelSnapshot {
    return structuredClone(this.snapshot);
  }

  onSnapshotChanged(listener: (snapshot: ChannelSnapshot) => void): () => void {
    this.snapshotListener = listener;
    listener(this.getSnapshot());
    return this.unsubscribeSnapshot;
  }

  onInboundText(listener: (event: InboundTextEvent) => void): () => void {
    this.inboundListener = listener;
    return this.unsubscribeInbound;
  }

  publishInbound(event: InboundTextEvent): void {
    this.snapshot = {
      ...this.snapshot,
      targets: [
        ...this.snapshot.targets.filter(
          (target) => target.accountId !== event.accountId || target.target !== event.target,
        ),
        { accountId: event.accountId, target: event.target, lastInboundAt: event.receivedAt },
      ],
    };
    this.snapshotListener?.(this.snapshot);
    this.inboundListener?.(event);
  }

  updateLocalLabels(input: LocalLabelUpdate): void {
    this.labelUpdates.push(input);
    this.snapshot = {
      accounts: this.snapshot.accounts.map((account) =>
        account.accountId === input.accountId
          ? { ...account, ...(input.accountLabel ? { label: input.accountLabel.trim() } : {}) }
          : account,
      ),
      targets: this.snapshot.targets.map((target) =>
        target.accountId === input.accountId && target.target === input.target
          ? { ...target, ...(input.targetLabel ? { label: input.targetLabel.trim() } : {}) }
          : target,
      ),
    };
    this.snapshotListener?.(this.snapshot);
  }

  close(): void {}
}

describe("DemoService", () => {
  it("includes the sanitized workflow run projection in public state", async () => {
    const workflows = {
      getPublicState: () => ({
        runs: [{
          runRef: "wf-1234abcd",
          source: "fixture" as const,
          workflowId: "fixture.pipeline",
          occurredAt: 1_800_000_000_000,
          status: "succeeded" as const,
          createdAt: 1_800_000_000_100,
          updatedAt: 1_800_000_000_200,
          steps: [],
          effects: [],
        }],
      }),
    };
    const service = new DemoService(
      new FakePort(),
      async () => "data:image/svg+xml,safe",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workflows,
    );

    expect(service.getPublicState().workflows).toEqual(workflows.getPublicState());
    await service.close();
  });

  it("exposes and configures independent media export grants", async () => {
    const configure = vi.fn();
    const mediaExports = {
      getPublicState: () => ({ revision: 0, roots: [{ id: "pictures", displayName: "Pictures", enabled: false, status: "available" as const }] }),
      configure,
    };
    const service = new DemoService(
      new FakePort(),
      async () => "data:image/svg+xml,safe",
      undefined,
      undefined,
      undefined,
      undefined,
      mediaExports,
    );

    expect(service.getPublicState().mediaExports?.roots[0]).toMatchObject({ id: "pictures", enabled: false });
    service.configureMediaExports({ rootIds: ["pictures"], confirmed: true });
    expect(configure).toHaveBeenCalledWith({ rootIds: ["pictures"], confirmed: true });
    await service.close();
  });
  it("automatically binds a valid first voice transcript after login and greets that sender once", async () => {
    const port = new FakePort();
    port.snapshot = { accounts: [{ accountId: "bot-new", credentialStatus: "usable" }], targets: [] };
    const saved: unknown[] = [];
    const bindingStore = {
      load: () => ({ version: 1 as const, status: "idle" as const }),
      save: (record: unknown) => saved.push(structuredClone(record)),
    };
    const service = new DemoService(
      port,
      async () => "data:image/svg+xml,safe",
      undefined,
      undefined,
      bindingStore,
    );
    const replyText = vi.fn().mockResolvedValue({ ok: true, messageId: "welcome-1" });
    const inbound = {
      key: "event-1",
      accountId: "bot-new",
      target: "owner@im.wechat",
      messageId: "inbound-1",
      source: "voice",
      text: "你好，我在用语音",
      receivedAt: 1_800_000_000_000,
      replyText,
    } satisfies InboundTextEvent;

    service.startLogin();
    port.loginListener?.({ kind: "connected" });
    await vi.waitFor(() =>
      expect(service.getPublicState()).toMatchObject({
        autoBinding: { status: "awaiting_inbound", accountId: "bot-new" },
      }),
    );

    port.publishInbound(inbound);
    port.publishInbound({ ...inbound, key: "event-2", messageId: "inbound-2", text: "第二条" });

    await vi.waitFor(() =>
      expect(service.getPublicState()).toMatchObject({
        phase: "ready",
        selectedAccountId: "bot-new",
        selectedTarget: "owner@im.wechat",
        autoBinding: {
          status: "accepted",
          accountId: "bot-new",
          target: "owner@im.wechat",
        },
      }),
    );
    expect(replyText).toHaveBeenCalledOnce();
    expect(replyText).toHaveBeenCalledWith("你好，微信连接已成功，现在可以直接给我发指令了。");
    expect(JSON.stringify(service.getPublicState())).not.toContain("event-1");
    expect(saved).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "awaiting_inbound", accountId: "bot-new" }),
      expect.objectContaining({ status: "sending", eventKey: "event-1" }),
      expect.objectContaining({ status: "accepted", eventKey: "event-1" }),
    ]));
  });

  it("keeps the automatic binding but never retries when the greeting request throws", async () => {
    const port = new FakePort();
    port.snapshot = { accounts: [{ accountId: "bot-new", credentialStatus: "usable" }], targets: [] };
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    const replyText = vi.fn().mockRejectedValue(new Error("network timeout"));

    service.startLogin();
    port.loginListener?.({ kind: "connected" });
    await vi.waitFor(() =>
      expect(service.getPublicState().autoBinding.status).toBe("awaiting_inbound"),
    );
    const inbound = {
      key: "event-timeout-1",
      accountId: "bot-new",
      target: "owner@im.wechat",
      messageId: "inbound-timeout-1",
      source: "text",
      text: "你好",
      receivedAt: 1_800_000_000_000,
      replyText,
    } satisfies InboundTextEvent;

    port.publishInbound(inbound);
    await vi.waitFor(() =>
      expect(service.getPublicState()).toMatchObject({
        phase: "ready",
        selectedTarget: "owner@im.wechat",
        autoBinding: { status: "failed", reason: "unknown" },
      }),
    );
    port.publishInbound({ ...inbound, key: "event-timeout-2" });
    await Promise.resolve();

    expect(replyText).toHaveBeenCalledOnce();
    expect(service.getPublicState().notice).toMatch(/结果未知.*没有自动重试/);
  });

  it("fails closed without arming or greeting when the post-login binding state cannot persist", async () => {
    const port = new FakePort();
    port.snapshot = { accounts: [{ accountId: "bot-new", credentialStatus: "usable" }], targets: [] };
    let saves = 0;
    const bindingStore = {
      load: () => ({ version: 1 as const, status: "idle" as const }),
      save: () => {
        saves += 1;
        if (saves > 1) throw new Error("disk unavailable");
      },
    };
    const service = new DemoService(
      port,
      async () => "data:image/svg+xml,safe",
      undefined,
      undefined,
      bindingStore,
    );

    service.startLogin();
    port.loginListener?.({ kind: "connected" });

    await vi.waitFor(() =>
      expect(service.getPublicState()).toMatchObject({
        phase: "login_error",
        autoBinding: { status: "idle" },
      }),
    );
    expect(service.getPublicState().notice).toMatch(/自动绑定状态.*无法保存/);
  });

  it("does not bind historical or different-account inbound messages", async () => {
    const port = new FakePort();
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    const replyText = vi.fn().mockResolvedValue({ ok: true, messageId: "must-not-send" });
    const event = {
      key: "historical-event",
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "historical-message",
      source: "text",
      text: "旧消息",
      receivedAt: 1_800_000_000_000,
      replyText,
    } satisfies InboundTextEvent;

    port.publishInbound(event);
    service.startLogin();
    port.snapshot = { accounts: [{ accountId: "bot-new", credentialStatus: "usable" }], targets: [] };
    port.loginListener?.({ kind: "connected" });
    await vi.waitFor(() =>
      expect(service.getPublicState().autoBinding.status).toBe("awaiting_inbound"),
    );
    port.publishInbound(event);
    await Promise.resolve();

    expect(replyText).not.toHaveBeenCalled();
    expect(service.getPublicState()).toMatchObject({
      selectedAccountId: null,
      selectedTarget: null,
      autoBinding: { status: "awaiting_inbound", accountId: "bot-new" },
    });
  });

  it("restores a persisted pending binding after a service reload", async () => {
    const port = new FakePort();
    const bindingStore = {
      load: () => ({
        version: 1 as const,
        status: "awaiting_inbound" as const,
        accountId: "bot-a",
        updatedAt: 1_800_000_000_000,
      }),
      save: vi.fn(),
    };
    const service = new DemoService(
      port,
      async () => "data:image/svg+xml,safe",
      undefined,
      undefined,
      bindingStore,
    );
    const replyText = vi.fn().mockResolvedValue({ ok: true, messageId: "welcome-restored" });

    port.publishInbound({
      key: "restored-event",
      accountId: "bot-a",
      target: "user@im.wechat",
      messageId: "restored-message",
      source: "text",
      text: "重载后的首条消息",
      receivedAt: 1_800_000_000_100,
      replyText,
    });

    await vi.waitFor(() =>
      expect(service.getPublicState().autoBinding.status).toBe("accepted"),
    );
    expect(replyText).toHaveBeenCalledOnce();
  });

  it("saves local account and target aliases through the channel snapshot seam", () => {
    const port = new FakePort();
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");

    service.saveLocalLabels({
      accountId: "bot-a",
      accountLabel: "我的个人微信",
      target: "user@im.wechat",
      targetLabel: "Aloong",
    });

    expect(port.labelUpdates).toEqual([
      {
        accountId: "bot-a",
        accountLabel: "我的个人微信",
        target: "user@im.wechat",
        targetLabel: "Aloong",
      },
    ]);
    expect(service.getPublicState()).toMatchObject({
      accounts: [{ accountId: "bot-a", label: "我的个人微信" }],
      targets: [{ target: "user@im.wechat", label: "Aloong" }],
    });
  });

  it("disables sending when the direct channel reports stale bot credentials", async () => {
    const port = new FakePort();
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    service.confirmSession({
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    });

    port.snapshot = {
      ...port.snapshot,
      accounts: [{ accountId: "bot-a", credentialStatus: "stale" }],
    };
    port.snapshotListener?.(port.snapshot);

    expect(service.getPublicState()).toMatchObject({ phase: "account_stale" });
    await expect(service.sendTestMessage("must not send")).rejects.toThrow(/凭据/);
    expect(port.sent).toHaveLength(0);
  });

  it("automatically publishes targets received from the direct channel", async () => {
    const port = new FakePort();
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");

    port.publishTargets([{ accountId: "bot-a", target: "auto@im.wechat" }]);

    expect(service.getPublicState()).toMatchObject({
      accounts: [{ accountId: "bot-a", credentialStatus: "usable" }],
      targets: [{ accountId: "bot-a", target: "auto@im.wechat" }],
      notice: "已自动同步新的微信入站目标。新连接会由首条消息自动完成绑定。",
    });
    await service.close();
    expect(port.unsubscribeSnapshot).toHaveBeenCalledOnce();
  });

  it("leaves a visible retryable error when direct login cannot start synchronously", () => {
    const port = new FakePort();
    port.startLogin = () => {
      throw new Error("private state unavailable");
    };
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");

    expect(() => service.startLogin()).toThrow(/private state unavailable/);
    expect(service.getPublicState()).toMatchObject({
      phase: "login_error",
      qrDataUrl: null,
    });
  });

  it("terminates a login whose QR cannot be rendered so the user can retry", async () => {
    const port = new FakePort();
    const service = new DemoService(port, async () => {
      throw new Error("render failed");
    });

    service.startLogin();
    const firstHandle = port.loginListener;
    firstHandle?.({ kind: "qr", url: "https://weixin.qq.com/x/valid" });
    await vi.waitFor(() => expect(service.getPublicState().phase).toBe("login_error"));

    expect(() => service.startLogin()).not.toThrow();
  });

  it("starts with credential metadata only and never exposes secrets", () => {
    const service = new DemoService(new FakePort(), async () => "data:image/svg+xml,safe");

    expect(service.getPublicState()).toMatchObject({
      phase: "configured",
      accounts: [{ accountId: "bot-a", credentialStatus: "usable" }],
      qrDataUrl: null,
    });
    expect(JSON.stringify(service.getPublicState())).not.toMatch(/token|secret/i);
  });

  it("publishes a QR image but not the source QR URL", async () => {
    const port = new FakePort();
    const service = new DemoService(port, async (url) => {
      expect(url).toContain("ticket=private");
      return "data:image/svg+xml;base64,public-image";
    });

    service.startLogin();
    port.loginListener?.({
      kind: "qr",
      url: "https://ilinkai.weixin.qq.com/connect?ticket=private",
    });
    await vi.waitFor(() => expect(service.getPublicState().phase).toBe("awaiting_scan"));

    const state = service.getPublicState();
    expect(state.qrDataUrl).toBe("data:image/svg+xml;base64,public-image");
    expect(JSON.stringify(state)).not.toContain("ticket=private");
  });

  it("accepts a synced target without requiring its machine ID twice", async () => {
    const service = new DemoService(new FakePort(), async () => "data:image/svg+xml,safe");

    await service.discoverTargets();
    service.confirmSession({
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    });

    expect(service.getPublicState()).toMatchObject({
      phase: "ready",
      selectedAccountId: "bot-a",
      selectedTarget: "user@im.wechat",
    });
  });

  it("does not enable send for a manually entered target without direct inbound context", () => {
    const service = new DemoService(new FakePort(), async () => "data:image/svg+xml,safe");

    expect(() =>
      service.confirmSession({
        accountId: "bot-a",
        target: "unknown@im.wechat",
        inboundConfirmed: true,
      }),
    ).toThrow(/尚未发现该直连入站目标/);
  });

  it("discovers only safe target metadata from recent inbound channel logs", async () => {
    const service = new DemoService(new FakePort(), async () => "data:image/svg+xml,safe");

    await service.discoverTargets();

    expect(service.getPublicState().targets).toEqual([
      { accountId: "bot-a", target: "user@im.wechat" },
    ]);
  });

  it("blocks send until ready and reports only channel acceptance", async () => {
    const port = new FakePort();
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");

    await expect(service.sendTestMessage("hello")).rejects.toThrow(/尚未完成/);

    await service.discoverTargets();
    service.confirmSession({
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    });
    await service.sendTestMessage("hello");

    expect(port.sent).toEqual([
      { accountId: "bot-a", target: "user@im.wechat", message: "hello" },
    ]);
    expect(service.getPublicState()).toMatchObject({
      phase: "sent",
      notice: "渠道已接受发送，请在微信端确认是否收到。",
    });
  });

  it("accepts a long logical test message and reports segmented channel acceptance", async () => {
    const port = new FakePort();
    port.sendResult = {
      ok: true,
      messageId: "part-2",
      messageIds: ["part-1", "part-2"],
      totalSegments: 2,
      acceptedSegments: 2,
      truncated: false,
      retriedSegments: 0,
      duplicatePossible: false,
    };
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    await service.discoverTargets();
    service.confirmSession({
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    });

    await service.sendTestMessage("长".repeat(1_501));

    expect(port.sent[0]?.message).toHaveLength(1_501);
    expect(service.getPublicState().notice).toMatch(/2 段.*渠道接受/);
  });

  it("does not retry or claim success when direct iLink returns an error", async () => {
    const port = new FakePort();
    port.sendResult = { ok: false, error: "channel rejected" };
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    await service.discoverTargets();
    service.confirmSession({
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    });

    await expect(service.sendTestMessage("hello")).rejects.toThrow(/发送失败/);

    expect(port.sent).toHaveLength(1);
    expect(service.getPublicState()).toMatchObject({ phase: "send_error" });
    expect(service.getPublicState().notice).toMatch(/重新发一条消息刷新上下文.*没有自动重试/);
    expect(service.getPublicState().notice).not.toMatch(/成功|已收到/);
  });

  it("turns a send-time -14 classification into a stale account state", async () => {
    const port = new FakePort();
    port.sendResult = { ok: false, reason: "auth_stale", error: "stale" };
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    service.confirmSession({
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    });

    await expect(service.sendTestMessage("hello")).rejects.toThrow(/凭据.*没有自动重试/);
    expect(service.getPublicState()).toMatchObject({ phase: "account_stale" });
    expect(port.sent).toHaveLength(1);
  });

  it("does not preserve a connected claim when the login process exits non-zero", () => {
    const port = new FakePort();
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    service.startLogin();
    port.loginListener?.({ kind: "connected" });
    port.exitListener?.({ ok: false });

    expect(service.getPublicState()).toMatchObject({ phase: "login_error" });
  });

  it("does not overwrite a stale credential detected while starting inbound monitoring", async () => {
    const port = new FakePort();
    port.start = async () => {
      port.snapshot = {
        ...port.snapshot,
        accounts: [{ accountId: "bot-a", credentialStatus: "stale" }],
      };
      port.snapshotListener?.(port.snapshot);
    };
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    service.startLogin();

    port.loginListener?.({ kind: "connected" });
    await Promise.resolve();
    await Promise.resolve();
    expect(service.getPublicState().phase).toBe("account_stale");
  });

  it("does not start rebinding while a real send is in flight", async () => {
    const port = new FakePort();
    let release!: (value: { ok: boolean; messageId: string }) => void;
    port.sendGate = new Promise((resolve) => {
      release = resolve;
    });
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    await service.discoverTargets();
    service.confirmSession({
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    });

    const sending = service.sendTestMessage("hello");
    expect(() => service.startLogin()).toThrow(/发送正在进行/);
    release({ ok: true, messageId: "msg-1" });
    await sending;
  });

  it("keeps a concurrent stale-account signal after an accepted send completes", async () => {
    const port = new FakePort();
    let release!: (value: { ok: boolean; messageId: string }) => void;
    port.sendGate = new Promise((resolve) => {
      release = resolve;
    });
    const service = new DemoService(port, async () => "data:image/svg+xml,safe");
    service.confirmSession({
      accountId: "bot-a",
      target: "user@im.wechat",
      inboundConfirmed: true,
    });

    const sending = service.sendTestMessage("hello");
    port.snapshot = {
      ...port.snapshot,
      accounts: [{ accountId: "bot-a", credentialStatus: "stale" }],
    };
    port.snapshotListener?.(port.snapshot);
    release({ ok: true, messageId: "accepted" });
    await sending;

    expect(service.getPublicState()).toMatchObject({
      phase: "account_stale",
      notice: expect.stringMatching(/渠道已接受本次发送.*凭据/),
    });
  });
});
