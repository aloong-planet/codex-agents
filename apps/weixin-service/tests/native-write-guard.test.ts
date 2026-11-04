import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NativeWriteGuard } from "../src/native-write-guard.js";

describe("NativeWriteGuard", () => {
  it("grants only fixed roots for the current turn after a successful snapshot", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-write-guard-"));
    const workspace = path.join(fixture, "workspace");
    const vault = path.join(fixture, "vault");
    fs.mkdirSync(workspace);
    fs.mkdirSync(vault);
    const snapshots = { prepare: vi.fn(() => "snapshot-1"), complete: vi.fn(() => ({ changes: [] })) };
    const guard = new NativeWriteGuard([workspace, vault], snapshots);
    guard.setEnabled(true);

    await expect(guard.request({
      threadId: "thread-1",
      turnId: "turn-1",
      permissions: { fileSystem: { write: [vault] }, network: { enabled: false } },
    })).resolves.toEqual({
      permissions: {
        fileSystem: { entries: [
          { access: "write", path: { type: "path", path: workspace } },
          { access: "write", path: { type: "path", path: vault } },
        ] },
        network: { enabled: false },
      },
      scope: "turn",
      strictAutoReview: true,
    });
    expect(snapshots.prepare).toHaveBeenCalledWith("thread-1", "turn-1");
    guard.complete("thread-1", "turn-1");
    expect(snapshots.complete).toHaveBeenCalledWith("snapshot-1");
  });

  it("rejects network and out-of-root write requests without taking a snapshot", async () => {
    const snapshots = { prepare: vi.fn(), complete: vi.fn() };
    const guard = new NativeWriteGuard(["/allowed"], snapshots);
    guard.setEnabled(true);
    await expect(guard.request({
      threadId: "t",
      turnId: "u",
      permissions: { fileSystem: { write: ["/outside"] } },
    })).rejects.toThrow("越界");
    await expect(guard.request({
      threadId: "t",
      turnId: "u",
      permissions: { fileSystem: { write: ["/allowed"] }, network: { enabled: true } },
    })).rejects.toThrow("网络");
    expect(snapshots.prepare).not.toHaveBeenCalled();
  });
});
