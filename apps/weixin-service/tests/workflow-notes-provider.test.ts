import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DirectMarkdownVault } from "../src/direct-markdown-vault.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { WorkflowNoteArtifactStore } from "../src/workflow-note-artifact-store.js";
import { WorkflowNotesProvider } from "../src/workflow-notes-provider.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-notes-provider-"));
  dirs.push(root);
  const vaultRoot = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
  const vault = new DirectMarkdownVault(vaultRoot);
  await vault.create("Projects/demo.md", "private project body");
  const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
  const draft = permissions.createDraft({ moduleId: "notes", scopes: [{ scopeId: "demo-vault", label: "demo Vault", directory: vaultRoot }] });
  permissions.save({ moduleId: "notes", expectedRevision: draft.revision, confirmed: true, scopes: draft.scopes });
  const artifacts = new WorkflowNoteArtifactStore(path.join(root, "artifacts"));
  const provider = new WorkflowNotesProvider(vault, vaultRoot, artifacts, permissions);
  return { root, vaultRoot, vault, permissions, artifacts, provider };
}

describe("WorkflowNotesProvider", () => {
  it("searches from a durable opaque request handle without returning the query", async () => {
    const { artifacts, provider } = await fixture();
    const request = artifacts.captureSearchRequest("message-1", "project");
    expect(request.handle).toMatch(/^query_[a-f0-9]{32}$/);

    const outcome = await provider.invoke({
      runId: "run-search-request", stepId: "search", capabilityId: "notes.search-request", capabilityVersion: 1,
      input: { scopeId: "demo-vault", requestHandle: request.handle }, dependencyResults: {}, resourceKeys: [],
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome).toMatchObject({ output: { matches: [{ fileName: "demo.md" }] } });
    expect(JSON.stringify(outcome)).not.toContain("project");
  });

  it("searches within an authorized scope and returns only opaque note handles", async () => {
    const { vaultRoot, artifacts, provider } = await fixture();
    const outcome = await provider.invoke({
      runId: "run-1", stepId: "search", capabilityId: "notes.search", capabilityVersion: 1,
      input: { scopeId: "demo-vault", query: "project" }, dependencyResults: {}, resourceKeys: [],
    });
    expect(outcome.status).toBe("succeeded");
    const output = (outcome as { output: { matches: Array<{ noteHandle: string }> } }).output;
    expect(output.matches).toHaveLength(1);
    expect(JSON.stringify(output)).not.toContain(vaultRoot);
    expect(artifacts.resolveNotePath(output.matches[0]!.noteHandle)).toBe("Projects/demo.md");
  });

  it("uses title and path ranked retrieval for file-selection searches", async () => {
    const { vault, provider } = await fixture();
    await vault.create("Architecture/Agent-工作流.md", "正文不含目标词。\n");
    await vault.create("meeting.md", "这份会议记录提到了 Agent 工作流。\n");

    const outcome = await provider.invoke({
      runId: "run-ranked-search", stepId: "search", capabilityId: "notes.search", capabilityVersion: 1,
      input: { scopeId: "demo-vault", query: "Agent 工作流" }, dependencyResults: {}, resourceKeys: [],
    });

    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { matches: [{ fileName: "Agent-工作流.md" }] },
    });
  });

  it("reads through a note handle and keeps the body out of workflow output", async () => {
    const { artifacts, provider } = await fixture();
    const note = artifacts.captureNotePath("Projects/demo.md");
    const outcome = await provider.invoke({
      runId: "run-1", stepId: "read", capabilityId: "notes.read", capabilityVersion: 1,
      input: { scopeId: "demo-vault", noteHandle: note.handle }, dependencyResults: {}, resourceKeys: [],
    });
    expect(outcome.status).toBe("succeeded");
    expect(JSON.stringify(outcome)).not.toContain("private project body");
    const output = (outcome as { output: { contentHandle: string; sha256: string } }).output;
    expect(output.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(artifacts.resolveContent(output.contentHandle)).toBe("private project body");
  });

  it("fails closed after read permission is revoked", async () => {
    const { artifacts, permissions, provider } = await fixture();
    const state = permissions.get("notes")!;
    permissions.save({
      moduleId: "notes", expectedRevision: state.revision, confirmed: true,
      scopes: state.scopes.map((scope) => ({ ...scope, read: false })),
    });
    const note = artifacts.captureNotePath("Projects/demo.md");
    await expect(provider.invoke({
      runId: "run-1", stepId: "read", capabilityId: "notes.read", capabilityVersion: 1,
      input: { scopeId: "demo-vault", noteHandle: note.handle }, dependencyResults: {}, resourceKeys: [],
    })).resolves.toEqual({ status: "failed", errorCode: "workflow_notes_permission_denied" });
  });

  it("keeps a nested scope from searching notes outside that directory", async () => {
    const { permissions, provider, vaultRoot } = await fixture();
    const state = permissions.get("notes")!;
    permissions.save({
      moduleId: "notes", expectedRevision: state.revision, confirmed: true,
      scopes: [{ scopeId: "projects", label: "Projects", directory: path.join(vaultRoot, "Projects"), read: true, write: false }],
    });
    const outcome = await provider.invoke({
      runId: "run-1", stepId: "search", capabilityId: "notes.search", capabilityVersion: 1,
      input: { scopeId: "projects", query: "project" }, dependencyResults: {}, resourceKeys: [],
    });
    expect(outcome.status).toBe("succeeded");
    expect((outcome as { output: { matches: unknown[] } }).output.matches).toHaveLength(1);
  });

  it("keeps note bodies and real paths out of the capability contract", async () => {
    const { provider } = await fixture();
    const serialized = JSON.stringify(provider.catalog());
    for (const forbidden of ["\"content\"", "\"body\"", "absolutePath", "filePath", "contextToken"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("creates and updates notes from private content handles with conflict protection", async () => {
    const { artifacts, permissions, provider, vault } = await fixture();
    const state = permissions.get("notes")!;
    permissions.save({
      moduleId: "notes", expectedRevision: state.revision, confirmed: true,
      scopes: state.scopes.map((scope) => ({ ...scope, write: true })),
    });
    const createdContent = artifacts.captureDraftContent("created body");
    const created = await provider.invoke({
      runId: "run-1", stepId: "create", capabilityId: "notes.create", capabilityVersion: 1,
      input: { scopeId: "demo-vault", relativePath: "Inbox/new.md", contentHandle: createdContent.handle },
      dependencyResults: {}, resourceKeys: ["notes:demo-vault:Inbox/new.md"],
      effectRef: "workflow-effect:create", operationId: "workflow-operation:create",
    });
    expect(created.status).toBe("succeeded");
    expect(await vault.read("Inbox/new.md")).toMatchObject({ content: "created body" });

    const existing = await vault.read("Projects/demo.md");
    const note = artifacts.captureNotePath(existing.path);
    const updatedContent = artifacts.captureDraftContent("updated body");
    const updated = await provider.invoke({
      runId: "run-1", stepId: "update", capabilityId: "notes.update", capabilityVersion: 1,
      input: { scopeId: "demo-vault", noteHandle: note.handle, contentHandle: updatedContent.handle, expectedSha256: existing.sha256 },
      dependencyResults: {}, resourceKeys: ["notes:demo-vault:Projects/demo.md"],
      effectRef: "workflow-effect:update", operationId: "workflow-operation:update",
    });
    expect(updated.status).toBe("succeeded");
    expect(await vault.read("Projects/demo.md")).toMatchObject({ content: "updated body" });

    await expect(provider.invoke({
      runId: "run-1", stepId: "stale", capabilityId: "notes.update", capabilityVersion: 1,
      input: { scopeId: "demo-vault", noteHandle: note.handle, contentHandle: updatedContent.handle, expectedSha256: existing.sha256 },
      dependencyResults: {}, resourceKeys: [], effectRef: "workflow-effect:stale", operationId: "workflow-operation:stale",
    })).resolves.toEqual({ status: "failed", errorCode: "workflow_notes_revision_conflict" });
  });

  it("rejects note writes when only the default read permission is enabled", async () => {
    const { artifacts, provider } = await fixture();
    const content = artifacts.captureDraftContent("must not write");
    await expect(provider.invoke({
      runId: "run-1", stepId: "create", capabilityId: "notes.create", capabilityVersion: 1,
      input: { scopeId: "demo-vault", relativePath: "denied.md", contentHandle: content.handle },
      dependencyResults: {}, resourceKeys: [], effectRef: "workflow-effect:denied", operationId: "workflow-operation:denied",
    })).resolves.toEqual({ status: "failed", errorCode: "workflow_notes_permission_denied" });
  });
});
