import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalFileTools } from "../src/local-file-tools.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WeixinTurnAdapter } from "../src/weixin-turn-adapter.js";
import { scriptedTurnRunner } from "./fixtures/scripted-turn-runner.js";

import type { InboundTextEvent } from "../src/demo-service.js";
import type { InboundContent } from "../src/channel-contract.js";
import { WorkflowToolGateway } from "../src/workflow-tool-gateway.js";
import { WorkflowToolHost } from "../src/workflow-tool-host.js";
import {
  MAIN_WEIXIN_DISABLED_FEATURES,
  createMediaSendToolRegistration,
  createWorkflowToolReplyProjector,
  WorkflowToolProductionControl,
} from "../src/workflow-tool-production.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { WorkflowEngine, type WorkflowSubmission, type WorkflowTrigger } from "../src/workflow-engine.js";

describe("WorkflowToolProductionControl", () => {
  it("retains the complete specialist task brief without treating it as a short file search", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "long-task-binding-"));
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions);
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: true });
    const engine = new WorkflowEngine(path.join(root, "workflows.sqlite"));
    const host = new WorkflowToolHost(catalog, new WorkflowToolGateway(catalog, [], engine, () => { throw new Error("unused"); }));
    const control = new WorkflowToolProductionControl(host, files);
    const text = "请帮我整理闲鱼和淘宝的商品文案包，保存为 demo-vault 中的 alice-listing.md，并把文件发回本群。商品事实：九成新二手机械键盘，品牌 Keychron，型号 K2，蓝牙和有线连接，红轴，购于 2025 年，键帽轻微使用痕迹，功能正常，原包装和 USB 线齐全，售价 200 元，南京同城自提。需要两个平台各自的标题、描述、成色披露和买家 FAQ；未提供的信息注明待确认，不要捏造，不发布商品。";
    const event: InboundContent = { key: "c".repeat(64), accountId: "bot", target: "group", senderId: "ou_owner", conversationType: "group", text,
      messageId: "long-task", source: "text", receivedAt: Date.now() };
    try {
      expect(Buffer.byteLength(text)).toBeGreaterThan(500);
      const binding = await control.bind("thread", event);
      try {
        expect(files.resolveQuery(files.queryHandle(event.key)!)).toBe(text);
        expect(binding.snapshot()).toMatchObject({ owner: "model" });
      } finally { await binding.release(); }
      expect(files.queryHandle(event.key)).toBeNull();
      expect(() => files.captureQuery("legacy-search", text)).toThrow("workflow_file_query_invalid");
    } finally { await engine.close(); permissions.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("binds a textless attachment without inventing original user text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-binding-"));
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const files = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions);
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: true });
    const engine = new WorkflowEngine(path.join(root, "workflows.sqlite"));
    const host = new WorkflowToolHost(catalog, new WorkflowToolGateway(catalog, [], engine, () => { throw new Error("unused"); }));
    const control = new WorkflowToolProductionControl(host, files);
    const event: InboundTextEvent = { key: "b".repeat(64), accountId: "bot", target: "user", text: "", messageId: "image-only", source: "media", receivedAt: Date.now(),
      attachments: [{ kind: "image", path: path.join(root, "image.png"), fileName: "image.png", mimeType: "image/png", sizeBytes: 10, quoted: false }], replyText: async () => ({ ok: true }) };
    try {
      const binding = await control.bind("thread", event);
      try {
        const handle = files.queryHandle(event.key);
        expect(handle).not.toBeNull();
        expect(files.resolveQuery(handle!)).toBe("");
        expect(binding.snapshot()).toMatchObject({ owner: "model" });
      } finally { await binding.release(); }
      expect(files.queryHandle(event.key)).toBeNull();
    } finally { await engine.close(); permissions.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("D05 unwinds a real partial binding and permits a fresh local-file lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "binding-cleanup-"));
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const vault = path.join(root, "vault");
    fs.mkdirSync(vault);
    permissions.save({ moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "vault", label: "Vault", directory: vault, read: true, write: false }] });
    const files = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions);
    const local = new LocalFileTools(permissions, { moduleIds: ["notes"], spoolDirectory: path.join(root, "snapshots") });
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
    const engine = new WorkflowEngine(path.join(root, "workflows.sqlite"));
    const gateway = new WorkflowToolGateway(catalog, [], engine, () => { throw new Error("no terminal tools"); });
    const host = new WorkflowToolHost(catalog, gateway, local);
    const event: InboundTextEvent = { key: "a".repeat(64), accountId: "bot", target: "user", text: "查找笔记",
      messageId: "partial-binding", source: "text", receivedAt: Date.now(), replyText: async () => ({ ok: true }) };
    const occupied = host.bind("thread", { eventKey: "occupied", accountId: "bot", target: "user", occurredAt: Date.now(),
      originalTextRef: "occupied-query", attachmentRefs: [] });
    const control = new WorkflowToolProductionControl(host, files, undefined, local);
    try {
      const modelReply = vi.fn(async () => "unused");
      const runTurn = scriptedTurnRunner(modelReply);
      await expect(runTurn("thread", new WeixinTurnAdapter("thread", event, {
        accountMemory: "", outboundRoots: [], workflowTools: control, isClosing: () => false,
      }))).rejects.toThrow("workflow_tool_turn_already_bound");
      expect(modelReply).not.toHaveBeenCalled();
      expect(files.queryHandle(event.key)).toBeNull();
      await occupied.release();
      const rebound = await control.bind("thread", event);
      expect(rebound.promptLines?.join("\n")).toContain("Vault");
      expect(files.queryHandle(event.key)).not.toBeNull();
      const released = rebound.release();
      expect(rebound.release()).toBe(released);
      await released;
      expect(files.queryHandle(event.key)).toBeNull();
    } finally { await occupied.release(); await local.close(); await engine.close(); permissions.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps native command execution out of the main Weixin file-tool runtime", () => {
    expect(MAIN_WEIXIN_DISABLED_FEATURES).toEqual(["shell_tool", "unified_exec"]);
  });

  it("projects a pending workflow result and records its presentation only after reply acceptance", async () => {
    const put = vi.fn();
    const request = {
      runId: "run-pending",
      signalRef: `workflow-signal:${"d".repeat(64)}`,
      stepId: "choose",
      revision: 2,
      expiresAt: 1_788_200_060_000,
      candidates: ["王林2.jpg", "王林.png"],
    };
    const projector = createWorkflowToolReplyProjector(
      { listPendingSignals: () => [request] },
      { get: () => undefined, put },
      () => 1_788_200_000_000,
      { resolveQuery: () => "把王林图片发给我" },
    );
    const receipt = projector({
      runId: "run-pending",
      source: "weixin",
      triggerId: "a".repeat(64),
      occurredAt: 1_788_200_000_000,
      status: "needs_input",
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
      requestedWorkflowId: "media.send-local-image-resolved",
    }, {
      eventKey: "a".repeat(64),
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      occurredAt: 1_788_200_000_000,
      originalTextRef: "filequery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      attachmentRefs: [],
    });

    expect(receipt).toMatchObject({ outcome: "needs_input", reply: expect.stringContaining("1. 王林2.jpg") });
    expect(put).not.toHaveBeenCalled();
    await receipt.onAccepted?.();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({
      accountRef: "bot@im.bot",
      targetRef: "owner@im.wechat",
      runId: "run-pending",
      revision: 2,
    }));
  });

  it("prepares media evidence for the model-selected source and releases it with the turn", async () => {
    const releaseHost = vi.fn(async () => {});
    const host = {
      contractHash: vi.fn(() => "f".repeat(64)),
      bind: vi.fn(() => ({ seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" as const }), release: releaseHost })),
    };
    const fileArtifacts = {
      captureTurnText: vi.fn(() => ({
        handle: "filequery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expiresAt: 1_788_286_400_000,
      })),
      deleteQuery: vi.fn(),
    };
    const mediaRequests = { prepareForToolTurn: vi.fn(), release: vi.fn() };
    const control = new WorkflowToolProductionControl(host, fileArtifacts, mediaRequests);
    const incoming = {
      key: "a".repeat(64),
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      messageId: "message-1",
      source: "text",
      text: "处理一下",
      receivedAt: 1_788_200_000_000,
      replyText: vi.fn(),
    } satisfies InboundTextEvent;

    const binding = await control.bind("thread-1", incoming);
    expect(mediaRequests.prepareForToolTurn).toHaveBeenCalledWith(incoming);
    await binding.release();
    await binding.release();
    expect(releaseHost).toHaveBeenCalledOnce();
    expect(mediaRequests.release).toHaveBeenCalledWith(incoming.key);
    expect(mediaRequests.release).toHaveBeenCalledOnce();
    expect(fileArtifacts.deleteQuery).toHaveBeenCalledWith("filequery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(fileArtifacts.deleteQuery).toHaveBeenCalledOnce();
  });

  it("binds opaque local-file access context and releases its sandbox with the turn", async () => {
    const releaseHost = vi.fn(async () => {});
    const host = {
      contractHash: vi.fn(() => "f".repeat(64)),
      bind: vi.fn(() => ({ seal: () => {}, drain: async () => {}, snapshot: () => ({ owner: "model" as const }), release: releaseHost })),
    };
    const fileArtifacts = {
      captureTurnText: vi.fn(() => ({
        handle: "filequery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expiresAt: 1_788_286_400_000,
      })),
      deleteQuery: vi.fn(),
    };
    const localRelease = vi.fn(async () => {});
    const localFiles = {
      bindTurn: vi.fn(() => ({
        promptLines: ["scoperef_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 相册（可读、不可写）"],
        release: localRelease,
      })),
    };
    const control = new WorkflowToolProductionControl(host, fileArtifacts, undefined, localFiles);
    const incoming = {
      key: "a".repeat(64),
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      messageId: "message-1",
      source: "text",
      text: "找相册中的图片",
      receivedAt: 1_788_200_000_000,
      replyText: vi.fn(),
    } satisfies InboundTextEvent;

    const binding = await control.bind("thread-1", incoming);
    expect(binding.promptLines).toEqual(localFiles.bindTurn.mock.results[0]!.value.promptLines);
    expect(localFiles.bindTurn).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: incoming.key,
      accountId: incoming.accountId,
      target: incoming.target,
    }));
    await binding.release();
    await vi.waitFor(() => expect(localRelease).toHaveBeenCalledOnce());
    expect(releaseHost).toHaveBeenCalledOnce();
  });

  it("cleans private turn artifacts when the host refuses the binding", async () => {
    const host = {
      contractHash: vi.fn(() => "f".repeat(64)),
      bind: vi.fn(() => { throw new Error("workflow_tool_turn_already_bound"); }),
    };
    const fileArtifacts = {
      captureTurnText: vi.fn(() => ({
        handle: "filequery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expiresAt: 1_788_286_400_000,
      })),
      deleteQuery: vi.fn(),
    };
    const mediaRequests = { prepareForToolTurn: vi.fn(), release: vi.fn() };
    const control = new WorkflowToolProductionControl(host, fileArtifacts, mediaRequests);
    const incoming = {
      key: "a".repeat(64),
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      messageId: "message-1",
      source: "text",
      text: "处理一下",
      receivedAt: 1_788_200_000_000,
      replyText: vi.fn(),
    } satisfies InboundTextEvent;

    await expect(control.bind("thread-1", incoming)).rejects.toThrow("workflow_tool_turn_already_bound");
    expect(fileArtifacts.deleteQuery).toHaveBeenCalledOnce();
    expect(mediaRequests.release).toHaveBeenCalledOnce();
  });

  it("routes model-selected media sources to their reviewed source-specific templates", async () => {
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: true, directFiles: true });
    const submit = vi.fn(async (trigger: WorkflowTrigger): Promise<WorkflowSubmission> => ({
      runId: `run-${trigger.triggerId}`,
      duplicate: false,
    }));
    const engine = {
      supersedePendingSignals: vi.fn(() => []),
      submit,
      get: vi.fn((runId: string) => ({ runId, status: "succeeded" })),
    };
    const requests = {
      captureFromTool: vi.fn(() => "mediareq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    };
    const localCandidate = {
      moduleId: "local-media",
      moduleRevision: 1,
      scopeId: "pictures",
      relativePath: "latest.png",
      fileName: "latest.png",
      displayPath: "Pictures/latest.png",
      sizeBytes: 8,
      modifiedAt: 1_788_200_000_000,
    };
    const directLocal = {
      localFiles: {
        describeForSend: vi.fn(() => [localCandidate]),
        snapshotForSend: vi.fn(async () => [{
          snapshotPath: "/private/snapshots/latest.png",
          fileName: "latest.png",
          sha256: "a".repeat(64),
          sizeBytes: 8,
        }]),
      },
      files: { captureSnapshot: vi.fn(() => ({
        handle: "filesnapshot_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        fileName: "latest.png",
        sizeBytes: 8,
        expiresAt: 1_788_286_400_000,
      })) },
      manifests: { capture: vi.fn(() => ({
        handle: "sendmanifest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expiresAt: 1_788_286_400_000,
      })) },
    };
    const gateway = new WorkflowToolGateway(
      catalog,
      [createMediaSendToolRegistration(requests, directLocal)],
      engine,
      () => ({ outcome: "accepted", reply: "图片已发送，请查收。" }),
    );
    const host = new WorkflowToolHost(catalog, gateway);
    const currentEventKey = "b".repeat(64);
    host.bind("thread-current", {
      eventKey: currentEventKey,
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      occurredAt: 1_788_200_000_000,
      originalTextRef: `filequery_${currentEventKey.slice(0, 32)}`,
      attachmentRefs: [],
    });
    await host.execute("send", { kind: "image", source: "current" }, {
      threadId: "thread-current",
      turnId: "turn-current",
      namespace: "media",
    });

    const localEventKey = "c".repeat(64);
    host.bind("thread-local", {
      eventKey: localEventKey,
      accountId: "bot@im.bot",
      target: "owner@im.wechat",
      occurredAt: 1_788_200_000_001,
      originalTextRef: `filequery_${localEventKey.slice(0, 32)}`,
      attachmentRefs: [],
    });
    await host.execute("send", {
      kind: "image",
      source: "local",
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    }, {
      threadId: "thread-local",
      turnId: "turn-local",
      namespace: "media",
    });

    expect(submit.mock.calls.map(([trigger]) => ({
      requestedWorkflowId: trigger.requestedWorkflowId,
      inputRefs: trigger.inputRefs,
    }))).toEqual([
      {
        requestedWorkflowId: "media.send-image-one-message",
        inputRefs: { mediaRequest: "mediareq_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      },
      {
        requestedWorkflowId: "weixin.send-local-images",
        inputRefs: { sendManifest: "sendmanifest_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      },
    ]);
    expect(requests.captureFromTool).toHaveBeenCalledOnce();
    expect(requests.captureFromTool).toHaveBeenCalledWith(currentEventKey, {
      kind: "image",
      source: "current",
    });
    expect(directLocal.localFiles.describeForSend).toHaveBeenCalledWith(
      expect.objectContaining({ eventKey: localEventKey }),
      ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    );
    expect(directLocal.localFiles.snapshotForSend).toHaveBeenCalledOnce();
  });
});
