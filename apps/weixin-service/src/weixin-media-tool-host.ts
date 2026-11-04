import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { InboundTextEvent } from "./demo-service.js";
import type { DynamicToolDefinition, DynamicToolHost, DynamicToolResult } from "./dynamic-tool-host.js";
import { MAX_ILINK_MEDIA_BYTES } from "./ilink-media.js";
import type { MediaExportLibrary } from "./media-export-library.js";

type Binding = { event: InboundTextEvent; roots: string[]; inboundPaths: Set<string>; mediaPaths: Map<string, { token: string; path: string }>; allowed: boolean };
export type WeixinMediaTurnBinding = { promptLines: string[]; release(): void };
type RecentImage = { path: string; observedAt: number };
const RECENT_IMAGE_TTL_MS = 10 * 60 * 1000;
const MAX_RECENT_IMAGES_PER_TARGET = 5;
const result = (success: boolean, value: unknown): DynamicToolResult => ({ success, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] });
const hasExplicitMediaSendIntent = (event: InboundTextEvent): boolean => {
  const hasSendAction = /(?:发送|发给|回传|传给|回发|发回)/u.test(event.text)
    || /\b(?:send|attach)\b/iu.test(event.text);
  const namesMedia = /(?:图片|照片|图像|截图|原图|文件|视频|这张|那张|上一张|刚才|image|photo|file|video)/iu.test(event.text);
  return hasSendAction && (namesMedia || (event.attachments?.length ?? 0) > 0 || (event.quote?.attachments.length ?? 0) > 0);
};

export class WeixinMediaToolHost implements DynamicToolHost {
  private readonly bindings = new Map<string, Binding>();
  private readonly recentImages = new Map<string, RecentImage[]>();
  constructor(private readonly now: () => number = Date.now, private readonly library?: MediaExportLibrary) {}
  definitions(): DynamicToolDefinition[] {
    return [
      { type: "function", name: "weixin_send_media", description: "仅在用户当前微信消息明确要求发送、回传或回发媒体时，把当前、引用、同目标近期图片或授权工作区内的受控本地文件发送回当前微信目标。", inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, caption: { type: "string" } } } },
      { type: "function", name: "weixin_find_images", description: "按文件名或相对路径查找用户已单独授权外发的 Downloads、Pictures、Documents 图片；返回的 mediaId 只在当前回合有效。", inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, rootId: { type: "string", enum: ["downloads", "pictures", "documents"] }, limit: { type: "integer", minimum: 1, maximum: 20 } } } },
      { type: "function", name: "weixin_send_image", description: "把 weixin_find_images 返回的当前回合 mediaId 对应图片发送到当前微信会话。", inputSchema: { type: "object", additionalProperties: false, required: ["mediaId"], properties: { mediaId: { type: "string" }, caption: { type: "string" } } } },
    ];
  }
  bind(threadId: string, event: InboundTextEvent, roots: string[]): WeixinMediaTurnBinding {
    const targetKey = `${event.accountId}\u0000${event.target}`;
    const observedAt = this.now();
    const activeRecent = (this.recentImages.get(targetKey) ?? [])
      .filter((item) => observedAt - item.observedAt <= RECENT_IMAGE_TTL_MS && fs.existsSync(item.path));
    const currentImages = (event.attachments ?? [])
      .filter((item) => item.kind === "image")
      .map((item) => fs.realpathSync(item.path));
    const deduplicated = new Map<string, RecentImage>();
    for (const imagePath of currentImages) deduplicated.set(imagePath, { path: imagePath, observedAt });
    for (const item of activeRecent) if (!deduplicated.has(item.path)) deduplicated.set(item.path, item);
    const recent = [...deduplicated.values()].slice(0, MAX_RECENT_IMAGES_PER_TARGET);
    if (recent.length > 0) this.recentImages.set(targetKey, recent);
    else this.recentImages.delete(targetKey);

    const currentPaths = [...(event.attachments ?? []), ...(event.quote?.attachments ?? [])].map((item) => fs.realpathSync(item.path));
    const allowed = hasExplicitMediaSendIntent(event);
    const inboundPaths = new Set([...currentPaths, ...recent.map((item) => item.path)]);
    this.bindings.set(threadId, { event, roots: roots.map((root) => fs.realpathSync(root)), inboundPaths, mediaPaths: new Map(), allowed });
    const enabledLibraryRoots = this.library?.getPublicState().roots
      .filter((root) => root.enabled && root.status === "available")
      .map((root) => root.displayName) ?? [];
    const libraryInstruction = allowed && enabledLibraryRoots.length > 0
      ? [`微信图片外发目录已授权：${enabledLibraryRoots.join("、")}。必须使用 weixin_find_images 查找，禁止使用 shell、exec 或普通文件工具读取这些目录；取得 mediaId 后使用 weixin_send_image 发送。`]
      : [];
    return {
      promptLines: allowed ? [...libraryInstruction, ...recent.map((item, index) => `近期图片 ${index + 1}：${item.path}`)] : [],
      release: () => { if (this.bindings.get(threadId)?.event === event) this.bindings.delete(threadId); },
    };
  }
  async execute(tool: string, argumentsValue: unknown, context?: { threadId: string; turnId: string }): Promise<DynamicToolResult> {
    if (!context || !["weixin_send_media", "weixin_find_images", "weixin_send_image"].includes(tool)) return result(false, { error: "媒体工具上下文无效" });
    const binding = this.bindings.get(context.threadId);
    if (!binding?.allowed || !binding.event.replyMedia) return result(false, { error: "当前微信消息没有明确授权媒体外发" });
    if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return result(false, { error: "参数无效" });
    const args = argumentsValue as Record<string, unknown>;
    if (tool === "weixin_find_images") {
      if (!this.library) return result(false, { error: "本地图片目录功能不可用" });
      const found = await this.library.search({
        ...(typeof args.query === "string" ? { query: args.query.slice(0, 200) } : {}),
        ...(typeof args.rootId === "string" ? { rootId: args.rootId } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
      const matches = found.matches.flatMap(({ token, ...match }) => {
        const resolved = this.library?.resolve(token);
        if (!resolved) return [];
        const mediaId = crypto.randomUUID();
        binding.mediaPaths.set(mediaId, { token, path: resolved });
        return [{ mediaId, ...match }];
      });
      return result(true, { matches, truncated: found.truncated });
    }
    const libraryMatch = typeof args.mediaId === "string" ? binding.mediaPaths.get(args.mediaId) : undefined;
    const requestedPath = tool === "weixin_send_image"
      ? (libraryMatch && this.library?.resolve(libraryMatch.token) === libraryMatch.path ? libraryMatch.path : undefined)
      : (typeof args.path === "string" && path.isAbsolute(args.path) ? args.path : undefined);
    if (!requestedPath) return result(false, { error: tool === "weixin_send_image" ? "图片句柄无效或已过期" : "必须提供本地绝对路径" });
    let info: fs.Stats;
    try { info = fs.lstatSync(requestedPath); }
    catch { return result(false, { error: "媒体文件不存在或不可读取" }); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ILINK_MEDIA_BYTES) return result(false, { error: "媒体文件无效或超过 100 MiB" });
    const real = fs.realpathSync(requestedPath);
    const inRoot = binding.roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
    const fromLibrary = tool === "weixin_send_image" && libraryMatch?.path === real;
    if (!inRoot && !binding.inboundPaths.has(real) && !fromLibrary) return result(false, { error: "媒体文件不在本轮或授权目录内" });
    const caption = typeof args.caption === "string" ? args.caption.slice(0, 12_000) : undefined;
    const sent = await binding.event.replyMedia(real, caption);
    return result(sent.ok, sent.ok ? { accepted: true, messageId: sent.messageId } : { accepted: false, reason: sent.reason ?? "unknown" });
  }
}
