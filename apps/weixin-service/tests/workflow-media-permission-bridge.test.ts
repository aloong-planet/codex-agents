import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MediaExportLibrary } from "../src/media-export-library.js";
import { WorkflowMediaPermissionBridge } from "../src/workflow-media-permission-bridge.js";
import { WorkflowModulePermissionStore } from "../src/workflow-module-permission-store.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("WorkflowMediaPermissionBridge", () => {
  it("mirrors configured media roots into read-only workflow scopes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-media-permission-"));
    directories.push(root);
    const home = path.join(root, "home");
    fs.mkdirSync(path.join(home, "Downloads"), { recursive: true });
    fs.mkdirSync(path.join(home, "Pictures"), { recursive: true });
    fs.mkdirSync(path.join(home, "Documents"), { recursive: true });
    const library = new MediaExportLibrary(path.join(root, "media.json"), home);
    const permissions = new WorkflowModulePermissionStore(path.join(root, "permissions.sqlite"));
    const bridge = new WorkflowMediaPermissionBridge(library, permissions);

    bridge.configure({ rootIds: ["pictures", "downloads"], confirmed: true });

    expect(permissions.get("local-media")).toMatchObject({
      saved: true,
      scopes: [
        { scopeId: "downloads", label: "Downloads", read: true, write: false },
        { scopeId: "pictures", label: "Pictures", read: true, write: false },
      ],
    });

    bridge.configure({ rootIds: [], confirmed: true });
    expect(permissions.get("local-media")?.scopes).toEqual([]);
  });
});
