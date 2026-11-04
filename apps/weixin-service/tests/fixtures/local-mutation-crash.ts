import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { LocalFileTools } from "../../src/local-file-tools.js";

// Exercise the real journal and sandbox through the public tool boundary. No model or channel.
const root = process.argv[2]!;
const kind = process.argv[3]!;
const phase = process.argv[4]!;
if (!path.isAbsolute(root) || !path.basename(root).startsWith("codex-weixin-mutation-recovery-") ||
    !["create", "overwrite", "edit"].includes(kind) ||
    !["crash", "resume", "prepared-crash", "prepared-rejected", "prepared-target-change", "retry-prepared", "file-sync-failure", "directory-sync-failure", "before-file-sync-crash", "before-directory-sync-crash"].includes(phase)) {
  throw new Error("invalid_mutation_fixture_arguments");
}
// Inject only the OS fsync boundary in this isolated process; SQLite and worker IO remain real.
const sync = fs.fsyncSync;
let failedDescriptor: number | undefined;
const syncTarget = phase === "file-sync-failure" || phase === "before-file-sync-crash" ? "file"
  : phase === "directory-sync-failure" || phase === "before-directory-sync-crash" ? "directory" : undefined;
if (syncTarget) {
  fs.fsyncSync = (fd) => {
    const info = fs.fstatSync(fd);
    if (syncTarget === "file" ? info.isFile() : info.isDirectory()) {
      fs.writeSync(2, `SYNC_CHECKPOINT:${syncTarget}\n`);
      if (phase.startsWith("before-")) process.kill(process.pid, "SIGKILL");
      failedDescriptor = fd;
      throw Object.assign(new Error("EIO: fsync failed at /private/sensitive-test-path"), { code: "EIO" });
    }
    sync(fd);
  };
}
const tools = new LocalFileTools({ get: () => ({
  moduleId: "notes", revision: 1, saved: true,
  scopes: [{ scopeId: "vault", label: "Recovery fixture", directory: path.join(root, "files"), read: true, write: true }],
}) }, {
  moduleIds: ["notes"], spoolDirectory: path.join(root, "spool"), operationDatabasePath: path.join(root, "operations.sqlite"),
  afterMutationPrepared: () => {
    if (phase === "prepared-rejected") throw new Error("fixture_preparation_rejected");
    if (phase === "prepared-target-change") fs.writeFileSync(path.join(root, "files", "item.txt"), "user changed during preparation");
    if (phase === "prepared-crash") {
      fs.writeSync(2, "PREPARED_CHECKPOINT\n");
      process.kill(process.pid, "SIGKILL");
    }
  },
  afterMutationDurable: () => {
    if (phase === "prepared-crash" || phase === "retry-prepared") return;
    if (phase === "crash") process.kill(process.pid, "SIGKILL");
    throw new Error("unexpected_repeated_mutation");
  },
});
const trusted = { eventKey: "interrupted-mutation", accountId: "fixture-account", target: "fixture@im.wechat",
  occurredAt: 1_788_200_000_000, originalTextRef: "filequery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", attachmentRefs: [] };
const binding = tools.bindTurn(trusted);
try {
  const content = "a".repeat(100_001);
  const beforeSha256 = crypto.createHash("sha256").update("before").digest("hex");
  let result: unknown;
  if (kind === "edit") {
    const found = await tools.execute({ toolId: "files.find", toolVersion: 2,
      arguments: { query: "item.txt", match: "literal", include: ["item.txt"] } }, trusted) as { entries: Array<{ fileRef: string }> };
    if (found.entries.length !== 1) throw new Error("fixture_file_missing");
    result = await tools.execute({ toolId: "files.edit", toolVersion: 1, arguments: {
      fileRef: found.entries[0]!.fileRef, expectedSha256: beforeSha256, oldText: "before", newText: content,
    } }, trusted);
  } else {
    result = await tools.execute({ toolId: "files.write", toolVersion: 1, arguments: {
      scopeRef: binding.promptLines[0]!.split(":", 1)[0]!, relativePath: "item.txt", content,
      overwrite: kind === "overwrite", ...(kind === "overwrite" ? { expectedSha256: beforeSha256 } : {}),
    } }, trusted);
  }
  process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
} catch (error) {
  let failedDescriptorClosed: boolean | undefined;
  if (failedDescriptor !== undefined) {
    try { fs.fstatSync(failedDescriptor); failedDescriptorClosed = false; }
    catch (descriptorError) { failedDescriptorClosed = (descriptorError as NodeJS.ErrnoException).code === "EBADF"; }
  }
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "fixture_failure",
    ...(failedDescriptorClosed !== undefined ? { failedDescriptorClosed } : {}),
  }) + "\n");
} finally {
  fs.fsyncSync = sync;
  await binding.release();
  await tools.close();
}
