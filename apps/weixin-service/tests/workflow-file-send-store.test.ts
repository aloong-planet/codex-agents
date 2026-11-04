import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowFileSendStore } from "../src/workflow-file-send-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("WorkflowFileSendStore", () => {
  it("binds private candidates to one account and target while exposing only safe metadata", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-send-store-"));
    dirs.push(root);
    const store = new WorkflowFileSendStore(root, () => 1_000, 60_000);
    const artifact = store.capture({
      accountRef: "bot@im.bot",
      targetRef: "owner@im.wechat",
      eventKey: "event-1",
      allowMultiple: true,
      selected: false,
      candidates: [candidate("one.md"), candidate("two.md")],
    });

    expect(store.resolve(artifact.handle, "other@im.bot", "owner@im.wechat")).toBeNull();
    const resolved = store.resolve(artifact.handle, "bot@im.bot", "owner@im.wechat")!;
    expect(resolved.preselectedRefs).toEqual([]);
    expect(store.publicCandidates(resolved)).toEqual([
      expect.objectContaining({ candidateRef: expect.stringMatching(/^sendcandidate_[a-f0-9]{32}$/u), fileName: "one.md" }),
      expect.objectContaining({ candidateRef: expect.stringMatching(/^sendcandidate_[a-f0-9]{32}$/u), fileName: "two.md" }),
    ]);
    expect(JSON.stringify(store.publicCandidates(resolved))).not.toContain("relativePath");
    expect(JSON.stringify(store.publicCandidates(resolved))).not.toContain("moduleId");
  });

  it("persists selected snapshot handles as preselected candidates", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-file-send-store-"));
    dirs.push(root);
    const store = new WorkflowFileSendStore(root, () => 1_000, 60_000);
    const artifact = store.capture({
      accountRef: "bot@im.bot", targetRef: "owner@im.wechat", eventKey: "event-2",
      allowMultiple: true, selected: true,
      candidates: [{ ...candidate("one.md"), snapshotHandle: "file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
    });

    const reopened = new WorkflowFileSendStore(root, () => 2_000, 60_000);
    const resolved = reopened.resolve(artifact.handle, "bot@im.bot", "owner@im.wechat")!;
    expect(resolved.preselectedRefs).toEqual([resolved.candidates[0]!.candidateRef]);
    expect(resolved.candidates[0]!.snapshotHandle).toBe("file_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

function candidate(fileName: string) {
  return {
    source: {
      moduleId: "notes", moduleRevision: 1, scopeId: "vault", relativePath: fileName,
      fileName, displayPath: `Vault/${fileName}`, sizeBytes: 5, modifiedAt: 1_000,
    },
  };
}
