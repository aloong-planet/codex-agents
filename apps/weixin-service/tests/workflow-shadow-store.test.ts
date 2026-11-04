import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowShadowStore } from "../src/workflow-shadow-store.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("WorkflowShadowStore", () => {
  it("persists an idempotent, body-free intent mapping for owner comparison", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-shadow-store-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "shadow.sqlite");
    const store = new WorkflowShadowStore(databasePath, () => 1_800_000_000_000);
    const observation = {
      triggerKeyHash: "a".repeat(64),
      intent: "notes.send-file",
      intentVersion: 1,
      workflowId: "notes.send-file-one-message",
      confidence: 0.97,
      slotKeys: ["query"],
    };

    expect(store.has(observation.triggerKeyHash)).toBe(false);
    store.observe(observation);
    store.observe(observation);

    expect(store.has(observation.triggerKeyHash)).toBe(true);
    expect(store.list()).toEqual([{ ...observation, observedAt: 1_800_000_000_000 }]);
    expect(JSON.stringify(store.list())).not.toContain("AI Agent private query");
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    store.close();
  });

  it("rejects raw trigger identifiers and unexpected slot names", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-shadow-store-invalid-"));
    tempDirs.push(directory);
    const store = new WorkflowShadowStore(path.join(directory, "shadow.sqlite"));

    expect(() => store.observe({
      triggerKeyHash: "message-1",
      intent: "notes.send-file",
      intentVersion: 1,
      workflowId: "notes.send-file-one-message",
      confidence: 0.9,
      slotKeys: ["query"],
    })).toThrow("workflow_shadow_observation_invalid");
    expect(() => store.observe({
      triggerKeyHash: "b".repeat(64),
      intent: "notes.send-file",
      intentVersion: 1,
      workflowId: "notes.send-file-one-message",
      confidence: 0.9,
      slotKeys: ["query", "../../path"],
    })).toThrow("workflow_shadow_observation_invalid");
    store.close();
  });
});
