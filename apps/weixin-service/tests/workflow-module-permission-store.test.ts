import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-module-permissions-"));
  tempDirs.push(root);
  const downloads = path.join(root, "Downloads");
  const pictures = path.join(root, "Pictures");
  fs.mkdirSync(downloads);
  fs.mkdirSync(pictures);
  const databasePath = path.join(root, "state", "permissions.sqlite");
  return { root, downloads, pictures, databasePath };
}

describe("WorkflowModulePermissionStore", () => {
  it("keeps recommended read-only grants as an unsaved draft until the user confirms", async () => {
    const { downloads, pictures, databasePath } = fixture();
    const store = new WorkflowModulePermissionStore(databasePath);

    expect(store.createDraft({ moduleId: "local-media", scopes: [
      { scopeId: "downloads", label: "Downloads", directory: downloads },
      { scopeId: "pictures", label: "Pictures", directory: pictures },
    ] })).toMatchObject({
      moduleId: "local-media", revision: 0, saved: false,
      scopes: [
        { scopeId: "downloads", read: true, write: false },
        { scopeId: "pictures", read: true, write: false },
      ],
    });
    expect(store.get("local-media")).toBeUndefined();

    expect(() => store.save({
      moduleId: "local-media", expectedRevision: 0, confirmed: false,
      scopes: [{ scopeId: "downloads", label: "Downloads", directory: downloads, read: true, write: false }],
    })).toThrow("workflow_module_permission_confirmation_required");
    expect(store.get("local-media")).toBeUndefined();

    const saved = store.save({
      moduleId: "local-media", expectedRevision: 0, confirmed: true,
      scopes: [
        { scopeId: "downloads", label: "Downloads", directory: downloads, read: true, write: false },
        { scopeId: "pictures", label: "Pictures", directory: pictures, read: true, write: false },
      ],
    });
    expect(saved).toMatchObject({ moduleId: "local-media", revision: 1, saved: true });
    await store.close();

    const reopened = new WorkflowModulePermissionStore(databasePath);
    expect(reopened.get("local-media")).toEqual(saved);
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    await reopened.close();
  });

  it("includes read in write grants and applies the most specific directory policy", async () => {
    const { downloads, databasePath } = fixture();
    const privateDirectory = path.join(downloads, "Private");
    fs.mkdirSync(privateDirectory);
    const publicFile = path.join(downloads, "public.txt");
    const privateFile = path.join(privateDirectory, "private.txt");
    fs.writeFileSync(publicFile, "public");
    fs.writeFileSync(privateFile, "private");
    const store = new WorkflowModulePermissionStore(databasePath);
    store.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [
        { scopeId: "downloads", label: "Downloads", directory: downloads, read: true, write: false },
        { scopeId: "private", label: "Private", directory: privateDirectory, read: false, write: true },
      ],
    });

    expect(() => store.assertAllowed({
      moduleId: "notes", access: "read", scopeId: "downloads", absolutePath: publicFile,
    })).not.toThrow();
    expect(() => store.assertAllowed({
      moduleId: "notes", access: "read", scopeId: "downloads", absolutePath: privateFile,
    })).toThrow("workflow_module_permission_denied");
    expect(() => store.assertAllowed({
      moduleId: "notes", access: "write", scopeId: "private", absolutePath: privateFile,
    })).not.toThrow();
    expect(() => store.assertAllowed({
      moduleId: "notes", access: "read", scopeId: "private", absolutePath: privateFile,
    })).not.toThrow();
    expect(() => store.assertAllowed({
      moduleId: "notes", access: "write", scopeId: "downloads", absolutePath: publicFile,
    })).toThrow("workflow_module_permission_denied");
    await store.close();
  });

  it("upgrades persisted write-only grants once and invalidates their old revision", async () => {
    const { downloads, pictures, databasePath } = fixture();
    const original = new WorkflowModulePermissionStore(databasePath);
    original.save({ moduleId: "notes", expectedRevision: 0, confirmed: true, scopes: [
      { scopeId: "downloads", label: "Downloads", directory: downloads, read: true, write: true },
      { scopeId: "pictures", label: "Pictures", directory: pictures, read: false, write: false },
    ] });
    await original.close();
    // Persisted input from the earlier independent-read/write schema, not live store state.
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("UPDATE workflow_module_scope SET can_read = 0 WHERE scope_id = 'downloads'");
    legacy.close();

    const migrated = new WorkflowModulePermissionStore(databasePath);
    expect(migrated.get("notes")).toMatchObject({ revision: 2, scopes: [
      { scopeId: "downloads", read: true, write: true },
      { scopeId: "pictures", read: false, write: false },
    ] });
    expect(() => migrated.assertAllowed({ moduleId: "notes", access: "read", scopeId: "downloads" })).not.toThrow();
    expect(() => migrated.save({ moduleId: "notes", expectedRevision: 1, confirmed: true, scopes: [] }))
      .toThrow("workflow_module_permission_revision_conflict");
    await migrated.close();
    const reopened = new WorkflowModulePermissionStore(databasePath);
    expect(reopened.get("notes")?.revision).toBe(2);
    await reopened.close();
  });

  it("rejects symlink escape and any attempt to request execute access", async () => {
    const { root, downloads, databasePath } = fixture();
    const outside = path.join(root, "outside.txt");
    const link = path.join(downloads, "escape.txt");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, link);
    const store = new WorkflowModulePermissionStore(databasePath);
    store.save({
      moduleId: "local-media", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "downloads", label: "Downloads", directory: downloads, read: true, write: false }],
    });

    expect(() => store.assertAllowed({
      moduleId: "local-media", access: "read", scopeId: "downloads", absolutePath: link,
    })).toThrow("workflow_module_permission_denied");
    expect(() => store.assertAllowed({
      moduleId: "local-media", access: "execute" as "read", scopeId: "downloads",
    })).toThrow("workflow_module_execute_forbidden");
    await store.close();
  });

  it("authorizes a not-yet-created descendant from its nearest existing ancestor", async () => {
    const { downloads, databasePath } = fixture();
    const store = new WorkflowModulePermissionStore(databasePath);
    store.save({
      moduleId: "notes", expectedRevision: 0, confirmed: true,
      scopes: [{ scopeId: "downloads", label: "Downloads", directory: downloads, read: false, write: true }],
    });

    expect(() => store.assertAllowed({
      moduleId: "notes", access: "write", scopeId: "downloads",
      absolutePath: path.join(downloads, "new", "nested", "note.md"),
    })).not.toThrow();
    await store.close();
  });

  it("uses revision CAS, merges identical duplicate directories, and persists revocation", async () => {
    const { downloads, databasePath } = fixture();
    const store = new WorkflowModulePermissionStore(databasePath);
    const first = store.save({
      moduleId: "local-media", expectedRevision: 0, confirmed: true,
      scopes: [
        { scopeId: "z-downloads", label: "Downloads copy", directory: downloads, read: true, write: false },
        { scopeId: "a-downloads", label: "Downloads", directory: downloads, read: true, write: false },
      ],
    });
    expect(first).toMatchObject({ revision: 1, scopes: [{ scopeId: "a-downloads" }] });
    expect(() => store.save({
      moduleId: "local-media", expectedRevision: 0, confirmed: true, scopes: [],
    })).toThrow("workflow_module_permission_revision_conflict");
    expect(store.get("local-media")?.revision).toBe(1);

    expect(store.save({
      moduleId: "local-media", expectedRevision: 1, confirmed: true, scopes: [],
    })).toEqual({ moduleId: "local-media", revision: 2, saved: true, scopes: [] });
    expect(() => store.assertAllowed({
      moduleId: "local-media", access: "read", scopeId: "a-downloads",
    })).toThrow("workflow_module_permission_denied");
    await store.close();
  });
});
