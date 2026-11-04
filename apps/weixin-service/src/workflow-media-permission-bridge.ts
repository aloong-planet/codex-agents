import type { MediaExportPublicState } from "./media-export-library.js";
import { MediaExportLibrary } from "./media-export-library.js";
import { WorkflowModulePermissionStore } from "./workflow-module-permission-store.js";

const MODULE_ID = "local-media";

export class WorkflowMediaPermissionBridge {
  constructor(
    private readonly mediaExports: MediaExportLibrary,
    private readonly permissions: WorkflowModulePermissionStore,
  ) {
    this.sync();
  }

  getPublicState(): MediaExportPublicState {
    return this.mediaExports.getPublicState();
  }

  configure(input: { rootIds: string[]; confirmed: boolean }): MediaExportPublicState {
    const state = this.mediaExports.configure(input);
    this.sync();
    return state;
  }

  private sync(): void {
    const scopes = this.mediaExports.getAuthorizedScopes().map((scope) => ({
      ...scope,
      read: true,
      write: false,
    }));
    const current = this.permissions.get(MODULE_ID);
    if (current && sameScopes(current.scopes, scopes)) return;
    this.permissions.save({
      moduleId: MODULE_ID,
      expectedRevision: current?.revision ?? 0,
      confirmed: true,
      scopes,
    });
  }
}

function sameScopes(
  left: Array<{ scopeId: string; label: string; directory: string; read: boolean; write: boolean }>,
  right: Array<{ scopeId: string; label: string; directory: string; read: boolean; write: boolean }>,
): boolean {
  const normalize = (items: typeof left) => [...items].sort((a, b) => a.scopeId.localeCompare(b.scopeId));
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((scope, index) => {
    const candidate = b[index]!;
    return scope.scopeId === candidate.scopeId && scope.label === candidate.label &&
      scope.directory === candidate.directory && scope.read === candidate.read && scope.write === candidate.write;
  });
}
