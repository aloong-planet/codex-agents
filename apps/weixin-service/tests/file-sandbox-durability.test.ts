import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeFileSandbox } from "../src/file-sandbox.js";

// Uses the real worker unchanged after an OS FileHandle.sync fault prelude, not a fake worker response.
// EIO is synthetic; this is not a physical disk failure or power-loss test.
describe("file_sandbox_temporary_sync_failure", () => {
  for (const kind of ["create", "overwrite", "edit"] as const) {
    it(`${kind}: leaves the original target intact and removes its temporary file on sync failure`, async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-temp-sync-")));
      const directory = path.join(root, "files");
      const spool = path.join(root, "spool");
      fs.mkdirSync(directory);
      fs.mkdirSync(spool);
      const target = path.join(directory, "item.md");
      // Markdown shape observed in the real-model edit/readback acceptance, with harmless test content.
      if (kind !== "create") { fs.writeFileSync(target, "# Agent Beta Updated\n"); fs.chmodSync(target, 0o640); }
      const before = kind === "create" ? undefined : fs.statSync(target);
      const trace = path.join(spool, "fault.txt");
      const workerPath = path.join(root, "sync-fault-worker.mjs");
      const workerSource = fs.readFileSync(fileURLToPath(new URL("../src/file-sandbox-worker.mjs", import.meta.url)), "utf8");
      fs.writeFileSync(workerPath, `
import faultFs from "node:fs";
const originalOpen = faultFs.promises.open;
faultFs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
    const close = handle.close.bind(handle);
    handle.sync = async () => {
      faultFs.writeFileSync(${JSON.stringify(trace)}, "sync_failed");
      throw Object.assign(new Error("EIO: temporary file sync failed"), { code: "EIO" });
    };
    handle.close = async () => { await close(); faultFs.appendFileSync(${JSON.stringify(trace)}, ":closed"); };
  }
  return handle;
};
` + workerSource);
      const access = { accountId: "fixture", moduleId: "files", revision: 1,
        scopes: [{ scopeRef: "scope", scopeId: "files", label: "Files", directory, read: true, write: true }],
        spoolDirectory: spool };
      const sandbox = new NodeFileSandbox(access, workerPath);
      const recovered = new NodeFileSandbox(access);
      try {
        const current = kind === "create" ? undefined
          : await sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "item.md" });
        const operation = kind === "edit"
          ? { type: "edit" as const, scopeRef: "scope", relativePath: "item.md", expectedSha256: current!.sha256,
              oldText: "Updated", newText: "Recovered" }
          : { type: "write" as const, scopeRef: "scope", relativePath: "item.md", overwrite: kind === "overwrite",
              content: "# Agent Beta Recovered\n", ...(current ? { expectedSha256: current.sha256 } : {}) };
        const execute = (worker: NodeFileSandbox) => operation.type === "edit" ? worker.execute(operation) : worker.execute(operation);
        await expect(execute(sandbox)).rejects.toThrow("file_sandbox_operation_failed");
        expect(fs.readFileSync(trace, "utf8")).toBe("sync_failed:closed");
        expect(fs.readdirSync(directory)).toEqual(kind === "create" ? [] : ["item.md"]);
        if (before) {
          expect((await sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "item.md" })).content)
            .toBe("# Agent Beta Updated\n");
          expect(fs.statSync(target).ino).toBe(before.ino);
          expect(fs.statSync(target).mtimeMs).toBe(before.mtimeMs);
          expect(fs.statSync(target).mode & 0o777).toBe(0o640);
        }
        await execute(recovered);
        expect((await recovered.execute({ type: "read", scopeRef: "scope", relativePath: "item.md" })).content)
          .toBe("# Agent Beta Recovered\n");
        expect(fs.readdirSync(directory)).toEqual(["item.md"]);
      } finally {
        await sandbox.close();
        await recovered.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
