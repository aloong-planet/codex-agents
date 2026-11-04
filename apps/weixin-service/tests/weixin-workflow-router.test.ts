import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { InboundTextEvent } from "../src/demo-service.js";
import { DirectMarkdownVault } from "../src/direct-markdown-vault.js";
import { WorkflowEngine } from "../src/workflow-engine.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { WorkflowNoteArtifactStore } from "../src/workflow-note-artifact-store.js";
import { WorkflowNotesProvider } from "../src/workflow-notes-provider.js";
import { WEIXIN_NOTE_SEARCH_WORKFLOW, WEIXIN_NOTE_SEND_FILE_WORKFLOW, WeixinWorkflowRouter } from "../src/weixin-workflow-router.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

async function harness(grantRead = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-workflow-router-"));
  dirs.push(root);
  const vaultRoot = path.join(root, "vault");
  fs.mkdirSync(path.join(vaultRoot, ".obsidian"), { recursive: true });
  const vault = new DirectMarkdownVault(vaultRoot);
  await vault.create("Projects/demo.md", "private project body");
  const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
  const draft = permissions.createDraft({
    moduleId: "notes",
    scopes: [{ scopeId: "vault", label: "demo Vault", directory: vaultRoot }],
  });
  if (grantRead) {
    permissions.save({ moduleId: "notes", expectedRevision: draft.revision, confirmed: true, scopes: draft.scopes });
  }
  const artifacts = new WorkflowNoteArtifactStore(path.join(root, "artifacts"));
  const files = new WorkflowFileArtifactStore(path.join(root, "files"), permissions);
  const provider = new WorkflowNotesProvider(vault, vaultRoot, artifacts, permissions, files);
  const engine = new WorkflowEngine(path.join(root, "workflows.sqlite"), {
    templates: [WEIXIN_NOTE_SEARCH_WORKFLOW, WEIXIN_NOTE_SEND_FILE_WORKFLOW],
    providers: [provider, {
      catalog: () => [{ id: "weixin.send_file", version: 1, effect: "external_send", retryClass: "non_idempotent", inputSchema: { type: "object", required: ["fileHandle"], properties: { fileHandle: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["accepted"], properties: { accepted: { type: "boolean" } }, additionalProperties: false } }],
      invoke: async () => ({ status: "succeeded", output: { accepted: true } }),
    }],
    modulePermissions: permissions,
  });
  await engine.start();
  return { engine, router: new WeixinWorkflowRouter(engine, artifacts), artifacts, vault };
}

function event(text: string): InboundTextEvent {
  return {
    key: "a".repeat(64),
    accountId: "bot@im.bot",
    target: "owner@im.wechat",
    messageId: "message-1",
    source: "text",
    text,
    receivedAt: 1_800_000_000_000,
    replyText: async () => ({ ok: true, messageId: "sent" }),
  };
}

describe("WeixinWorkflowRouter", () => {
  it("leaves ordinary chat that merely mentions notes on the Codex path", async () => {
    const { engine, router } = await harness();

    await expect(router.tryHandle(event("我喜欢在笔记里记录项目进展"))).resolves.toEqual({ handled: false });
    expect(engine.getPublicState().runs).toHaveLength(0);
    await engine.close();
  });

  it("asks for the missing query instead of falling back to Codex", async () => {
    const { engine, router } = await harness();

    await expect(router.tryHandle(event("搜索笔记"))).resolves.toEqual({
      handled: true,
      outcome: "needs_input",
      reply: "请告诉我需要搜索的关键词。",
    });
    expect(engine.getPublicState().runs).toHaveLength(0);
    await engine.close();
  });

  it("runs an explicit note search through the reviewed workflow and renders safe matches", async () => {
    const { engine, router } = await harness();

    const result = await router.tryHandle(event("搜索笔记 project"));
    expect(result).toMatchObject({ handled: true, outcome: "needs_input" });
    if (!result.handled) throw new Error("workflow router unexpectedly bypassed");
    expect(result.reply).toMatch(/^找到 1 篇笔记：\n1\. demo\.md\n\n回复“发送笔记 [a-f0-9]{6} 序号”/u);
    expect(engine.getPublicState().runs[0]).toMatchObject({
      source: "weixin",
      workflowId: "notes.search-from-weixin",
      status: "succeeded",
    });
    const serialized = JSON.stringify(engine.getPublicState());
    expect(serialized).not.toContain("project");
    expect(serialized).not.toContain("owner@im.wechat");
    await engine.close();
  });

  it("sends the selected Markdown file without reading its body into the workflow result", async () => {
    const { engine, router } = await harness();
    const search = await router.tryHandle(event("搜索笔记 project"));
    if (!search.handled) throw new Error("workflow router unexpectedly bypassed");
    const reference = /发送笔记 ([a-f0-9]{6}) 1/u.exec(search.reply)?.[1];

    const result = await router.tryHandle({ ...event(`发送笔记 ${reference} 1`), key: "b".repeat(64), messageId: "message-2" });

    expect(result).toEqual({ handled: true, outcome: "succeeded", reply: "文件已发送，请查收。" });
    expect(JSON.stringify(engine.getPublicState())).not.toContain("private project body");
    expect(engine.getPublicState().runs[0]).toMatchObject({ workflowId: "notes.send-file-from-weixin", status: "succeeded" });
    await engine.close();
  });

  it("deduplicates the same inbound event and reuses its durable rendered result", async () => {
    const { engine, router } = await harness();
    const inbound = event("搜索笔记 project");

    const first = await router.tryHandle(inbound);
    const duplicate = await router.tryHandle(inbound);

    expect(duplicate).toEqual(first);
    expect(engine.getPublicState().runs).toHaveLength(1);
    await engine.close();
  });

  it("returns an understandable empty result without falling back to Codex", async () => {
    const { engine, router } = await harness();

    await expect(router.tryHandle(event("在笔记中搜索 nonexistent"))).resolves.toEqual({
      handled: true,
      outcome: "succeeded",
      reply: "没有找到匹配的文件。",
    });
    await engine.close();
  });

  it("keeps ownership and returns a fixed settings hint when note read permission is absent", async () => {
    const { engine, router } = await harness(false);

    const result = await router.tryHandle(event("搜索笔记 project"));

    expect(result).toEqual({
      handled: true,
      outcome: "failed",
      reply: "没有读取这个文件的权限，请在“本地权限”中启用后重试。",
    });
    expect(JSON.stringify(result)).not.toContain("workflow-note");
    expect(engine.getPublicState().runs[0]).toMatchObject({ status: "blocked" });
    await engine.close();
  });

  it("truncates unusual note names without splitting a Unicode code point", async () => {
    const { engine, router, vault } = await harness();
    const longName = `${"😀".repeat(59)}a😀-unicode-marker.md`;
    await vault.create(longName, "body");

    const result = await router.tryHandle(event("搜索笔记 unicode-marker"));
    expect(result.handled).toBe(true);
    if (!result.handled) throw new Error("workflow router unexpectedly bypassed");
    expect(Array.from(result.reply).some((character) => {
      const code = character.charCodeAt(0);
      return character.length === 1 && code >= 0xd800 && code <= 0xdfff;
    })).toBe(false);
    await engine.close();
  });
});
