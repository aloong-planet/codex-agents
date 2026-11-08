import fs from "node:fs";
import { scriptedTurnRunner } from "./fixtures/scripted-turn-runner.js";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { LocalFileTools } from "../src/local-file-tools.js";
import { AccountMemoryStore } from "../src/account-memory-store.js";
import { AccountMemorySystem } from "../src/account-memory-system.js";
import { CodexServiceStore } from "../src/codex-service-store.js";
import type { InboundTextEvent, SendTextResult } from "../src/demo-service.js";
import { WeixinCodexService, type CodexAgent } from "../src/weixin-codex-service.js";
import { WorkflowModulePermissionSettings } from "../src/workflow-module-permission-settings.js";
import { WorkflowEngine } from "../src/workflow-engine.js";
import { MediaExportLibrary } from "../src/media-export-library.js";
import { WorkflowMediaArtifactStore } from "../src/workflow-media-artifact-store.js";
import { WorkflowMediaProvider } from "../src/workflow-media-provider.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowFileSendProvider } from "../src/workflow-file-send-provider.js";
import { WorkflowFileSendStore } from "../src/workflow-file-send-store.js";
import {
  WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW,
  WEIXIN_SEND_FILES_WORKFLOW,
} from "../src/workflow-file-send-intent.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { PendingResponseCoordinator } from "../src/workflow-pending-response-coordinator.js";
import { WorkflowPendingPresentationStore } from "../src/workflow-pending-presentation-store.js";
import { WorkflowRunTargetStore } from "../src/workflow-run-target-store.js";
import { WorkflowToolGateway } from "../src/workflow-tool-gateway.js";
import { createProductionWorkflowToolCatalog, WorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { WorkflowToolHost, type TrustedWorkflowTurn } from "../src/workflow-tool-host.js";
import { createWeixinSendFilesToolRegistration, createWorkflowToolReplyProjector, WorkflowToolProductionControl } from "../src/workflow-tool-production.js";
import { unrelatedProtectedRoots } from "./support/service-state.js";

const dirs: string[] = [];
// Coverage boundary: this suite invokes the production tool gateway, not the
// inbound model loop. SendPort is fake; neither Tencent acceptance nor phone
// receipt is established. Those require the production-parity/live gates.
afterEach(() => dirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("terminal_file_media_workflow_regression", () => {
  it("production_contract_and_access_rotation_regression preserves durable memory and pending identity without replaying accepted effects (agent boundary fake)", async () => {
    const fixture = await createFixture();
    const memoryRoot = path.join(fixture.root, "memory");
    new AccountMemoryStore(memoryRoot).apply("bot@im.bot", {
      batchId: "development-preference", basedOnRevision: 0, evidenceEntryIds: new Set(["preference-turn"]),
      mutations: [{ op: "add", id: "package-manager", category: "preferences", value: "JavaScript 项目默认使用 pnpm。", evidenceEntryIds: ["preference-turn"], confidence: 1 }],
    });
    const serviceStore = () => new CodexServiceStore(path.join(fixture.root, "codex-service.json"));
    const createConversation = async (catalog: WorkflowToolCatalog) => {
      const prompts: string[] = [];
      let listener: ((event: InboundTextEvent) => unknown) | undefined;
      // Only the model/channel boundaries are faked. Memory, contract hashing,
      // permissions, references, Run/Effect stores and service lifecycle are real.
      const agent: CodexAgent = {
        startOrResume: async (threadId) => threadId ?? randomUUID(),
        runTurn: scriptedTurnRunner(async (_threadId, input) => {
          prompts.push(typeof input === "string" ? input : input.filter((item) => item.type === "text").map((item) => item.text).join("\n"));
          return JSON.stringify({ message: "边界测试回复。", results: [] });
        }),
        close: () => {},
      };
      const host = new WorkflowToolHost(catalog, fixture.gateway, fixture.localFiles);
      const memory = new AccountMemorySystem({
        store: new AccountMemoryStore(memoryRoot), statePath: path.join(fixture.root, "memory-jobs.json"),
        curator: { curate: async () => ({ status: "noop" }), close: () => {} },
      });
      const service = new WeixinCodexService({
        getSnapshot: () => ({ accounts: [{ accountId: "bot@im.bot", credentialStatus: "usable" }], targets: [{ accountId: "bot@im.bot", target: "owner@im.wechat" }] }),
        onInboundText: (next) => { listener = next; return () => { listener = undefined; }; },
      }, agent, serviceStore(), fixture.root, Date.now, undefined, undefined, false,
      undefined, undefined, undefined, memory, undefined, undefined,
      new WorkflowToolProductionControl(host, fixture.files, undefined, fixture.localFiles));
      await service.start();
      await service.enable("bot@im.bot", "owner@im.wechat");
      return {
        service, prompts,
        deliver: async (text: string) => {
          await listener!({ key: randomUUID().replaceAll("-", "").repeat(2), accountId: "bot@im.bot", target: "owner@im.wechat", source: "text", text,
            messageId: randomUUID(), receivedAt: Date.now(), replyText: async () => ({ ok: true, messageId: "fixture-reply" }) });
        },
      };
    };
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
    let conversation: Awaited<ReturnType<typeof createConversation>> | undefined;
    try {
      conversation = await createConversation(catalog);
      await conversation.deliver("仅本轮上下文标记 HISTORY_SENTINEL，不是持久记忆。");
      const oldSession = serviceStore().load().targetSessions[0]!;
      const found = await fixture.find();
      await fixture.gateway.submit({ toolId: "weixin.send_files", toolVersion: 1,
        arguments: { disposition: "needs_choice", candidateRefs: found.map((entry) => entry.fileRef), allowMultiple: false },
      }, fixture.trusted);
      const pending = fixture.engine.listPendingSignals("bot@im.bot", "owner@im.wechat")[0]!;
      await conversation.service.close();
      await fixture.restartEngine();

      // A real visible description upgrade, not an arbitrary mocked hash.
      const upgraded = new WorkflowToolCatalog(catalog.members().map((member) => member.id === "files.find"
        ? { ...member, description: `${member.description} 返回当前目录内的匹配结果。` } : member));
      conversation = await createConversation(upgraded);
      await conversation.deliver("继续讨论开发偏好。");
      const upgradedSession = serviceStore().load().targetSessions[0]!;
      expect(upgradedSession.threadId).not.toBe(oldSession.threadId);
      expect(upgradedSession.toolContractHash).not.toBe(oldSession.toolContractHash);
      expect(conversation.prompts[0]).toContain("JavaScript 项目默认使用 pnpm。");
      expect(conversation.prompts[0]).not.toContain("HISTORY_SENTINEL");
      expect(fixture.engine.listPendingSignals("bot@im.bot", "owner@im.wechat")).toEqual([pending]);
      await fixture.engine.signal({ signalId: "after-contract-upgrade", signalRef: pending.signalRef,
        expectedRevision: pending.revision, selection: pending.candidates[1], accountRef: "bot@im.bot", targetRef: "owner@im.wechat" });
      const accepted = fixture.engine.get(pending.runId)!;
      expect(accepted).toMatchObject({ status: "succeeded", effects: [{ state: "accepted" }] });
      expect(fixture.sent).toEqual(["second"]);

      const settings = new WorkflowModulePermissionSettings(fixture.permissions, [{ moduleId: "notes", name: "Notes", description: "Fixture notes",
        scopes: [{ scopeId: "vault", label: "Vault", directory: path.join(fixture.root, "vault") }],
      }], () => conversation!.service.narrowFileAccessContext());
      settings.configure({ moduleId: "notes", expectedRevision: 1, confirmed: true, scopes: [{ scopeId: "vault", read: false, write: false }] });
      await conversation.service.close();
      await fixture.restartEngine();
      conversation = await createConversation(upgraded);
      await conversation.deliver("继续讨论开发偏好。");
      const narrowedSession = serviceStore().load().targetSessions[0]!;
      expect(narrowedSession.threadId).not.toBe(upgradedSession.threadId);
      expect(narrowedSession.accessContextEpoch).toBe(1);
      expect(narrowedSession.toolContractHash).toBe(upgradedSession.toolContractHash);
      expect(conversation.prompts[0]).toContain("JavaScript 项目默认使用 pnpm。");
      expect(conversation.prompts[0]).not.toContain("Vault（可读");
      expect(conversation.prompts[0]).not.toContain("HISTORY_SENTINEL");
      expect(fixture.engine.get(pending.runId)).toEqual(accepted);
      expect(fixture.sent).toEqual(["second"]);
      expect(countFiles(fixture.snapshotRoot)).toBe(1);
    } finally {
      await conversation?.service.close();
      await fixture.close();
    }
  });

  it("snapshots selected references before accepting the Run and maps one external effect per file", async () => {
    const fixture = await createFixture();
    try {
      const found = await fixture.find();
      const result = await fixture.gateway.submit({
        toolId: "weixin.send_files", toolVersion: 1,
        arguments: { disposition: "selected", fileRefs: found.map((entry) => entry.fileRef) },
      }, fixture.trusted);

      expect(result.disposition).toBe("claimed");
      expect(fixture.sent).toEqual(["first", "second"]);
      expect(fixture.snapshotsAtAcceptance).toEqual([2]);
      expect(fixture.engine.get(fixture.runIds[0]!)).toMatchObject({ status: "succeeded" });
      expect(countFiles(fixture.snapshotRoot)).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("persists ambiguous candidates without copying files, then snapshots only the user's choice", async () => {
    const fixture = await createFixture();
    try {
      const found = await fixture.find();
      const result = await fixture.gateway.submit({
        toolId: "weixin.send_files", toolVersion: 1,
        arguments: {
          disposition: "needs_choice",
          candidateRefs: found.map((entry) => entry.fileRef),
          allowMultiple: false,
        },
      }, fixture.trusted);

      expect(result.disposition).toBe("claimed");
      expect(countFiles(fixture.snapshotRoot)).toBe(0);
      expect(fixture.snapshotsAtAcceptance).toEqual([0]);
      const run = fixture.engine.get(fixture.runIds[0]!)!;
      expect(run).toMatchObject({ status: "needs_input" });
      const pending = fixture.engine.listPendingSignals("bot@im.bot", "owner@im.wechat")[0]!;
      await fixture.engine.signal({
        signalId: "choose-second",
        signalRef: pending.signalRef,
        expectedRevision: pending.revision,
        selection: pending.candidates[1],
        accountRef: "bot@im.bot",
        targetRef: "owner@im.wechat",
      });

      expect(fixture.sent).toEqual(["second"]);
      expect(countFiles(fixture.snapshotRoot)).toBe(1);
      expect(fixture.engine.get(fixture.runIds[0]!)).toMatchObject({ status: "succeeded" });
    } finally {
      await fixture.close();
    }
  });

  it("continues after a rejected file and projects partial success without replaying either effect on restart (channel boundary fake)", async () => {
    const fixture = await createFixture([{ ok: false, reason: "rejected" }, { ok: true }]);
    try {
      const found = await fixture.find();
      const result = await fixture.gateway.submit({
        toolId: "weixin.send_files", toolVersion: 1,
        arguments: { disposition: "selected", fileRefs: found.map((entry) => entry.fileRef) },
      }, fixture.trusted);

      expect(result).toMatchObject({
        disposition: "claimed",
        receipt: { outcome: "rejected", reply: "部分文件已发送，其余文件发送失败。" },
      });
      expect(fixture.sent).toEqual(["first", "second"]);
      expect(fixture.submissions.map((item) => item.fileName)).toEqual(["one.md", "two.md"]);
      expect(fixture.channelEvents).toEqual(["start:one.md", "finish:one.md", "start:two.md", "finish:two.md"]);
      expect(new Set(fixture.submissions.map((item) => item.operationId)).size).toBe(2);
      for (const submission of fixture.submissions) {
        expect(path.relative(fs.realpathSync(fixture.snapshotRoot), fs.realpathSync(submission.filePath))).not.toMatch(/^\.\./);
      }
      const runId = fixture.runIds[0]!;
      const run = fixture.engine.get(runId)!;
      expect(run).toMatchObject({
        status: "failed", errorCode: "workflow_map_partial_failure",
        effects: [expect.objectContaining({ state: "rejected" }), expect.objectContaining({ state: "accepted" })],
      });
      await fixture.restartEngine();
      expect(fixture.engine.get(runId)).toEqual(run);
      expect(fixture.project(runId)).toMatchObject({ outcome: "rejected", reply: "部分文件已发送，其余文件发送失败。" });
      expect(fixture.sent).toEqual(["first", "second"]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps an unknown file outcome after restart without resending and projects a safe warning (channel boundary fake)", async () => {
    const fixture = await createFixture([{ ok: false, reason: "unknown" }]);
    try {
      const found = await fixture.find();
      const result = await fixture.gateway.submit({
        toolId: "weixin.send_files", toolVersion: 1,
        arguments: { disposition: "selected", fileRefs: [found[0]!.fileRef] },
      }, fixture.trusted);
      expect(result).toMatchObject({
        disposition: "claimed",
        receipt: { outcome: "unknown", reply: "文件发送结果暂时无法确认，请检查微信；系统不会自动重发。" },
      });
      const runId = fixture.runIds[0]!;
      const before = fixture.engine.get(runId)!;
      expect(before).toMatchObject({ status: "outcome_unknown", effects: [expect.objectContaining({ state: "unknown" })] });
      expect(fixture.sent).toEqual(["first"]);
      const operationId = fixture.submissions[0]!.operationId;
      await fixture.restartEngine();
      const after = fixture.engine.get(runId)!;
      expect(after.status).toBe("outcome_unknown");
      expect(after.effects).toEqual(before.effects);
      expect(fixture.project(runId)).toMatchObject({
        outcome: "unknown", reply: "文件发送结果暂时无法确认，请检查微信；系统不会自动重发。",
      });
      expect(fixture.sent).toEqual(["first"]);
      expect(fixture.submissions.map((item) => item.operationId)).toEqual([operationId]);
      expect(countFiles(fixture.snapshotRoot)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("production_pending_restart_and_new_goal_workflow: reopens durable file services and resumes only the original Run (router boundary fake)", async () => {
    const fixture = await createFixture();
    let presentations: WorkflowPendingPresentationStore | undefined =
      new WorkflowPendingPresentationStore(path.join(fixture.root, "presentations.sqlite"));
    try {
      const found = await fixture.find();
      await fixture.gateway.submit({
        toolId: "weixin.send_files", toolVersion: 1,
        arguments: {
          disposition: "needs_choice",
          candidateRefs: found.map((entry) => entry.fileRef),
          allowMultiple: false,
        },
      }, fixture.trusted);
      const runId = fixture.runIds[0]!;
      expect(countFiles(fixture.snapshotRoot)).toBe(0);
      const pendingBefore = fixture.engine.listPendingSignals("bot@im.bot", "owner@im.wechat")[0]!;
      presentations.put({
        accountRef: "bot@im.bot",
        targetRef: "owner@im.wechat",
        runId,
        signalRef: pendingBefore.signalRef,
        revision: pendingBefore.revision,
        requestTextHash: "a".repeat(64),
        expiresAt: pendingBefore.expiresAt,
        acceptedAt: 1,
      });

      const restarted = await fixture.restartEngine();
      presentations.close();
      presentations = undefined;
      presentations = new WorkflowPendingPresentationStore(path.join(fixture.root, "presentations.sqlite"));
      expect(presentations.get("bot@im.bot", "owner@im.wechat")).toMatchObject({
        runId,
        signalRef: pendingBefore.signalRef,
        revision: pendingBefore.revision,
      });
      const pendingAfter = restarted.listPendingSignals("bot@im.bot", "owner@im.wechat")[0]!;
      expect(pendingAfter).toEqual(pendingBefore);
      const coordinator = new PendingResponseCoordinator({
        engine: restarted,
        presentations,
        router: {
          route: async (input) => ({
            kind: "respond",
            requestRef: input.requests[0]!.requestRef,
            choiceRefs: [input.requests[0]!.choices[1]!.choiceRef],
          }),
        },
        now: () => 2,
      });
      const resumed = await coordinator.handle({
        trustedTurn: {
          eventKey: "selection-after-restart",
          accountRef: "bot@im.bot",
          targetRef: "owner@im.wechat",
          occurredAt: 2,
        },
        userText: "第二个",
      });

      expect(resumed).toMatchObject({ owner: "workflow", kind: "resumed", run: { runId, status: "succeeded" } });
      expect(fixture.runIds).toEqual([runId]);
      expect(fixture.sent).toEqual(["second"]);
      expect(countFiles(fixture.snapshotRoot)).toBe(1);
      expect(restarted.get(runId)).toMatchObject({
        status: "succeeded",
        effects: [expect.objectContaining({ state: "accepted" })],
      });
      expect(restarted.listPendingSignals("bot@im.bot", "owner@im.wechat")).toEqual([]);
      const restartedAgain = await fixture.restartEngine();
      expect(restartedAgain.get(runId)).toMatchObject({ status: "succeeded", effects: [expect.objectContaining({ state: "accepted" })] });
      expect(restartedAgain.listPendingSignals("bot@im.bot", "owner@im.wechat")).toEqual([]);
      expect(fixture.sent).toEqual(["second"]);
      expect(countFiles(fixture.snapshotRoot)).toBe(1);
    } finally {
      presentations?.close();
      await fixture.close();
    }
  });
});

async function createFixture(sendResults: SendTextResult[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-send-integration-"));
  dirs.push(root);
  const vault = path.join(root, "vault");
  const artifactRoot = path.join(root, "artifacts");
  const snapshotRoot = path.join(artifactRoot, "snapshots");
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, "one.md"), "first");
  fs.writeFileSync(path.join(vault, "two.md"), "second");
  let permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
  permissions.save({
    moduleId: "notes", expectedRevision: 0, confirmed: true,
    scopes: [{ scopeId: "vault", label: "Vault", directory: vault, read: true, write: false }],
  });
  const createLocalFiles = () => new LocalFileTools(permissions, {
    moduleIds: ["notes"],
    protectedRoots: unrelatedProtectedRoots, spoolDirectory: snapshotRoot,
    operationDatabasePath: path.join(root, "operations.sqlite"),
  });
  let localFiles = createLocalFiles();
  let files = new WorkflowFileArtifactStore(artifactRoot, permissions);
  let manifests = new WorkflowFileSendStore(path.join(root, "manifests"));
  const targetDatabasePath = path.join(root, "targets.sqlite");
  let targets = new WorkflowRunTargetStore(targetDatabasePath);
  const runIds: string[] = [];
  const snapshotsAtAcceptance: number[] = [];
  const sent: string[] = [];
  const channelEvents: string[] = [];
  const submissions: Array<{ fileName?: string; operationId: string; filePath: string }> = [];
  const mediaLibrary = new MediaExportLibrary(path.join(root, "media.json"), root);
  const mediaArtifacts = new WorkflowMediaArtifactStore(path.join(root, "media-artifacts"), mediaLibrary);
  const presentations = new WorkflowPendingPresentationStore(path.join(root, "reply-presentations.sqlite"));
  // Only the external channel is faked: production code resolves snapshots,
  // classifies delivery outcomes, persists Effects and renders user replies.
  const createSendProvider = () => new WorkflowMediaProvider(mediaLibrary, mediaArtifacts, targets, {
    sendImage: async () => { throw new Error("unexpected image send"); },
    sendFile: async (input) => {
      channelEvents.push(`start:${input.fileName}`);
      submissions.push(input);
      sent.push(fs.readFileSync(input.filePath, "utf8"));
      const result = sendResults[sent.length - 1] ?? { ok: true };
      await new Promise<void>((resolve) => setImmediate(resolve));
      channelEvents.push(`finish:${input.fileName}`);
      return result;
    },
    reconcile: async () => ({ status: "unknown" }),
  }, files);
  const workflowDatabasePath = path.join(root, "workflows.sqlite");
  const createEngine = () => new WorkflowEngine(workflowDatabasePath, {
    templates: [WEIXIN_SEND_FILES_WORKFLOW, WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW],
    providers: [new WorkflowFileSendProvider(manifests, files, localFiles, {
      resolveRunTarget: (runId) => targets.resolveRunTarget(runId),
    }), createSendProvider()],
    onRunAccepted: ({ runId, trigger }) => {
      snapshotsAtAcceptance.push(countFiles(snapshotRoot));
      targets.bind(runId, trigger.accountRef!, trigger.targetRef!);
      runIds.push(runId);
    },
  });
  let engine = createEngine();
  await engine.start();
  const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
  const createGateway = () => new WorkflowToolGateway(
    catalog,
    [createWeixinSendFilesToolRegistration(localFiles, files, manifests)],
    engine,
    createWorkflowToolReplyProjector(engine, presentations, Date.now, { resolveQuery: () => "把匹配的原文件发给我" }),
  );
  let gateway = createGateway();
  const trusted: TrustedWorkflowTurn = {
    eventKey: "event-1", accountId: "bot@im.bot", target: "owner@im.wechat", occurredAt: 1,
    originalTextRef: "filequery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", attachmentRefs: [],
  };
  let binding = localFiles.bindTurn(trusted);
  return {
    root, get gateway() { return gateway; }, get engine() { return engine; },
    get permissions() { return permissions; }, get localFiles() { return localFiles; }, get files() { return files; },
    trusted, sent, submissions, channelEvents, runIds, snapshotRoot, snapshotsAtAcceptance,
    project: (runId: string) => createWorkflowToolReplyProjector(engine, presentations, Date.now)(engine.get(runId), trusted),
    find: async () => {
      const found = await localFiles.execute({
        toolId: "files.find", toolVersion: 2,
        arguments: { query: ".md", match: "literal", sort: { field: "name", direction: "asc" }, limit: 10 },
      }, trusted) as { entries: Array<{ fileRef: string }> };
      return found.entries;
    },
    restartEngine: async () => {
      await engine.close();
      await binding.release();
      await localFiles.close();
      await permissions.close();
      targets.close();
      permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
      localFiles = createLocalFiles();
      files = new WorkflowFileArtifactStore(artifactRoot, permissions);
      manifests = new WorkflowFileSendStore(path.join(root, "manifests"));
      targets = new WorkflowRunTargetStore(targetDatabasePath);
      engine = createEngine();
      await engine.start();
      gateway = createGateway();
      binding = localFiles.bindTurn(trusted);
      return engine;
    },
    close: async () => {
      await binding.release();
      await engine.close();
      await localFiles.close();
      await permissions.close();
      targets.close();
      presentations.close();
    },
  };
}

function countFiles(root: string): number {
  if (!fs.existsSync(root)) return 0;
  return fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
}
