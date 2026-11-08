// Actual permission-worker seam. Native model access and authenticated main ingress have separate acceptance checks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { LocalFileTools } from "../src/local-file-tools.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

it("retains business file access while excluding protected state under an ancestor grant and persisted send candidates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-file-access-"));
  const directory = path.join(root, "documents"), privateRoot = path.join(directory, "internal-state");
  fs.mkdirSync(privateRoot, { recursive: true });
  fs.writeFileSync(path.join(directory, "business.md"), "business needle");
  fs.writeFileSync(path.join(privateRoot, "memory.md"), "private needle");
  fs.symlinkSync(privateRoot, path.join(directory, "alias"));
  const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
  permissions.save({ moduleId: "notes", expectedRevision: 0, confirmed: true,
    scopes: [{ scopeId: "documents", label: "Documents", directory, read: true, write: true }] });
  const open = (protectedRoots: string[]) => new LocalFileTools(permissions, { moduleIds: ["notes"], spoolDirectory: path.join(root, "spool"), protectedRoots });
  // A candidate persisted while internal-state was outside the protected set, as by a build before the set covered it.
  let tools = open([path.join(root, "service-state")]);
  const personal: TrustedWorkflowTurn = { accountId: "same-account", target: "owner@im.wechat", eventKey: "private", occurredAt: 1, originalTextRef: "text", attachmentRefs: [] };
  const group: TrustedWorkflowTurn = { ...personal, target: `feishu.group.${"a".repeat(64)}`, requesterRef: "ou_alice", eventKey: "group" };
  let privateBinding = tools.bindTurn(personal);
  const earlier = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: { kind: "file" } }, personal) as { entries: Array<{ fileRef: string; fileName: string }> };
  const persistedCandidate = tools.describeForSend(personal, [earlier.entries.find((entry) => entry.fileName === "memory.md")!.fileRef]);
  await privateBinding.release(); await tools.close();

  tools = open([privateRoot]);
  privateBinding = tools.bindTurn({ ...personal, eventKey: "private-protected" });
  let groupBinding = tools.bindTurn(group);
  const execute = (trusted: TrustedWorkflowTurn, toolId: string, toolVersion: number, args: Record<string, unknown>) => tools.execute({ toolId, toolVersion, arguments: args }, trusted);
  try {
    const personalFiles = await execute({ ...personal, eventKey: "private-protected" }, "files.find", 2, { kind: "file" }) as { entries: Array<{ fileName: string }> };
    expect(personalFiles.entries.map((entry) => entry.fileName)).toEqual(["business.md"]);
    const found = await execute(group, "files.find", 2, { kind: "file" }) as { entries: Array<{ fileRef: string; fileName: string }> };
    expect(found.entries.map((entry) => entry.fileName)).toEqual(["business.md"]);
    expect(await execute(group, "files.read", 2, { fileRef: found.entries[0]!.fileRef })).toMatchObject({ content: "business needle" });
    expect(await execute(group, "files.grep", 2, { pattern: "needle" })).toMatchObject({ matches: [{ text: "business needle" }], scanComplete: true });
    const scopeRef = groupBinding.promptLines[0]!.split(":", 1)[0]!;
    const created = await execute(group, "files.write", 1, { scopeRef, relativePath: "created.md", content: "created for group", overwrite: false }) as { fileRef: string };
    expect(await execute(group, "files.read", 2, { fileRef: created.fileRef })).toMatchObject({ content: "created for group" });
    for (const relativePath of ["internal-state/new.md", "alias/new.md"]) {
      await expect(execute(group, "files.write", 1, { scopeRef, relativePath, content: "blocked", overwrite: false })).rejects.toThrow();
    }
    const snapshots = await tools.snapshotForSend(group, [created.fileRef]);
    expect(snapshots).toMatchObject([{ fileName: "created.md", sizeBytes: 17 }]);
    expect(fs.readFileSync(snapshots[0]!.snapshotPath, "utf8")).toBe("created for group");
    await privateBinding.release(); await groupBinding.release(); await tools.close(); tools = open([privateRoot]);
    privateBinding = tools.bindTurn({ ...personal, eventKey: "private-reopened" });
    groupBinding = tools.bindTurn({ ...group, eventKey: "group-reopened" });
    await expect(tools.snapshotCandidates(group.accountId, persistedCandidate)).rejects.toThrow("local_file_permission_denied");
    await expect(tools.snapshotCandidates(personal.accountId, persistedCandidate)).rejects.toThrow("local_file_permission_denied");
    expect(fs.readdirSync(privateRoot)).toEqual(["memory.md"]);
    expect(fs.readFileSync(path.join(privateRoot, "memory.md"), "utf8")).toBe("private needle");
  } finally { await privateBinding.release(); await groupBinding.release(); await tools.close(); permissions.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
