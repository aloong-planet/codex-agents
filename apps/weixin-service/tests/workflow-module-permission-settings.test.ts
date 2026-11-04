import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkflowModulePermissionSettings } from "../src/workflow-module-permission-settings.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";

describe("WorkflowModulePermissionSettings", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("presents read-only install defaults without granting them until the user saves", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-module-settings-"));
    roots.push(root);
    const vault = path.join(root, "vault");
    fs.mkdirSync(vault);
    const store = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const settings = new WorkflowModulePermissionSettings(store, [{
      moduleId: "notes",
      name: "Obsidian 笔记",
      description: "搜索、读取、新建和修改已授权目录中的 Markdown 文件",
      scopes: [{ scopeId: "demo-vault", label: "demo Vault", directory: vault }],
    }]);

    expect(settings.getPublicState()).toEqual({
      executeAllowed: false,
      modules: [{
        moduleId: "notes",
        name: "Obsidian 笔记",
        description: "搜索、读取、新建和修改已授权目录中的 Markdown 文件",
        revision: 0,
        saved: false,
        scopes: [{ scopeId: "demo-vault", label: "demo Vault", directory: vault, read: true, write: false }],
      }],
    });
    expect(() => store.assertAllowed({ moduleId: "notes", access: "read", scopeId: "demo-vault" }))
      .toThrow("workflow_module_permission_denied");

    const saved = settings.configure({
      moduleId: "notes",
      expectedRevision: 0,
      confirmed: true,
      scopes: [{ scopeId: "demo-vault", read: true, write: true }],
    });

    expect(saved.modules[0]).toMatchObject({ revision: 1, saved: true });
    expect(saved.modules[0]?.scopes[0]).toMatchObject({ read: true, write: true });
    expect(() => store.assertAllowed({ moduleId: "notes", access: "write", scopeId: "demo-vault" }))
      .not.toThrow();
    await store.close();
  });

  it("rejects unknown scopes instead of accepting browser-supplied directories", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-module-settings-"));
    roots.push(root);
    const vault = path.join(root, "vault");
    fs.mkdirSync(vault);
    const store = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const settings = new WorkflowModulePermissionSettings(store, [{
      moduleId: "notes", name: "Notes", description: "Notes",
      scopes: [{ scopeId: "vault", label: "Vault", directory: vault }],
    }]);

    expect(() => settings.configure({
      moduleId: "notes",
      expectedRevision: 0,
      confirmed: true,
      scopes: [{ scopeId: "other", read: true, write: false }],
    })).toThrow("workflow_module_permission_scope_unknown");
    await store.close();
  });

  it("shows newly registered directories as an unsaved read-only draft after a module upgrade", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-module-settings-"));
    roots.push(root);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const store = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    store.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "first", label: "First", directory: first, read: true, write: true }],
    });
    const upgraded = new WorkflowModulePermissionSettings(store, [{
      moduleId: "notes", name: "Notes", description: "Notes",
      scopes: [
        { scopeId: "first", label: "First renamed", directory: first },
        { scopeId: "second", label: "Second", directory: second },
      ],
    }]);

    expect(upgraded.getPublicState().modules[0]).toMatchObject({
      revision: 1,
      saved: false,
      scopes: [
        { scopeId: "first", label: "First renamed", read: true, write: true },
        { scopeId: "second", label: "Second", read: true, write: false },
      ],
    });
    expect(() => store.assertAllowed({ moduleId: "notes", access: "read", scopeId: "second" }))
      .toThrow("workflow_module_permission_denied");
    await store.close();
  });

  it("reports only saved read-scope narrowing to the access-context owner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-module-settings-"));
    roots.push(root);
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    const store = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const onReadNarrowed = vi.fn();
    const settings = new WorkflowModulePermissionSettings(store, [{
      moduleId: "notes", name: "Notes", description: "Notes",
      scopes: [
        { scopeId: "first", label: "First", directory: first },
        { scopeId: "second", label: "Second", directory: second },
      ],
    }], onReadNarrowed);

    settings.configure({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [
        { scopeId: "first", read: true, write: false },
        { scopeId: "second", read: false, write: false },
      ],
    });
    settings.configure({
      moduleId: "notes", expectedRevision: 1, confirmed: true,
      scopes: [
        { scopeId: "first", read: true, write: true },
        { scopeId: "second", read: true, write: false },
      ],
    });
    expect(onReadNarrowed).not.toHaveBeenCalled();

    settings.configure({
      moduleId: "notes", expectedRevision: 2, confirmed: true,
      scopes: [
        { scopeId: "first", read: false, write: true },
        { scopeId: "second", read: true, write: false },
      ],
    });
    expect(settings.getPublicState().modules[0]?.scopes[0]).toMatchObject({ read: true, write: true });
    expect(onReadNarrowed).not.toHaveBeenCalled();
    expect(() => store.assertAllowed({ moduleId: "notes", access: "read", scopeId: "first" })).not.toThrow();

    settings.configure({
      moduleId: "notes", expectedRevision: 3, confirmed: true,
      scopes: [
        { scopeId: "first", read: false, write: false },
        { scopeId: "second", read: true, write: false },
      ],
    });
    expect(onReadNarrowed).toHaveBeenCalledTimes(1);
    await store.close();
  });
});
