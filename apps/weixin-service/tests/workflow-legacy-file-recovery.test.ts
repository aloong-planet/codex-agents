import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowEngine, type WorkflowCapabilityProvider } from "../src/workflow-engine.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { WorkflowRunTargetStore } from "../src/workflow-run-target-store.js";
import { WorkflowMediaProvider } from "../src/workflow-media-provider.js";
import { MediaExportLibrary } from "../src/media-export-library.js";
import { WorkflowMediaArtifactStore } from "../src/workflow-media-artifact-store.js";
import { NOTES_SEND_FILE_WORKFLOW } from "../src/workflow-notes-send-intent.js";
import { renderWorkflowRun } from "../src/weixin-workflow-trigger-adapter.js";
import { LocalFileTools } from "../src/local-file-tools.js";
import type { SendTextResult } from "../src/demo-service.js";

// Historical bootstrap protocol: 24efdc4 workflow-files-provider.ts LOCATE and
// the retained NOTES_SEND_FILE_WORKFLOW. This generates a real frozen plan via
// Engine.submit, then removes the old search provider before recovery. It is
// not a real Weixin/model test or a claim of running an old binary.
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe("access_context_and_legacy_run_regression", () => {
  it("resumes a frozen legacy file choice without a search provider and sends only a private snapshot", async () => {
    const fixture = await createLegacyFixture();
    try {
      const pending = fixture.engine.listPendingSignals("bot@im.bot", "owner@im.wechat")[0]!;
      expect(pending.candidates).toHaveLength(2);
      const before = fixture.engine.get(pending.runId)!;
      await fixture.upgrade();
      expect(fixture.engine.get(pending.runId)).toEqual(before);
      expect(fixture.engine.listPendingSignals("bot@im.bot", "owner@im.wechat")[0]).toEqual(pending);

      const signal = {
        signalId: "choose-second", signalRef: pending.signalRef, expectedRevision: pending.revision,
        selection: [pending.candidates[1]], accountRef: "bot@im.bot", targetRef: "owner@im.wechat",
      };
      await fixture.engine.signal(signal);
      const completed = fixture.engine.get(pending.runId)!;
      expect(completed).toMatchObject({ status: "succeeded", effects: [expect.objectContaining({ state: "accepted" })] });
      expect(fixture.submissions.map((item) => ({ fileName: item.fileName, content: item.content })))
        .toEqual([{ fileName: "two.md", content: "second" }]);
      const sentPath = fixture.submissions[0]!.filePath;
      expect(sentPath).not.toBe(fs.realpathSync(path.join(fixture.vault, "two.md")));
      expect(path.relative(fs.realpathSync(fixture.artifactRoot), sentPath)).not.toMatch(/^\.\./);
      expect(renderWorkflowRun(completed, [])).toMatchObject({ reply: "文件已发送，请查收。" });
      await fixture.upgrade();
      expect(fixture.engine.get(pending.runId)).toEqual(completed);
      await fixture.engine.signal(signal);
      expect(fixture.submissions).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it.each(["revoked", "expired"] as const)("does not send a %s legacy candidate after upgrade", async (boundary) => {
    const fixture = await createLegacyFixture();
    try {
      const pending = fixture.engine.listPendingSignals("bot@im.bot", "owner@im.wechat")[0]!;
      expect(pending.candidates).toHaveLength(2);
      await fixture.upgrade();
      if (boundary === "revoked") fixture.revoke();
      else fixture.expireArtifacts();
      await fixture.engine.signal({
        signalId: `choose-${boundary}`, signalRef: pending.signalRef, expectedRevision: pending.revision,
        selection: [pending.candidates[0]], accountRef: "bot@im.bot", targetRef: "owner@im.wechat",
      });
      expect(fixture.engine.get(pending.runId)).toMatchObject({ status: boundary === "revoked" ? "blocked" : "failed" });
      if (boundary === "revoked") {
        expect(renderWorkflowRun(fixture.engine.get(pending.runId)!, [])).toMatchObject({
          reply: "没有读取这个文件的权限，请在“本地权限”中启用后重试。",
        });
      }
      expect(fixture.submissions).toEqual([]);
      await fixture.upgrade();
      expect(fixture.engine.get(pending.runId)).toMatchObject({ status: boundary === "revoked" ? "blocked" : "failed" });
      expect(fixture.submissions).toEqual([]);
    } finally { await fixture.close(); }
  });

  it("preserves an unknown legacy send across restart without replaying the selected file", async () => {
    const fixture = await createLegacyFixture({ ok: false, reason: "unknown" });
    try {
      const pending = fixture.engine.listPendingSignals("bot@im.bot", "owner@im.wechat")[0]!;
      await fixture.upgrade();
      await fixture.engine.signal({
        signalId: "choose-unknown", signalRef: pending.signalRef, expectedRevision: pending.revision,
        selection: [pending.candidates[0]], accountRef: "bot@im.bot", targetRef: "owner@im.wechat",
      });
      const before = fixture.engine.get(pending.runId)!;
      expect(before).toMatchObject({ status: "outcome_unknown", effects: [expect.objectContaining({ state: "unknown" })] });
      expect(fixture.submissions.map((entry) => entry.content)).toEqual(["first"]);
      await fixture.upgrade();
      const after = fixture.engine.get(pending.runId)!;
      expect(after.status).toBe("outcome_unknown");
      expect(after.effects).toEqual(before.effects);
      expect(renderWorkflowRun(after, [])).toMatchObject({ reply: "文件发送结果暂时无法确认，请检查微信；系统不会自动重发。" });
      expect(fixture.submissions.map((entry) => entry.content)).toEqual(["first"]);
    } finally { await fixture.close(); }
  });
});

async function createLegacyFixture(sendResult: SendTextResult = { ok: true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-legacy-recovery-"));
  roots.push(root);
  const vault = path.join(root, "vault");
  const artifactRoot = path.join(root, "files");
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, "one.md"), "first");
  fs.writeFileSync(path.join(vault, "two.md"), "second");
  let permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
  permissions.save({ moduleId: "notes", expectedRevision: 0, confirmed: true,
    scopes: [{ scopeId: "vault", label: "Vault", directory: vault, read: true, write: false }] });
  let artifactTime = Date.now();
  let files = new WorkflowFileArtifactStore(artifactRoot, permissions, () => artifactTime);
  let targets = new WorkflowRunTargetStore(path.join(root, "targets.sqlite"));
  const library = new MediaExportLibrary(path.join(root, "media.json"), root);
  const media = new WorkflowMediaArtifactStore(path.join(root, "media"), library);
  const submissions: Array<{ filePath: string; fileName: string | undefined; content: string }> = [];
  const sender = () => new WorkflowMediaProvider(library, media, targets, {
    sendImage: async () => { throw new Error("unexpected image"); },
    sendFile: async ({ filePath, fileName }) => {
      submissions.push({ filePath, fileName, content: fs.readFileSync(filePath, "utf8") });
      return sendResult;
    },
    reconcile: async () => ({ status: "unknown" }),
  }, files, undefined, {
    snapshotLegacyFile: async (accountId, input) => {
      const localFiles = new LocalFileTools(permissions, { moduleIds: ["notes"], spoolDirectory: path.join(artifactRoot, "snapshots"), operationDatabasePath: path.join(root, "operations.sqlite") });
      try { return await localFiles.snapshotLegacyFile(accountId, input); } finally { await localFiles.close(); }
    },
  });
  const bootstrap: WorkflowCapabilityProvider = {
    catalog: () => [{
      id: "files.locate", version: 1, effect: "read", retryClass: "pure",
      modulePermission: { moduleIdInput: "moduleId", access: "read", scopeInput: "scopeId" },
      inputSchema: { type: "object", required: ["moduleId", "scopeId", "requestHandle", "extensions"], additionalProperties: false,
        properties: { moduleId: { type: "string" }, scopeId: { type: "string" }, requestHandle: { type: "string" }, extensions: { type: "array", items: { type: "string" } } } },
      outputSchema: { type: "object", required: ["matches", "strategy", "truncated"], additionalProperties: false,
        properties: { matches: { type: "array", maxItems: 20, items: {
          type: "object", required: ["fileHandle", "fileName", "displayPath", "matchSource", "expiresAt"], additionalProperties: false,
          properties: { fileHandle: { type: "string" }, fileName: { type: "string" }, displayPath: { type: "string" }, matchSource: { type: "string", enum: ["name_path", "content"] }, expiresAt: { type: "number" } },
        } }, strategy: { type: "string", enum: ["name_path", "content"] }, truncated: { type: "boolean" } } },
    }],
    invoke: async () => ({ status: "succeeded", output: {
      matches: fs.readdirSync(vault).sort().map((fileName) => {
        const file = files.capture({ absolutePath: path.join(vault, fileName), moduleId: "notes", scopeId: "vault" });
        return { fileHandle: file.handle, fileName, displayPath: `Vault/${fileName}`, matchSource: "name_path", expiresAt: file.expiresAt };
      }), strategy: "name_path", truncated: false,
    } }),
  };
  const createEngine = (legacy: boolean) => new WorkflowEngine(path.join(root, "workflows.sqlite"), {
    templates: legacy ? [NOTES_SEND_FILE_WORKFLOW] : [],
    providers: legacy ? [bootstrap, sender()] : [sender()],
    modulePermissions: permissions,
    onRunAccepted: ({ runId, trigger }) => targets.bind(runId, trigger.accountRef!, trigger.targetRef!),
  });
  let engine = createEngine(true);
  await engine.start();
  await engine.submit({ source: "weixin", triggerId: "legacy-message", requestedWorkflowId: "notes.send-file-one-message",
    occurredAt: Date.now(), accountRef: "bot@im.bot", targetRef: "owner@im.wechat", inputRefs: { fileQuery: files.captureQuery("legacy-message", "md").handle } });
  return {
    vault, artifactRoot, submissions, get engine() { return engine; },
    expireArtifacts: () => { artifactTime += 24 * 60 * 60 * 1000; },
    revoke: () => {
      const state = permissions.get("notes")!;
      permissions.save({ moduleId: "notes", expectedRevision: state.revision, confirmed: true,
        scopes: state.scopes.map((scope) => ({ ...scope, read: false, write: false })) });
    },
    upgrade: async () => {
      await engine.close();
      permissions.close();
      targets.close();
      permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
      files = new WorkflowFileArtifactStore(artifactRoot, permissions, () => artifactTime);
      targets = new WorkflowRunTargetStore(path.join(root, "targets.sqlite"));
      engine = createEngine(false);
      engine.retirePendingCapability("files.resolve", 1, "workflow_file_resolver_retired");
      await engine.start();
    },
    close: async () => { await engine.close(); permissions.close(); targets.close(); },
  };
}
