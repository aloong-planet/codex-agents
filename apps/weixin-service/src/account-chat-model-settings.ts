export type CodexReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return typeof value === "string" && ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value);
}
export type ChatModelTrack = "fast" | "balanced" | "quality";

export type ChatModelSelection =
  | { mode: "track"; track: ChatModelTrack; effort: CodexReasoningEffort }
  | { mode: "pinned"; model: string; effort: CodexReasoningEffort };

export type ChatModelSetting = {
  accountId: string;
  selection: ChatModelSelection;
  revision: number;
  updatedAt: number;
};

export type CodexModelDescriptor = {
  model: string;
  displayName: string;
  hidden: boolean;
  inputModalities: readonly string[];
  supportedReasoningEfforts: readonly CodexReasoningEffort[];
  defaultReasoningEffort: CodexReasoningEffort;
  upgrade?: string;
};

export type ChatModelCatalog = { fetchedAt: number; models: CodexModelDescriptor[] };
export type ResolvedChatModel =
  | { available: true; model: string; effort: CodexReasoningEffort; configRevision: number; source: "track" | "pinned"; track?: ChatModelTrack; degraded?: true }
  | { available: false; reason: "pinned_model_unavailable" | "track_unavailable" | "effort_unsupported"; configRevision: number; source: "track" | "pinned" };

const TRACK_MODELS: Record<ChatModelTrack, readonly string[]> = {
  fast: ["gpt-5.6-luna"],
  balanced: ["gpt-5.6-terra"],
  quality: ["gpt-5.6-sol"],
};

const DEFAULT_SELECTION: ChatModelSelection = { mode: "track", track: "fast", effort: "low" };

export function builtInChatModelCatalog(): ChatModelCatalog {
  return {
    fetchedAt: 0,
    models: [
      { model: "gpt-5.6-luna", displayName: "Luna", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" },
      { model: "gpt-5.6-terra", displayName: "Terra", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "medium" },
      { model: "gpt-5.6-sol", displayName: "Sol", hidden: false, inputModalities: ["text"], supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "medium" },
    ],
  };
}

export class AccountChatModelSettings {
  private settings: ChatModelSetting[];
  private catalog: ChatModelCatalog;

  constructor(settings: ChatModelSetting[], catalog: ChatModelCatalog) {
    this.settings = structuredClone(settings);
    this.catalog = this.sanitizeCatalog(catalog);
  }

  configure(accountId: string, selection: ChatModelSelection, updatedAt: number): ChatModelSetting {
    const model = selection.mode === "pinned"
      ? this.catalog.models.find((candidate) => candidate.model === selection.model)
      : this.firstTrackModel(selection.track);
    if (!model) throw new Error(selection.mode === "pinned" ? "所选模型当前不可用" : "所选自动档位当前不可用");
    if (!model.supportedReasoningEfforts.includes(selection.effort)) {
      throw new Error("模型不支持所选推理强度");
    }
    const current = this.settings.find((item) => item.accountId === accountId);
    const next: ChatModelSetting = {
      accountId,
      selection: structuredClone(selection),
      revision: (current?.revision ?? 0) + 1,
      updatedAt,
    };
    this.settings = [...this.settings.filter((item) => item.accountId !== accountId), next];
    return structuredClone(next);
  }

  resolve(accountId: string): ResolvedChatModel {
    const setting = this.settings.find((item) => item.accountId === accountId);
    const selection = setting?.selection ?? DEFAULT_SELECTION;
    const model = selection.mode === "pinned"
      ? this.catalog.models.find((candidate) => candidate.model === selection.model)
      : this.firstTrackModel(selection.track);
    if (!model) {
      return {
        available: false,
        reason: selection.mode === "pinned" ? "pinned_model_unavailable" : "track_unavailable",
        configRevision: setting?.revision ?? 0,
        source: selection.mode,
      };
    }
    if (!model.supportedReasoningEfforts.includes(selection.effort)) {
      if (selection.mode === "track" && model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)) {
        return { available: true, model: model.model, effort: model.defaultReasoningEffort, configRevision: setting?.revision ?? 0, source: "track", track: selection.track, degraded: true };
      }
      return {
        available: false,
        reason: "effort_unsupported",
        configRevision: setting?.revision ?? 0,
        source: selection.mode,
      };
    }
    return {
      available: true,
      model: model.model,
      effort: selection.effort,
      configRevision: setting?.revision ?? 0,
      source: selection.mode,
      ...(selection.mode === "track" ? { track: selection.track } : {}),
    };
  }

  replaceCatalog(catalog: ChatModelCatalog): void {
    this.catalog = this.sanitizeCatalog(catalog);
  }

  snapshot(): { settings: ChatModelSetting[]; catalog: ChatModelCatalog } {
    return structuredClone({ settings: this.settings, catalog: this.catalog });
  }

  publicState(accountId?: string): { selection: ChatModelSelection; revision: number; resolved: ResolvedChatModel; catalog: ChatModelCatalog } {
    const setting = accountId ? this.settings.find((item) => item.accountId === accountId) : undefined;
    return {
      selection: structuredClone(setting?.selection ?? DEFAULT_SELECTION),
      revision: setting?.revision ?? 0,
      resolved: this.resolve(accountId ?? ""),
      catalog: structuredClone(this.catalog),
    };
  }

  private firstTrackModel(track: ChatModelTrack): CodexModelDescriptor | undefined {
    for (const id of TRACK_MODELS[track]) {
      const model = this.catalog.models.find((candidate) => candidate.model === id && !candidate.upgrade);
      if (model) return model;
    }
    return undefined;
  }

  private sanitizeCatalog(catalog: ChatModelCatalog): ChatModelCatalog {
    return {
      fetchedAt: catalog.fetchedAt,
      models: catalog.models.filter((model) =>
        !model.hidden && model.inputModalities.includes("text") && model.supportedReasoningEfforts.length > 0,
      ).map((model) => ({ ...model, inputModalities: [...model.inputModalities], supportedReasoningEfforts: [...model.supportedReasoningEfforts] })),
    };
  }
}
