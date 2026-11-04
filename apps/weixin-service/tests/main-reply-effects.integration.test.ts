import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CodexServiceStore } from "../src/codex-service-store.js";
import { DemoService, type SendTextResult, type WeixinChannel } from "../src/demo-service.js";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { DurableInboundStore } from "../src/durable-inbound-store.js";
import { FixtureAppServerTransport, type FixtureModelToolCall } from "../src/fixture-app-server-transport.js";
import { CodexConversation } from "../src/codex-conversation.js";
import type { AppServerMessage } from "../src/codex-app-server-client.js";
import { FixturePort } from "../src/fixture-port.js";
import { createDemoServer } from "../src/http-server.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { LocalFileTools } from "../src/local-file-tools.js";
import { MediaExportLibrary } from "../src/media-export-library.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { WeixinCodexService, type CodexAgent } from "../src/weixin-codex-service.js";
import { WorkflowEngine } from "../src/workflow-engine.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW, WEIXIN_SEND_FILES_WORKFLOW } from "../src/workflow-file-send-intent.js";
import { WorkflowFileSendProvider } from "../src/workflow-file-send-provider.js";
import { WorkflowFileSendStore } from "../src/workflow-file-send-store.js";
import { WorkflowMediaArtifactStore } from "../src/workflow-media-artifact-store.js";
import { WorkflowMediaProvider } from "../src/workflow-media-provider.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { WorkflowPendingPresentationStore } from "../src/workflow-pending-presentation-store.js";
import { WorkflowRunTargetStore } from "../src/workflow-run-target-store.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { WorkflowToolGateway } from "../src/workflow-tool-gateway.js";
import { WorkflowToolHost } from "../src/workflow-tool-host.js";
import { AppServerTurnFailure } from "../src/app-server-turn-driver.js";
import { createWeixinSendFilesToolRegistration, createWorkflowToolReplyProjector, WorkflowToolProductionControl } from "../src/workflow-tool-production.js";

// Production HTTP ingress, durable inbox, tool host, sandbox, Run/Effect and
// stores are real. Only model/channel boundaries are fixtures. This establishes
// failure isolation, not model semantics, Tencent acceptance or phone receipt.
describe("structured final reply after real side effects", () => {
  for (const claimed of [false, true]) {
    it.each(["completed", "failed", "interrupted", "disconnect"] as const)(`D17/D18 keeps the same turn across retry with claimed=${claimed} then %s`, async (terminal) => {
      const fixture = await createFixture();
      let sending: Promise<void> | undefined;
      try {
        fixture.calls.push(findNote(), ...(claimed ? [sendNote(), findNote()] : []));
        fixture.pauseForRetry(claimed ? 2 : 1, terminal);
        sending = fixture.send(claimed ? "把 Vault 中 one.md 原文件发给我。" : "查找 Vault 中 one.md，不要发送原文件。");
        void sending.catch(() => {});
        await vi.waitFor(() => expect(fixture.retryPaused()).toBe(true), { timeout: 10_000 });
        expect(fixture.owner()).toBe(claimed ? "workflow" : "model");
        expect(fixture.texts).toEqual(["已收到，正在处理。"]);
        expect(fixture.runIds).toHaveLength(claimed ? 1 : 0);
        fixture.continueProtocol();
        await sending;
        const execution = fixture.reply.mock.results[0]!.value;
        if (terminal === "completed") {
          await expect(execution).resolves.toMatchObject(claimed
            ? { owner: "workflow_owned", receipt: { reply: "文件已发送，请查收。" } }
            : { owner: "model_owned", finalText: JSON.stringify({ message: "收到", results: [] }) });
        } else {
          const failure = await execution.catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(AppServerTurnFailure);
          expect(failure).toMatchObject({ ownership: claimed
            ? { owner: "workflow", runRef: fixture.runIds[0], receipt: { reply: "文件已发送，请查收。" } }
            : { owner: "model" } });
        }
        expect(fixture.wire.filter((message) => message.method === "turn/start")).toHaveLength(1);
        expect(fixture.wire.filter((message) => message.method === "turn/interrupt")).toEqual([]);
        const requests = fixture.received.filter((message) => message.method === "item/tool/call");
        expect(new Set(requests.map((message) => message.params?.turnId)).size).toBe(1);
        for (const request of requests) expect(fixture.wire.filter((message) => !message.method && message.id === request.id)).toHaveLength(1);
        if (claimed) {
          expect(fixture.sentFiles).toEqual([{ name: "one.md", body: "before", operationId: expect.any(String) }]);
          expect(fixture.engine.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state: "accepted" })]);
          expect(fixture.wire.filter((m) => m.id !== undefined && !m.method).at(-1)?.result).toMatchObject({
            success: true, contentItems: [{ type: "inputText", text: expect.stringContaining("workflow_turn_already_claimed") }],
          });
        } else expect(fixture.sentFiles).toEqual([]);
        expect(fixture.texts.at(-1)).toBe(claimed ? "文件已发送，请查收。" : terminal === "completed" ? "收到" : "我暂时无法处理这条消息，请稍后再发一条新消息。");
        expect(fixture.store.load().runtimeRuns.at(-1)?.timings).toContainEqual(expect.objectContaining({ stage: "agent", outcome: terminal === "disconnect" ? "failed" : terminal }));
      } finally { fixture.continueProtocol(); await sending?.catch(() => {}); await fixture.close(); }
    }, 120_000);
  }

  it("D15/I05 retains durable ownership when receipt projection fails after a real file submission", async () => {
    const fixture = await createFixture();
    try {
      fixture.calls.push(findNote(), sendNote(), sendNote());
      fixture.failProjection();
      fixture.setFinal(JSON.stringify({ message: "MODEL_TAIL_MUST_NOT_SEND", results: [{ subject: "发送", status: "completed" }] }));
      await fixture.send("把 Vault 中 one.md 原文件发给我。");
      expect(fixture.texts).toEqual(["已收到，正在处理。", "我暂时无法处理这条消息，请稍后再发一条新消息。"]);
      expect(fixture.sentFiles).toEqual([{ name: "one.md", body: "before", operationId: expect.any(String) }]);
      expect(fixture.runIds).toHaveLength(1);
      expect(fixture.engine.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state: "accepted" })]);
      expect(fixture.store.load().transcript.at(-1)).not.toHaveProperty("businessResult");
      expect(fixture.inbox.peek(fixture.keys[0]!)).toMatchObject({ state: "completed", attempts: 1 });
      const responses = fixture.wire.filter((m) => m.id !== undefined && !m.method);
      expect(responses.at(-1)?.result).toMatchObject({ success: true, contentItems: [
        { type: "inputText", text: expect.stringContaining("workflow_turn_already_claimed") },
      ] });
      await fixture.diagnostics.close();
      const observed = await readDiagnostics(path.join(fixture.root, "otel"), { maxRecords: 10_000, maxBytes: 20 * 1024 ** 2 });
      expect(observed.records).toContainEqual(expect.objectContaining({ name: "tool.result", attributes: expect.objectContaining({
        toolId: "weixin.send_files", ownerAfter: "workflow", runRef: fixture.runIds[0],
        errorCode: "workflow_tool_receipt_unavailable",
      }) }));
      const reloaded = await fixture.reloadEngine();
      try {
        expect(reloaded.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state: "accepted" })]);
        expect(fixture.sentFiles).toHaveLength(1);
      } finally { await reloaded.close(); }
    } finally { await fixture.close(); }
  }, 120_000);

  it("D16 keeps an undispatched successor queued while Demo drains an active send", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture({ ok: true }, gate);
    const unsubscribe = fixture.subscribeCommand();
    try {
      fixture.calls.push(findNote(), sendNote());
      const first = fixture.send("把 Vault 中 one.md 原文件发给我。");
      await fixture.waitForFileSend(first);
      expect(fixture.sentFiles).toHaveLength(1);
      const second = fixture.send("停机后仍需处理的下一条");
      await vi.waitFor(() => expect(fixture.inbox.peekQueued("fixture-bot", "fixture-user@im.wechat")?.text).toBe("停机后仍需处理的下一条"), { timeout: 30_000 });
      const closing = fixture.closeDemo();
      release();
      await Promise.all([first, second, closing]);
      expect(fixture.inbox.peekQueued("fixture-bot", "fixture-user@im.wechat")).toMatchObject({ state: "queued", attempts: 0, text: "停机后仍需处理的下一条" });
      expect(fixture.sentFiles).toHaveLength(1);
    } finally { release(); unsubscribe(); await fixture.close(); }
  }, 120_000);

  for (const missingReceipt of [false, true]) {
    it.each(["malformed", "disconnect", "no_final", "cleanup"] as const)(`D14 keeps durable acceptance with missingReceipt=${missingReceipt} after %s`, async (failure) => {
      const fixture = await createFixture();
      try {
        fixture.calls.push(findNote(), sendNote());
        if (missingReceipt) fixture.failProjection();
        fixture.failNext(failure);
        fixture.failTrace();
        await fixture.send("把 Vault 中 one.md 原文件发给我。");
        expect(fixture.injectedFailures).toContain(failure);
        expect(fixture.runIds).toHaveLength(1);
        expect(fixture.sentFiles).toEqual([{ name: "one.md", body: "before", operationId: expect.any(String) }]);
        expect(fixture.engine.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state: "accepted" })]);
        expect(fixture.texts).toEqual(["已收到，正在处理。", missingReceipt
          ? "我暂时无法处理这条消息，请稍后再发一条新消息。" : "文件已发送，请查收。"]);
        expect(fixture.store.load().transcript.at(-1)).not.toHaveProperty("businessResult");
        expect(fixture.inbox.peek(fixture.keys[0]!)).toMatchObject({ state: "completed", attempts: 1 });
        expect(fixture.wire.filter((m) => m.method === "turn/start")).toHaveLength(1);
        expect(fixture.wire.filter((m) => m.method === "turn/interrupt")).toEqual([]);
        await fixture.diagnostics.close();
        const observed = await readDiagnostics(path.join(fixture.root, "otel"), { maxRecords: 10_000, maxBytes: 20 * 1024 ** 2 });
        expect(observed.records).toContainEqual(expect.objectContaining({ name: "tool.result", attributes: expect.objectContaining({
          toolId: "weixin.send_files", ownerAfter: "workflow", runRef: fixture.runIds[0],
        }) }));
        if (failure === "cleanup") expect(observed.records).toContainEqual(expect.objectContaining({ name: "app_server.turn_drain", attributes: expect.objectContaining({
          status: "failed", errorCode: "permission_cleanup_failed",
        }) }));
      } finally { await fixture.close(); }
    }, 120_000);
  }

  it("D07 corrects an actual preflight rejection in the same turn before claiming once", async () => {
    const fixture = await createFixture();
    try {
      fixture.calls.push(
        { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [`fileref_${"a".repeat(32)}`] } },
        findNote(),
        { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [resultRef(1, ["entries", 0, "fileRef"])] } },
      );
      await fixture.send("把 Vault 中 one.md 原文件发给我。");
      const requests = fixture.received.filter((m) => m.method === "item/tool/call");
      expect(new Set(requests.map((m) => m.params?.turnId)).size).toBe(1);
      const error = fixture.wire.find((m) => m.id === requests[0]?.id)?.result as { success: boolean; contentItems: Array<{ text: string }> };
      expect(error.success).toBe(true);
      expect(JSON.parse(error.contentItems[0]!.text)).toMatchObject({ ok: false, error: { code: "local_file_reference_invalid", action: "refresh_reference" } });
      expect(fixture.runsAtResponse).toEqual([0, 0, 1]);
      expect(fixture.runIds).toHaveLength(1);
      expect(fixture.sentFiles).toEqual([{ name: "one.md", body: "before", operationId: expect.any(String) }]);
      expect(fixture.texts.at(-1)).toBe("文件已发送，请查收。");
    } finally { await fixture.close(); }
  }, 120_000);

  it.each([
    { state: "accepted", result: { ok: true } },
    { state: "rejected", result: { ok: false, reason: "rejected" } },
    { state: "unknown", result: { ok: false, reason: "unknown" } },
  ] satisfies Array<{ state: string; result: SendTextResult }>)("AC-06 binds the real pending presentation only after text $state", async ({ state, result }) => {
    const fixture = await createFixture();
    let accept!: () => void;
    const gate = new Promise<void>((resolve) => { accept = resolve; });
    try {
      fs.writeFileSync(path.join(fixture.root, "vault", "two.md"), "second");
      fixture.calls.push(
        { namespace: "files", tool: "find", arguments: { scopeRefs: [{ $fixtureScopeLabel: "Vault" }], query: ".md", match: "literal", limit: 10 } },
        { namespace: "weixin", tool: "send_files", arguments: { disposition: "needs_choice", allowMultiple: true,
          candidateRefs: [resultRef(0, ["entries", 0, "fileRef"]), resultRef(0, ["entries", 1, "fileRef"])] } },
      );
      const replyStarted = fixture.setTextReply(result, gate);
      const inbound = fixture.send("把 Vault 中的 Markdown 文件列出来让我选，先不要发送。");
      await Promise.race([replyStarted, inbound.then(() => { throw new Error("inbound completed before pending reply"); })]);
      expect(fixture.texts).toHaveLength(2);
      expect(fixture.texts[1]).toContain("one.md");
      expect(fixture.texts[1]).toContain("two.md");
      expect(fixture.presentations.get("fixture-bot", "fixture-user@im.wechat")).toBeUndefined();
      accept();
      await inbound;
      expect(fixture.runIds).toHaveLength(1);
      expect(fixture.engine.get(fixture.runIds[0]!)).toMatchObject({ status: "needs_input" });
      const presentation = fixture.presentations.get("fixture-bot", "fixture-user@im.wechat");
      if (state === "accepted") {
        expect(presentation).toMatchObject({ runId: fixture.runIds[0] });
        console.info("Ticket04 pending presentation:", JSON.stringify(fixture.texts[1]));
      }
      else expect(presentation).toBeUndefined();
      expect(fixture.sentFiles).toEqual([]);
      expect(fixture.store.load().transcript.at(-1)).not.toHaveProperty("businessResult");
      expect(fixture.inbox.peek(fixture.keys[0]!)).toMatchObject({ state: "completed", attempts: 1 });
    } finally { accept(); await fixture.close(); }
  }, 120_000);

  it("I06 holds same-target FIFO until the first admitted send and cleanup finish", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture({ ok: true }, gate);
    try {
      fixture.calls.push(findNote(), sendNote());
      const first = fixture.send("把 Vault 中 one.md 原文件发给我。");
      await fixture.waitForFileSend(first);
      expect(fixture.sentFiles).toHaveLength(1);
      const second = fixture.send("只回复：收到");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fixture.wire.filter((message) => message.method === "turn/start")).toHaveLength(1);
      release();
      await Promise.all([first, second]);
      expect(fixture.wire.filter((message) => message.method === "turn/start")).toHaveLength(2);
      expect(fixture.sentFiles).toEqual([{ name: "one.md", body: "before", operationId: expect.any(String) }]);
      expect(fixture.texts).toEqual(["已收到，正在处理。", "文件已发送，请查收。", "已收到，正在处理。", "收到"]);
      expect(fixture.keys).toHaveLength(2);
      for (const key of fixture.keys) expect(fixture.inbox.peek(key)).toMatchObject({ state: "completed", attempts: 1 });
    } finally { release(); await fixture.close(); }
  }, 120_000);

  it("D10 drains an accepted terminal operation before service close and retains its late receipt", async () => {
    let accept!: () => void;
    const gate = new Promise<void>((resolve) => { accept = resolve; });
    const fixture = await createFixture({ ok: true }, gate);
    try {
      fixture.calls.push(findNote(), sendNote());
      const inbound = fixture.send("把 Vault 中 one.md 原文件发给我。");
      await fixture.waitForFileSend(inbound);
      expect(fixture.sentFiles).toHaveLength(1);
      let closed = false;
      const closing = Promise.resolve(fixture.codex.close()).then(() => { closed = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closed).toBe(false);
      accept();
      await inbound;
      await closing;
      expect(fixture.texts.at(-1)).toBe("文件已发送，请查收。");
      expect(fixture.sentFiles).toEqual([{ name: "one.md", body: "before", operationId: expect.any(String) }]);
      expect(fixture.engine.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state: "accepted" })]);
      expect(fixture.inbox.peek(fixture.keys[0]!)).toMatchObject({ state: "completed", attempts: 1 });
    } finally { accept(); await fixture.close(); }
  }, 120_000);

  it("returns a domain error to the scripted model and corrects the write in the same production turn", async () => {
    const fixture = await createFixture();
    try {
      const args = { scopeRef: { $fixtureScopeLabel: "Vault" }, relativePath: "repair.md", content: "corrected" };
      fixture.calls.push(
        { namespace: "files", tool: "write", arguments: args },
        { namespace: "files", tool: "write", arguments: { ...args, overwrite: false } },
      );
      fixture.setFinal(JSON.stringify({ message: "已创建 repair.md。", results: [{ subject: "创建文件", status: "completed" }] }));
      await fixture.send("在 Vault 新建 repair.md，内容为 corrected。");
      expect(fixture.texts.at(-1)).toBe("已创建 repair.md。");
      expect(fs.readFileSync(path.join(fixture.root, "vault", "repair.md"), "utf8")).toBe("corrected");
      const requests = fixture.received.filter((m) => m.method === "item/tool/call");
      expect(requests).toHaveLength(2);
      expect(new Set(requests.map((m) => m.params?.turnId)).size).toBe(1);
      const firstResponses = fixture.wire.filter((m) => m.id === requests[0]!.id);
      expect(firstResponses).toHaveLength(1);
      expect(firstResponses[0]?.result).toMatchObject({ success: true });
      const first = firstResponses[0]!.result as { contentItems: Array<{ text: string }> };
      expect(JSON.parse(first.contentItems[0]!.text)).toMatchObject({ ok: false, error: {
        code: "workflow_tool_arguments_invalid", retryable: true, action: "correct_arguments", fieldIssues: expect.any(Array),
      } });
      expect(fixture.filesAtResponse).toEqual([["one.md"], ["one.md", "repair.md"]]);
      expect(fixture.wire.filter((m) => m.id === requests[1]!.id)).toHaveLength(1);
      expect(fixture.wire.filter((m) => m.method === "turn/start")).toHaveLength(1);
      expect(fixture.received.at(-1)).toMatchObject({ method: "turn/completed", params: { turn: { status: "completed" } } });
      expect(fixture.runIds).toEqual([]);
      expect(fixture.sentFiles).toEqual([]);
    } finally { await fixture.close(); }
  }, 120_000);

  it.each(["malformed", "disconnect"] as const)("keeps a completed file edit after %s without replaying the turn", async (failure) => {
    const fixture = await createFixture();
    try {
      fixture.calls.push(...editNote());
      fixture.failNext(failure);
      await fixture.send("把 Vault 中 one.md 的 before 改为 after。");
      expect(fs.readFileSync(fixture.note, "utf8")).toBe("after");
      expect(fixture.reply).toHaveBeenCalledOnce(); // No model repair/replay is a contract.
      expect(fixture.injectedFailures).toEqual([failure]);
      expect(fixture.store.load().transcript.at(-1)).toMatchObject({ status: "agent_failed" });
      expect(fixture.store.load().transcript.at(-1)).not.toHaveProperty("businessResult");
      expect(fixture.runIds).toEqual([]);
      expect(fixture.sentFiles).toEqual([]);
      expect(fixture.texts.at(-1)).toBe("我暂时无法处理这条消息，请稍后再发一条新消息。");
      // A real disconnection needs an explicit reconnect; the old reply wrapper
      // never closed a connection and falsely implied automatic recovery.
      if (failure === "disconnect") await fixture.restartConnection();
      await fixture.send("只回复：收到");
      expect(fixture.reply).toHaveBeenCalledTimes(2);
      expect(fixture.texts.at(-1)).toBe("收到");
      expect(fs.readFileSync(fixture.note, "utf8")).toBe("after");
      expect(fixture.store.load().transcript.at(-1)?.businessResult).toMatchObject({ source: "main_model", results: [] });
      expect(fixture.keys).toHaveLength(2);
      for (const key of fixture.keys) expect(fixture.inbox.peek(key)).toMatchObject({ state: "completed", attempts: 1 });
    } finally { await fixture.close(); }
  }, 120_000);

  it("keeps the completed edit when final reply persistence fails, without reporting durable results as saved", async () => {
    const fixture = await createFixture();
    try {
      fixture.calls.push(...editNote());
      fixture.setFinal(JSON.stringify({ message: "修改完成。", results: [{ subject: "修改笔记", status: "completed" }] }));
      fixture.failFinalSave();
      await fixture.send("把 Vault 中 one.md 的 before 改为 after。");
      expect(fs.readFileSync(fixture.note, "utf8")).toBe("after");
      expect(fixture.codex.getPublicState()).toMatchObject({ status: "error", notice: expect.stringContaining("本地回复记录保存失败") });
      expect(fixture.codex.getPublicState().transcript.at(-1)).toMatchObject({ text: "修改完成。", businessResult: { results: [{ subject: "修改笔记", status: "completed" }] } });
      expect(fixture.reply).toHaveBeenCalledOnce();
      expect(fixture.texts).toHaveLength(2);
      expect(fixture.runIds).toEqual([]);
      expect(fixture.inbox.peek(fixture.keys[0]!)).toMatchObject({ state: "completed", attempts: 1 });
    } finally { await fixture.close(); }
  }, 120_000);

  it("ignores valid model results after terminal ownership instead of replacing the durable receipt", async () => {
    const fixture = await createFixture();
    try {
      fixture.calls.push(findNote(), sendNote());
      fixture.setFinal(JSON.stringify({ message: "MODEL_TAIL_MUST_NOT_SEND", results: [{ subject: "取消并重试发送", status: "cancelled" }] }));
      await fixture.send("把 Vault 中 one.md 原文件发给我。");
      expect(fixture.runIds).toHaveLength(1);
      expect(fixture.engine.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state: "accepted" })]);
      expect(fixture.sentFiles).toHaveLength(1);
      expect(fixture.texts).toHaveLength(2);
      expect(fixture.texts[1]).toBe("文件已发送，请查收。");
      expect(fixture.store.load().transcript.at(-1)).not.toHaveProperty("businessResult");
    } finally { await fixture.close(); }
  }, 120_000);

  for (const failure of ["malformed", "disconnect"] as const) {
    it.each([
      { channel: "accepted", result: { ok: true }, state: "accepted", notice: "文件已发送，请查收。" },
      { channel: "rejected", result: { ok: false, reason: "rejected" }, state: "rejected", notice: "文件发送失败，请稍后重试。" },
      { channel: "unknown", result: { ok: false, reason: "unknown" }, state: "unknown", notice: "文件发送结果暂时无法确认，请检查微信；系统不会自动重发。" },
    ] satisfies Array<{ channel: string; result: SendTextResult; state: string; notice: string }>)(`retains workflow ownership and the $channel Effect after ${failure}`, async ({ result, state, notice }) => {
      const fixture = await createFixture(result);
      try {
        fixture.calls.push(findNote(), sendNote());
        fixture.failNext(failure);
        await fixture.send("把 Vault 中 one.md 原文件发给我。");
        expect(fixture.runIds).toHaveLength(1);
        expect(fixture.sentFiles).toEqual([{ name: "one.md", body: "before", operationId: expect.any(String) }]);
        expect(fixture.engine.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state })]);
        expect(fixture.texts).toHaveLength(2); // One acknowledgement plus one workflow receipt.
        expect(fixture.texts[1]).toBe(notice);
        const saved = fixture.store.load().transcript.at(-1);
        expect(saved).toMatchObject({ text: notice, status: "accepted" });
        expect(saved).not.toHaveProperty("businessResult");
        expect(saved).not.toHaveProperty("replyFailure");
        expect(fixture.reply).toHaveBeenCalledOnce();
        expect(fixture.injectedFailures).toEqual([failure]);
        if (failure === "disconnect") {
          expect(fixture.store.load().runtimeRuns.at(-1)?.timings).toContainEqual(expect.objectContaining({ stage: "agent", outcome: "failed" }));
        }
        expect(fixture.inbox.peek(fixture.keys[0]!)).toMatchObject({ state: "completed", attempts: 1 });
        const reloaded = await fixture.reloadEngine();
        try {
          expect(reloaded.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state })]);
          expect(fixture.sentFiles).toHaveLength(1);
        } finally { await reloaded.close(); }
      } finally { await fixture.close(); }
    }, 120_000);
  }

  it("preserves an accepted Effect and the save warning when the workflow receipt cannot be persisted", async () => {
    const fixture = await createFixture();
    try {
      fixture.calls.push(findNote(), sendNote());
      fixture.failFinalSave();
      await fixture.send("把 Vault 中 one.md 原文件发给我。");
      expect(fixture.codex.getPublicState()).toMatchObject({ status: "error", notice: expect.stringContaining("本地回复记录保存失败") });
      expect(fixture.runIds).toHaveLength(1);
      expect(fixture.engine.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state: "accepted" })]);
      expect(fixture.sentFiles).toHaveLength(1);
      expect(fixture.texts).toHaveLength(2);
      expect(fixture.texts[1]).toBe("文件已发送，请查收。");
      expect(fixture.reply).toHaveBeenCalledOnce();
      expect(fixture.inbox.peek(fixture.keys[0]!)).toMatchObject({ state: "completed", attempts: 1 });
      const reloaded = await fixture.reloadEngine();
      try {
        expect(reloaded.get(fixture.runIds[0]!)?.effects).toEqual([expect.objectContaining({ state: "accepted" })]);
        expect(fixture.sentFiles).toHaveLength(1);
      } finally { await reloaded.close(); }
    } finally { await fixture.close(); }
  }, 120_000);

  it("does not collect final result content in actual OTel files or redact already supplied diagnostic attributes", async () => {
    const fixture = await createFixture();
    try {
      fixture.calls.push(findNote());
      fixture.setFinal(JSON.stringify({ message: "FINAL_MESSAGE_SENTINEL", results: [
        { subject: "FINAL_SUBJECT_SENTINEL", status: "completed" },
        { subject: "SECOND_GOAL_SENTINEL", status: "not_found" },
      ] }));
      await fixture.send("查看 Vault 中 one.md 的文件名。");
      expect(fixture.texts.at(-1)).toBe("FINAL_MESSAGE_SENTINEL");
      expect(fixture.store.load().transcript.at(-1)?.businessResult).toMatchObject({
        version: 1, source: "main_model", inboundKey: fixture.keys[0], results: [
          { subject: "FINAL_SUBJECT_SENTINEL", status: "completed" },
          { subject: "SECOND_GOAL_SENTINEL", status: "not_found" },
        ],
      });
      // Existing attributes must survive, even when values are outside old enums.
      fixture.diagnostics.checkpoint("existing.integration", { errorCode: "custom_error_keep_me", model: "future-model-v3" });
      await fixture.diagnostics.close();
      const output = await readDiagnostics(path.join(fixture.root, "otel"), { maxRecords: 10_000, maxBytes: 20 * 1024 ** 2 });
      expect(output).toMatchObject({ evidence: "observed", malformed: 0, unreadable: 0, budgetLimited: false, dropped: false, rotated: false });
      expect(output.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "tool.result", attributes: expect.objectContaining({ toolId: "files.find", domainSuccess: true }) }),
        expect.objectContaining({ name: "app_server.turn_drain", attributes: expect.objectContaining({ status: "succeeded" }) }),
        expect.objectContaining({ name: "app_server.turn_cleanup", attributes: expect.objectContaining({ status: "succeeded" }) }),
        expect.objectContaining({ name: "existing.integration", attributes: { errorCode: "custom_error_keep_me", model: "future-model-v3" } }),
      ]));
      const serialized = JSON.stringify(output.records);
      const raw = fs.readdirSync(path.join(fixture.root, "otel")).map((name) => fs.readFileSync(path.join(fixture.root, "otel", name), "utf8")).join("\n");
      for (const sentinel of ["FINAL_MESSAGE_SENTINEL", "FINAL_SUBJECT_SENTINEL", "SECOND_GOAL_SENTINEL"]) {
        expect(serialized).not.toContain(sentinel);
        expect(raw).not.toContain(sentinel);
      }
      expect(fixture.runIds).toEqual([]);
      expect(fixture.sentFiles).toEqual([]);
    } finally { await fixture.close(); }
  }, 120_000);
});

function resultRef(call: number, path: Array<string | number>) { return { $fixtureToolResult: { call, path } }; }
function findNote(): FixtureModelToolCall {
  return { namespace: "files", tool: "find", arguments: {
    scopeRefs: [{ $fixtureScopeLabel: "Vault" }], query: "one.md", match: "literal", limit: 1,
  } };
}
function sendNote(): FixtureModelToolCall {
  return { namespace: "weixin", tool: "send_files", arguments: { disposition: "selected", fileRefs: [resultRef(0, ["entries", 0, "fileRef"])] } };
}
function editNote(): FixtureModelToolCall[] {
  return [findNote(), { namespace: "files", tool: "read", arguments: { fileRef: resultRef(0, ["entries", 0, "fileRef"]) } },
    { namespace: "files", tool: "edit", arguments: {
      fileRef: resultRef(0, ["entries", 0, "fileRef"]), expectedSha256: resultRef(1, ["sha256"]), oldText: "before", newText: "after",
    } }];
}

async function createFixture(sendResult: SendTextResult = { ok: true }, sendGate?: Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-results-effects-"));
  const vault = path.join(root, "vault");
  fs.mkdirSync(vault);
  const note = path.join(vault, "one.md");
  fs.writeFileSync(note, "before");
  const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
  permissions.save({ moduleId: "notes", expectedRevision: 0, confirmed: true,
    scopes: [{ scopeId: "vault", label: "Vault", directory: vault, read: true, write: true }] });
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(root, "otel")));
  const localFiles = new LocalFileTools(permissions, {
    moduleIds: ["notes"], spoolDirectory: path.join(root, "artifacts", "snapshots"),
    operationDatabasePath: path.join(root, "operations.sqlite"), diagnostics,
  });
  const files = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions);
  const manifests = new WorkflowFileSendStore(path.join(root, "manifests"));
  const targets = new WorkflowRunTargetStore(path.join(root, "targets.sqlite"));
  const presentations = new WorkflowPendingPresentationStore(path.join(root, "presentations.sqlite"));
  const media = new MediaExportLibrary(path.join(root, "media.json"), root);
  const sentFiles: Array<{ name: string | undefined; body: string; operationId: string }> = [];
  let fileStarted!: () => void;
  const fileSubmission = new Promise<void>((resolve) => { fileStarted = resolve; });
  const runIds: string[] = [];
  const createEngine = () => new WorkflowEngine(path.join(root, "workflows.sqlite"), {
    templates: [WEIXIN_SEND_FILES_WORKFLOW, WEIXIN_SEND_FILES_SINGLE_CHOICE_WORKFLOW], diagnostics,
    providers: [new WorkflowFileSendProvider(manifests, files, localFiles, { resolveRunTarget: (id) => targets.resolveRunTarget(id) }),
      new WorkflowMediaProvider(media, new WorkflowMediaArtifactStore(path.join(root, "media-artifacts"), media), targets, {
        sendImage: async () => { throw new Error("unexpected image send"); },
        sendFile: async (input) => {
          sentFiles.push({ name: input.fileName, body: fs.readFileSync(input.filePath, "utf8"), operationId: input.operationId });
          fileStarted();
          await sendGate;
          return sendResult;
        },
        reconcile: async () => ({ status: "unknown" }),
      }, files)],
    onRunAccepted: ({ runId, trigger }) => { targets.bind(runId, trigger.accountRef!, trigger.targetRef!); runIds.push(runId); },
  });
  const engine = createEngine();
  let engineClosed = false;
  const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
  let failProjection = false;
  const projector = createWorkflowToolReplyProjector(engine, presentations, Date.now, files);
  const gateway = new WorkflowToolGateway(catalog, [createWeixinSendFilesToolRegistration(localFiles, files, manifests)], engine,
    (run, trusted) => {
      if (failProjection) throw new Error("fixture_receipt_projection_failed");
      return projector(run, trusted);
    });
  let failTrace = false;
  const host = new WorkflowToolHost(catalog, gateway, localFiles, { diagnostics, trace: () => {
    if (failTrace) throw new Error("fixture_trace_unavailable");
  } });
  const calls: FixtureModelToolCall[] = [];
  let failure: "malformed" | "disconnect" | "no_final" | "cleanup" | undefined;
  let noFinal = false, failCleanup = false;
  const injectedFailures: string[] = [];
  let final = JSON.stringify({ message: "收到", results: [] });
  const wire: AppServerMessage[] = [];
  const received: AppServerMessage[] = [];
  let retry: { after: number; terminal: "completed" | "failed" | "interrupted" | "disconnect" } | undefined;
  let resumeProtocol: (() => void) | undefined;
  let protocolListener: (message: AppServerMessage) => void = () => {};
  let protocolExit: (error?: Error) => void = () => {};
  const filesAtResponse: string[][] = [];
  const runsAtResponse: number[] = [];
  const model = new CodexConversation(() => {
    const transport = new FixtureAppServerTransport({ takeFixtureModelToolCall: () => calls.shift() }, () => {
      const current = failure;
      failure = undefined;
      if (current) injectedFailures.push(current);
      noFinal = current === "no_final";
      failCleanup = current === "cleanup";
      if (current === "disconnect") return new Error("fixture_model_disconnected");
      return current === "malformed" ? "PRIVATE_MALFORMED_FINAL" : final;
    });
    return {
      send(message) {
        wire.push(structuredClone(message));
        if (message.id !== undefined && !message.method) {
          filesAtResponse.push(fs.readdirSync(vault).sort());
          runsAtResponse.push(runIds.length);
          if (retry && filesAtResponse.length === retry.after) {
            const request = received.find((entry) => entry.id === message.id && entry.method === "item/tool/call")!;
            protocolListener({ method: "error", params: { threadId: request.params!.threadId, turnId: request.params!.turnId,
              willRetry: true, error: { message: "temporary model error" } } });
            resumeProtocol = () => { resumeProtocol = undefined; transport.send(message); };
            return;
          }
        }
        transport.send(message);
      },
      onMessage: (listener) => { protocolListener = listener; return transport.onMessage((message) => {
        const item = message.params?.item;
        if (noFinal && ((item && typeof item === "object" && "type" in item && item.type === "agentMessage") || message.method === "item/agentMessage/delta")) return;
        if (message.method === "turn/completed" && retry) {
          if (retry.terminal === "disconnect") { protocolExit(new Error("fixture_model_disconnected")); return; }
          message = { ...message, params: { ...message.params, turn: { ...(message.params!.turn as object), status: retry.terminal } } };
        }
        received.push(structuredClone(message)); listener(message);
      }); },
      onExit: (listener) => { protocolExit = listener; return transport.onExit(listener); },
      close: () => transport.close(),
    };
  }, 600_000, host, {
    request: async () => ({}),
    complete: () => { if (failCleanup) fs.readFileSync(path.join(root, "missing-permission-finalizer")); },
  });
  const reply = vi.fn<CodexAgent["runTurn"]>((...args) => model.runTurn(...args));
  const agent: CodexAgent = { startOrResume: (...args) => model.startOrResume(...args), runTurn: reply, close: () => model.close() };
  const inbox = new DurableInboundStore(path.join(root, "inbound.sqlite"));
  const port = new FixturePort(inbox);
  const texts: string[] = [], keys: string[] = [];
  const stateFile = path.join(root, "codex-service.json");
  let failSave = false;
  let textReply: { result: SendTextResult; gate?: Promise<void>; started: () => void } | undefined;
  const channel: Pick<WeixinChannel, "getSnapshot" | "onInboundText"> = {
    getSnapshot: () => port.getSnapshot(),
    onInboundText: (listener) => port.onInboundText((event) => {
      keys.push(event.key);
      return listener({ ...event, replyText: async (text) => {
        texts.push(text);
        const configured = texts.length === 2 ? textReply : undefined;
        configured?.started();
        await configured?.gate;
        const result = configured?.result ?? await event.replyText(text);
        if (failSave && texts.length === 2) {
          fs.renameSync(stateFile, `${stateFile}.backup`);
          fs.mkdirSync(stateFile);
        }
        return result;
      } });
    }),
  };
  const store = new CodexServiceStore(stateFile);
  const codex = new WeixinCodexService(channel, agent, store, root, Date.now, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined,
    new WorkflowToolProductionControl(host, files, undefined, localFiles), diagnostics);
  const demo = new DemoService(port, async () => "data:image/svg+xml,fixture", codex);
  const server = createDemoServer(demo, { fixtureMode: true });
  const close = async () => {
    if (fs.existsSync(`${stateFile}.backup`)) { fs.rmdirSync(stateFile); fs.renameSync(`${stateFile}.backup`, stateFile); }
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await demo.close();
    if (!engineClosed) { await engine.close(); engineClosed = true; }
    await localFiles.close();
    permissions.close(); targets.close(); presentations.close(); inbox.close();
    await diagnostics.close();
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    await engine.start();
    await port.start();
    await codex.start();
    await codex.enable("fixture-bot", "fixture-user@im.wechat");
    port.activateInboundDispatch();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  } catch (error) { await close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address unavailable");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    note, root, store, inbox, keys, texts, calls, reply, runIds, sentFiles, engine, diagnostics, codex, injectedFailures, wire, received, filesAtResponse, runsAtResponse, presentations,
    waitForFileSend: (inbound: Promise<void>) => Promise.race([fileSubmission,
      inbound.then(() => { throw new Error("inbound completed before file submission"); })]),
    closeDemo: () => demo.close(),
    pauseForRetry: (after: number, terminal: NonNullable<typeof retry>["terminal"]) => { retry = { after, terminal }; },
    retryPaused: () => resumeProtocol !== undefined,
    continueProtocol: () => resumeProtocol?.(),
    owner: () => {
      const params = received.filter((message) => message.method === "item/tool/call").at(-1)!.params!;
      return host.turnOwner({ threadId: String(params.threadId), turnId: String(params.turnId), namespace: null });
    },
    subscribeCommand: () => port.onInboundCommand(async () => false),
    failNext: (value: typeof failure) => { failure = value; },
    setFinal: (value: string) => { final = value; },
    restartConnection: async () => {
      const thread = store.load().targetSessions[0]!.threadId;
      await model.close();
      await model.startOrResume(thread, root);
    },
    failFinalSave: () => { failSave = true; },
    failProjection: () => { failProjection = true; },
    failTrace: () => { failTrace = true; },
    setTextReply: (result: SendTextResult, gate: Promise<void>) => new Promise<void>((started) => {
      textReply = { result, gate, started };
    }),
    send: async (text: string) => {
      const response = await fetch(`${origin}/api/fixture/inbound`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(30_000),
      });
      expect(response.status).toBe(200);
    },
    reloadEngine: async () => {
      await engine.close();
      engineClosed = true;
      const reloaded = createEngine();
      try { await reloaded.start(); }
      catch (error) { await reloaded.close(); throw error; }
      return reloaded;
    },
    close,
  };
}
