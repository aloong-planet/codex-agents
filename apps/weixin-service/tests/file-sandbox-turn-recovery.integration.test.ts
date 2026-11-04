import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { LocalFileTools } from "../src/local-file-tools.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { WorkflowToolHost } from "../src/workflow-tool-host.js";

// Observe the OS process boundary only. Still spawn the actual permission-limited worker;
// no private sandbox/session access and no mock of the production file/tool classes.
const spawned = vi.hoisted((): ChildProcess[] => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawned.push(child);
    return child;
  } };
});

it("allows the main tool loop to query again after a sandbox timeout in the same trusted turn", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "weixin-turn-sandbox-recovery-")));
  const directory = path.join(root, "files");
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "probe.txt"), "recovery probe\n");
  const files = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
    scopes: [{ scopeId: "files", label: "Files", directory, read: true, write: false }],
  }) }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
  const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
    { submit: async () => { throw new Error("unexpected terminal workflow"); } }, files);
  const trusted = { eventKey: "inbound", accountId: "fixture", target: "fixture-user", occurredAt: Date.now(),
    originalTextRef: "synthetic", attachmentRefs: [] };
  const local = files.bindTurn(trusted);
  const binding = host.bind("thread", trusted);
  const context = { threadId: "thread", turnId: "turn", namespace: "files" };
  const argumentsValue = { query: "probe", kind: "file", match: "literal", limit: 1 };
  try {
    expect((await host.execute("find", argumentsValue, context)).success).toBe(true);
    const child = spawned.at(-1);
    expect(child?.pid).toBeGreaterThan(0);
    if (!child) throw new Error("expected a real worker process");
    expect(child.kill("SIGSTOP")).toBe(true);
    const failed = await host.execute("find", argumentsValue, context);
    expect(failed.success).toBe(true);
    expect(failed.contentItems).toEqual([{ type: "inputText",
      text: '{"ok":false,"error":{"code":"local_file_search_timeout","retryable":false,"action":"change_request"}}' }]);
    const recovered = await host.execute("find", argumentsValue, context);
    expect(recovered.success).toBe(true);
    expect(recovered.contentItems).toEqual([expect.objectContaining({ text: expect.stringContaining('"fileName":"probe.txt"') })]);
    expect(binding.snapshot().owner).toBe("model");
  } finally {
    binding.release();
    await local.release();
    await files.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
