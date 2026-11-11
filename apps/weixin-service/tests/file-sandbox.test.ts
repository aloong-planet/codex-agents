import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSandbox } from "../src/file-sandbox.js";

const temporaryDirectories: string[] = [];

// Special-device coverage is read-only (/dev/null); writable/block devices and adversarial
// path replacement between filesystem calls require a disposable isolated OS environment.
// The real two-worker races below exercise observed interleavings, not every possible schedule.

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local_file_query_contract_regression", () => {
  it("continues a recursive query without rescanning and rejects changed or consumed cursors", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "continuation-")); temporaryDirectories.push(root);
    const directory = path.join(root, "files"); fs.mkdirSync(path.join(directory, "nested"), { recursive: true });
    fs.writeFileSync(path.join(directory, "old.txt"), "old");
    fs.writeFileSync(path.join(directory, "nested", "latest.txt"), "latest");
    fs.utimesSync(path.join(directory, "old.txt"), 100, 100);
    fs.utimesSync(path.join(directory, "nested", "latest.txt"), 200, 200);
    const sandbox = new NodeFileSandbox({ accountId: "a", moduleId: "files", revision: 1,
      scopes: [{ scopeRef: "scope", scopeId: "root", label: "Files", directory, read: true, write: false }],
      spoolDirectory: path.join(root, "spool") });
    const query = { type: "find" as const, kind: "file" as const, limit: 1, batchSize: 1,
      sort: { field: "modified_at" as const, direction: "desc" as const } };
    try {
      let result = await sandbox.execute(query);
      const firstCursor = result.scanCursor;
      expect(firstCursor).toEqual(expect.any(String));
      if (!firstCursor) throw new Error("missing continuation");
      expect(result.scanComplete).toBe(false);
      await expect(sandbox.execute({ ...query, query: "different", scanCursor: firstCursor })).rejects.toThrow("file_sandbox_cursor_invalid");
      let entries = result.scannedEntries, files = result.scannedFiles, batches = 1;
      while (result.scanCursor) {
        expect(batches++).toBeLessThan(6);
        result = await sandbox.execute({ ...query, scanCursor: result.scanCursor });
        entries += result.scannedEntries; files += result.scannedFiles;
      }
      expect(entries).toBe(3); expect(files).toBe(2);
      expect(result).toMatchObject({ scanComplete: true, entries: [{ relativePath: "nested/latest.txt" }], resultTruncated: true });
      await expect(sandbox.execute({ ...query, scanCursor: firstCursor })).rejects.toThrow("file_sandbox_cursor_invalid");
      const abandoned = await sandbox.execute(query);
      if (!abandoned.scanCursor) throw new Error("missing abandoned continuation");
      await sandbox.execute({ ...query, scanCursor: abandoned.scanCursor, cancelScan: true });
      await expect(sandbox.execute({ ...query, scanCursor: abandoned.scanCursor })).rejects.toThrow("file_sandbox_cursor_invalid");
    } finally { await sandbox.close(); }
  });

  it("rejects FIFO text operations inside the actual sandbox without opening the pipe", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-sandbox-fifo-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const target = path.join(directory, "pipe.txt");
    execFileSync("mkfifo", [target]);
    const original = fs.lstatSync(target);
    expect(original.isFIFO()).toBe(true);
    const sandbox = new NodeFileSandbox({ accountId: "a", moduleId: "files", revision: 1,
      scopes: [{ scopeRef: "scope", scopeId: "root", label: "Files", directory, read: true, write: true }],
      spoolDirectory: path.join(root, "spool") });
    try {
      await expect(sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "pipe.txt" }))
        .rejects.toThrow("file_sandbox_file_invalid");
      await expect(sandbox.execute({ type: "inspect", scopeRef: "scope", relativePath: "pipe.txt" }))
        .rejects.toThrow("file_sandbox_file_invalid");
      await expect(sandbox.execute({ type: "plan_edit", scopeRef: "scope", relativePath: "pipe.txt",
        expectedSha256: "0".repeat(64), oldText: "old", newText: "new" }))
        .rejects.toThrow("file_sandbox_file_invalid");
      await expect(sandbox.execute({ type: "edit", scopeRef: "scope", relativePath: "pipe.txt",
        expectedSha256: "0".repeat(64), oldText: "old", newText: "new" }))
        .rejects.toThrow("file_sandbox_file_invalid");
      await expect(sandbox.execute({ type: "write", scopeRef: "scope", relativePath: "pipe.txt",
        overwrite: true, expectedSha256: "0".repeat(64), content: "new" }))
        .rejects.toThrow("file_sandbox_file_invalid");
      expect(fs.lstatSync(target).isFIFO()).toBe(true);
      expect(fs.lstatSync(target).ino).toBe(original.ino);
      expect(fs.readdirSync(directory)).toEqual(["pipe.txt"]);
    } finally { await sandbox.close(); }
  });

  it("rejects the actual null character device as file content with read-only device access", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-device-probe-"));
    temporaryDirectories.push(root);
    expect(fs.lstatSync("/dev/null").isCharacterDevice()).toBe(true);
    const sandbox = new NodeFileSandbox({ accountId: "a", moduleId: "files", revision: 1,
      scopes: [{ scopeRef: "device", scopeId: "device", label: "Read-only device probe", directory: "/dev", read: true, write: false }],
      spoolDirectory: path.join(root, "spool") });
    try {
      await expect(sandbox.execute({ type: "read", scopeRef: "device", relativePath: "null" }))
        .rejects.toThrow("file_sandbox_file_invalid");
      await expect(sandbox.execute({ type: "inspect", scopeRef: "device", relativePath: "null" }))
        .rejects.toThrow("file_sandbox_file_invalid");
    } finally { await sandbox.close(); }
  });

  it("allows exactly one independent creator for the same absent file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-create-race-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const access = { accountId: "a", moduleId: "files", revision: 1,
      scopes: [{ scopeRef: "scope", scopeId: "root", label: "Files", directory, read: true, write: true }],
      spoolDirectory: path.join(root, "spool") };
    const sandboxes = [new NodeFileSandbox(access), new NodeFileSandbox(access)];
    try {
      await Promise.all(sandboxes.map((sandbox) => sandbox.execute({ type: "find", query: "item" })));
      const results = await Promise.allSettled(sandboxes.map((sandbox, index) => sandbox.execute({
        type: "write", scopeRef: "scope", relativePath: "item.txt", overwrite: false,
        content: index === 0 ? "writer-a" : "writer-b",
      })));
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toEqual([
        expect.objectContaining({ reason: new Error("file_sandbox_file_exists") }),
      ]);
      const winner = results.findIndex((result) => result.status === "fulfilled");
      expect(fs.readFileSync(path.join(directory, "item.txt"), "utf8")).toBe(winner === 0 ? "writer-a" : "writer-b");
      expect(fs.readdirSync(directory)).toEqual(["item.txt"]);
      const losingSandbox = sandboxes[winner === 0 ? 1 : 0]!;
      await expect(losingSandbox.execute({ type: "write", scopeRef: "scope", relativePath: "item.txt",
        overwrite: false, content: "late overwrite" })).rejects.toThrow("file_sandbox_file_exists");
      expect(fs.readFileSync(path.join(directory, "item.txt"), "utf8")).toBe(winner === 0 ? "writer-a" : "writer-b");
    } finally { await Promise.all(sandboxes.map((sandbox) => sandbox.close())); }
  });

  it("creates different files concurrently below the same new parent directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-parent-race-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const access = { accountId: "a", moduleId: "files", revision: 1,
      scopes: [{ scopeRef: "scope", scopeId: "root", label: "Files", directory, read: true, write: true }],
      spoolDirectory: path.join(root, "spool") };
    const sandboxes = [new NodeFileSandbox(access), new NodeFileSandbox(access)];
    try {
      await Promise.all(sandboxes.map((sandbox) => sandbox.execute({ type: "find", query: "item" })));
      for (let round = 0; round < 12; round += 1) {
        const parent = `new-${round}/nested`;
        const results = await Promise.allSettled(sandboxes.map((sandbox, index) => sandbox.execute({
          type: "write", scopeRef: "scope", relativePath: `${parent}/${index}.txt`,
          overwrite: false, content: index === 0 ? "first file" : "second file",
        })));
        const diagnostic = results.map((result) => result.status === "rejected" ? String(result.reason) : "created");
        expect(results.map((result) => result.status), JSON.stringify(diagnostic)).toEqual(["fulfilled", "fulfilled"]);
        expect(fs.readFileSync(path.join(directory, parent, "0.txt"), "utf8")).toBe("first file");
        expect(fs.readFileSync(path.join(directory, parent, "1.txt"), "utf8")).toBe("second file");
        expect(fs.readdirSync(path.join(directory, parent)).sort()).toEqual(["0.txt", "1.txt"]);
      }
    } finally { await Promise.all(sandboxes.map((sandbox) => sandbox.close())); }
  });

  it("separates regex and smart-case matching from decode, size and grep-byte limits", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-grep-boundaries-"));
    temporaryDirectories.push(parent);
    const directory = path.join(parent, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "a.txt"), "Needle 12\nneedle 34\nNeedle xx");
    fs.writeFileSync(path.join(directory, "invalid.txt"), Buffer.from([0xff, 0xfe, 0xff]));
    fs.writeFileSync(path.join(directory, "large.txt"), "x".repeat(5 * 1024 * 1024));
    const sandbox = new NodeFileSandbox({ accountId: "a", moduleId: "files", revision: 1,
      scopes: [{ scopeRef: "scope", scopeId: "root", label: "Files", directory, read: true, write: false }],
      spoolDirectory: path.join(parent, "spool") });
    try {
      const insensitive = await sandbox.execute({ type: "grep", pattern: "^needle \\d+$", mode: "regex", case: "smart" });
      expect(insensitive.matches.map((hit) => hit.line)).toEqual([1, 2]);
      expect(insensitive.skipped).toEqual([
        { scopeRef: "scope", relativePath: "invalid.txt", reason: "decode_failed" },
        { scopeRef: "scope", relativePath: "large.txt", reason: "too_large" },
      ]);
      const sensitive = await sandbox.execute({ type: "grep", pattern: "^Needle \\d+$", mode: "regex", case: "smart" });
      expect(sensitive.matches.map((hit) => hit.line)).toEqual([1]);
      await expect(sandbox.execute({ type: "grep", pattern: "[", mode: "regex" })).rejects.toThrow("file_sandbox_regex_invalid");
      await expect(sandbox.execute({ type: "grep", pattern: "needle", budget: {
        maxScannedEntries: 10, maxScannedFiles: 10, maxScannedBytes: 10_000_000, maxGrepBytes: 2,
      } })).resolves.toMatchObject({ scanComplete: false, matches: [], grepBytes: 0 });
      await expect(sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "invalid.txt" }))
        .rejects.toThrow("file_sandbox_content_unsupported");
      await expect(sandbox.execute({ type: "read", scopeRef: "scope", relativePath: "large.txt" }))
        .rejects.toThrow("file_sandbox_file_too_large");
    } finally { await sandbox.close(); }
  });

  it("rejects oversized grep responses without killing the sandbox so the query can be narrowed", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-grep-frame-"));
    temporaryDirectories.push(parent);
    const directory = path.join(parent, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "large-context.txt"), ("needle " + "汉".repeat(493) + "\n").repeat(300));
    const sandbox = new NodeFileSandbox({ accountId: "a", moduleId: "files", revision: 1,
      scopes: [{ scopeRef: "scope", scopeId: "root", label: "Files", directory, read: true, write: false }],
      spoolDirectory: path.join(parent, "spool") });
    try {
      await expect(sandbox.execute({ type: "grep", pattern: "needle", limit: 100, contextLines: 10 }))
        .rejects.toThrow("file_sandbox_result_too_large");
      await expect(sandbox.execute({ type: "grep", pattern: "needle", limit: 1, contextLines: 0 }))
        .resolves.toMatchObject({ scanComplete: true, resultTruncated: true, matches: [{ line: 1 }] });
    } finally { await sandbox.close(); }
  });

  it("matches recursive basename filters and zero-directory globstars for find and grep", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-glob-regression-"));
    temporaryDirectories.push(parent);
    const authorized = path.join(parent, "authorized");
    const spool = path.join(parent, "spool");
    fs.mkdirSync(path.join(authorized, "notes", "nested"), { recursive: true });
    fs.mkdirSync(spool);
    for (const name of ["Agent Root.md", "notes/Agent Alpha.md", "notes/nested/Agent Beta.md", "notes/Secret.md", "notes/Agent.txt"]) {
      fs.writeFileSync(path.join(authorized, name), "Needle\n");
    }
    const sandbox = new NodeFileSandbox({
      accountId: "account-1", moduleId: "notes", revision: 1,
      scopes: [{ scopeRef: "scope-notes", scopeId: "vault", label: "Notes", directory: authorized, read: true, write: false }],
      spoolDirectory: spool,
    });
    try {
      const cases = [
        { include: ["*.md"], exclude: ["Secret*"], paths: ["Agent Root.md", "notes/Agent Alpha.md", "notes/nested/Agent Beta.md"] },
        { include: ["**/*.md"], exclude: ["**/Secret*"], paths: ["Agent Root.md", "notes/Agent Alpha.md", "notes/nested/Agent Beta.md"] },
        { include: ["notes/*.md"], exclude: ["Secret*"], paths: ["notes/Agent Alpha.md"] },
        { include: ["notes/**/*.md"], exclude: ["Secret*"], paths: ["notes/Agent Alpha.md", "notes/nested/Agent Beta.md"] },
        { include: ["*.md"], exclude: ["notes/**"], paths: ["Agent Root.md"] },
      ];
      for (const sample of cases) {
        const found = await sandbox.execute({ type: "find", kind: "file", include: sample.include, exclude: sample.exclude });
        expect(found.entries.map((entry) => entry.relativePath).sort(), JSON.stringify(sample)).toEqual(sample.paths);
        const grepped = await sandbox.execute({ type: "grep", pattern: "Needle", mode: "literal", include: sample.include, exclude: sample.exclude });
        expect(grepped.matches.map((entry) => entry.relativePath).sort(), JSON.stringify(sample)).toEqual(sample.paths);
      }
    } finally {
      await sandbox.close();
    }
  });

  it("finds name and path matches only inside its immutable readable scopes", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-file-sandbox-"));
    temporaryDirectories.push(parent);
    const authorized = path.join(parent, "authorized");
    const outside = path.join(parent, "outside");
    const spool = path.join(parent, "spool");
    fs.mkdirSync(path.join(authorized, "notes"), { recursive: true });
    fs.mkdirSync(outside);
    fs.mkdirSync(spool);
    fs.writeFileSync(path.join(authorized, "notes", "Quarterly Report.md"), "inside");
    fs.writeFileSync(path.join(outside, "Quarterly Report.md"), "outside");

    const sandbox = new NodeFileSandbox({
      accountId: "account-1",
      moduleId: "notes",
      revision: 3,
      scopes: [{
        scopeRef: "scope-notes",
        scopeId: "vault",
        label: "Notes",
        directory: authorized,
        read: true,
        write: false,
      }],
      spoolDirectory: spool,
    });
    try {
      const result = await sandbox.execute({
        type: "find",
        query: "quarterly report",
        match: "literal",
        case: "insensitive",
        kind: "file",
        sort: { field: "path", direction: "asc" },
        limit: 10,
      });

      expect(result).toEqual({
        entries: [{
          scopeRef: "scope-notes",
          fileName: "Quarterly Report.md",
          relativePath: "notes/Quarterly Report.md",
          kind: "file",
          sizeBytes: 6,
          modifiedAt: expect.any(Number),
          relevanceScore: 450,
        }],
        scanComplete: true,
        resultTruncated: false,
        scannedEntries: 2,
        scannedFiles: 1,
        scannedBytes: 6,
      });
      expect(JSON.stringify(result)).not.toContain(parent);
    } finally {
      await sandbox.close();
    }
  });

  it("normalizes Unicode and applies smart case to queries and globs", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-file-sandbox-"));
    temporaryDirectories.push(parent);
    const authorized = path.join(parent, "authorized");
    const spool = path.join(parent, "spool");
    fs.mkdirSync(path.join(authorized, "资料"), { recursive: true });
    fs.mkdirSync(spool);
    fs.writeFileSync(path.join(authorized, "资料", "Ｒｅｐｏｒｔ.TXT"), "inside");

    const sandbox = new NodeFileSandbox({
      accountId: "account-1",
      moduleId: "notes",
      revision: 3,
      scopes: [{
        scopeRef: "scope-notes",
        scopeId: "vault",
        label: "Notes",
        directory: authorized,
        read: true,
        write: false,
      }],
      spoolDirectory: spool,
    });
    try {
      const insensitive = await sandbox.execute({
        type: "find",
        query: "report",
        case: "smart",
        include: ["**/*.txt"],
        kind: "file",
      });
      expect(insensitive.entries.map((entry) => entry.fileName)).toEqual(["Ｒｅｐｏｒｔ.TXT"]);

      const sensitive = await sandbox.execute({
        type: "find",
        query: "REPORT",
        case: "smart",
        include: ["**/*.txt"],
        kind: "file",
      });
      expect(sensitive.entries).toEqual([]);
    } finally {
      await sandbox.close();
    }
  });

  it("ranks partial fuzzy term coverage instead of requiring every query word", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-file-sandbox-"));
    temporaryDirectories.push(parent);
    const authorized = path.join(parent, "authorized");
    const spool = path.join(parent, "spool");
    fs.mkdirSync(authorized);
    fs.mkdirSync(spool);
    fs.writeFileSync(path.join(authorized, "Agent Alpha.md"), "alpha");
    fs.writeFileSync(path.join(authorized, "Agent Beta.md"), "beta");
    fs.writeFileSync(path.join(authorized, "Meeting Notes.md"), "meeting");

    const sandbox = new NodeFileSandbox({
      accountId: "account-1",
      moduleId: "notes",
      revision: 3,
      scopes: [{
        scopeRef: "scope-notes",
        scopeId: "vault",
        label: "Notes",
        directory: authorized,
        read: true,
        write: false,
      }],
      spoolDirectory: spool,
    });
    try {
      const result = await sandbox.execute({
        type: "find",
        query: "agent 笔记",
        match: "fuzzy",
        case: "insensitive",
        kind: "file",
        sort: { field: "relevance", direction: "desc" },
        limit: 10,
      });

      expect(result.entries.map((entry) => entry.fileName)).toEqual(["Agent Alpha.md", "Agent Beta.md"]);
      expect(result.entries.every((entry) => entry.relevanceScore > 0)).toBe(true);
    } finally {
      await sandbox.close();
    }
  });

  it("has the runtime deny a direct read outside every authorized root", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-file-sandbox-"));
    temporaryDirectories.push(parent);
    const authorized = path.join(parent, "authorized");
    const outside = path.join(parent, "outside");
    const spool = path.join(parent, "spool");
    fs.mkdirSync(authorized);
    fs.mkdirSync(outside);
    fs.mkdirSync(spool);
    const sentinel = path.join(outside, "must-not-read.txt");
    fs.writeFileSync(sentinel, "secret");

    const sandbox = new NodeFileSandbox({
      accountId: "account-1",
      moduleId: "notes",
      revision: 3,
      scopes: [{
        scopeRef: "scope-notes",
        scopeId: "vault",
        label: "Notes",
        directory: authorized,
        read: true,
        write: false,
      }],
      spoolDirectory: spool,
    });
    try {
      await expect(sandbox.verifyReadDenied(sentinel)).resolves.toBe(true);
    } finally {
      await sandbox.close();
    }
  });

  it("greps bounded text snippets and reports binary files as skipped", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-file-sandbox-"));
    temporaryDirectories.push(parent);
    const authorized = path.join(parent, "authorized");
    const spool = path.join(parent, "spool");
    fs.mkdirSync(authorized);
    fs.mkdirSync(spool);
    fs.writeFileSync(path.join(authorized, "alpha.md"), "before\nNeedle here\nafter\n");
    fs.writeFileSync(path.join(authorized, "binary.bin"), Buffer.from([0, 1, 2, 3]));

    const sandbox = new NodeFileSandbox({
      accountId: "account-1",
      moduleId: "notes",
      revision: 3,
      scopes: [{
        scopeRef: "scope-notes",
        scopeId: "vault",
        label: "Notes",
        directory: authorized,
        read: true,
        write: false,
      }],
      spoolDirectory: spool,
    });
    try {
      await expect(sandbox.execute({
        type: "grep",
        pattern: "needle",
        mode: "literal",
        case: "insensitive",
        contextLines: 1,
        limit: 10,
      })).resolves.toEqual({
        matches: [{
          scopeRef: "scope-notes",
          fileName: "alpha.md",
          relativePath: "alpha.md",
          line: 2,
          text: "Needle here",
          before: ["before"],
          after: ["after"],
          sizeBytes: 25,
          modifiedAt: expect.any(Number),
        }],
        skipped: [{ scopeRef: "scope-notes", relativePath: "binary.bin", reason: "binary" }],
        scanComplete: true,
        resultTruncated: false,
        scannedEntries: 2,
        scannedFiles: 2,
        scannedBytes: 29,
        grepBytes: 29,
      });
    } finally {
      await sandbox.close();
    }
  });

  it("reads a bounded line window without accepting an absolute path", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-file-sandbox-"));
    temporaryDirectories.push(parent);
    const authorized = path.join(parent, "authorized");
    const spool = path.join(parent, "spool");
    fs.mkdirSync(authorized);
    fs.mkdirSync(spool);
    fs.writeFileSync(path.join(authorized, "lines.txt"), "one\ntwo\nthree\nfour");

    const sandbox = new NodeFileSandbox({
      accountId: "account-1",
      moduleId: "notes",
      revision: 3,
      scopes: [{
        scopeRef: "scope-notes",
        scopeId: "vault",
        label: "Notes",
        directory: authorized,
        read: true,
        write: false,
      }],
      spoolDirectory: spool,
    });
    try {
      await expect(sandbox.execute({
        type: "read",
        scopeRef: "scope-notes",
        relativePath: "lines.txt",
        startLine: 2,
        maxLines: 2,
      })).resolves.toEqual({
        content: "two\nthree",
        startLine: 2,
        endLine: 3,
        totalLines: 4,
        truncated: true,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        sizeBytes: 18,
        modifiedAt: expect.any(Number),
      });
      await expect(sandbox.execute({
        type: "read",
        scopeRef: "scope-notes",
        relativePath: path.join(authorized, "lines.txt"),
      })).rejects.toThrow("file_sandbox_operation_invalid");
    } finally {
      await sandbox.close();
    }
  });

  it("inspects a recovery digest without returning content and keeps the authorized boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-inspect-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "item.txt"), "hello");
    fs.chmodSync(path.join(directory, "item.txt"), 0o600);
    fs.writeFileSync(path.join(root, "outside.txt"), "secret");
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(directory, "escape.txt"));
    const sandbox = new NodeFileSandbox({ accountId: "account", moduleId: "files", revision: 1,
      scopes: [{ scopeId: "root", scopeRef: "scope-files", label: "Files", directory, read: true, write: false }],
      spoolDirectory: path.join(root, "spool") });
    try {
      await expect(sandbox.execute({ type: "inspect", scopeRef: "scope-files", relativePath: "item.txt" })).resolves.toEqual({
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        sizeBytes: 5, modifiedAt: fs.statSync(path.join(directory, "item.txt")).mtimeMs, mode: 0o600,
      });
      for (const relativePath of ["../outside.txt", "escape.txt"]) {
        await expect(sandbox.execute({ type: "inspect", scopeRef: "scope-files", relativePath })).rejects.toThrow();
      }
      await expect(sandbox.execute({ type: "inspect", scopeRef: "unknown", relativePath: "item.txt" }))
        .rejects.toThrow("file_sandbox_permission_denied");
    } finally { await sandbox.close(); }
  });

  // Only this Interface reads by path: the file tools issue no reference to a file below a closed root.
  it("refuses a read and an inspection by path below a root that a saved scope closed, and reads beside it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-closed-root-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "Documents"), vault = path.join(directory, "vault");
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, "secret.md"), "secret");
    fs.writeFileSync(path.join(directory, "beside.md"), "beside");
    const sandbox = new NodeFileSandbox({ accountId: "account", moduleId: "local-media", revision: 1,
      scopes: [{ scopeId: "documents", scopeRef: "scope-documents", label: "Documents", directory, read: true, write: false, closedRoots: [fs.realpathSync(vault)] }],
      spoolDirectory: path.join(root, "spool") });
    try {
      await expect(sandbox.execute({ type: "read", scopeRef: "scope-documents", relativePath: "vault/secret.md" })).rejects.toThrow(/^file_sandbox_permission_denied$/u);
      await expect(sandbox.execute({ type: "inspect", scopeRef: "scope-documents", relativePath: "vault/secret.md" })).rejects.toThrow(/^file_sandbox_permission_denied$/u);
      // The answer does not tell whether the file exists.
      await expect(sandbox.execute({ type: "read", scopeRef: "scope-documents", relativePath: "vault/absent.md" })).rejects.toThrow(/^file_sandbox_permission_denied$/u);
      await expect(sandbox.execute({ type: "read", scopeRef: "scope-documents", relativePath: "beside.md" })).resolves.toMatchObject({ content: "beside" });
    } finally { await sandbox.close(); }
  });

  it("creates an immutable private snapshot and rejects stale source metadata", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-file-sandbox-"));
    temporaryDirectories.push(parent);
    const authorized = path.join(parent, "authorized");
    const spool = path.join(parent, "spool");
    fs.mkdirSync(authorized);
    fs.mkdirSync(spool);
    const source = path.join(authorized, "photo.png");
    fs.writeFileSync(source, Buffer.from([1, 2, 3, 4]));
    const initial = fs.statSync(source);
    const sandbox = new NodeFileSandbox({
      accountId: "account-1",
      moduleId: "local-media",
      revision: 1,
      scopes: [{
        scopeRef: "scope-pictures",
        scopeId: "pictures",
        label: "Pictures",
        directory: authorized,
        read: true,
        write: false,
      }],
      spoolDirectory: spool,
    });
    try {
      const snapshot = await sandbox.execute({
        type: "snapshot",
        scopeRef: "scope-pictures",
        relativePath: "photo.png",
        expectedSizeBytes: initial.size,
        expectedModifiedAt: initial.mtimeMs,
      });
      expect(snapshot).toEqual({
        snapshotPath: expect.stringMatching(new RegExp(`^${escapeRegExp(fs.realpathSync(spool))}${escapeRegExp(path.sep)}`)),
        fileName: "photo.png",
        sha256: crypto.createHash("sha256").update(Buffer.from([1, 2, 3, 4])).digest("hex"),
        sizeBytes: 4,
      });
      expect(fs.statSync(snapshot.snapshotPath).mode & 0o777).toBe(0o600);
      fs.writeFileSync(source, Buffer.from([9, 9, 9, 9, 9]));
      expect(fs.readFileSync(snapshot.snapshotPath)).toEqual(Buffer.from([1, 2, 3, 4]));
      await expect(sandbox.execute({
        type: "snapshot",
        scopeRef: "scope-pictures",
        relativePath: "photo.png",
        expectedSizeBytes: initial.size,
        expectedModifiedAt: initial.mtimeMs,
      })).rejects.toThrow("file_sandbox_content_conflict");
    } finally {
      await sandbox.close();
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
