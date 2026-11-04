import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalFileTools } from "../src/local-file-tools.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";
import { WorkflowFileArtifactStore } from "../src/workflow-file-artifact-store.js";
import { WorkflowToolProductionControl } from "../src/workflow-tool-production.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { describe, expect, it } from "vitest";
import { CodexConversation } from "../src/codex-conversation.js";
import { FixtureAppServerTransport } from "../src/fixture-app-server-transport.js";
import { WorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { WorkflowToolHost } from "../src/workflow-tool-host.js";

// Public protocol/tool boundaries; real host bindings with a deterministic resource
// executor. Phone delivery and real-model semantics are separate acceptance checks.
const trusted = { eventKey: "same-inbound", accountId: "account", target: "target", occurredAt: 1,
  originalTextRef: "text", attachmentRefs: [] };
function hostFixture(fail = false) {
  let effects = 0;
  const host = new WorkflowToolHost(new WorkflowToolCatalog([{
    id: "files.edit", version: 1, description: "Edit the test resource.", executionClass: "inline_mutation",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  }]), { submit: async () => { throw new Error("unexpected terminal"); } }, {
    execute: async () => { effects++; if (fail) throw new Error("effect outcome unknown"); return { changed: "first" }; },
  });
  return { host, effects: () => effects };
}

describe("request resources across model recovery", () => {
  it("recovers a disconnect during input preparation before a protocol turn exists", async () => {
    const resource = hostFixture(); let disconnect: () => void = () => {}; let submitted = 0;
    const agent = new CodexConversation(() => {
      const peer = new FixtureAppServerTransport({ takeFixtureModelToolCall: () => undefined }, () => "prepared request recovered", () => { submitted++; });
      return { send: peer.send.bind(peer), onMessage: peer.onMessage.bind(peer), close: peer.close.bind(peer),
        onExit: (listener) => { disconnect = () => { peer.close(); listener(new Error("connection lost during prepare")); }; return peer.onExit(listener); } };
    }, 600_000, resource.host, undefined, 300_000, { automaticRecovery: true });
    try {
      const threadId = await agent.startOrResume(undefined, "/tmp");
      const result = await agent.runTurn(threadId, { prepare: async () => {
        const binding = resource.host.bind(threadId, trusted); disconnect();
        return { input: [{ type: "text", text: "first request" }], binding };
      } });
      expect(result).toEqual({ owner: "model_owned", finalText: "prepared request recovered" });
      expect(submitted).toBe(1);
      await resource.host.bind(threadId, { ...trusted, eventKey: "next" }).release();
    } finally { await agent.close(); }
  });
  it("reuses a completed mutation after its response connection is lost", async () => {
    const resource = hostFixture();
    let connections = 0;
    const agent = new CodexConversation(() => {
      const attempt = ++connections;
      let queued = true;
      const peer = new FixtureAppServerTransport({ takeFixtureModelToolCall: () => {
        if (!queued) return undefined; queued = false;
        return { namespace: "files", tool: "edit", arguments: { value: "first" } };
      } }, results => JSON.stringify(results), undefined, `recovery-${attempt}`);
      let exit: (error?: Error) => void = () => {};
      return {
        send: (message) => {
          if (attempt === 1 && !message.method) { peer.close(); exit(new Error("lost before tool response delivery")); }
          else peer.send(message);
        },
        onMessage: (listener) => peer.onMessage(listener),
        onExit: (listener) => { exit = listener; return peer.onExit(listener); },
        close: () => peer.close(),
      };
    }, 600_000, resource.host, undefined, 300_000, { automaticRecovery: true });
    try {
      const threadId = await agent.startOrResume(undefined, "/tmp");
      const result = await agent.runTurn(threadId, { prepare: async () => ({
        input: [{ type: "text", text: "edit once" }], binding: resource.host.bind(threadId, trusted),
      }) });
      expect(result).toEqual({ owner: "model_owned", finalText: '[{"changed":"first"}]' });
      expect(resource.effects()).toBe(1);
      expect(connections).toBe(2);
      await resource.host.bind(threadId, { ...trusted, eventKey: "next" }).release();
    } finally { await agent.close(); }
  });
  it("keeps real file references and the accumulated sixty-second budget through recovery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-budget-"));
    const vault = path.join(root, "vault"); fs.mkdirSync(vault); fs.writeFileSync(path.join(vault, "sample.txt"), "sample");
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    permissions.save({ moduleId: "files", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "root", label: "Files", directory: vault, read: true, write: false }] });
    let clock = 0, reads = 0, fileRef = "", connections = 0;
    const local = new LocalFileTools(permissions, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), now: () => clock });
    const artifacts = new WorkflowFileArtifactStore(path.join(root, "artifacts"), permissions);
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      { submit: async () => { throw new Error("no terminal expected"); } }, {
        execute: async (request, context) => {
          const pending = local.execute(request, context);
          if (request.toolId === "files.read") clock += ++reads === 1 ? 40_000 : 20_000;
          const result = await pending;
          if (request.toolId === "files.find") fileRef = (result as { entries: Array<{ fileRef: string }> }).entries[0]!.fileRef;
          return result;
        },
      });
    const control = new WorkflowToolProductionControl(host, artifacts, undefined, local);
    const agent = new CodexConversation(() => {
      const attempt = ++connections;
      const calls = attempt === 1
        ? [{ namespace: "files", tool: "find", arguments: { query: "sample" } },
          { namespace: "files", tool: "read", arguments: { fileRef: { $fixtureToolResult: { call: 0, path: ["entries", 0, "fileRef"] } } } }]
        : [{ namespace: "files", tool: "read", arguments: { fileRef } }, { namespace: "files", tool: "read", arguments: { fileRef } }];
      return new FixtureAppServerTransport({ takeFixtureModelToolCall: () => calls.shift() },
        results => attempt === 1 ? new Error("disconnect after read") : JSON.stringify(results), undefined, `budget-${attempt}`);
    }, 600_000, host, undefined, 300_000, { automaticRecovery: true });
    try {
      const threadId = await agent.startOrResume(undefined, root);
      const result = await agent.runTurn(threadId, { prepare: async () => ({ input: [{ type: "text", text: "read sample" }],
        binding: await control.bind(threadId, { key: "a".repeat(64), accountId: "account", target: "target", text: "read sample",
          messageId: "one", source: "text", receivedAt: 1 }) }) });
      expect(result.owner).toBe("model_owned");
      if (result.owner !== "model_owned") throw new Error("expected model reply");
      const observations = JSON.parse(result.finalText);
      expect(observations).toHaveLength(2);
      expect(observations[0]).toMatchObject({ content: "sample" });
      expect(observations[1]).toMatchObject({ ok: false, error: { code: "local_file_turn_budget_exhausted" } });
      expect(connections).toBe(2);
      expect(artifacts.queryHandle("a".repeat(64))).toBeNull();
    } finally { await agent.close(); await local.close(); permissions.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("blocks changed mutation replay and uncertain effects (uncertain=%s)", async uncertain => {
    const resource = hostFixture(uncertain); const binding = resource.host.bind("thread", trusted);
    try {
      await resource.host.execute("edit", { value: "first" }, { threadId: "thread", turnId: "first", namespace: "files" });
      await binding.drain();
      if (uncertain) expect(() => binding.resume!()).toThrow("model_recovery_effect_unconfirmed");
      else {
        const evidence = binding.resume!(); expect(evidence).toHaveLength(1);
        const changed = await resource.host.execute("edit", { value: "different" }, { threadId: "thread", turnId: "second", namespace: "files" });
        expect(changed.contentItems[0]!.text).toContain("model_recovery_effect_unconfirmed");
      }
      expect(resource.effects()).toBe(1);
    } finally { await binding.release(); }
  });

  it.each([false, true])("retains a claimed terminal workflow receipt without submitting another workflow (release failure=%s)", async releaseFails => {
    let submissions = 0, connections = 0, modelTurns = 0;
    const host = new WorkflowToolHost(new WorkflowToolCatalog([{
      id: "weixin.send_files", version: 1, description: "Submit a test file.", executionClass: "terminal_workflow",
      effectClass: "external_send", templateId: "test-send", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }]), { submit: async () => { submissions++; return { disposition: "claimed", runRef: "run-one",
      receipt: { outcome: "accepted", reply: "已受理一次", runRef: "run-one" } }; } });
    const agent = new CodexConversation(() => {
      const index = ++connections; let queued = true;
      return new FixtureAppServerTransport({ takeFixtureModelToolCall: () => {
        if (!queued) return undefined; queued = false; return { namespace: "weixin", tool: "send_files", arguments: {} };
      } }, () => new Error("lost after workflow claim"), () => { modelTurns++; }, `owned-${index}`);
    }, 600_000, host, undefined, 300_000, { automaticRecovery: true });
    try {
      const threadId = await agent.startOrResume(undefined, "/tmp");
      await expect(agent.runTurn(threadId, { prepare: async () => {
        const binding = host.bind(threadId, trusted);
        return { input: [{ type: "text", text: "send once" }], binding: { ...binding,
          release: async () => { await binding.release(); if (releaseFails) throw new Error("resource release failed"); } } };
      } })).rejects.toMatchObject({ ownership: { owner: "workflow", runRef: "run-one", receipt: { reply: "已受理一次" } } });
      expect(submissions).toBe(1); expect(modelTurns).toBe(1);
    } finally { await agent.close(); }
  });

});
