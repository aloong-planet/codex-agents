import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DemoService } from "./demo-service.js";
import type { FixtureModelToolCall } from "./fixture-app-server-transport.js";

const MAX_BODY_BYTES = 64 * 1024;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

function securityHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}

function json(res: ServerResponse, status: number, value: unknown): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  const host = req.headers.host;
  return Boolean(origin && host && origin === `http://${host}`);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("只接受 JSON 请求"), { statusCode: 415 });
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("请求体过大"), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("JSON 格式无效"), { statusCode: 400 });
  }
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
  return value;
}

function requiredStringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} 必须是字符串数组`);
  }
  return value;
}

function requiredNonnegativeInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${key} 必须是非负整数`);
  return Number(value);
}

function requiredModulePermissionScopes(
  body: Record<string, unknown>,
): Array<{ scopeId: string; read: boolean; write: boolean }> {
  const value = body.scopes;
  if (!Array.isArray(value)) throw new Error("scopes 必须是数组");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("scopes 格式无效");
    const scope = item as Record<string, unknown>;
    if (typeof scope.scopeId !== "string" || typeof scope.read !== "boolean" || typeof scope.write !== "boolean") {
      throw new Error("scopes 格式无效");
    }
    return { scopeId: scope.scopeId, read: scope.read, write: scope.write };
  });
}

function optionalFixtureInboundText(body: Record<string, unknown>): string | undefined {
  const text = optionalString(body, "text");
  if (text !== undefined && (text.trim().length === 0 || [...text].length > 4_000)) {
    throw Object.assign(new Error("text 必须是 1 到 4000 个字符"), { statusCode: 400 });
  }
  return text;
}

function optionalFixtureModelToolCalls(body: Record<string, unknown>): FixtureModelToolCall[] | undefined {
  const value = body.modelToolCalls ?? body.modelToolCall;
  if (value === undefined) return undefined;
  const calls = Array.isArray(value) ? value : [value];
  if (calls.length < 1 || calls.length > 16) {
    throw Object.assign(new Error("modelToolCalls 格式无效"), { statusCode: 400 });
  }
  return calls.map(parseFixtureModelToolCall);
}

function parseFixtureModelToolCall(value: unknown): FixtureModelToolCall {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("modelToolCall 格式无效"), { statusCode: 400 });
  }
  const record = value as Record<string, unknown>;
  if (typeof record.namespace !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(record.namespace) ||
      typeof record.tool !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(record.tool)) {
    throw Object.assign(new Error("modelToolCall 工具无效"), { statusCode: 400 });
  }
  return {
    namespace: record.namespace,
    tool: record.tool,
    arguments: structuredClone(record.arguments),
  };
}

function serveStatic(pathname: string, res: ServerResponse): boolean {
  const files: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  };
  const entry = files[pathname];
  if (!entry) return false;
  securityHeaders(res);
  res.statusCode = 200;
  res.setHeader("content-type", entry.type);
  res.end(fs.readFileSync(path.join(PUBLIC_DIR, entry.file)));
  return true;
}

export function createDemoServer(
  service: DemoService,
  options: { fixtureMode?: boolean; channelState?: () => Record<string, unknown>; feishuFixture?: { emit(input: unknown): Promise<void> } } = {},
): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      if (req.method === "GET" && url.pathname === "/api/state") {
        json(res, 200, { ...service.getPublicState(), ...options.channelState?.() });
        return;
      }
      if (req.method === "GET" && serveStatic(url.pathname, res)) return;
      if (req.method !== "POST") {
        json(res, 404, { error: "未找到" });
        return;
      }
      if (!sameOrigin(req)) {
        json(res, 403, { error: "拒绝跨来源写请求" });
        return;
      }
      const body = await readJson(req);
      if (url.pathname === "/api/fixture/feishu/inbound" && options.fixtureMode && options.feishuFixture) {
        await options.feishuFixture.emit(body);
      } else if (url.pathname === "/api/login/start") {
        service.startLogin();
      } else if (url.pathname === "/api/login/code") {
        service.submitPairCode(requiredString(body, "code"));
      } else if (url.pathname === "/api/session/confirm") {
        service.confirmSession({
          accountId: requiredString(body, "accountId"),
          target: requiredString(body, "target"),
          inboundConfirmed: body.inboundConfirmed === true,
        });
      } else if (url.pathname === "/api/session/discover") {
        await service.discoverTargets();
      } else if (url.pathname === "/api/fixture/inbound" && options.fixtureMode) {
        await service.emitFixtureInbound(optionalFixtureInboundText(body));
      } else if (url.pathname === "/api/fixture/workflow/inbound" && options.fixtureMode) {
        await service.emitFixtureWorkflowInbound(
          optionalFixtureInboundText(body),
          optionalFixtureModelToolCalls(body),
        );
      } else if (url.pathname === "/api/labels") {
        const accountLabel = optionalString(body, "accountLabel");
        const target = optionalString(body, "target");
        const targetLabel = optionalString(body, "targetLabel");
        service.saveLocalLabels({
          accountId: requiredString(body, "accountId"),
          ...(accountLabel !== undefined ? { accountLabel } : {}),
          ...(target !== undefined ? { target } : {}),
          ...(targetLabel !== undefined ? { targetLabel } : {}),
        });
      } else if (url.pathname === "/api/send") {
        await service.sendTestMessage(requiredString(body, "message"));
      } else if (url.pathname === "/api/codex/enable") {
        await service.enableCodex(
          requiredString(body, "accountId"),
          requiredString(body, "target"),
        );
      } else if (url.pathname === "/api/codex/disable") {
        service.disableCodex(
          requiredString(body, "accountId"),
          requiredString(body, "target"),
        );
      } else if (url.pathname === "/api/codex/memory/enable") {
        service.enableCodexMemory(requiredString(body, "accountId"));
      } else if (url.pathname === "/api/codex/memory/disable") {
        service.disableCodexMemory(requiredString(body, "accountId"));
      } else if (url.pathname === "/api/codex/memory/retry-latest-failed") {
        service.retryLatestCodexMemoryFailure(requiredString(body, "accountId"));
      } else if (url.pathname === "/api/codex/memory/notification-target") {
        service.confirmCodexMemoryNotificationTarget(
          requiredString(body, "accountId"),
          requiredString(body, "target"),
        );
      } else if (url.pathname === "/api/codex/desktop/open") {
        await service.openCodexDesktop(
          requiredString(body, "accountId"),
          requiredString(body, "target"),
        );
      } else if (url.pathname === "/api/codex/vault/enable") {
        service.enableCodexVault();
      } else if (url.pathname === "/api/codex/vault/disable") {
        service.disableCodexVault();
      } else if (url.pathname === "/api/codex/permissions/configure") {
        service.configureCodexPermissions({
          mode: requiredString(body, "mode") as "safe" | "guarded_plus" | "advanced_controlled",
          rootIds: requiredStringArray(body, "rootIds"),
          confirmed: body.confirmed === true,
        });
      } else if (url.pathname === "/api/media-exports/configure") {
        service.configureMediaExports({
          rootIds: requiredStringArray(body, "rootIds"),
          confirmed: body.confirmed === true,
        });
      } else if (url.pathname === "/api/workflows/module-permissions/configure") {
        service.configureWorkflowModulePermissions({
          moduleId: requiredString(body, "moduleId"),
          expectedRevision: requiredNonnegativeInteger(body, "expectedRevision"),
          confirmed: body.confirmed === true,
          scopes: requiredModulePermissionScopes(body),
        });
      } else if (url.pathname === "/api/codex/model/configure") {
        const mode = requiredString(body, "mode");
        if (mode !== "track" && mode !== "pinned") throw new Error("mode 必须是 track 或 pinned");
        const effort = requiredString(body, "effort") as import("./account-chat-model-settings.js").CodexReasoningEffort;
        service.configureCodexChatModel(
          requiredString(body, "accountId"),
          mode === "pinned"
            ? { mode: "pinned", model: requiredString(body, "model"), effort }
            : { mode: "track", track: requiredString(body, "track") as import("./account-chat-model-settings.js").ChatModelTrack, effort },
        );
      } else if (url.pathname === "/api/codex/model/refresh") {
        await service.refreshCodexModelCatalog();
      } else if (url.pathname === "/api/news/preview") {
        await service.previewDailyNews();
      } else if (url.pathname === "/api/news/retry") {
        await service.retryDailyNews();
      } else if (url.pathname === "/api/news/send-preview") {
        await service.sendDailyNewsPreview(
          requiredString(body, "accountId"),
          requiredString(body, "target"),
        );
      } else if (url.pathname === "/api/news/enable") {
        await service.enableDailyNews(
          requiredString(body, "accountId"),
          requiredString(body, "target"),
        );
      } else if (url.pathname === "/api/news/disable") {
        service.disableDailyNews();
      } else {
        json(res, 404, { error: "未找到" });
        return;
      }
      json(res, 200, { ...service.getPublicState(), ...options.channelState?.() });
    } catch (error) {
      const statusCode =
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : 400;
      const message = error instanceof Error ? error.message : "请求失败";
      json(res, Number.isInteger(statusCode) ? statusCode : 400, { error: message });
    }
  });
}
