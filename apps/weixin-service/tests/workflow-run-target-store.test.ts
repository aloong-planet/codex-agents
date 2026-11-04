import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowRunTargetStore } from "../src/workflow-run-target-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("WorkflowRunTargetStore", () => {
  it("persists one immutable trusted target per run", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-run-target-"));
    dirs.push(root);
    const databasePath = path.join(root, "targets.sqlite");
    const first = new WorkflowRunTargetStore(databasePath);
    first.bind("run-1", "bot@im.bot", "owner@im.wechat");
    expect(first.resolveRunTarget("run-1")).toEqual({ accountId: "bot@im.bot", target: "owner@im.wechat" });
    expect(() => first.bind("run-1", "bot@im.bot", "other@im.wechat")).toThrow("workflow_run_target_conflict");
    first.close();

    const reopened = new WorkflowRunTargetStore(databasePath);
    expect(reopened.resolveRunTarget("run-1")).toEqual({ accountId: "bot@im.bot", target: "owner@im.wechat" });
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    reopened.close();
  });
  it("reopens an opaque channel target without relabeling a legacy destination", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-run-target-"));
    dirs.push(root);
    const databasePath = path.join(root, "targets.sqlite");
    const first = new WorkflowRunTargetStore(databasePath);
    first.bind("legacy", "bot@im.bot", "owner@im.wechat");
    first.bind("new", "feishu.app", "feishu.owner-123");
    expect(() => first.bind("new", "feishu.app", "feishu.other")).toThrow("workflow_run_target_conflict");
    expect(() => first.bind("bad", "feishu.app", "target/escape")).toThrow("workflow_run_target_invalid");
    first.close();
    const reopened = new WorkflowRunTargetStore(databasePath);
    try {
      expect(reopened.resolveRunTarget("new")).toEqual({ accountId: "feishu.app", target: "feishu.owner-123" });
      expect(reopened.resolveRunTarget("legacy")).toEqual({ accountId: "bot@im.bot", target: "owner@im.wechat" });
      expect(reopened.resolveRunTarget("bad")).toBeNull();
    } finally { reopened.close(); }
  });

});
