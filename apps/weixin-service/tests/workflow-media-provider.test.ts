import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SendTextResult } from "../src/demo-service.js";
import { MediaExportLibrary } from "../src/media-export-library.js";
import { WorkflowMediaArtifactStore } from "../src/workflow-media-artifact-store.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowMediaProvider, type WorkflowMediaSendPort } from "../src/workflow-media-provider.js";
import { WorkflowMediaRequestStore } from "../src/workflow-media-request-store.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { LocalFileTools } from "../src/local-file-tools.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-media-provider-"));
  dirs.push(root);
  const home = path.join(root, "home");
  for (const name of ["Downloads", "Pictures", "Documents"]) fs.mkdirSync(path.join(home, name), { recursive: true });
  const imagePath = path.join(home, "Pictures", "holiday.png");
  fs.writeFileSync(imagePath, "image");
  const library = new MediaExportLibrary(path.join(root, "grants.json"), home);
  library.configure({ rootIds: ["pictures"], confirmed: true });
  const artifacts = new WorkflowMediaArtifactStore(path.join(root, "artifacts"), library);
  const requests = new WorkflowMediaRequestStore(path.join(root, "requests"), artifacts);
  const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
  const draft = permissions.createDraft({ moduleId: "notes", scopes: [{ scopeId: "vault", label: "Vault", directory: path.join(home, "Pictures") }] });
  permissions.save({ moduleId: "notes", expectedRevision: draft.revision, confirmed: true, scopes: draft.scopes });
  const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
  const sendImage = vi.fn(async (): Promise<SendTextResult> => ({ ok: true, messageId: "private-message-id" }));
  const sendFile = vi.fn<WorkflowMediaSendPort["sendFile"]>(async () => ({ ok: true, messageId: "private-file-message-id" }));
  const reconcile = vi.fn(async () => ({ status: "accepted" as const }));
  const provider = new WorkflowMediaProvider(library, artifacts, {
    resolveRunTarget: (runId) => runId === "run-1" ? { accountId: "bot@im.bot", target: "owner@im.wechat" } : null,
  }, { sendImage, sendFile, reconcile }, files, requests, {
    snapshotLegacyFile: async (accountId, input) => {
      const localFiles = new LocalFileTools(permissions, {
        moduleIds: ["notes"], spoolDirectory: path.join(root, "files", "snapshots"),
        operationDatabasePath: path.join(root, "operations.sqlite"),
      });
      try { return await localFiles.snapshotLegacyFile(accountId, input); } finally { await localFiles.close(); }
    },
  });
  return { root, home, imagePath, library, artifacts, requests, files, provider, sendImage, sendFile, reconcile };
}

describe("terminal_file_media_workflow_regression", () => {
  it("resolves a frozen local-image request into opaque candidates with its explicit caption", async () => {
    const { provider, requests } = await fixture();
    const event = {
      key: "request-1", messageId: "request-1", accountId: "bot@im.bot", target: "owner@im.wechat",
      source: "text" as const, text: "把 Pictures 的 holiday 图片发给我", receivedAt: Date.now(),
      replyText: vi.fn(),
    };
    requests.observe(event);
    const requestHandle = requests.capture(event.key, { query: "holiday", rootId: "pictures", caption: "旅行" });

    const outcome = await provider.invoke({
      runId: "run-1", stepId: "resolve", capabilityId: "media.resolve_images", capabilityVersion: 1,
      input: { requestHandle }, dependencyResults: {}, resourceKeys: [],
    });

    expect(outcome.status).toBe("succeeded");
    const matches = (outcome as { output: { matches: Array<Record<string, unknown>> } }).output.matches;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ fileName: "holiday.png", caption: "旅行" });
    expect(JSON.stringify(matches)).not.toContain("/home/");
  });

  it("distinguishes an unauthorized requested directory from an empty search", async () => {
    const { provider, requests, library } = await fixture();
    library.configure({ rootIds: [], confirmed: true });
    const incoming = {
      key: "request-denied", messageId: "request-denied", accountId: "bot@im.bot", target: "owner@im.wechat",
      source: "text" as const, text: "把 Pictures 的 holiday 图片发给我", receivedAt: Date.now(), replyText: vi.fn(),
    };
    requests.observe(incoming);
    const requestHandle = requests.capture(incoming.key, { query: "holiday", rootId: "pictures" });

    await expect(provider.invoke({
      runId: "run-1", stepId: "resolve", capabilityId: "media.resolve_images", capabilityVersion: 1,
      input: { requestHandle }, dependencyResults: {}, resourceKeys: [],
    })).resolves.toEqual({ status: "failed", errorCode: "workflow_module_permission_denied" });
  });

  it("snapshots legacy file handles before either file-send capability reaches the external port", async () => {
    const { files, imagePath, provider, sendFile } = await fixture();
    const file = files.capture({ absolutePath: imagePath, moduleId: "notes", scopeId: "vault" });
    await expect(provider.invoke({ runId: "run-1", stepId: "send", capabilityId: "weixin.send_file", capabilityVersion: 1, input: { fileHandle: file.handle }, dependencyResults: {}, resourceKeys: [], effectRef: "workflow-effect:abc", operationId: "workflow-operation:abc" })).resolves.toEqual({ status: "succeeded", output: { accepted: true } });
    expect(sendFile).toHaveBeenCalledWith({ accountId: "bot@im.bot", target: "owner@im.wechat", filePath: expect.any(String), fileName: "holiday.png", operationId: "workflow-operation:abc" });

    await expect(provider.invoke({ runId: "run-1", stepId: "submit", capabilityId: "weixin.submit_file", capabilityVersion: 1, input: { fileHandle: file.handle }, dependencyResults: {}, resourceKeys: [], effectRef: "workflow-effect:def", operationId: "workflow-operation:def" })).resolves.toEqual({ status: "succeeded", output: { accepted: true } });
    expect(sendFile).toHaveBeenLastCalledWith({ accountId: "bot@im.bot", target: "owner@im.wechat", filePath: expect.any(String), fileName: "holiday.png", operationId: "workflow-operation:def" });
    expect(sendFile).toHaveBeenCalledTimes(2);
    for (const [sent] of sendFile.mock.calls) {
      expect(sent.filePath).not.toBe(fs.realpathSync(imagePath));
      expect(fs.readFileSync(sent.filePath, "utf8")).toBe("image");
    }
  });

  it("prepares an authorized file handle as an opaque image handle", async () => {
    const { root, imagePath, library, artifacts } = await fixture();
    const permissions = new WorkflowModulePermissionStore(path.join(root, "media-permissions.sqlite"));
    permissions.save({
      moduleId: "local-media",
      expectedRevision: 0,
      confirmed: true,
      scopes: [{ scopeId: "pictures", label: "Pictures", directory: path.dirname(imagePath), read: true, write: false }],
    });
    const files = new WorkflowFileArtifactStore(path.join(root, "prepared-files"), permissions);
    const file = files.capture({ absolutePath: imagePath, moduleId: "local-media", scopeId: "pictures" });
    const provider = new WorkflowMediaProvider(library, artifacts, {
      resolveRunTarget: () => null,
    }, {
      sendImage: vi.fn(), sendFile: vi.fn(), reconcile: vi.fn(),
    }, files);

    const outcome = await provider.invoke({
      runId: "run-1", stepId: "prepare", capabilityId: "media.prepare_image", capabilityVersion: 1,
      input: { fileHandle: file.handle }, dependencyResults: {}, resourceKeys: [],
    });

    expect(outcome.status).toBe("succeeded");
    const mediaHandle = (outcome as { output: { mediaHandle: string } }).output.mediaHandle;
    expect(mediaHandle).toMatch(/^media_[a-f0-9]{32}$/);
    const preparedPath = artifacts.resolve(mediaHandle);
    expect(preparedPath).not.toBe(fs.realpathSync(imagePath));
    expect(fs.readFileSync(preparedPath!, "utf8")).toBe(fs.readFileSync(imagePath, "utf8"));
  });

  it("finds authorized images and returns only opaque handles plus safe metadata", async () => {
    const { home, imagePath, provider, artifacts } = await fixture();
    const outcome = await provider.invoke({
      runId: "run-1", stepId: "find", capabilityId: "media.find_images", capabilityVersion: 1,
      input: { query: "holiday", rootId: "pictures", limit: 5 }, dependencyResults: {}, resourceKeys: [],
    });

    expect(outcome.status).toBe("succeeded");
    const output = (outcome as { output: { matches: Array<{ handle: string }> } }).output;
    expect(output.matches).toHaveLength(1);
    expect(output.matches[0]!.handle).toMatch(/^media_[a-f0-9]{32}$/);
    expect(JSON.stringify(output)).not.toContain(home);
    expect(artifacts.resolve(output.matches[0]!.handle)).toBe(fs.realpathSync(imagePath));
  });

  it("sends a resolved image to the trusted run target with the stable operation id", async () => {
    const { imagePath, library, artifacts, provider, sendImage } = await fixture();
    const found = await library.search({ query: "holiday" });
    const artifact = artifacts.capture(found.matches[0]!);

    const outcome = await provider.invoke({
      runId: "run-1", stepId: "send", capabilityId: "weixin.send_image", capabilityVersion: 1,
      input: { mediaHandle: artifact.handle }, dependencyResults: {}, resourceKeys: ["weixin:target:private"],
      effectRef: "workflow-effect:abc", operationId: "workflow-operation:abc",
    });

    expect(outcome).toEqual({ status: "succeeded", output: { accepted: true } });
    expect(sendImage).toHaveBeenCalledWith({
      accountId: "bot@im.bot", target: "owner@im.wechat", filePath: fs.realpathSync(imagePath),
      operationId: "workflow-operation:abc",
    });
  });

  it("fails closed for a revoked handle and preserves an unknown channel result", async () => {
    const { library, artifacts, provider, sendImage } = await fixture();
    const found = await library.search({ query: "holiday" });
    const artifact = artifacts.capture(found.matches[0]!);
    library.configure({ rootIds: [], confirmed: true });

    await expect(provider.invoke({
      runId: "run-1", stepId: "send", capabilityId: "weixin.send_image", capabilityVersion: 1,
      input: { mediaHandle: artifact.handle }, dependencyResults: {}, resourceKeys: [],
      effectRef: "workflow-effect:abc", operationId: "workflow-operation:abc",
    })).resolves.toEqual({ status: "failed", errorCode: "workflow_media_handle_unavailable" });
    expect(sendImage).not.toHaveBeenCalled();

    library.configure({ rootIds: ["pictures"], confirmed: true });
    const refreshed = await library.search({ query: "holiday" });
    const next = artifacts.capture(refreshed.matches[0]!);
    sendImage.mockResolvedValueOnce({ ok: false, reason: "unknown", error: "private provider detail" });
    await expect(provider.invoke({
      runId: "run-1", stepId: "send", capabilityId: "weixin.send_image", capabilityVersion: 1,
      input: { mediaHandle: next.handle }, dependencyResults: {}, resourceKeys: [],
      effectRef: "workflow-effect:def", operationId: "workflow-operation:def",
    })).resolves.toEqual({ status: "unknown", errorCode: "weixin_media_send_unknown" });
  });

  it("reconciles by stable operation id without invoking send again", async () => {
    const { provider, reconcile, sendImage } = await fixture();
    await expect(provider.reconcile("workflow-effect:abc", { runId: "run-1", operationId: "workflow-operation:abc" })).resolves.toEqual({ status: "accepted" });
    expect(reconcile).toHaveBeenCalledWith("workflow-operation:abc", { accountId: "bot@im.bot", target: "owner@im.wechat" });
    await expect(provider.reconcile("workflow-effect:abc")).resolves.toEqual({ status: "unknown", errorCode: "workflow_target_unavailable" });
    await expect(provider.reconcile("workflow-effect:abc", { runId: "unbound", operationId: "workflow-operation:abc" }))
      .resolves.toEqual({ status: "unknown", errorCode: "workflow_target_unavailable" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(sendImage).not.toHaveBeenCalled();
  });

  it("keeps account, target, paths and tokens out of the public capability contract", async () => {
    const { provider } = await fixture();
    const serialized = JSON.stringify(provider.catalog());
    for (const forbidden of ["accountId", "target", "filePath", "absolutePath", "contextToken", "token"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
