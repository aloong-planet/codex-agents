import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowPendingPresentationStore } from "../src/workflow-pending-presentation-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("WorkflowPendingPresentationStore", () => {
  it("persists the latest accepted presentation per account and target", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-presentation-"));
    tempDirs.push(directory);
    const databasePath = path.join(directory, "workflow.sqlite");
    const first = new WorkflowPendingPresentationStore(databasePath);
    first.put({
      accountRef: "account-a", targetRef: "target-a", runId: "run-latest",
      signalRef: "workflow-input:latest", revision: 2,
      requestTextHash: "a".repeat(64), expiresAt: 1_800_000_100_000, acceptedAt: 1_800_000_000_000,
    });
    first.close();

    const reopened = new WorkflowPendingPresentationStore(databasePath);
    expect(reopened.get("account-a", "target-a")).toEqual({
      accountRef: "account-a", targetRef: "target-a", runId: "run-latest",
      signalRef: "workflow-input:latest", revision: 2,
      requestTextHash: "a".repeat(64), expiresAt: 1_800_000_100_000, acceptedAt: 1_800_000_000_000,
    });
    reopened.close();
  });

  it("does not let a delayed older acceptance replace the latest presentation", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-presentation-order-"));
    tempDirs.push(directory);
    const store = new WorkflowPendingPresentationStore(path.join(directory, "workflow.sqlite"));
    const base = {
      accountRef: "account-a", targetRef: "target-a", revision: 2,
      requestTextHash: "a".repeat(64), expiresAt: 1_800_000_100_000,
    };
    store.put({ ...base, runId: "run-new", signalRef: "signal-new", acceptedAt: 1_800_000_000_010 });
    store.put({ ...base, runId: "run-old", signalRef: "signal-old", acceptedAt: 1_800_000_000_000 });

    expect(store.get("account-a", "target-a")).toMatchObject({ runId: "run-new", signalRef: "signal-new" });
    store.close();
  });
});
