import { describe, expect, it } from "vitest";

import {
  WorkflowToolCatalog,
  createProductionWorkflowToolCatalog,
  type WorkflowToolMember,
} from "../src/workflow-tool-catalog.js";

describe("tool_catalog_contract_regression", () => {
  // Contract publication guard only; live fixture outbox assertions verify model behavior.
  it("publishes cross-page accumulation and single terminal submission guidance", () => {
    const catalog = createProductionWorkflowToolCatalog({ files: true, media: true, directFiles: true });
    for (const id of ["files.find", "files.grep"]) {
      const description = catalog.members().find((member) => member.id === id)!.description;
      expect(description).toContain("每一页");
      expect(description).toContain("最后一页");
      expect(description).toContain("不是累计");
    }
    for (const id of ["weixin.send_files", "media.send"]) {
      const description = catalog.members().find((member) => member.id === id)!.description;
      expect(description).toContain("跨页");
      expect(description).toContain("一次调用");
      expect(description).toContain("部分");
    }
  });

  it.each(["files.find", "files.grep"])("%s rejects unsupported brace globs instead of reporting a false empty search", (tool) => {
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
    const base = tool === "files.grep" ? { pattern: "album" } : { query: "album" };
    for (const field of ["include", "exclude"]) {
      expect(catalog.accepts(tool, 2, { ...base, [field]: ["**/*.{png,jpg,jpeg,webp,gif,heic}"] })).toBe(false);
      expect(catalog.accepts(tool, 2, { ...base, [field]: ["**/*.png", "**/*.jpg"] })).toBe(true);
      expect(catalog.validationIssues(tool, 2, { ...base, [field]: ["*.{png,jpg}"] }))
        .toContain(`/${field}/0:pattern`);
    }
  });

  it("keeps local operations and schedules while delivery is unavailable", () => {
    const catalog = createProductionWorkflowToolCatalog({ files: true, media: true, directFiles: true, schedules: true, delivery: false });
    expect(catalog.memberIds().filter((id) => id.startsWith("files."))).toEqual([
      "files.edit", "files.find", "files.grep", "files.read", "files.write",
    ]);
    expect(catalog.memberIds()).toContain("schedules.create");
    expect(catalog.memberIds()).not.toContain("weixin.send_files");
    expect(catalog.memberIds()).not.toContain("media.send");
  });

  it("registers an inline query without requiring a workflow template", () => {
    const catalog = new WorkflowToolCatalog([{
      id: "files.find",
      version: 2,
      description: "Find authorized files by name or relative path.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
      },
      executionClass: "inline_query",
    }]);

    expect(catalog.members()).toEqual([{
      id: "files.find",
      version: 2,
      description: "Find authorized files by name or relative path.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string" } },
      },
      executionClass: "inline_query",
    }]);
  });

  it("does not expose retired Resolver-backed tool members", () => {
    const catalog = createProductionWorkflowToolCatalog({ files: true, media: true });

    expect(catalog.memberIds()).toEqual([]);
    expect(catalog.definitions()).toEqual([]);
  });

  it("uses only the enabled model-visible contract to calculate a deterministic hash", () => {
    const first = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
    const second = new WorkflowToolCatalog([...first.members()].reverse());
    expect(first.memberIds()).toContain("files.find");
    expect(first.contractHash()).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.contractHash()).toBe(first.contractHash());
  });

  it.each(["id", "version", "description", "inputSchema"] as const)(
    "changes the hash when only %s changes within the full enabled catalog",
    (field) => {
      const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
      const replacements = {
        id: "files.finder", version: 3, description: "Find authorized files with a revised description.",
        inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 256 } } },
      };
      const changed = new WorkflowToolCatalog(catalog.members().map((member): WorkflowToolMember =>
        member.id === "files.find" ? { ...member, [field]: replacements[field] } : member));
      expect(catalog.members()).toHaveLength(6);
      expect(changed.members()).toHaveLength(6);
      expect(changed.contractHash()).not.toBe(catalog.contractHash());
    },
  );

  it("exposes direct query and mutation tools with their execution classes", () => {
    const catalog = createProductionWorkflowToolCatalog({
      files: false,
      media: false,
      directFiles: true,
    });

    expect(catalog.memberIds()).toEqual(["files.edit", "files.find", "files.grep", "files.read", "files.write", "weixin.send_files"]);
    expect(catalog.members().map((member) => member.executionClass)).toEqual([
      "inline_mutation",
      "inline_query",
      "inline_query",
      "inline_query",
      "inline_mutation",
      "terminal_workflow",
    ]);
    expect(JSON.stringify(catalog.definitions())).not.toContain("templateId");
    expect(catalog.accepts("weixin.send_files", 1, {
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    })).toBe(true);
    expect(catalog.accepts("weixin.send_files", 1, {
      disposition: "needs_choice",
      candidateRefs: [
        "fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "fileref_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ],
      allowMultiple: true,
    })).toBe(true);
    expect(catalog.accepts("weixin.send_files", 1, {
      disposition: "selected",
      fileRefs: [],
    })).toBe(false);
    expect(catalog.accepts("weixin.send_files", 1, {
      disposition: "needs_choice",
      candidateRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      allowMultiple: false,
    })).toBe(false);
  });

  it("keeps contextual media sources and accepts only selected local file references", () => {
    const catalog = createProductionWorkflowToolCatalog({ files: true, media: true, directFiles: true });

    expect(catalog.memberIds()).toEqual([
      "files.edit",
      "files.find",
      "files.grep",
      "files.read",
      "files.write",
      "media.send",
      "weixin.send_files",
    ]);
    expect(catalog.memberIds()).not.toContain("files.send");
    expect(catalog.accepts("media.send", 1, { kind: "image", source: "current" })).toBe(true);
    expect(catalog.accepts("media.send", 1, {
      kind: "image",
      source: "local",
      disposition: "selected",
      fileRefs: ["fileref_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
    })).toBe(true);
    expect(catalog.accepts("media.send", 1, { kind: "image", source: "local", root: "pictures" })).toBe(false);
    const media = catalog.definitions().find((definition) => definition.name === "media");
    const weixin = catalog.definitions().find((definition) => definition.name === "weixin");
    const files = catalog.definitions().find((definition) => definition.name === "files");
    expect(JSON.stringify(media)).toContain("files.find");
    expect(JSON.stringify(media)).toContain("图片");
    expect(JSON.stringify(media)).not.toContain("any_authorized");
    expect(JSON.stringify(weixin)).toContain("非图片");
    expect(JSON.stringify(files)).toContain("更短的区分性名称或路径词");
  });

  it("fails closed when a registered member contains an unsupported nested schema type", () => {
    const catalog = new WorkflowToolCatalog([{
      id: "files.inspect",
      version: 1,
      description: "Inspect one authorized file.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "unsupported" } },
      },
      executionClass: "inline_query",
    }]);

    expect(catalog.accepts("files.inspect", 1, { query: "secret" })).toBe(false);
  });

  it("enforces the complete registered schema instead of a hand-written keyword subset", () => {
    const catalog = new WorkflowToolCatalog([{
      id: "weixin.send_files",
      version: 1,
      description: "Send selected file references.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["fileRefs"],
        properties: {
          fileRefs: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string" },
          },
        },
      },
      executionClass: "terminal_workflow",
      effectClass: "external_send",
      templateId: "weixin.send-files",
    }]);

    expect(catalog.accepts("weixin.send_files", 1, { fileRefs: [] })).toBe(false);
    expect(catalog.accepts("weixin.send_files", 1, { fileRefs: ["ref-1", "ref-1"] })).toBe(false);
    expect(catalog.accepts("weixin.send_files", 1, { fileRefs: ["ref-1"] })).toBe(true);
  });

  it("requires CAS inputs for edits and explicit overwrite state for writes", () => {
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
    expect(catalog.accepts("files.edit", 1, {
      fileRef: "ref-1",
      expectedSha256: "a".repeat(64),
      oldText: "before",
      newText: "after",
    })).toBe(true);
    expect(catalog.accepts("files.edit", 1, {
      fileRef: "ref-1",
      oldText: "before",
      newText: "after",
    })).toBe(false);
    expect(catalog.accepts("files.write", 1, {
      scopeRef: "scope-1",
      relativePath: "notes/new.md",
      content: "hello",
      overwrite: false,
    })).toBe(true);
    expect(catalog.accepts("files.write", 1, {
      scopeRef: "scope-1",
      relativePath: "notes/new.md",
      content: "hello",
      overwrite: true,
    })).toBe(false);
    expect(catalog.accepts("files.write", 1, {
      scopeRef: "scope-1",
      relativePath: "notes/existing.md",
      content: "hello",
      overwrite: true,
      expectedSha256: "b".repeat(64),
    })).toBe(true);
  });

  it("identifies missing known write fields without echoing unknown argument names or values", () => {
    const catalog = createProductionWorkflowToolCatalog({ files: false, media: false, directFiles: true });
    const issues = catalog.validationIssues("files.write", 1, {
      relativePath: "new.md", content: "private content", "private-secret-key": "secret",
    });
    expect(issues).toContain("/scopeRef:required");
    expect(issues).toContain("/overwrite:required");
    expect(JSON.stringify(issues)).not.toContain("private");
    expect(JSON.stringify(issues)).not.toContain("secret");
  });
});
