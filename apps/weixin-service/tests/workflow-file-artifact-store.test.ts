import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("WorkflowFileArtifactStore", () => {
  it("bounds complete turn text independently from legacy search queries", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-turn-text-"));
    dirs.push(root);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const store = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions);
    try {
      const text = "😀".repeat(16384);
      const captured = store.captureTurnText("complete-turn", text);
      expect(store.resolveQuery(captured.handle)).toBe(text);
      expect(() => store.captureTurnText("too-large", `${text}a`)).toThrow("workflow_file_query_invalid");
      expect(() => store.captureQuery("legacy-query", "a".repeat(501))).toThrow("workflow_file_query_invalid");
    } finally { permissions.close(); }
  });

  it("keeps an authorized local file behind a durable opaque handle", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-artifact-"));
    dirs.push(root);
    const vault = path.join(root, "vault");
    fs.mkdirSync(vault);
    const notePath = path.join(vault, "demo.md");
    fs.writeFileSync(notePath, "private body");
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const draft = permissions.createDraft({ moduleId: "notes", scopes: [{ scopeId: "vault", label: "Vault", directory: vault }] });
    permissions.save({ moduleId: "notes", expectedRevision: draft.revision, confirmed: true, scopes: draft.scopes });
    const store = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions, () => 1_000, 60_000);

    const artifact = store.capture({ absolutePath: notePath, moduleId: "notes", scopeId: "vault" });

    expect(artifact).toMatchObject({ handle: expect.stringMatching(/^file_[a-f0-9]{32}$/), fileName: "demo.md", sizeBytes: 12, expiresAt: 61_000 });
    expect(JSON.stringify(artifact)).not.toContain(notePath);
    expect(new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions, () => 2_000, 60_000).resolve(artifact.handle)).toBe(fs.realpathSync(notePath));
  });

  it("persists a validated structured search plan while retaining legacy query compatibility", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-query-artifact-"));
    dirs.push(root);
    const vault = path.join(root, "vault");
    fs.mkdirSync(vault);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const store = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions, () => 1_000, 60_000);
    const plan = {
      nameTerms: ["摘要"], pathTerms: ["2026-08-12"], contentTerms: [],
    };

    const structured = store.captureSearchPlan("structured-trigger", plan);
    const legacy = store.captureQuery("legacy-trigger", "AI Agent");
    const reopened = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions, () => 2_000, 60_000);

    expect(reopened.resolveSearchPlan(structured.handle)).toEqual(plan);
    expect(reopened.resolveQuery(structured.handle)).toBeNull();
    expect(reopened.resolveSearchPlan(legacy.handle)).toEqual({
      nameTerms: ["AI Agent"], pathTerms: [], contentTerms: ["AI Agent"],
    });
  });

  it("looks up a previously captured raw request by its trusted trigger key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-query-handle-"));
    dirs.push(root);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const store = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions, () => 1_000, 60_000);

    const captured = store.captureQuery("message-42", "把昨天那篇 AI Agent 笔记原文件发给我");

    expect(store.queryHandle("message-42")).toBe(captured.handle);
    expect(store.queryHandle("missing-message")).toBeNull();
  });

  it("accepts only validated immutable snapshots under its private snapshot root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-snapshot-artifact-"));
    dirs.push(root);
    const artifactRoot = path.join(root, "artifacts");
    const snapshots = path.join(artifactRoot, "snapshots");
    fs.mkdirSync(snapshots, { recursive: true });
    const snapshotPath = path.join(snapshots, "snapshot.bin");
    const body = Buffer.from([5, 4, 3, 2, 1]);
    fs.writeFileSync(snapshotPath, body, { mode: 0o600 });
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const store = new WorkflowFileArtifactStore(artifactRoot, permissions, () => 1_000, 60_000);
    const sha256 = crypto.createHash("sha256").update(body).digest("hex");

    const artifact = store.captureSnapshot({ absolutePath: snapshotPath, fileName: "original.bin", sha256, sizeBytes: body.length });
    expect(artifact).toMatchObject({ fileName: "original.bin", sizeBytes: body.length, expiresAt: 61_000 });
    expect(JSON.stringify(artifact)).not.toContain(snapshotPath);
    expect(store.resolve(artifact.handle)).toBe(fs.realpathSync(snapshotPath));

    fs.writeFileSync(snapshotPath, "tampered");
    expect(store.resolve(artifact.handle)).toBeNull();
    const outside = path.join(root, "outside.bin");
    fs.writeFileSync(outside, body);
    expect(() => store.captureSnapshot({ absolutePath: outside, fileName: "outside.bin", sha256, sizeBytes: body.length }))
      .toThrow("workflow_file_snapshot_invalid");
  });

  it("removes orphaned and expired immutable snapshots when reopened", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-snapshot-cleanup-"));
    dirs.push(root);
    const artifactRoot = path.join(root, "artifacts");
    const snapshots = path.join(artifactRoot, "snapshots", "account", "notes", "1");
    fs.mkdirSync(snapshots, { recursive: true });
    const activePath = path.join(snapshots, `${"a".repeat(32)}.md`);
    const expiredPath = path.join(snapshots, `${"b".repeat(32)}.md`);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const activeStore = new WorkflowFileArtifactStore(artifactRoot, permissions, () => 1_000, 60_000);
    fs.mkdirSync(snapshots, { recursive: true });
    fs.writeFileSync(activePath, "active", { mode: 0o600 });
    const activeBody = fs.readFileSync(activePath);
    const active = activeStore.captureSnapshot({
      absolutePath: activePath,
      fileName: "active.md",
      sha256: crypto.createHash("sha256").update(activeBody).digest("hex"),
      sizeBytes: activeBody.length,
    });
    const expiringStore = new WorkflowFileArtifactStore(artifactRoot, permissions, () => 1_000, 1_000);
    fs.writeFileSync(expiredPath, "expired", { mode: 0o600 });
    const expiredBody = fs.readFileSync(expiredPath);
    expiringStore.captureSnapshot({
      absolutePath: expiredPath,
      fileName: "expired.md",
      sha256: crypto.createHash("sha256").update(expiredBody).digest("hex"),
      sizeBytes: expiredBody.length,
    });
    const orphanPath = path.join(snapshots, `${"c".repeat(32)}.md`);
    fs.writeFileSync(orphanPath, "orphan", { mode: 0o600 });

    const reopened = new WorkflowFileArtifactStore(artifactRoot, permissions, () => 3_000, 60_000);

    expect(reopened.resolve(active.handle)).toBe(fs.realpathSync(activePath));
    expect(fs.existsSync(activePath)).toBe(true);
    expect(fs.existsSync(expiredPath)).toBe(false);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });
});
