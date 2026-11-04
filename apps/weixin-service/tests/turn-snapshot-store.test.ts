import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { TurnSnapshotStore } from "../src/turn-snapshot-store.js";

const digest = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("TurnSnapshotStore", () => {
  it("snapshots allowed roots, records a delete, and restores only without a later conflict", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-turn-snapshot-"));
    const root = path.join(fixture, "vault");
    const state = path.join(fixture, "private");
    fs.mkdirSync(root);
    const note = path.join(root, "note.md");
    fs.writeFileSync(note, "before\n");
    const before = digest(note);
    const snapshots = new TurnSnapshotStore(state, [root]);

    const snapshotId = snapshots.prepare("thread-1", "turn-1");
    fs.unlinkSync(note);
    expect(snapshots.complete(snapshotId)).toMatchObject({
      changes: [{ root, relativePath: "note.md", kind: "deleted" }],
    });

    snapshots.restore(snapshotId);
    expect(digest(note)).toBe(before);
    fs.writeFileSync(note, "later edit\n");
    expect(() => snapshots.restore(snapshotId)).toThrow("恢复冲突");
  });

  it("fails closed when a symlink or snapshot budget would make recovery incomplete", () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-turn-snapshot-limit-"));
    const root = path.join(fixture, "vault");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "large.md"), "12345");
    expect(() => new TurnSnapshotStore(path.join(fixture, "private"), [root], 4).prepare("t", "u"))
      .toThrow("快照预算");
  });
});
