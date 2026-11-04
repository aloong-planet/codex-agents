import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowFileSendProvider } from "../src/workflow-file-send-provider.js";
import { WorkflowFileSendStore } from "../src/workflow-file-send-store.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("WorkflowFileSendProvider", () => {
  it("loads safe candidates, snapshots only the chosen items, and reuses committed handles", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-send-provider-"));
    dirs.push(root);
    const artifactRoot = path.join(root, "artifacts");
    const snapshotRoot = path.join(artifactRoot, "snapshots");
    fs.mkdirSync(snapshotRoot, { recursive: true });
    const manifests = new WorkflowFileSendStore(path.join(root, "manifests"));
    const files = new WorkflowFileArtifactStore(
      artifactRoot,
      new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite")),
    );
    const snapshotCandidates = vi.fn(async (_accountId: string, candidates: Array<{ fileName: string }>) =>
      candidates.map((candidate) => {
        const body = Buffer.from(`snapshot:${candidate.fileName}`);
        const snapshotPath = path.join(snapshotRoot, `${candidate.fileName}.snapshot`);
        fs.writeFileSync(snapshotPath, body, { mode: 0o600 });
        return {
          snapshotPath,
          fileName: candidate.fileName,
          sha256: crypto.createHash("sha256").update(body).digest("hex"),
          sizeBytes: body.length,
        };
      }));
    const provider = new WorkflowFileSendProvider(manifests, files, { snapshotCandidates }, {
      resolveRunTarget: (runId) => runId === "run-1"
        ? { accountId: "bot@im.bot", target: "owner@im.wechat" }
        : null,
    });
    const artifact = manifests.capture({
      accountRef: "bot@im.bot", targetRef: "owner@im.wechat", eventKey: "event-1",
      allowMultiple: true, selected: false,
      candidates: [candidate("one.md"), candidate("two.md")],
    });
    const load = await provider.invoke(invocation("run-1", "files.load_send_manifest", { manifestHandle: artifact.handle }));
    expect(load.status).toBe("succeeded");
    const publicCandidates = (load as { output: { candidates: Array<Record<string, unknown>> } }).output.candidates;
    expect(JSON.stringify(publicCandidates)).not.toContain("relativePath");

    const prepare = await provider.invoke(invocation("run-1", "files.prepare_send_selection", {
      manifestHandle: artifact.handle,
      selection: [publicCandidates[1]],
    }));
    expect(prepare).toEqual({
      status: "succeeded",
      output: { items: [{ fileHandle: expect.stringMatching(/^file_[a-f0-9]{32}$/u) }] },
    });
    expect(snapshotCandidates).toHaveBeenCalledWith("bot@im.bot", [expect.objectContaining({ fileName: "two.md" })]);

    await provider.invoke(invocation("run-1", "files.prepare_send_selection", {
      manifestHandle: artifact.handle,
      selection: [publicCandidates[1]],
    }));
    expect(snapshotCandidates).toHaveBeenCalledTimes(1);
  });

  it("rejects more than one choice for a single-choice manifest", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-send-provider-"));
    dirs.push(root);
    const manifests = new WorkflowFileSendStore(path.join(root, "manifests"));
    const files = new WorkflowFileArtifactStore(
      path.join(root, "artifacts"),
      new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite")),
    );
    const provider = new WorkflowFileSendProvider(manifests, files, { snapshotCandidates: vi.fn() }, {
      resolveRunTarget: () => ({ accountId: "bot@im.bot", target: "owner@im.wechat" }),
    });
    const artifact = manifests.capture({
      accountRef: "bot@im.bot", targetRef: "owner@im.wechat", eventKey: "event-2",
      allowMultiple: false, selected: false,
      candidates: [candidate("one.md"), candidate("two.md")],
    });
    const manifest = manifests.resolve(artifact.handle, "bot@im.bot", "owner@im.wechat")!;
    const publicCandidates = manifests.publicCandidates(manifest);

    await expect(provider.invoke(invocation("run-1", "files.prepare_send_selection", {
      manifestHandle: artifact.handle,
      selection: publicCandidates,
    }))).resolves.toEqual({ status: "failed", errorCode: "workflow_file_send_selection_invalid" });
  });

  it("returns a structured failure when a pending selection was not one of the presented candidates", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-send-provider-"));
    dirs.push(root);
    const manifests = new WorkflowFileSendStore(path.join(root, "manifests"));
    const files = new WorkflowFileArtifactStore(
      path.join(root, "artifacts"),
      new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite")),
    );
    const provider = new WorkflowFileSendProvider(manifests, files, { snapshotCandidates: vi.fn() }, {
      resolveRunTarget: () => ({ accountId: "bot@im.bot", target: "owner@im.wechat" }),
    });
    const artifact = manifests.capture({
      accountRef: "bot@im.bot", targetRef: "owner@im.wechat", eventKey: "event-invalid",
      allowMultiple: true, selected: false, candidates: [candidate("one.md"), candidate("two.md")],
    });

    await expect(provider.invoke(invocation("run-1", "files.prepare_send_selection", {
      manifestHandle: artifact.handle,
      selection: [{
        candidateRef: "candidate_not_presented",
        fileName: "other.md",
        displayPath: "Vault/other.md",
        sizeBytes: 5,
        modifiedAt: 1_000,
      }],
    }))).resolves.toEqual({ status: "failed", errorCode: "workflow_file_send_selection_invalid" });
  });
});

function invocation(runId: string, capabilityId: string, input: Record<string, unknown>) {
  return { runId, stepId: "step", capabilityId, capabilityVersion: 1, input, dependencyResults: {}, resourceKeys: [] };
}

function candidate(fileName: string) {
  return {
    source: {
      moduleId: "notes", moduleRevision: 1, scopeId: "vault", relativePath: fileName,
      fileName, displayPath: `Vault/${fileName}`, sizeBytes: 5, modifiedAt: 1_000,
    },
  };
}
