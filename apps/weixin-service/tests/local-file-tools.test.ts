import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { LocalFileTools } from "../src/local-file-tools.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import { WorkflowToolHost, type WorkflowToolTraceEvent } from "../src/workflow-tool-host.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("local_file_query_contract_regression", () => {
  it("rejects search results when the saved permission changes after admission", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-revocation-")); temporaryDirectories.push(root);
    const directory = path.join(root, "files"); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "private.txt"), "private");
    let observations = 0;
    const files = new LocalFileTools({ get: () => ({ moduleId: "files", revision: ++observations <= 2 ? 1 : 2, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }],
    }) }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const trusted = turn("revoked-search", "account-a"), binding = files.bindTurn(trusted);
    try {
      await expect(files.execute({ toolId: "files.find", toolVersion: 2, arguments: { kind: "file", limit: 1 } }, trusted))
        .rejects.toThrow("local_file_permission_changed");
    } finally { await binding.release(); await files.close(); }
  });

  it("completes recursive latest search beyond the old file-count boundary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "recursive-latest-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "Downloads");
    const older = path.join(directory, "a-sdk", "nested");
    const newer = path.join(directory, "z-project", "deep");
    fs.mkdirSync(older, { recursive: true }); fs.mkdirSync(newer, { recursive: true });
    for (let index = 0; index < 20_001; index += 1) fs.writeFileSync(path.join(older, `${index}.txt`), "");
    const latest = path.join(newer, "latest.mp4");
    fs.writeFileSync(latest, "latest"); fs.utimesSync(latest, 2_000_000_000, 2_000_000_000);
    const files = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "downloads", label: "Downloads", directory, read: true, write: false }],
    }) }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const trusted = turn("recursive-latest", "account-a"), binding = files.bindTurn(trusted);
    try {
      expect(await files.execute({ toolId: "files.find", toolVersion: 2, arguments: {
        kind: "file", sort: { field: "modified_at", direction: "desc" }, limit: 1,
      } }, trusted)).toMatchObject({ scanComplete: true, entries: [{ fileName: "latest.mp4" }] });
    } finally { await binding.release(); await files.close(); }
  }, 30_000);

  it("finds the latest video without charging unrelated file sizes as content reads", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-find-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "Downloads"); fs.mkdirSync(directory);
    const archive = path.join(directory, "a-large.zip");
    fs.writeFileSync(archive, ""); fs.truncateSync(archive, 600 * 1024 * 1024);
    fs.writeFileSync(path.join(directory, "b-old.mp4"), "old");
    fs.writeFileSync(path.join(directory, "z-latest.mp4"), "new");
    fs.utimesSync(path.join(directory, "b-old.mp4"), 100, 100);
    fs.utimesSync(path.join(directory, "z-latest.mp4"), 200, 200);
    const files = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "downloads", label: "Downloads", directory, read: true, write: false }],
    }) }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const trusted = turn("metadata-find", "account-a"), binding = files.bindTurn(trusted);
    try {
      const request = { toolId: "files.find", toolVersion: 2, arguments: {
        kind: "file", include: ["*.mp4"], sort: { field: "modified_at", direction: "desc" }, limit: 1,
      } };
      expect(await files.execute(request, trusted)).toMatchObject({ scanComplete: true,
        entries: [{ fileName: "z-latest.mp4" }], resultTruncated: true });
      expect(await files.execute(request, trusted)).toMatchObject({ scanComplete: true,
        entries: [{ fileName: "z-latest.mp4" }] });
    } finally { await binding.release(); await files.close(); }
  });

  it("traces real search completeness without retaining file names, references, or content", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "private-a.txt"), "private body");
    fs.writeFileSync(path.join(directory, "private-b.txt"), "private body");
    const files = new LocalFileTools({ get: () => ({
      moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }],
    }) }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), budget: { maxScannedFiles: 1 } });
    const traces: WorkflowToolTraceEvent[] = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      { submit: async () => { throw new Error("unexpected send"); } }, files, { trace: (event) => traces.push(event) });
    const trusted = turn("search-completeness-trace", "account-a");
    const binding = files.bindTurn(trusted);
    const hostBinding = host.bind("trace-thread", trusted);
    try {
      await host.execute("find", {
        query: "private", kind: "file", match: "literal", case: "insensitive",
        sort: { field: "modified_at", direction: "desc" }, limit: 1,
      }, { threadId: "trace-thread", turnId: "trace-turn", namespace: "files" });
      expect(traces).toEqual([expect.objectContaining({
        argumentSummary: expect.objectContaining({ queryOptions: {
          kind: "file", match: "literal", case: "insensitive",
          sort: { field: "modified_at", direction: "desc" }, limit: 1,
        } }), resultSummary: {
        entryCount: 1, scanComplete: false, resultTruncated: false,
      } })]);
      expect(traces[0]?.argumentSummary.queryInputs?.query).toBe("private");
      expect(JSON.stringify(traces)).not.toContain("fileref_");
      expect(JSON.stringify(traces)).not.toContain(directory);
    } finally {
      hostBinding.release();
      await binding.release();
      await files.close();
    }
  });

  it("traces grep counts and original query parameters without collecting file contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-grep-trace-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "private-a.txt"), "private needle\nprivate needle");
    fs.writeFileSync(path.join(directory, "private-b.txt"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(directory, "private-c.txt"), Buffer.from([0xff, 0xfe]));
    const files = new LocalFileTools({ get: () => ({
      moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Private", directory, read: true, write: false }],
    }) }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const traces: WorkflowToolTraceEvent[] = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      { submit: async () => { throw new Error("unexpected send"); } }, files, { trace: (event) => traces.push(event) });
    const trusted = turn("grep-trace", "account-a");
    const binding = files.bindTurn(trusted);
    const hostBinding = host.bind("grep-thread", trusted);
    try {
      await host.execute("grep", {
        pattern: "private needle", mode: "literal", case: "sensitive", contextLines: 0, limit: 1,
        include: ["private-*.txt"], exclude: ["private-hidden*"],
      }, { threadId: "grep-thread", turnId: "grep-turn", namespace: "files" });
      expect(traces).toEqual([expect.objectContaining({
        argumentSummary: expect.objectContaining({
          queryOptions: { mode: "literal", case: "sensitive", contextLines: 0, limit: 1 },
          arrayLengths: { include: 1, exclude: 1 },
        }),
        resultSummary: {
          matchCount: 1, scanComplete: true, resultTruncated: true,
          skippedCount: 2, skippedByReason: { binary: 1, decode_failed: 1 },
        },
      })]);
      const serialized = JSON.stringify(traces);
      expect(traces[0]?.argumentSummary.queryInputs).toEqual({
        pattern: "private needle", mode: "literal", case: "sensitive", contextLines: 0, limit: 1,
        include: ["private-*.txt"], exclude: ["private-hidden*"],
      });
      for (const secret of ["Private", "fileref_", directory, "private needle\\nprivate needle"]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      hostBinding.release();
      await binding.release();
      await files.close();
    }
  });

  it("retains invalid query selectors for diagnosis without executing them", async () => {
    const traces: WorkflowToolTraceEvent[] = [];
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true }),
      { submit: async () => { throw new Error("unexpected send"); } },
      { execute: async () => { throw new Error("invalid parameters must not execute"); } },
      { trace: (event) => traces.push(event) });
    const binding = host.bind("invalid-thread", turn("invalid-options", "account-a"));
    try {
      await host.execute("find", {
        query: "/Users/private/query", kind: "private-kind", match: "private-match", case: "private-case",
        sort: { field: "/Users/private/sort", direction: "private-direction" },
        limit: 101, include: ["private-*.txt"], scopeRefs: ["scoperef_private"], cursor: "private-cursor",
      }, { threadId: "invalid-thread", turnId: "invalid-turn", namespace: "files" });
      expect(traces).toHaveLength(1);
      expect(traces[0]?.errorCode).toBe("workflow_tool_arguments_invalid");
      expect(traces[0]?.argumentSummary.queryOptions).toBeUndefined();
      expect(traces[0]?.resultSummary).toBeUndefined();
      expect(traces[0]?.argumentSummary.queryInputs).toEqual({
        query: "/Users/private/query", kind: "private-kind", match: "private-match", case: "private-case",
        sort: { field: "/Users/private/sort", direction: "private-direction" },
        limit: 101, include: ["private-*.txt"], scopeRefs: ["scoperef_private"], cursor: "private-cursor",
      });
    } finally { binding.release(); }
  });

  it("retains original query inputs across host recreation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-trace-fingerprint-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const traces: WorkflowToolTraceEvent[] = [];
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
    const files = editableTools(directory, path.join(root, "spool"));
    const gateway = { submit: async () => { throw new Error("unexpected send"); } };
    const host = new WorkflowToolHost(catalog, gateway, files, { trace: (event) => traces.push(event) });
    const trusted = turn("fingerprint", "account-a");
    const fileBinding = files.bindTurn(trusted);
    const binding = host.bind("fingerprint", trusted);
    const context = { threadId: "fingerprint", turnId: "one", namespace: "files" };
    const restarted = new WorkflowToolHost(catalog, gateway, files, { trace: (event) => traces.push(event) });
    const nextBinding = restarted.bind("fingerprint", trusted);
    try {
      const args = { query: "private-project", include: ["secret*.md"], scopeRefs: [fileBinding.promptLines[0]!.split(":", 1)[0]!] };
      await host.execute("find", args, context);
      await host.execute("find", args, context);
      await host.execute("find", { ...args, query: "private-other" }, context);
      await restarted.execute("find", args, context);
      expect(traces.map((entry) => entry.argumentSummary.queryInputs?.query))
        .toEqual(["private-project", "private-project", "private-other", "private-project"]);
      for (const entry of traces) expect(entry.argumentSummary.queryInputs?.include).toEqual(["secret*.md"]);
    } finally { binding.release(); nextBinding.release(); await fileBinding.release(); await files.close(); }
  });

  it("distinguishes mistyped scope references from denied access and allows an exact-reference retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "holiday.png"), "fixture");
    const writeOnly = path.join(root, "write-only");
    fs.mkdirSync(writeOnly);
    fs.writeFileSync(path.join(writeOnly, "hidden.png"), "private");
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "files", revision: 1, saved: true,
        scopes: [
          { scopeId: "pictures", label: "Pictures", directory: files, read: true, write: false },
          { scopeId: "write-only", label: "Write only", directory: writeOnly, read: false, write: true },
        ],
      }),
    }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const trusted = turn("scope-repair", "account-a");
    const binding = tools.bindTurn(trusted);
    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;
    try {
      for (const toolId of ["files.find", "files.grep"]) {
        await expect(tools.execute({
          toolId, toolVersion: 2,
          arguments: { scopeRefs: ["scoperef_05aab829046edd53ea0ba8a5c16fffd0bb8a"], query: "holiday", pattern: "fixture" },
        }, trusted)).rejects.toThrow("local_file_reference_invalid");
      }
      await expect(tools.execute({
        toolId: "files.write", toolVersion: 1,
        arguments: { scopeRef: "scoperef_unknown", relativePath: "new.md", content: "test", overwrite: false },
      }, trusted)).rejects.toThrow("local_file_reference_invalid");
      await expect(tools.execute({
        toolId: "files.write", toolVersion: 1,
        arguments: { scopeRef, relativePath: "new.md", content: "test", overwrite: false },
      }, trusted)).rejects.toThrow("local_file_permission_denied");
      await expect(tools.execute({
        toolId: "files.find", toolVersion: 2,
        arguments: { scopeRefs: [scopeRef], query: "holiday", limit: 1 },
      }, trusted)).resolves.toMatchObject({ entries: [{ fileName: "holiday.png" }] });
      await expect(tools.execute({
        toolId: "files.find", toolVersion: 2,
        arguments: { scopeRefs: [binding.promptLines[1]!.split(":", 1)[0]!] },
      }, trusted)).resolves.toMatchObject({ entries: [{ fileName: "hidden.png" }] });
      const readable = await tools.execute({
        toolId: "files.find", toolVersion: 2, arguments: { include: ["*.png"] },
      }, trusted) as { entries: Array<{ fileName: string }>; scanComplete: boolean };
      expect(readable.entries.map((entry) => entry.fileName).sort()).toEqual(["hidden.png", "holiday.png"]);
      expect(readable.scanComplete).toBe(true);
      expect(fs.existsSync(path.join(files, "new.md"))).toBe(false);
    } finally {
      await binding.release();
      await tools.close();
    }
  });

  it("searches multiple authorized modules, returns opaque references, and reads by reference", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const notes = path.join(root, "notes");
    const pictures = path.join(root, "pictures");
    const spool = path.join(root, "spool");
    fs.mkdirSync(notes);
    fs.mkdirSync(pictures);
    fs.writeFileSync(path.join(notes, "计划.md"), "第一行\n第二行\n第三行");
    fs.writeFileSync(path.join(pictures, "holiday.png"), Buffer.from([1, 2, 3]));

    const permissions = {
      get: (moduleId: string) => moduleId === "notes"
        ? {
            moduleId,
            revision: 3,
            saved: true,
            scopes: [{ scopeId: "vault", label: "Demo Vault", directory: notes, read: true, write: false }],
          }
        : moduleId === "local-media"
          ? {
              moduleId,
              revision: 5,
              saved: true,
              scopes: [{ scopeId: "pictures", label: "相册", directory: pictures, read: true, write: false }],
            }
          : undefined,
    };
    const tools = new LocalFileTools(permissions, {
      moduleIds: ["notes", "local-media"],
      spoolDirectory: spool,
    });
    const trusted = turn("event-a", "account-a");
    const binding = tools.bindTurn(trusted);

    expect(binding.promptLines.join("\n")).toContain("Demo Vault");
    expect(binding.promptLines.join("\n")).toContain("相册");
    expect(binding.promptLines.join("\n")).not.toContain(notes);
    expect(binding.promptLines.join("\n")).not.toContain(pictures);

    const found = await tools.execute({
      toolId: "files.find",
      toolVersion: 2,
      arguments: { query: "计划", kind: "file", limit: 10 },
    }, trusted) as {
      entries: Array<{ fileRef: string; fileName: string; displayPath: string }>;
      scanComplete: boolean;
      resultTruncated: boolean;
    };
    expect(found).toMatchObject({
      entries: [{ fileRef: expect.stringMatching(/^fileref_[a-f0-9]{32}$/u), fileName: "计划.md", displayPath: "Demo Vault/计划.md" }],
      scanComplete: true,
      resultTruncated: false,
    });
    expect(JSON.stringify(found)).not.toContain(notes);

    const read = await tools.execute({
      toolId: "files.read",
      toolVersion: 2,
      arguments: { fileRef: found.entries[0]!.fileRef, startLine: 2, maxLines: 1 },
    }, trusted);
    expect(read).toMatchObject({ content: "第二行", startLine: 2, endLine: 2, totalLines: 3, truncated: true });

    const otherTurn = turn("event-b", "account-a");
    const otherBinding = tools.bindTurn(otherTurn);
    await expect(tools.execute({
      toolId: "files.read",
      toolVersion: 2,
      arguments: { fileRef: found.entries[0]!.fileRef },
    }, otherTurn)).rejects.toThrow("local_file_reference_invalid");
    await otherBinding.release();

    await binding.release();
    await expect(tools.execute({
      toolId: "files.find",
      toolVersion: 2,
      arguments: { query: "计划" },
    }, trusted)).rejects.toThrow("local_file_turn_unavailable");
  });

  it("local_file_unicode_boundary_matching", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    for (const fileName of ["agent-guide.md", "旅行笔记.md", "release-notes.md", "version-42.txt", "历史记录.md"]) {
      fs.writeFileSync(path.join(files, fileName), fileName);
    }
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "files",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "root", label: "Files", directory: files, read: true, write: false }],
      }),
    }, { moduleIds: ["files"], spoolDirectory: spool });

    const queryNames = async (eventKey: string, query: string, caseMode: "smart" | "insensitive" = "smart") => {
      const trusted = turn(eventKey, "account-a");
      const binding = tools.bindTurn(trusted);
      try {
        const result = await tools.execute({
          toolId: "files.find",
          toolVersion: 2,
          arguments: { query, match: "fuzzy", case: caseMode, kind: "file", limit: 20 },
        }, trusted) as { entries: Array<{ fileName: string }> };
        return result.entries.map((entry) => entry.fileName);
      } finally {
        await binding.release();
      }
    };

    const spaced = await queryNames("unicode-spaced", "agent 笔记");
    expect(spaced).toEqual(["agent-guide.md", "旅行笔记.md"]);
    await expect(queryNames("unicode-joined", "agent笔记")).resolves.toEqual(spaced);
    await expect(queryNames("unicode-case", "AGENT笔记", "insensitive")).resolves.toEqual(spaced);
    await expect(queryNames("unicode-nfkc", "ＡＧＥＮＴ笔记", "insensitive")).resolves.toEqual(spaced);
    await expect(queryNames("unicode-number", "release42、记录")).resolves.toEqual([
      "release-notes.md",
      "version-42.txt",
      "历史记录.md",
    ]);
  });

  it("reserves a distinct-file read budget before parallel reads while allowing pages of an admitted file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-read-budget-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "a.txt"), "甲\n乙");
    fs.writeFileSync(path.join(directory, "b.txt"), "丙");
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), budget: { maxReadFiles: 1 } });
    const trusted = turn("distinct-read-budget", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2,
        arguments: { sort: { field: "name", direction: "asc" } } }, trusted) as { entries: Array<{ fileRef: string }> };
      const results = await Promise.allSettled(found.entries.map(({ fileRef }) => tools.execute({
        toolId: "files.read", toolVersion: 2, arguments: { fileRef, maxLines: 1 },
      }, trusted)));
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { content: "甲" } });
      expect(results[1]).toMatchObject({ status: "rejected", reason: new Error("local_file_turn_budget_exhausted") });
      await expect(tools.execute({ toolId: "files.read", toolVersion: 2,
        arguments: { fileRef: found.entries[0]!.fileRef, startLine: 2, maxLines: 1 } }, trusted))
        .resolves.toMatchObject({ content: "乙" });
    } finally { await binding.release(); await tools.close(); }
  });

  it("reserves aggregate read characters before concurrent dispatch and counts Unicode code points", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-read-characters-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "a.txt"), "😀甲");
    fs.writeFileSync(path.join(directory, "b.txt"), "乙\n丙");
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), budget: { maxReadCharacters: 3 } });
    const trusted = turn("parallel-read-characters", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2,
        arguments: { sort: { field: "name", direction: "asc" } } }, trusted) as { entries: Array<{ fileRef: string }> };
      const results = await Promise.allSettled(found.entries.map(({ fileRef }) => tools.execute({
        toolId: "files.read", toolVersion: 2, arguments: { fileRef },
      }, trusted)));
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { content: "😀甲" } });
      expect(results[1]).toMatchObject({ status: "rejected", reason: new Error("local_file_turn_budget_exhausted") });
      await expect(tools.execute({ toolId: "files.read", toolVersion: 2,
        arguments: { fileRef: found.entries[1]!.fileRef, maxLines: 1 } }, trusted)).resolves.toMatchObject({ content: "乙" });
      await expect(tools.execute({ toolId: "files.read", toolVersion: 2,
        arguments: { fileRef: found.entries[1]!.fileRef } }, trusted)).rejects.toThrow("local_file_turn_budget_exhausted");
    } finally { await binding.release(); await tools.close(); }
  });

  it("retains a failed read admission while releasing its unused character reservation", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-failed-read-budget-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "a.bin"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(directory, "b.txt"), "乙");
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), budget: { maxReadFiles: 1, maxReadCharacters: 3 } });
    const trusted = turn("failed-read-admission", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2,
        arguments: { sort: { field: "name", direction: "asc" } } }, trusted) as { entries: Array<{ fileRef: string }> };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(tools.execute({ toolId: "files.read", toolVersion: 2,
          arguments: { fileRef: found.entries[0]!.fileRef } }, trusted)).rejects.toThrow("file_sandbox_content_unsupported");
      }
      await expect(tools.execute({ toolId: "files.read", toolVersion: 2,
        arguments: { fileRef: found.entries[1]!.fileRef } }, trusted)).rejects.toThrow("local_file_turn_budget_exhausted");
    } finally { await binding.release(); await tools.close(); }
  });

  it("shares one call budget across find, grep and read even when their data budgets remain", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-call-budget-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "item.txt"), "needle");
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), budget: { maxCalls: 3 } });
    const trusted = turn("mixed-call-budget", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2,
        arguments: {} }, trusted) as { entries: Array<{ fileRef: string }> };
      await expect(tools.execute({ toolId: "files.grep", toolVersion: 2,
        arguments: { pattern: "needle" } }, trusted)).resolves.toMatchObject({ matches: [{ line: 1 }] });
      const request = { toolId: "files.read", toolVersion: 2, arguments: { fileRef: found.entries[0]!.fileRef } };
      await expect(tools.execute(request, trusted)).resolves.toMatchObject({ content: "needle" });
      await expect(tools.execute(request, trusted)).rejects.toThrow("local_file_turn_budget_exhausted");
    } finally { await binding.release(); await tools.close(); }
  });

  it("bounds an oversized read before the sandbox response frame and releases unused reservations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-read-frame-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "huge.txt"), "x".repeat(1_100_000));
    fs.writeFileSync(path.join(directory, "small.txt"), "甲乙");
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), budget: { maxReadCharacters: 3 } });
    const trusted = turn("bounded-read", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2,
        arguments: { sort: { field: "name", direction: "asc" } } }, trusted) as { entries: Array<{ fileRef: string }> };
      await expect(tools.execute({ toolId: "files.read", toolVersion: 2,
        arguments: { fileRef: found.entries[0]!.fileRef } }, trusted)).rejects.toThrow("local_file_turn_budget_exhausted");
      await expect(tools.execute({ toolId: "files.read", toolVersion: 2,
        arguments: { fileRef: found.entries[1]!.fileRef } }, trusted)).resolves.toMatchObject({ content: "甲乙" });
    } finally { await binding.release(); await tools.close(); }
  });

  it("does not grant the same traversal allowance to concurrent searches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-concurrent-scan-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "a.txt"), "alpha");
    fs.writeFileSync(path.join(directory, "b.txt"), "beta");
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), budget: { maxScannedFiles: 3 } });
    const trusted = turn("parallel-traversal", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const results = await Promise.all([
        tools.execute({ toolId: "files.find", toolVersion: 2, arguments: {} }, trusted),
        tools.execute({ toolId: "files.grep", toolVersion: 2, arguments: { pattern: "a" } }, trusted),
      ]);
      expect(results[0]).toMatchObject({ scanComplete: true, entries: [{ fileName: "a.txt" }, { fileName: "b.txt" }] });
      expect(results[1]).toMatchObject({ scanComplete: false });
    } finally { await binding.release(); await tools.close(); }
  });

  it("enforces one aggregate result budget across repeated calls", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "a.txt"), "same");
    fs.writeFileSync(path.join(files, "b.txt"), "same");
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "files",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "root", label: "Files", directory: files, read: true, write: false }],
      }),
    }, {
      moduleIds: ["files"],
      spoolDirectory: spool,
      budget: { maxResultItems: 2 },
    });
    const trusted = turn("event-budget", "account-a");
    const binding = tools.bindTurn(trusted);
    await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: { query: ".txt", limit: 2 } }, trusted);
    await expect(tools.execute({
      toolId: "files.find",
      toolVersion: 2,
      arguments: { query: ".txt", limit: 1 },
    }, trusted)).rejects.toThrow("local_file_turn_budget_exhausted");
    await binding.release();
  });

  it("excludes model waiting from the file execution wall-clock budget and counts overlapping work once", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "sample.txt"), "sample");
    let clock = 0;
    const tools = new LocalFileTools({
      get: () => ({ moduleId: "files", revision: 1, saved: true,
        scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }] }),
    }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), now: () => clock,
      budget: { maxWallClockMs: 100 } });
    const trusted = turn("execution-wall-clock", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: { query: "sample" } }, trusted) as { entries: Array<{ fileRef: string }> };
      const request = { toolId: "files.read", toolVersion: 2, arguments: { fileRef: found.entries[0]!.fileRef } };
      clock = 70_000; // Waiting for the model, before any file work.
      const first = tools.execute(request, trusted);
      const second = tools.execute(request, trusted);
      clock += 60;
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      clock += 70_000; // Waiting between model tool calls also consumes no file work.
      const third = tools.execute(request, trusted);
      await Promise.resolve(); // Dispatch before advancing time spent inside this read.
      clock += 40;
      await expect(third).resolves.toMatchObject({ content: "sample" });
      await expect(tools.execute(request, trusted)).rejects.toThrow("local_file_turn_budget_exhausted");
    } finally {
      await binding.release();
      await tools.close();
    }
  });

  it("rejects queued searches once active file work has exhausted the execution time budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-queued-time-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "item.txt"), "sample");
    let clock = 0;
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), now: () => clock, budget: { maxWallClockMs: 100 } });
    const trusted = turn("queued-time", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const request = { toolId: "files.find", toolVersion: 2, arguments: {} };
      const first = tools.execute(request, trusted);
      await Promise.resolve(); // First scan is dispatched; the next call must wait behind it.
      const second = tools.execute(request, trusted);
      clock = 100;
      const results = await Promise.allSettled([first, second]);
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { scanComplete: true } });
      expect(results[1]).toMatchObject({ status: "rejected", reason: new Error("local_file_turn_budget_exhausted") });
    } finally { await binding.release(); await tools.close(); }
  });

  it("keeps relevance ordering stable across modules and paginates without overlap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const spool = path.join(root, "spool");
    fs.mkdirSync(path.join(first, "target"), { recursive: true });
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, "target", "a-notes.md"), "weak");
    fs.writeFileSync(path.join(first, "target", "b-notes.md"), "weak");
    fs.writeFileSync(path.join(second, "target"), "exact");
    fs.writeFileSync(path.join(second, "target-z.md"), "partial");

    const tools = new LocalFileTools({
      get: (moduleId: string) => ({
        moduleId,
        revision: 1,
        saved: true,
        scopes: [{
          scopeId: "root",
          label: moduleId,
          directory: moduleId === "first" ? first : second,
          read: true,
          write: false,
        }],
      }),
    }, { moduleIds: ["first", "second"], spoolDirectory: spool });
    const trusted = turn("event-pages", "account-a");
    const binding = tools.bindTurn(trusted);
    const firstPage = await tools.execute({
      toolId: "files.find",
      toolVersion: 2,
      arguments: { query: "target", kind: "file", sort: { field: "relevance", direction: "desc" }, limit: 2 },
    }, trusted) as { entries: Array<{ fileName: string }>; cursor?: string; resultTruncated: boolean };
    expect(firstPage.entries.map((entry) => entry.fileName)).toEqual(["target", "target-z.md"]);
    expect(firstPage).toMatchObject({ cursor: expect.any(String), resultTruncated: true });

    const secondPage = await tools.execute({
      toolId: "files.find",
      toolVersion: 2,
      arguments: {
        query: "target",
        kind: "file",
        sort: { field: "relevance", direction: "desc" },
        limit: 2,
        cursor: firstPage.cursor,
      },
    }, trusted) as { entries: Array<{ fileName: string }>; cursor?: string; resultTruncated: boolean };
    expect(secondPage.entries.map((entry) => entry.fileName)).toEqual(["a-notes.md", "b-notes.md"]);
    expect(secondPage.resultTruncated).toBe(false);
    await binding.release();
  });

  it.each([
    ["modified_at", "desc", ["Z.txt", "a.txt"]], ["modified_at", "asc", ["Z.txt", "a.txt"]],
    ["relevance", "desc", ["Z.txt", "a.txt"]], ["relevance", "asc", ["Z.txt", "a.txt"]],
    ["name", "asc", ["Z.txt", "a.txt"]], ["name", "desc", ["a.txt", "Z.txt"]],
    ["path", "asc", ["Z.txt", "a.txt"]], ["path", "desc", ["a.txt", "Z.txt"]],
  ] as const)("keeps equal-time ordering identical for whole results and cursor pages: %s %s", async (field, direction, expected) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-sort-pages-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const timestamp = new Date("2026-08-20T12:00:00Z");
    for (const name of ["a.txt", "Z.txt"]) {
      fs.writeFileSync(path.join(directory, name), "fixture");
      fs.utimesSync(path.join(directory, name), timestamp, timestamp);
    }
    const tools = new LocalFileTools({ get: () => ({
      moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }],
    }) }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const trusted = turn("equal-time-pages", "account-a");
    const binding = tools.bindTurn(trusted);
    const query = { kind: "file", sort: { field, direction } };
    type Page = { entries: Array<{ fileName: string; modifiedAt: number }>; cursor?: string; scanComplete: boolean; resultTruncated: boolean };
    try {
      const first = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: { ...query, limit: 1 } }, trusted) as Page;
      expect(first).toMatchObject({ entries: [{ fileName: expected[0], modifiedAt: 1787227200000 }], scanComplete: true, resultTruncated: true });
      expect(first.cursor).toEqual(expect.any(String));
      const second = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: { ...query, limit: 1, cursor: first.cursor } }, trusted) as Page;
      expect(second).toMatchObject({ entries: [{ fileName: expected[1] }], scanComplete: true, resultTruncated: false });
      expect(second.cursor).toBeUndefined();
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const whole = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: { ...query, limit: 20 } }, trusted) as Page;
        expect(whole.entries.map((entry) => entry.fileName)).toEqual(expected);
      }
    } finally { await binding.release(); await tools.close(); }
  });

  it.each([false, true])("keeps equal relative paths stable across new turns (multiple modules: %s)", async (multipleModules) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-scope-ties-"));
    temporaryDirectories.push(root);
    for (const id of ["gamma", "beta", "alpha"]) {
      fs.mkdirSync(path.join(root, id));
      fs.writeFileSync(path.join(root, id, "same.txt"), "needle");
      fs.utimesSync(path.join(root, id, "same.txt"), new Date("2026-08-20T12:00:00Z"), new Date("2026-08-20T12:00:00Z"));
    }
    const tools = new LocalFileTools({ get: (moduleId: string) => ({
      moduleId, revision: 1, saved: true,
      scopes: (multipleModules ? [moduleId] : ["gamma", "beta", "alpha"]).map((id) => ({
        scopeId: id, label: id, directory: path.join(root, id), read: true, write: false,
      })),
    }) }, { moduleIds: multipleModules ? ["gamma", "beta", "alpha"] : ["files"], spoolDirectory: path.join(root, "spool") });
    try {
      for (let repeat = 0; repeat < 5; repeat += 1) {
        const trusted = turn(`scope-ties-${repeat}`, "account-a");
        const binding = tools.bindTurn(trusted);
        try {
          for (const toolId of ["files.find", "files.grep"]) {
            const args = toolId === "files.find" ? { query: "same", sort: { field: "modified_at", direction: "desc" } } : { pattern: "needle" };
            const result = await tools.execute({ toolId, toolVersion: 2, arguments: { ...args, limit: 1 } }, trusted) as {
              entries?: Array<{ displayPath: string }>; matches?: Array<{ displayPath: string }>;
            };
            expect((result.entries ?? result.matches)?.map((entry) => entry.displayPath)).toEqual(["alpha/same.txt"]);
          }
        } finally { await binding.release(); }
      }
    } finally { await tools.close(); }
  });

  it("marks the merged search incomplete when the first module finishes but the second reaches the scan budget", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-partial-modules-"));
    temporaryDirectories.push(root);
    for (const moduleId of ["first", "second"]) fs.mkdirSync(path.join(root, moduleId));
    fs.writeFileSync(path.join(root, "first", "z.txt"), "first complete");
    fs.writeFileSync(path.join(root, "second", "a.txt"), "second partial");
    fs.writeFileSync(path.join(root, "second", "b.txt"), "not scanned");
    const tools = new LocalFileTools({ get: (moduleId: string) => ({
      moduleId, revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: moduleId, directory: path.join(root, moduleId), read: true, write: false }],
    }) }, { moduleIds: ["first", "second"], spoolDirectory: path.join(root, "spool"), budget: { maxScannedFiles: 2 } });
    const trusted = turn("partial-modules", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const result = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: { kind: "file", sort: { field: "name", direction: "asc" }, limit: 20 } }, trusted);
      expect(result).toMatchObject({
        entries: [{ displayPath: "second/a.txt" }, { displayPath: "first/z.txt" }],
        scanComplete: false, resultTruncated: false,
      });
    } finally { await binding.release(); await tools.close(); }
  });

  it("keeps grep cursor pages in the same order as the sandbox across mixed-case names", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-grep-pages-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "a.txt"), "needle");
    fs.writeFileSync(path.join(directory, "Z.txt"), "needle");
    const tools = new LocalFileTools({ get: () => ({
      moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: false }],
    }) }, { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const trusted = turn("grep-pages", "account-a");
    const binding = tools.bindTurn(trusted);
    type Page = { matches: Array<{ fileName: string; line: number }>; cursor?: string; scanComplete: boolean; resultTruncated: boolean };
    try {
      const first = await tools.execute({ toolId: "files.grep", toolVersion: 2, arguments: { pattern: "needle", limit: 1 } }, trusted) as Page;
      expect(first).toMatchObject({ matches: [{ fileName: "Z.txt", line: 1 }], scanComplete: true, resultTruncated: true });
      expect(first.cursor).toEqual(expect.any(String));
      const second = await tools.execute({ toolId: "files.grep", toolVersion: 2, arguments: { pattern: "needle", limit: 1, cursor: first.cursor } }, trusted) as Page;
      expect(second).toMatchObject({ matches: [{ fileName: "a.txt", line: 1 }], scanComplete: true, resultTruncated: false });
      expect(second.cursor).toBeUndefined();
    } finally { await binding.release(); await tools.close(); }
  });

  it("keeps grep file references usable for immutable send snapshots", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "matched.md"), "send this original file");
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "notes",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "root", label: "Files", directory: files, read: true, write: false }],
      }),
    }, { moduleIds: ["notes"], spoolDirectory: spool });
    const trusted = turn("event-grep-send", "account-a");
    const binding = tools.bindTurn(trusted);
    const grep = await tools.execute({
      toolId: "files.grep",
      toolVersion: 2,
      arguments: { pattern: "original", limit: 1 },
    }, trusted) as { matches: Array<{ fileRef: string }> };
    const snapshots = await tools.snapshotForSend(trusted, [grep.matches[0]!.fileRef]);
    expect(snapshots).toMatchObject([{ fileName: "matched.md", sizeBytes: 23 }]);
    await binding.release();
  });

  it.each(["files.find", "files.grep"] as const)("stops an incomplete scan and blocks sending or later calls: %s", async (toolId) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "a.txt"), "needle");
    fs.writeFileSync(path.join(files, "b.txt"), "needle");
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "files",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "root", label: "Files", directory: files, read: true, write: false }],
      }),
    }, {
      moduleIds: ["files"],
      spoolDirectory: spool,
      budget: { maxScannedFiles: 1 },
    });
    const trusted = turn("event-scan-budget", "account-a");
    const binding = tools.bindTurn(trusted);
    const first = await tools.execute({
      toolId, toolVersion: 2, arguments: { ...(toolId === "files.find" ? { query: ".txt" } : { pattern: "needle" }), limit: 10 },
    }, trusted) as { entries?: Array<{ fileName: string; fileRef: string }>; matches?: Array<{ fileName: string; fileRef: string }>; scanComplete: boolean };
    const candidates = first.entries ?? first.matches!;
    expect(first.scanComplete).toBe(false);
    expect(candidates).toMatchObject([{ fileName: "a.txt" }]);
    await expect(tools.snapshotForSend(trusted, [candidates[0]!.fileRef]))
      .rejects.toThrow("local_file_search_incomplete");
    await expect(tools.execute({
      toolId, toolVersion: 2, arguments: { ...(toolId === "files.find" ? { query: ".txt" } : { pattern: "needle" }), limit: 10 },
    }, trusted)).rejects.toThrow("local_file_turn_budget_exhausted");
    await binding.release();
  });
});

describe("local_file_mutation_contract_regression", () => {
  it("rejects an actual FIFO before create or overwrite without blocking or replacing it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-fifo-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    fs.mkdirSync(files);
    const target = path.join(files, "pipe.txt");
    execFileSync("mkfifo", [target]);
    const original = fs.lstatSync(target);
    expect(original.isFIFO()).toBe(true);
    const tools = editableTools(files, path.join(root, "spool"));
    const trusted = turn("event-fifo", "account-a");
    const binding = tools.bindTurn(trusted);
    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;
    try {
      await expect(tools.execute({ toolId: "files.write", toolVersion: 1, arguments: {
        scopeRef, relativePath: "pipe.txt", content: "must not replace", overwrite: false,
      } }, trusted)).rejects.toThrow("local_file_file_exists");
      await expect(tools.execute({ toolId: "files.write", toolVersion: 1, arguments: {
        scopeRef, relativePath: "pipe.txt", content: "must not replace", overwrite: true,
        expectedSha256: "0".repeat(64),
      } }, trusted)).rejects.toThrow("local_file_path_unsafe");
      expect(fs.lstatSync(target).isFIFO()).toBe(true);
      expect(fs.lstatSync(target).ino).toBe(original.ino);
      expect(fs.readdirSync(files)).toEqual(["pipe.txt"]);
    } finally { await binding.release(); await tools.close(); }
  });

  it("rejects directories and non-regular socket targets before overwrite", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    const socketPath = path.join(files, "service.sock");
    fs.mkdirSync(files);
    fs.mkdirSync(path.join(files, "folder"));
    const socket = net.createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(socketPath, resolve);
    });
    const tools = editableTools(files, spool);
    const trusted = turn("event-special-target", "account-a");
    const binding = tools.bindTurn(trusted);
    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;
    try {
      for (const relativePath of ["folder", "service.sock"]) {
        await expect(tools.execute({
          toolId: "files.write",
          toolVersion: 1,
          arguments: {
            scopeRef,
            relativePath,
            content: "blocked",
            overwrite: true,
            expectedSha256: "0".repeat(64),
          },
        }, trusted)).rejects.toThrow("local_file_path_unsafe");
      }
      expect(fs.lstatSync(path.join(files, "folder")).isDirectory()).toBe(true);
      expect(fs.lstatSync(socketPath).isSocket()).toBe(true);
    } finally {
      await binding.release();
      await tools.close();
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });

  it("rejects writes before mutation when the aggregate byte budget is insufficient", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "notes",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "root", label: "Files", directory: files, read: false, write: true }],
      }),
    }, {
      moduleIds: ["notes"],
      spoolDirectory: spool,
      budget: { maxWriteBytes: 4 },
    });
    const trusted = turn("event-write-budget", "account-a");
    const binding = tools.bindTurn(trusted);
    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;
    await expect(tools.execute({
      toolId: "files.write",
      toolVersion: 1,
      arguments: { scopeRef, relativePath: "too-large.md", content: "12345", overwrite: false },
    }, trusted)).rejects.toThrow("local_file_turn_budget_exhausted");
    expect(fs.existsSync(path.join(files, "too-large.md"))).toBe(false);
    await binding.release();
  });

  it("rejects absolute paths, traversal, and symlinked parents before writing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const outside = path.join(root, "outside");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(files, "escape"), "dir");
    const tools = editableTools(files, spool);
    const trusted = turn("event-write-paths", "account-a");
    const binding = tools.bindTurn(trusted);
    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;

    for (const relativePath of [path.join(root, "absolute.md"), "../outside.md", "nested/../../outside.md"]) {
      await expect(tools.execute({
        toolId: "files.write",
        toolVersion: 1,
        arguments: { scopeRef, relativePath, content: "blocked", overwrite: false },
      }, trusted)).rejects.toThrow("local_file_tool_arguments_invalid");
    }
    await expect(tools.execute({
      toolId: "files.write",
      toolVersion: 1,
      arguments: { scopeRef, relativePath: "escape/outside.md", content: "blocked", overwrite: false },
    }, trusted)).rejects.toThrow("local_file_mutation_failed");
    expect(fs.existsSync(path.join(outside, "outside.md"))).toBe(false);
    await binding.release();
    await tools.close();
  });

  it("includes search and read when write is granted without a separate read flag", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-write-only-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: false, write: true }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const trusted = turn("write-only", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;
      const created = await tools.execute({ toolId: "files.write", toolVersion: 1,
        arguments: { scopeRef, relativePath: "new.txt", content: "新文件", overwrite: false } }, trusted) as { fileRef: string };
      expect(fs.readFileSync(path.join(directory, "new.txt"), "utf8")).toBe("新文件");
      await expect(tools.execute({ toolId: "files.read", toolVersion: 2, arguments: { fileRef: created.fileRef } }, trusted))
        .resolves.toMatchObject({ content: "新文件" });
      await expect(tools.execute({ toolId: "files.find", toolVersion: 2, arguments: {} }, trusted))
        .resolves.toMatchObject({ entries: [{ fileName: "new.txt" }], scanComplete: true });
    } finally { await binding.release(); await tools.close(); }
  });

  it("allows hash-guarded overwrite through the read access included in write permission", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "existing.md"), "before");
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "notes",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "root", label: "Files", directory: files, read: false, write: true }],
      }),
    }, { moduleIds: ["notes"], spoolDirectory: spool });
    const trusted = turn("event-overwrite-permission", "account-a");
    const binding = tools.bindTurn(trusted);
    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;

    await expect(tools.execute({
      toolId: "files.write",
      toolVersion: 1,
      arguments: {
        scopeRef,
        relativePath: "existing.md",
        content: "after",
        overwrite: true,
        expectedSha256: "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb",
      },
    }, trusted)).resolves.toMatchObject({ created: false });
    expect(fs.readFileSync(path.join(files, "existing.md"), "utf8")).toBe("after");
    await binding.release();
    await tools.close();
  });

  it("does not read or edit binary files returned by filename search", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const tools = editableTools(files, spool);
    const trusted = turn("event-binary", "account-a");
    const binding = tools.bindTurn(trusted);
    const found = await tools.execute({
      toolId: "files.find", toolVersion: 2, arguments: { query: "binary.bin", match: "literal" },
    }, trusted) as { entries: Array<{ fileRef: string }> };

    await expect(tools.execute({
      toolId: "files.read", toolVersion: 2, arguments: { fileRef: found.entries[0]!.fileRef },
    }, trusted)).rejects.toThrow();
    await expect(tools.execute({
      toolId: "files.edit",
      toolVersion: 1,
      arguments: {
        fileRef: found.entries[0]!.fileRef,
        expectedSha256: "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8",
        oldText: "a",
        newText: "b",
      },
    }, trusted)).rejects.toThrow("local_file_mutation_failed");
    expect(fs.readFileSync(path.join(files, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
    await binding.release();
    await tools.close();
  });

  it("edits with CAS, returns a new reference, and creates a new UTF-8 file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "existing.md"), "before\nline two", { mode: 0o640 });
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "notes",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "vault", label: "Vault", directory: files, read: true, write: true }],
      }),
    }, { moduleIds: ["notes"], spoolDirectory: spool });
    const trusted = turn("event-edit", "account-a");
    const binding = tools.bindTurn(trusted);
    const found = await tools.execute({
      toolId: "files.find", toolVersion: 2, arguments: { query: "existing.md", match: "literal" },
    }, trusted) as { entries: Array<{ fileRef: string }> };
    const read = await tools.execute({
      toolId: "files.read", toolVersion: 2, arguments: { fileRef: found.entries[0]!.fileRef },
    }, trusted) as { sha256: string };

    const edited = await tools.execute({
      toolId: "files.edit",
      toolVersion: 1,
      arguments: {
        fileRef: found.entries[0]!.fileRef,
        expectedSha256: read.sha256,
        oldText: "before",
        newText: "after",
      },
    }, trusted) as { fileRef: string; sha256: string; changed: boolean };
    expect(edited).toMatchObject({
      fileRef: expect.stringMatching(/^fileref_[a-f0-9]{32}$/u),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      changed: true,
    });
    expect(edited.fileRef).not.toBe(found.entries[0]!.fileRef);
    expect(fs.readFileSync(path.join(files, "existing.md"), "utf8")).toBe("after\nline two");
    expect(fs.statSync(path.join(files, "existing.md")).mode & 0o777).toBe(0o640);
    await expect(tools.execute({
      toolId: "files.edit",
      toolVersion: 1,
      arguments: {
        fileRef: found.entries[0]!.fileRef,
        expectedSha256: read.sha256,
        oldText: "before",
        newText: "after",
      },
    }, trusted)).resolves.toEqual(edited);
    await expect(tools.execute({
      toolId: "files.edit",
      toolVersion: 1,
      arguments: {
        fileRef: found.entries[0]!.fileRef,
        expectedSha256: read.sha256,
        oldText: "before",
        newText: "different",
      },
    }, trusted)).rejects.toThrow("local_file_content_conflict");

    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;
    const created = await tools.execute({
      toolId: "files.write",
      toolVersion: 1,
      arguments: {
        scopeRef,
        relativePath: "nested/new.md",
        content: "new content",
        overwrite: false,
      },
    }, trusted) as { fileRef: string; sha256: string; created: boolean };
    expect(created).toMatchObject({
      fileRef: expect.stringMatching(/^fileref_[a-f0-9]{32}$/u),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      created: true,
    });
    expect(fs.readFileSync(path.join(files, "nested", "new.md"), "utf8")).toBe("new content");
    await binding.release();
  });

  it("checks current write permission before returning a journalled mutation result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-mutation-revocation-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    let revision = 1;
    let write = true;
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool") });
    const trusted = turn("mutation-revoked", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const args = { scopeRef: binding.promptLines[0]!.split(":", 1)[0]!, relativePath: "new.txt", content: "safe", overwrite: false };
      await tools.execute({ toolId: "files.write", toolVersion: 1, arguments: args }, trusted);
      revision = 2;
      write = false;
      await expect(tools.execute({ toolId: "files.write", toolVersion: 1, arguments: args }, trusted))
        .rejects.toThrow("local_file_permission_changed");
      expect(fs.readFileSync(path.join(directory, "new.txt"), "utf8")).toBe("safe");
    } finally { await binding.release(); await tools.close(); }
  });

  it("keeps zero and ambiguous replacements unchanged and applies replaceAll only when requested", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-replace-boundaries-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "item.txt"), "same same");
    const tools = editableTools(directory, path.join(root, "spool"));
    const trusted = turn("replace-boundaries", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: {} }, trusted) as { entries: Array<{ fileRef: string }> };
      const fileRef = found.entries[0]!.fileRef;
      const read = await tools.execute({ toolId: "files.read", toolVersion: 2, arguments: { fileRef } }, trusted) as { sha256: string };
      for (const oldText of ["absent", "same"]) {
        await expect(tools.execute({ toolId: "files.edit", toolVersion: 1, arguments: {
          fileRef, expectedSha256: read.sha256, oldText, newText: "wrong",
        } }, trusted)).rejects.toThrow("local_file_content_conflict");
        expect(fs.readFileSync(path.join(directory, "item.txt"), "utf8")).toBe("same same");
      }
      const edited = await tools.execute({ toolId: "files.edit", toolVersion: 1, arguments: {
        fileRef, expectedSha256: read.sha256, oldText: "same", newText: "new", replaceAll: true,
      } }, trusted) as { sizeBytes: number; modifiedAt: number };
      expect(fs.readFileSync(path.join(directory, "item.txt"), "utf8")).toBe("new new");
      expect(edited.sizeBytes).toBe(7);
      expect(edited.modifiedAt).toBe(fs.statSync(path.join(directory, "item.txt")).mtimeMs);
    } finally { await binding.release(); await tools.close(); }
  });

  it("rejects stale references for new edits even with the current hash but preserves exact retry recovery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-stale-edit-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "item.txt"), "before");
    const tools = editableTools(directory, path.join(root, "spool"));
    const trusted = turn("stale-edit", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: {} }, trusted) as { entries: Array<{ fileRef: string }> };
      const fileRef = found.entries[0]!.fileRef;
      const before = await tools.execute({ toolId: "files.read", toolVersion: 2, arguments: { fileRef } }, trusted) as { sha256: string };
      const args = { fileRef, expectedSha256: before.sha256, oldText: "before", newText: "after" };
      const edited = await tools.execute({ toolId: "files.edit", toolVersion: 1, arguments: args }, trusted) as { fileRef: string; sha256: string };
      await expect(tools.execute({ toolId: "files.edit", toolVersion: 1,
        arguments: { fileRef, expectedSha256: edited.sha256, oldText: "after", newText: "wrong" } }, trusted))
        .rejects.toThrow("local_file_content_conflict");
      await expect(tools.execute({ toolId: "files.edit", toolVersion: 1, arguments: args }, trusted)).resolves.toEqual(edited);
      expect(fs.readFileSync(path.join(directory, "item.txt"), "utf8")).toBe("after");
    } finally { await binding.release(); await tools.close(); }
  });

  it("does not reactivate an earlier edit result after a later edit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-edit-replay-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "item.txt"), "before");
    const tools = editableTools(directory, path.join(root, "spool"));
    const trusted = turn("edit-replay", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: {} }, trusted) as { entries: Array<{ fileRef: string }> };
      const initialRef = found.entries[0]!.fileRef;
      const initial = await tools.execute({ toolId: "files.read", toolVersion: 2, arguments: { fileRef: initialRef } }, trusted) as { sha256: string };
      const firstRequest = { toolId: "files.edit", toolVersion: 1,
        arguments: { fileRef: initialRef, expectedSha256: initial.sha256, oldText: "before", newText: "after" } };
      const first = await tools.execute(firstRequest, trusted) as { fileRef: string; sha256: string };
      const latest = await tools.execute({ toolId: "files.edit", toolVersion: 1,
        arguments: { fileRef: first.fileRef, expectedSha256: first.sha256, oldText: "after", newText: "latest version" } }, trusted) as { fileRef: string };
      await expect(tools.execute(firstRequest, trusted)).rejects.toThrow("local_file_content_conflict");
      const [snapshot] = await tools.snapshotForSend(trusted, [latest.fileRef]);
      expect(fs.readFileSync(snapshot!.snapshotPath, "utf8")).toBe("latest version");
      expect(fs.readFileSync(path.join(directory, "item.txt"), "utf8")).toBe("latest version");
    } finally { await binding.release(); await tools.close(); }
  });

  it("does not start a queued write after the file execution budget expires", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-queued-write-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    let clock = 0;
    const tools = new LocalFileTools({ get: () => ({ moduleId: "files", revision: 1, saved: true,
      scopes: [{ scopeId: "root", label: "Files", directory, read: true, write: true }] }) },
    { moduleIds: ["files"], spoolDirectory: path.join(root, "spool"), now: () => clock, budget: { maxWallClockMs: 100 } });
    const trusted = turn("queued-write", "account-a");
    const binding = tools.bindTurn(trusted);
    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;
    try {
      const first = tools.execute({ toolId: "files.write", toolVersion: 1,
        arguments: { scopeRef, relativePath: "first.txt", content: "first", overwrite: false } }, trusted);
      await Promise.resolve();
      const second = tools.execute({ toolId: "files.write", toolVersion: 1,
        arguments: { scopeRef, relativePath: "second.txt", content: "second", overwrite: false } }, trusted);
      clock = 100;
      const results = await Promise.allSettled([first, second]);
      expect(results[0]).toMatchObject({ status: "fulfilled", value: { created: true } });
      expect(results[1]).toMatchObject({ status: "rejected", reason: new Error("local_file_turn_budget_exhausted") });
      expect(fs.readdirSync(directory)).toEqual(["first.txt"]);
      expect(fs.readFileSync(path.join(directory, "first.txt"), "utf8")).toBe("first");
    } finally { await binding.release(); await tools.close(); }
  });

  it("checks journalled writes against the file after reopening the operation store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-write-replay-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    const spool = path.join(root, "spool");
    const operationDatabasePath = path.join(root, "operations.sqlite");
    fs.mkdirSync(directory);
    const trusted = turn("write-replay", "account-a");
    const first = editableTools(directory, spool, { operationDatabasePath });
    const binding = first.bindTurn(trusted);
    // Exceeds the model-facing read response limit, but a recovery digest contains no body.
    const content = "a".repeat(100_001);
    try {
      await first.execute({ toolId: "files.write", toolVersion: 1, arguments: {
        scopeRef: binding.promptLines[0]!.split(":", 1)[0]!, relativePath: "item.txt", content, overwrite: false,
      } }, trusted);
    } finally { await binding.release(); await first.close(); }
    const restarted = editableTools(directory, spool, { operationDatabasePath });
    const rebound = restarted.bindTurn(trusted);
    const request = { toolId: "files.write", toolVersion: 1, arguments: {
      scopeRef: rebound.promptLines[0]!.split(":", 1)[0]!, relativePath: "item.txt", content, overwrite: false,
    } };
    try {
      await expect(restarted.execute(request, trusted)).resolves.toMatchObject({ created: true, sizeBytes: 100_001 });
      fs.writeFileSync(path.join(directory, "item.txt"), "externally changed");
      await expect(restarted.execute(request, trusted)).rejects.toThrow("local_file_content_conflict");
      expect(fs.readFileSync(path.join(directory, "item.txt"), "utf8")).toBe("externally changed");
    } finally { await rebound.release(); await restarted.close(); }
  });

  it("recovers an unreported long single-line create without a model-facing body read", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-started-write-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const operationDatabasePath = path.join(root, "operations.sqlite");
    const spool = path.join(root, "spool");
    const trusted = turn("unreported-write", "account-a");
    const content = "a".repeat(100_001);
    const first = editableTools(directory, spool, { operationDatabasePath,
      afterMutationDurable: () => { throw new Error("interrupted_before_journal_complete"); } });
    const binding = first.bindTurn(trusted);
    try {
      await expect(first.execute({ toolId: "files.write", toolVersion: 1, arguments: {
        scopeRef: binding.promptLines[0]!.split(":", 1)[0]!, relativePath: "item.txt", content, overwrite: false,
      } }, trusted)).rejects.toThrow("interrupted_before_journal_complete");
    } finally { await binding.release(); await first.close(); }
    const target = path.join(directory, "item.txt");
    expect(fs.readFileSync(target, "utf8")).toBe("a".repeat(100_001));
    const durableFile = fs.statSync(target);
    const restarted = editableTools(directory, spool, { operationDatabasePath,
      afterMutationDurable: () => { throw new Error("must_not_write_again"); } });
    const rebound = restarted.bindTurn(trusted);
    try {
      const result = await restarted.execute({ toolId: "files.write", toolVersion: 1, arguments: {
        scopeRef: rebound.promptLines[0]!.split(":", 1)[0]!, relativePath: "item.txt", content, overwrite: false,
      } }, trusted);
      expect(result).toMatchObject({ created: true, sizeBytes: 100_001 });
      expect(result).not.toHaveProperty("content");
      expect(fs.statSync(target).ino).toBe(durableFile.ino);
      expect(fs.statSync(target).mtimeMs).toBe(durableFile.mtimeMs);
      expect(fs.readFileSync(target, "utf8")).toBe("a".repeat(100_001));
    } finally { await rebound.release(); await restarted.close(); }
  });

  it("preserves the existing mode despite umask and explicitly reports other metadata limitations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-metadata-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "files");
    fs.mkdirSync(directory);
    const target = path.join(directory, "mode.txt");
    fs.writeFileSync(target, "before");
    fs.chmodSync(target, 0o666);
    const tools = editableTools(directory, path.join(root, "spool"));
    const trusted = turn("metadata", "account-a");
    const binding = tools.bindTurn(trusted);
    try {
      const found = await tools.execute({ toolId: "files.find", toolVersion: 2, arguments: {} }, trusted) as { entries: Array<{ fileRef: string }> };
      const read = await tools.execute({ toolId: "files.read", toolVersion: 2,
        arguments: { fileRef: found.entries[0]!.fileRef } }, trusted) as { sha256: string };
      const edited = await tools.execute({ toolId: "files.edit", toolVersion: 1, arguments: {
        fileRef: found.entries[0]!.fileRef, expectedSha256: read.sha256, oldText: "before", newText: "after",
      } }, trusted);
      expect(fs.statSync(target).mode & 0o777).toBe(0o666);
      expect(edited).toMatchObject({ metadataPreservation: { mode: "preserved", other: "not_guaranteed" } });
      await expect(tools.snapshotForSend(trusted, [found.entries[0]!.fileRef])).rejects.toThrow("local_file_content_conflict");
    } finally { await binding.release(); await tools.close(); }
  });

  it("coalesces concurrent identical mutations for one account", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    let durableMutations = 0;
    const tools = editableTools(files, spool, {
      afterMutationDurable: () => { durableMutations += 1; },
    });
    const trusted = turn("event-concurrent-write", "account-a");
    const binding = tools.bindTurn(trusted);
    const scopeRef = binding.promptLines[0]!.split(":", 1)[0]!;
    const request = {
      toolId: "files.write",
      toolVersion: 1,
      arguments: {
        scopeRef,
        relativePath: "concurrent.md",
        content: "one durable mutation",
        overwrite: false,
      },
    } as const;

    const [first, second] = await Promise.all([
      tools.execute(request, trusted),
      tools.execute(request, trusted),
    ]);

    expect(second).toEqual(first);
    expect(durableMutations).toBe(1);
    expect(fs.readFileSync(path.join(files, "concurrent.md"), "utf8")).toBe("one durable mutation");
    await binding.release();
    await tools.close();
  });

  it("preserves an existing UTF-8 BOM and CRLF shape while editing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    const source = path.join(files, "windows.md");
    fs.writeFileSync(source, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("before\r\nline two\r\n", "utf8")]));
    const tools = editableTools(files, spool);
    const trusted = turn("event-bom", "account-a");
    const binding = tools.bindTurn(trusted);
    const found = await tools.execute({
      toolId: "files.find", toolVersion: 2, arguments: { query: "windows.md", match: "literal" },
    }, trusted) as { entries: Array<{ fileRef: string }> };
    const read = await tools.execute({
      toolId: "files.read", toolVersion: 2, arguments: { fileRef: found.entries[0]!.fileRef },
    }, trusted) as { sha256: string };
    await tools.execute({
      toolId: "files.edit",
      toolVersion: 1,
      arguments: {
        fileRef: found.entries[0]!.fileRef,
        expectedSha256: read.sha256,
        oldText: "before\nline two",
        newText: "after\nline three",
      },
    }, trusted);
    expect(fs.readFileSync(source)).toEqual(Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("after\r\nline three\r\n", "utf8"),
    ]));
    await binding.release();
    await tools.close();
  });

  it("reconciles a durable edit after the process loses its result before journal commit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    const databasePath = path.join(root, "operations.sqlite");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "recover.md"), "before");
    let injected = false;
    const first = editableTools(files, spool, {
      operationDatabasePath: databasePath,
      afterMutationDurable: () => {
        if (!injected) {
          injected = true;
          throw new Error("simulated_process_exit");
        }
      },
    });
    const trusted = turn("event-recover", "account-a");
    const firstBinding = first.bindTurn(trusted);
    const firstFound = await first.execute({
      toolId: "files.find", toolVersion: 2, arguments: { query: "recover.md", match: "literal" },
    }, trusted) as { entries: Array<{ fileRef: string }> };
    const before = await first.execute({
      toolId: "files.read", toolVersion: 2, arguments: { fileRef: firstFound.entries[0]!.fileRef },
    }, trusted) as { sha256: string };
    const editArguments = {
      fileRef: firstFound.entries[0]!.fileRef,
      expectedSha256: before.sha256,
      oldText: "before",
      newText: "after",
    };
    await expect(first.execute({ toolId: "files.edit", toolVersion: 1, arguments: editArguments }, trusted))
      .rejects.toThrow("simulated_process_exit");
    expect(fs.readFileSync(path.join(files, "recover.md"), "utf8")).toBe("after");
    await firstBinding.release();
    await first.close();

    const restarted = editableTools(files, spool, { operationDatabasePath: databasePath });
    const restartedBinding = restarted.bindTurn(trusted);
    const foundAfterRestart = await restarted.execute({
      toolId: "files.find", toolVersion: 2, arguments: { query: "recover.md", match: "literal" },
    }, trusted) as { entries: Array<{ fileRef: string }> };
    await expect(restarted.execute({
      toolId: "files.edit",
      toolVersion: 1,
      arguments: { ...editArguments, fileRef: foundAfterRestart.entries[0]!.fileRef },
    }, trusted)).resolves.toMatchObject({ changed: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(fs.readFileSync(path.join(files, "recover.md"), "utf8")).toBe("after");
    await restartedBinding.release();
    await restarted.close();
  });

  it("snapshots selected current-turn references before external send", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    const source = path.join(files, "result.md");
    fs.writeFileSync(source, "first version");
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "notes",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "vault", label: "Vault", directory: files, read: true, write: false }],
      }),
    }, { moduleIds: ["notes"], spoolDirectory: spool });
    const trusted = turn("event-snapshot", "account-a");
    const binding = tools.bindTurn(trusted);
    const found = await tools.execute({
      toolId: "files.find", toolVersion: 2, arguments: { query: "result.md", match: "literal" },
    }, trusted) as { entries: Array<{ fileRef: string }> };

    const [snapshot] = await tools.snapshotForSend(trusted, [found.entries[0]!.fileRef]);
    expect(snapshot).toMatchObject({
      fileName: "result.md",
      sizeBytes: 13,
    });
    expect(path.relative(fs.realpathSync(spool), snapshot!.snapshotPath)).not.toMatch(/^\.\.(?:\/|$)/u);
    expect(snapshot!.snapshotPath).not.toContain("account-a");
    fs.writeFileSync(source, "second version");
    expect(fs.readFileSync(snapshot!.snapshotPath, "utf8")).toBe("first version");
    await expect(tools.snapshotForSend(trusted, [found.entries[0]!.fileRef]))
      .rejects.toThrow("local_file_content_conflict");
    await binding.release();
  });

  it("enforces the durable snapshot quota across calls for one account", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-local-files-"));
    temporaryDirectories.push(root);
    const files = path.join(root, "files");
    const spool = path.join(root, "spool");
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, "one.txt"), "123456");
    fs.writeFileSync(path.join(files, "two.txt"), "abcdef");
    const tools = new LocalFileTools({
      get: () => ({
        moduleId: "notes",
        revision: 1,
        saved: true,
        scopes: [{ scopeId: "vault", label: "Vault", directory: files, read: true, write: false }],
      }),
    }, {
      moduleIds: ["notes"],
      spoolDirectory: spool,
      budget: { maxSnapshotBytes: 10 },
    });
    const trusted = turn("event-snapshot-quota", "account-a");
    const binding = tools.bindTurn(trusted);
    const found = await tools.execute({
      toolId: "files.find", toolVersion: 2, arguments: { query: ".txt", match: "literal", limit: 10 },
    }, trusted) as { entries: Array<{ fileRef: string; fileName: string }> };

    await expect(tools.snapshotForSend(trusted, [found.entries.find((entry) => entry.fileName === "one.txt")!.fileRef]))
      .resolves.toHaveLength(1);
    await expect(tools.snapshotForSend(trusted, [found.entries.find((entry) => entry.fileName === "two.txt")!.fileRef]))
      .rejects.toThrow("local_file_snapshot_quota_exceeded");
    await binding.release();
    await tools.close();
  });
});

function turn(eventKey: string, accountId: string): TrustedWorkflowTurn {
  return {
    eventKey,
    accountId,
    target: "owner@im.wechat",
    occurredAt: 1_788_200_000_000,
    originalTextRef: "filequery_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    attachmentRefs: [],
  };
}

function editableTools(
  files: string,
  spool: string,
  options: { operationDatabasePath?: string; afterMutationDurable?: () => void } = {},
): LocalFileTools {
  return new LocalFileTools({
    get: () => ({
      moduleId: "notes",
      revision: 1,
      saved: true,
      scopes: [{ scopeId: "vault", label: "Vault", directory: files, read: true, write: true }],
    }),
  }, { moduleIds: ["notes"], spoolDirectory: spool, ...options });
}
