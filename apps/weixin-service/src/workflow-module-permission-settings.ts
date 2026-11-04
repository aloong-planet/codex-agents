import fs from "node:fs";

import type {
  WorkflowModulePermissionScope,
  WorkflowModulePermissionState,
  WorkflowModulePermissionStore,
} from "./workflow-module-permission-store.js";

export type WorkflowModuleDefinition = {
  moduleId: string;
  name: string;
  description: string;
  scopes: Array<{ scopeId: string; label: string; directory: string }>;
};

export type PublicWorkflowModulePermissionState = {
  executeAllowed: false;
  modules: Array<WorkflowModulePermissionState & { name: string; description: string }>;
};

export type WorkflowModulePermissionSelection = {
  moduleId: string;
  expectedRevision: number;
  confirmed: boolean;
  scopes: Array<{ scopeId: string; read: boolean; write: boolean }>;
};

export class WorkflowModulePermissionSettings {
  private readonly definitions = new Map<string, WorkflowModuleDefinition>();

  constructor(
    private readonly store: WorkflowModulePermissionStore,
    definitions: WorkflowModuleDefinition[],
    private readonly onReadNarrowed: () => void = () => {},
  ) {
    for (const definition of definitions) {
      if (this.definitions.has(definition.moduleId)) throw new Error("workflow_module_definition_duplicate");
      this.definitions.set(definition.moduleId, structuredClone(definition));
    }
  }

  getPublicState(): PublicWorkflowModulePermissionState {
    return {
      executeAllowed: false,
      modules: [...this.definitions.values()].map((definition) => this.publicModule(definition)),
    };
  }

  configure(input: WorkflowModulePermissionSelection): PublicWorkflowModulePermissionState {
    const definition = this.definitions.get(input.moduleId);
    if (!definition) throw new Error("workflow_module_permission_module_unknown");
    const candidates = new Map(definition.scopes.map((scope) => [scope.scopeId, scope]));
    if (input.scopes.length !== candidates.size) throw new Error("workflow_module_permission_scope_unknown");
    const scopes: WorkflowModulePermissionScope[] = input.scopes.map((selection) => {
      const candidate = candidates.get(selection.scopeId);
      if (!candidate) throw new Error("workflow_module_permission_scope_unknown");
      return { ...candidate, read: selection.read || selection.write, write: selection.write };
    });
    if (new Set(input.scopes.map((scope) => scope.scopeId)).size !== input.scopes.length) {
      throw new Error("workflow_module_permission_scope_unknown");
    }
    const previous = this.store.get(input.moduleId);
    if (previous && readScopeWasNarrowed(previous.scopes, scopes)) {
      this.onReadNarrowed();
    }
    this.store.save({
      moduleId: input.moduleId,
      expectedRevision: input.expectedRevision,
      confirmed: input.confirmed,
      scopes,
    });
    return this.getPublicState();
  }

  private publicModule(
    definition: WorkflowModuleDefinition,
  ): WorkflowModulePermissionState & { name: string; description: string } {
    const current = this.store.get(definition.moduleId);
    if (!current) {
      return {
        ...this.store.createDraft({ moduleId: definition.moduleId, scopes: definition.scopes }),
        name: definition.name,
        description: definition.description,
      };
    }
    let matchesSavedDefinition = current.scopes.length === definition.scopes.length;
    const scopes = definition.scopes.map((candidate) => {
      const directory = fs.realpathSync(candidate.directory);
      const saved = current.scopes.find((scope) =>
        scope.scopeId === candidate.scopeId && scope.directory === directory);
      if (!saved) matchesSavedDefinition = false;
      return {
        ...candidate,
        directory,
        read: saved?.read ?? true,
        write: saved?.write ?? false,
      };
    });
    return {
      moduleId: definition.moduleId,
      revision: current.revision,
      saved: matchesSavedDefinition,
      scopes,
      name: definition.name,
      description: definition.description,
    };
  }
}

function readScopeWasNarrowed(
  previous: WorkflowModulePermissionScope[],
  next: WorkflowModulePermissionScope[],
): boolean {
  const nextReadablePaths = new Set(next.filter((scope) => scope.read).map((scope) => fs.realpathSync(scope.directory)));
  return previous.some((scope) => scope.read && !nextReadablePaths.has(scope.directory));
}
