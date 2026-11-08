export type ModelSafeDemoState = {
  phase: string;
  notice: string;
  accounts: unknown[];
  targets: unknown[];
  selectedAccountId?: string | null;
  selectedTarget?: string | null;
  codex?: {
    status: string;
    threadReady: boolean;
    enabledTargets: Array<{ accountId: string; target: string }>;
    notice: string;
    permissions?: {
      onboardingCompleted: boolean;
      mode: "safe" | "guarded_plus" | "advanced_controlled";
      restrictedReadSupported: boolean;
      selectedRoots: Array<{ id: string; displayName: string }>;
      revision: number;
      pendingCount: number;
    };
  };
};

export type DemoStateResult = {
  modelState: ModelSafeDemoState;
  privateUi: {
    qrDataUrl: string | null;
    permissionCandidates: Array<{ id: string; displayName: string; path: string }>;
  };
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function requireLoopbackBaseUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("微信 Demo 地址必须是本机 HTTP loopback");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("微信 Demo 地址格式无效");
  }
  return url.origin;
}

function optionalProperty<T extends object, K extends string>(
  source: T,
  key: K,
): Record<K, unknown> | Record<string, never> {
  return key in source ? ({ [key]: source[key as unknown as keyof T] } as Record<K, unknown>) : {};
}

function parsePublicState(value: unknown): DemoStateResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("微信 Demo 返回了无效状态");
  }
  const state = value as Record<string, unknown>;
  if (
    typeof state.phase !== "string" ||
    typeof state.notice !== "string" ||
    !Array.isArray(state.accounts) ||
    !Array.isArray(state.targets)
  ) {
    throw new Error("微信 Demo 状态缺少必要字段");
  }
  const qrDataUrl =
    typeof state.qrDataUrl === "string" && state.qrDataUrl.startsWith("data:image/png;base64,")
      ? state.qrDataUrl
      : null;
  const codexValue = state.codex && typeof state.codex === "object" && !Array.isArray(state.codex)
    ? state.codex as Record<string, unknown>
    : null;
  const permissionsValue = codexValue?.permissions &&
    typeof codexValue.permissions === "object" && !Array.isArray(codexValue.permissions)
    ? codexValue.permissions as Record<string, unknown>
    : null;
  const capabilityValue = permissionsValue?.capability &&
    typeof permissionsValue.capability === "object" && !Array.isArray(permissionsValue.capability)
    ? permissionsValue.capability as Record<string, unknown>
    : null;
  const permissionCandidates = Array.isArray(permissionsValue?.candidates)
    ? permissionsValue.candidates.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const candidate = value as Record<string, unknown>;
        return typeof candidate.id === "string" &&
          typeof candidate.displayName === "string" &&
          typeof candidate.path === "string"
          ? [{ id: candidate.id, displayName: candidate.displayName, path: candidate.path }]
          : [];
      })
    : [];
  const permissionModes = ["safe", "guarded_plus", "advanced_controlled"] as const;
  const permissions = permissionsValue &&
    typeof permissionsValue.onboardingCompleted === "boolean" &&
    typeof permissionsValue.mode === "string" &&
    permissionModes.includes(permissionsValue.mode as typeof permissionModes[number]) &&
    typeof capabilityValue?.restrictedReadSupported === "boolean" &&
    Array.isArray(permissionsValue.selectedRoots) &&
    Number.isSafeInteger(permissionsValue.revision) &&
    Number.isSafeInteger(permissionsValue.pendingCount)
    ? {
        onboardingCompleted: permissionsValue.onboardingCompleted,
        mode: permissionsValue.mode as typeof permissionModes[number],
        restrictedReadSupported: capabilityValue.restrictedReadSupported,
        selectedRoots: permissionsValue.selectedRoots.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const selected = value as Record<string, unknown>;
          return typeof selected.id === "string" && typeof selected.displayName === "string"
            ? [{ id: selected.id, displayName: selected.displayName }]
            : [];
        }),
        revision: permissionsValue.revision as number,
        pendingCount: permissionsValue.pendingCount as number,
      }
    : undefined;
  const codex = codexValue &&
    typeof codexValue.status === "string" &&
    typeof codexValue.threadReady === "boolean" &&
    typeof codexValue.notice === "string" &&
    Array.isArray(codexValue.enabledTargets)
    ? {
        status: codexValue.status,
        threadReady: codexValue.threadReady,
        enabledTargets: codexValue.enabledTargets.flatMap((value) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const item = value as Record<string, unknown>;
          return typeof item.accountId === "string" && typeof item.target === "string"
            ? [{ accountId: item.accountId, target: item.target }]
            : [];
        }),
        notice: codexValue.notice,
        ...(permissions ? { permissions } : {}),
      }
    : undefined;
  return {
    modelState: {
      phase: state.phase,
      notice: state.notice,
      accounts: state.accounts,
      targets: state.targets,
      ...optionalProperty(state, "selectedAccountId"),
      ...optionalProperty(state, "selectedTarget"),
      ...(codex ? { codex } : {}),
    },
    privateUi: { qrDataUrl, permissionCandidates },
  } as DemoStateResult;
}

export class DemoHttpClient {
  private readonly baseUrl: string;
  private credential: Promise<string> | undefined;

  /**
   * `authorize` returns the console cookie (`name=value`) for the local service. The credential is kept in
   * memory only; a 401 means it was revoked or replaced, so the client authorizes once more and retries.
   */
  constructor(
    baseUrl = "http://127.0.0.1:4317",
    private readonly fetchFn: FetchLike = fetch,
    private readonly authorize?: () => Promise<string>,
  ) {
    this.baseUrl = requireLoopbackBaseUrl(baseUrl);
  }

  async getState(): Promise<DemoStateResult> {
    const response = await this.send(`${this.baseUrl}/api/state`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`微信 Demo 状态请求失败（HTTP ${response.status}）`);
    return parsePublicState(await response.json());
  }

  async startLogin(): Promise<DemoStateResult> {
    return this.post("/api/login/start", {});
  }

  async submitPairCode(code: string): Promise<DemoStateResult> {
    return this.post("/api/login/code", { code });
  }

  async discoverTargets(): Promise<DemoStateResult> {
    return this.post("/api/session/discover", {});
  }

  async confirmSession(
    accountId: string,
    target: string,
    inboundConfirmed: boolean,
  ): Promise<DemoStateResult> {
    return this.post("/api/session/confirm", { accountId, target, inboundConfirmed });
  }

  async sendTestMessage(message: string): Promise<DemoStateResult> {
    return this.post("/api/send", { message });
  }

  async enableCodex(accountId: string, target: string): Promise<DemoStateResult> {
    return this.post("/api/codex/enable", { accountId, target });
  }

  async disableCodex(accountId: string, target: string): Promise<DemoStateResult> {
    return this.post("/api/codex/disable", { accountId, target });
  }

  async openCodexDesktop(accountId: string, target: string): Promise<DemoStateResult> {
    return this.post("/api/codex/desktop/open", { accountId, target });
  }

  async configurePermissions(
    mode: "safe" | "guarded_plus" | "advanced_controlled",
    rootIds: string[],
    confirmed: boolean,
  ): Promise<DemoStateResult> {
    return this.post("/api/codex/permissions/configure", { mode, rootIds, confirmed });
  }

  private async send(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
    if (!this.authorize) return this.fetchFn(url, init);
    for (let attempt = 0; ; attempt += 1) {
      const current = this.credential ?? this.authorize();
      this.credential = current;
      let cookie: string;
      try {
        cookie = await current;
      } catch (error) {
        if (this.credential === current) this.credential = undefined;
        throw error;
      }
      const response = await this.fetchFn(url, { ...init, headers: { ...init.headers, cookie } });
      if (response.status !== 401 || attempt > 0) return response;
      if (this.credential === current) this.credential = undefined;
    }
  }

  private async post(pathname: string, body: Record<string, unknown>): Promise<DemoStateResult> {
    const response = await this.send(`${this.baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        origin: this.baseUrl,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(
        typeof value?.error === "string"
          ? value.error
          : `微信 Demo 登录请求失败（HTTP ${response.status}）`,
      );
    }
    return parsePublicState(await response.json());
  }
}
