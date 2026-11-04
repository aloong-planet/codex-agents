import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

import type { DemoStateResult } from "./demo-http-client.js";
import { WEIXIN_PANEL_URI, weixinPanelHtml } from "./panel-html.js";

export interface WeixinDemoClient {
  getState(): Promise<DemoStateResult>;
  startLogin?(): Promise<DemoStateResult>;
  submitPairCode?(code: string): Promise<DemoStateResult>;
  discoverTargets?(): Promise<DemoStateResult>;
  confirmSession?(
    accountId: string,
    target: string,
    inboundConfirmed: boolean,
  ): Promise<DemoStateResult>;
  sendTestMessage?(message: string): Promise<DemoStateResult>;
  enableCodex?(accountId: string, target: string): Promise<DemoStateResult>;
  disableCodex?(accountId: string, target: string): Promise<DemoStateResult>;
  openCodexDesktop?(accountId: string, target: string): Promise<DemoStateResult>;
  configurePermissions?(
    mode: "safe" | "guarded_plus" | "advanced_controlled",
    rootIds: string[],
    confirmed: boolean,
  ): Promise<DemoStateResult>;
}

const APP_META = {
  ui: { resourceUri: WEIXIN_PANEL_URI, visibility: ["model", "app"] as const },
};

function success(result: DemoStateResult, text: string) {
  const privateMeta = {
    ...(result.privateUi.qrDataUrl ? { qrDataUrl: result.privateUi.qrDataUrl } : {}),
    ...(result.privateUi.permissionCandidates.length > 0
      ? { permissionCandidates: result.privateUi.permissionCandidates }
      : {}),
  };
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: result.modelState,
    _meta: privateMeta,
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : "微信直连操作失败",
      },
    ],
  };
}

async function run(action: () => Promise<DemoStateResult>, text: string) {
  try {
    return success(await action(), text);
  } catch (error) {
    return failure(error);
  }
}

function required<T extends keyof WeixinDemoClient>(client: WeixinDemoClient, method: T) {
  const value = client[method];
  if (typeof value !== "function") throw new Error(`测试客户端未实现 ${String(method)}`);
  return value.bind(client) as NonNullable<WeixinDemoClient[T]>;
}

export function createWeixinMcpServer(client: WeixinDemoClient): McpServer {
  const server = new McpServer(
    { name: "codex-weixin", version: "0.1.0" },
    { instructions: "通过本机微信直连 Demo 显示扫码状态和明确确认后的测试发送。" },
  );

  registerAppResource(
    server,
    "微信直连助手面板",
    WEIXIN_PANEL_URI,
    {
      description: "用于真实微信扫码、会话确认和显式测试发送的本地内嵌面板。",
      _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
    },
    async () => ({
      contents: [
        {
          uri: WEIXIN_PANEL_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: weixinPanelHtml,
          _meta: {
            ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "show_weixin_panel",
    {
      title: "打开微信直连面板",
      description: "显示本机微信直连服务的状态与交互面板。",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: APP_META,
    },
    async () => run(() => client.getState(), "微信直连面板已打开。"),
  );

  registerAppTool(
    server,
    "get_weixin_state",
    {
      title: "刷新微信直连状态",
      description: "只读取本机微信直连服务状态。",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async () => run(() => client.getState(), "状态已刷新。"),
  );

  registerAppTool(
    server,
    "start_weixin_login",
    {
      title: "生成真实微信二维码",
      description: "请求腾讯 iLink 真实登录二维码；不会自动扫码或授权。",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async () => run(() => required(client, "startLogin")(), "已请求真实微信二维码。"),
  );

  registerAppTool(
    server,
    "submit_weixin_pair_code",
    {
      title: "提交微信配对码",
      description: "仅在手机微信要求时提交数字配对码。",
      inputSchema: { code: z.string().trim().regex(/^\d{1,12}$/) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async ({ code }) => run(() => required(client, "submitPairCode")(code), "配对码已提交。"),
  );

  registerAppTool(
    server,
    "discover_weixin_targets",
    {
      title: "同步微信入站目标",
      description: "从本机直连状态同步最近给 bot 发过消息的目标。",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async () => run(() => required(client, "discoverTargets")(), "入站目标已同步。"),
  );

  registerAppTool(
    server,
    "confirm_weixin_session",
    {
      title: "确认微信会话与目标",
      description: "确认账户、入站目标以及用户已主动发过入站消息。",
      inputSchema: {
        accountId: z.string().min(1).max(256),
        target: z.string().regex(/^[A-Za-z0-9._-]+@im\.wechat$/),
        inboundConfirmed: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async ({ accountId, target, inboundConfirmed }) =>
      run(
        () => required(client, "confirmSession")(accountId, target, inboundConfirmed),
        "会话与目标已确认。",
      ),
  );

  registerAppTool(
    server,
    "send_weixin_test_message",
    {
      title: "发送微信测试消息",
      description: "在用户显式确认后，向已确认目标发送一条真实微信消息。",
      inputSchema: {
        message: z.string().trim().min(1).max(450),
        outboundConfirmed: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async ({ message }) =>
      run(
        () => required(client, "sendTestMessage")(message),
        "渠道已接受发送请求，请在微信端确认是否收到。",
      ),
  );

  registerAppTool(
    server,
    "enable_weixin_codex_relay",
    {
      title: "启用微信 Codex 转发",
      description: "为已选微信目标启用独立 Codex App Server 任务。",
      inputSchema: {
        accountId: z.string().min(1).max(256),
        target: z.string().regex(/^[A-Za-z0-9._-]+@im\.wechat$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async ({ accountId, target }) => run(
      () => required(client, "enableCodex")(accountId, target),
      "已启用当前目标的 Codex 转发。",
    ),
  );

  registerAppTool(
    server,
    "disable_weixin_codex_relay",
    {
      title: "停用微信 Codex 转发",
      description: "停用已选微信目标的自动处理。",
      inputSchema: {
        accountId: z.string().min(1).max(256),
        target: z.string().regex(/^[A-Za-z0-9._-]+@im\.wechat$/),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async ({ accountId, target }) => run(
      () => required(client, "disableCodex")(accountId, target),
      "已停用当前目标的 Codex 转发。",
    ),
  );

  registerAppTool(
    server,
    "open_weixin_codex_desktop_thread",
    {
      title: "在 Codex Desktop 中查看",
      description: "请求本机 Codex Desktop 打开当前微信目标对应的原生任务；不恢复或接管任务。",
      inputSchema: {
        accountId: z.string().min(1).max(256),
        target: z.string().regex(/^[A-Za-z0-9._-]+@im\.wechat$/),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async ({ accountId, target }) => run(
      () => required(client, "openCodexDesktop")(accountId, target),
      "已请求 Codex Desktop 打开当前任务；原生页面可能提示任务正在其他位置运行。",
    ),
  );

  registerAppTool(
    server,
    "configure_weixin_codex_permissions",
    {
      title: "配置微信 Codex 权限",
      description: "设置三档本地权限与已授权目录；只允许面板调用。",
      inputSchema: {
        mode: z.enum(["safe", "guarded_plus", "advanced_controlled"]),
        rootIds: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).min(1).max(20),
        confirmed: z.literal(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { ...APP_META.ui, visibility: ["app"] } },
    },
    async ({ mode, rootIds, confirmed }) => run(
      () => required(client, "configurePermissions")(mode, rootIds, confirmed),
      "权限设置已保存，将从下一条微信消息开始生效。",
    ),
  );

  return server;
}
