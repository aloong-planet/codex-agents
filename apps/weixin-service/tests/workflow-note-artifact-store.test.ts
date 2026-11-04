import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowNoteArtifactStore } from "../src/workflow-note-artifact-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("WorkflowNoteArtifactStore", () => {
  it("reuses one search request handle for the same inbound and rejects changed content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-note-search-request-"));
    dirs.push(root);
    const store = new WorkflowNoteArtifactStore(root, () => 1_000, 60_000);

    const first = store.captureSearchRequest("inbound-1", "project");
    const duplicate = store.captureSearchRequest("inbound-1", " project ");

    expect(duplicate).toEqual(first);
    expect(store.resolveSearchRequest(first.handle)).toBe("project");
    expect(() => store.captureSearchRequest("inbound-1", "private")).toThrow("workflow_note_search_request_conflict");
  });

  it("persists note and content handles without returning the note body", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-note-artifacts-"));
    dirs.push(root);
    const store = new WorkflowNoteArtifactStore(root, () => 1_000, 60_000);
    const note = store.captureNotePath("Projects/demo.md");
    const content = store.captureContent(note.handle, "private note body");

    expect(note).toMatchObject({ handle: expect.stringMatching(/^note_[a-f0-9]{32}$/), fileName: "demo.md" });
    expect(content).toMatchObject({ handle: expect.stringMatching(/^content_[a-f0-9]{32}$/), sizeBytes: 17 });
    expect(JSON.stringify({ note, content })).not.toContain("private note body");

    const reopened = new WorkflowNoteArtifactStore(root, () => 2_000, 60_000);
    expect(reopened.resolveNotePath(note.handle)).toBe("Projects/demo.md");
    expect(reopened.resolveContent(content.handle)).toBe("private note body");
    for (const file of fs.readdirSync(root)) expect(fs.statSync(path.join(root, file)).mode & 0o777).toBe(0o600);
  });

  it("rejects traversal and expires both kinds of handles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-note-expiry-"));
    dirs.push(root);
    const store = new WorkflowNoteArtifactStore(root, () => 1_000, 60_000);
    expect(() => store.captureNotePath("../private.md")).toThrow("workflow_note_path_invalid");
    const note = store.captureNotePath("safe.md");
    const content = store.captureContent(note.handle, "safe");
    const expired = new WorkflowNoteArtifactStore(root, () => 61_000, 60_000);
    expect(expired.resolveNotePath(note.handle)).toBeNull();
    expect(expired.resolveContent(content.handle)).toBeNull();
  });

  it("stores generated draft content without requiring an existing note", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-note-draft-"));
    dirs.push(root);
    const store = new WorkflowNoteArtifactStore(root);
    const draft = store.captureDraftContent("new note body");
    expect(JSON.stringify(draft)).not.toContain("new note body");
    expect(store.resolveContent(draft.handle)).toBe("new note body");
  });

  it("rejects generated drafts larger than the writable note limit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-note-draft-limit-"));
    dirs.push(root);
    const store = new WorkflowNoteArtifactStore(root);
    expect(() => store.captureDraftContent("x".repeat(100_001))).toThrow("workflow_note_content_too_large");
  });
});
