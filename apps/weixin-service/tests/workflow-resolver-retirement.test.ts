import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkflowEngine } from "../src/workflow-engine.js";
import { WorkflowRetirementNotifier } from "../src/workflow-retirement-notifier.js";
import { WorkflowRunTargetStore } from "../src/workflow-run-target-store.js";
import { renderWorkflowRun } from "../src/weixin-workflow-trigger-adapter.js";
import type { SendTextResult } from "../src/demo-service.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

it.each(["unknown", "throw", "interrupted", "rejected", "partial", "unproven"] as const)(
  "does not resend a notice after %s even after restarting",
  async (boundary) => {
    const fixture = await noticeFixture();
    try {
      fixture.notifier.migrate();
      if (boundary === "interrupted") {
        // Public pre-send claim is the actual durable state at a process crash.
        expect(fixture.engine.claimRetirementNotice(fixture.runId)).toBe(true);
      } else {
        fixture.setResult(() => {
          if (boundary === "throw") throw new Error("transport interrupted");
          return { ok: false, reason: boundary === "rejected" ? "rejected" : boundary === "unproven" ? "context_missing" : boundary === "partial" ? "context_stale" : "unknown",
            ...(boundary === "partial" ? { acceptedSegments: 1 } : {}) };
        });
        await fixture.notifier.runNow();
      }
      await fixture.restart();
      fixture.setResult(() => ({ ok: true }));
      await fixture.notifier.runNow();
      expect(fixture.engine.listRetirementNotices()).toMatchObject([{ state: boundary === "rejected" ? "failed" : "unknown" }]);
      expect(fixture.sent).toHaveLength(boundary === "interrupted" ? 0 : 1);
    } finally { await fixture.close(); }
  },
);

it("waits for the original account and retries a definitively unsent context failure after backoff", async () => {
  const fixture = await noticeFixture();
  try {
    fixture.notifier.migrate();
    fixture.setAvailable(false);
    await fixture.notifier.runNow();
    expect(fixture.sent).toHaveLength(0);
    fixture.setAvailable(true);
    fixture.setResult(() => ({ ok: false, reason: "context_missing", acceptedSegments: 0 }));
    await fixture.notifier.runNow();
    expect(fixture.engine.listRetirementNotices()).toMatchObject([{ state: "pending", nextAttemptAt: 61_000 }]);
    await fixture.restart();
    await fixture.notifier.runNow();
    expect(fixture.sent).toHaveLength(1);
    fixture.advance();
    fixture.setResult(() => ({ ok: true }));
    await fixture.notifier.runNow();
    expect(fixture.sent).toHaveLength(2);
    expect(fixture.engine.listRetirementNotices()).toMatchObject([{ state: "accepted" }]);
  } finally { await fixture.close(); }
});

it("never substitutes the current target when an old task lacks a target binding", async () => {
  const fixture = await noticeFixture(false);
  try {
    fixture.notifier.migrate();
    await fixture.notifier.runNow();
    expect(fixture.sent).toHaveLength(0);
    expect(fixture.engine.listRetirementNotices()).toMatchObject([{ state: "pending" }]);
  } finally { await fixture.close(); }
});

async function noticeFixture(bindTarget = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-notice-boundary-"));
  directories.push(directory);
  let now = 1_000;
  const database = path.join(directory, "workflow.sqlite");
  const targets = new WorkflowRunTargetStore(path.join(directory, "targets.sqlite"));
  const sent: Array<{ accountId: string; target: string; message: string }> = [];
  let result: () => SendTextResult = () => ({ ok: true });
  let available = true;
  const channel = {
    getSnapshot: () => ({ accounts: [{ accountId: available ? "bot" : "other", credentialStatus: "usable" as const }],
      targets: [{ accountId: "bot", target: "owner@im.wechat" }] }),
    onSnapshotChanged: () => () => {},
    sendText: async (input: { accountId: string; target: string; message: string }) => { sent.push(input); return result(); },
  };
  let engine = new WorkflowEngine(database, { now: () => now });
  const { runId } = await engine.submit({ source: "weixin", triggerId: "legacy-notice", occurredAt: now,
    requestedWorkflowId: "media.send-local-image-resolved" });
  if (bindTarget) targets.bind(runId, "bot", "owner@im.wechat");
  let notifier = new WorkflowRetirementNotifier(engine, targets, channel);
  return { sent, runId, get engine() { return engine; }, get notifier() { return notifier; },
    setResult: (next: () => SendTextResult) => { result = next; },
    setAvailable: (next: boolean) => { available = next; },
    advance: () => { now += 60_000; },
    restart: async () => {
      await notifier.close(); await engine.close();
      engine = new WorkflowEngine(database, { now: () => now });
      notifier = new WorkflowRetirementNotifier(engine, targets, channel);
      notifier.migrate();
    },
    close: async () => { await notifier.close(); await engine.close(); targets.close(); },
  };
}

it("persists a retirement notice and sends understandable text only to the original target, once across restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-notice-"));
  directories.push(directory);
  const database = path.join(directory, "workflow.sqlite");
  const targets = new WorkflowRunTargetStore(path.join(directory, "targets.sqlite"));
  let engine = new WorkflowEngine(database, { onRunAccepted: ({ runId }) => targets.bind(runId, "bot", "original@im.wechat") });
  const accepted = await engine.submit({ source: "weixin", triggerId: "old-notes", occurredAt: 1,
    accountRef: "bot", targetRef: "original@im.wechat", requestedWorkflowId: "notes.send-file-resolved" });
  const sent: Array<{ accountId: string; target: string; message: string }> = [];
  const channel = {
    getSnapshot: () => ({ accounts: [{ accountId: "bot", credentialStatus: "usable" as const }],
      targets: [{ accountId: "bot", target: "original@im.wechat" }, { accountId: "bot", target: "current@im.wechat" }] }),
    onSnapshotChanged: () => () => {},
    sendText: async (input: { accountId: string; target: string; message: string }) => { sent.push(input); return { ok: true }; },
  };
  new WorkflowRetirementNotifier(engine, targets, channel).migrate();
  await engine.close();
  engine = new WorkflowEngine(database);
  try {
    const notifier = new WorkflowRetirementNotifier(engine, targets, channel);
    notifier.migrate();
    await Promise.all([notifier.runNow(), notifier.runNow()]);
    expect(sent).toEqual([{ accountId: "bot", target: "original@im.wechat",
      message: "之前的文件查找任务已结束。若仍需要这个文件，请重新告诉我。" }]);
    expect(renderWorkflowRun(engine.get(accepted.runId))).toMatchObject({
      reply: "之前的文件查找任务已结束。若仍需要这个文件，请重新告诉我。",
    });
    await engine.close();
    engine = new WorkflowEngine(database);
    const restarted = new WorkflowRetirementNotifier(engine, targets, channel);
    restarted.migrate();
    await restarted.runNow();
    expect(sent).toHaveLength(1);
  } finally { await engine.close(); targets.close(); }
});

it("retires accepted legacy queries before plans exist without retiring unrelated missing templates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-retirement-"));
  directories.push(directory);
  const database = path.join(directory, "workflow.sqlite");
  const old = new WorkflowEngine(database);
  const notes = await old.submit({ source: "weixin", triggerId: "old-notes", occurredAt: 1,
    accountRef: "bot", targetRef: "user@im.wechat", requestedWorkflowId: "notes.send-file-resolved" });
  const image = await old.submit({ source: "weixin", triggerId: "old-image", occurredAt: 2,
    accountRef: "bot", targetRef: "user@im.wechat", requestedWorkflowId: "media.send-local-image-resolved" });
  const unrelated = await old.submit({ source: "weixin", triggerId: "other", occurredAt: 3,
    requestedWorkflowId: "other.missing-template" });
  expect(old.get(notes.runId)?.status).toBe("accepted");
  await old.close();
  const engine = new WorkflowEngine(database);
  try {
    expect(engine.retirePendingCapability("files.resolve", 1, "workflow_file_resolver_retired",
      ["notes.send-file-resolved", "media.send-local-image-resolved"]).sort()).toEqual([notes.runId, image.runId].sort());
    expect(engine.get(notes.runId)).toMatchObject({ status: "failed", errorCode: "workflow_file_resolver_retired" });
    expect(engine.get(image.runId)).toMatchObject({ status: "failed", errorCode: "workflow_file_resolver_retired" });
    expect(engine.get(unrelated.runId)?.status).toBe("accepted");
    expect(engine.retirePendingCapability("files.resolve", 1, "workflow_file_resolver_retired",
      ["notes.send-file-resolved", "media.send-local-image-resolved"])).toEqual([]);
    await engine.start();
    expect(engine.get(unrelated.runId)?.errorCode).toBe("workflow_template_unavailable");
  } finally { await engine.close(); }
});
