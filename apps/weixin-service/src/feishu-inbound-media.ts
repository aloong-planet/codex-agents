import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { InboundContent, MessageAttachment } from "./channel-contract.js";

export interface FeishuResourceTransport {
  getMessage(messageId: string): Promise<unknown>;
  download(input: { messageId: string; resourceKey: string; type: "image" | "file" }): Promise<{
    stream: AsyncIterable<Uint8Array>; contentType?: string; cancel(): void;
  }>;
}
type Message = { messageId: string; type: string; content: string; parentId?: string };
type Content = Pick<InboundContent, "source" | "text" | "attachments" | "quote">;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,512}$/.test(value);
const imageExtensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp" };
function imageMime(prefix: Buffer): string | undefined {
  if (prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(prefix.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (prefix.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}

/** Platform resource keys and quote lookup stay here; the core receives only private local attachments. */
export class FeishuInboundMedia {
  constructor(private readonly root: string, private readonly chatId: string, private readonly transport: FeishuResourceTransport) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
  }

  async normalize(message: Message): Promise<Content> {
    let parent: Message | undefined;
    if (message.parentId) {
      if (!identifier(message.parentId)) throw new Error("feishu_quote_invalid");
      const response = object(await this.transport.getMessage(message.parentId));
      const items = object(response?.data)?.items;
      const item = Array.isArray(items) && items.length === 1 ? object(items[0]) : undefined;
      const body = object(item?.body);
      if (response?.code !== 0 || item?.message_id !== message.parentId || item?.chat_id !== this.chatId ||
          typeof item?.msg_type !== "string" || typeof body?.content !== "string") throw new Error("feishu_quote_invalid");
      parent = { messageId: message.parentId, type: item.msg_type, content: body.content };
    }
    const current = await this.content(message, false);
    if (!parent) return current;
    const quote = await this.content(parent, true);
    return { ...current, quote: { text: quote.text, attachments: quote.attachments ?? [] } };
  }

  private async content(message: Message, quoted: boolean): Promise<Content> {
    if (!identifier(message.messageId) || message.content.length > 64 * 1024) throw new Error("feishu_message_invalid");
    let data: Record<string, unknown> | undefined;
    try { data = object(JSON.parse(message.content)); } catch { throw new Error("feishu_message_invalid"); }
    if (message.type === "text") {
      if (typeof data?.text !== "string" || Array.from(data.text).length > 8000) throw new Error("feishu_message_invalid");
      return { source: "text", text: data.text };
    }
    if (message.type === "post") {
      if (typeof data?.title !== "string" || !Array.isArray(data.content)) throw new Error("feishu_message_invalid");
      const keys: string[] = [];
      const paragraphs: string[] = [];
      if (data.title) paragraphs.push(data.title);
      for (const paragraph of data.content) {
        if (!Array.isArray(paragraph)) throw new Error("feishu_message_invalid");
        const parts: string[] = [];
        for (const value of paragraph) {
          const node = object(value);
          switch (node?.tag) {
            case "text": case "code_block":
              if (typeof node.text !== "string") throw new Error("feishu_message_invalid");
              parts.push(node.text);
              break;
            case "a":
              if (typeof node.text !== "string" || typeof node.href !== "string") throw new Error("feishu_message_invalid");
              parts.push(`${node.text} (${node.href})`);
              break;
            case "at":
              if (typeof node.user_id !== "string" || typeof node.user_name !== "string") throw new Error("feishu_message_invalid");
              parts.push(node.user_name ? `@${node.user_name}` : node.user_id);
              break;
            case "img":
              if (!identifier(node.image_key)) throw new Error("feishu_resource_invalid");
              keys.push(node.image_key);
              break;
            case "emotion":
              if (typeof node.emoji_type !== "string") throw new Error("feishu_message_invalid");
              parts.push(`[${node.emoji_type}]`);
              break;
            case "hr": parts.push("---"); break;
            default: throw new Error("feishu_post_tag_unsupported");
          }
        }
        if (parts.length) paragraphs.push(parts.join(""));
      }
      const text = paragraphs.join("\n");
      if (Array.from(text).length > 8000 || keys.length > 20) throw new Error("feishu_message_invalid");
      const attachments: MessageAttachment[] = [];
      for (const resourceKey of keys) attachments.push(await this.save({ messageId: message.messageId, resourceKey, type: "image" }, quoted));
      return { source: attachments.length ? "media" : "text", text, attachments };
    }
    if (message.type !== "image" && message.type !== "file") throw new Error("feishu_message_type_unsupported");
    const resourceKey = message.type === "image" ? data?.image_key : data?.file_key;
    if (!identifier(resourceKey)) throw new Error("feishu_resource_invalid");
    const fileName = message.type === "file" ? data?.file_name : undefined;
    if (message.type === "file" && (typeof fileName !== "string" || !fileName || fileName.length > 255 ||
        /[/\\\r\n\0]/u.test(fileName) || fileName === "." || fileName === "..")) throw new Error("feishu_resource_invalid");
    const attachment = await this.save({ messageId: message.messageId, resourceKey, type: message.type }, quoted,
      typeof fileName === "string" ? fileName : undefined);
    return { source: "media", text: "", attachments: [attachment] };
  }

  private async save(input: Parameters<FeishuResourceTransport["download"]>[0], quoted: boolean, name?: string): Promise<MessageAttachment> {
    const resource = await this.transport.download(input);
    const temporary = path.join(this.root, `${randomUUID()}.part`);
    let fd: number | undefined;
    const timer = setTimeout(() => resource.cancel(), 30_000);
    let size = 0;
    let prefix: Buffer = Buffer.alloc(0);
    const digest = createHash("sha256");
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      for await (const chunk of resource.stream) {
        if (!(chunk instanceof Uint8Array)) throw new Error("feishu_resource_invalid");
        size += chunk.byteLength;
        if (size > 100 * 1024 * 1024) throw new Error("feishu_resource_too_large");
        if (prefix.length < 12) prefix = Buffer.concat([prefix, chunk.subarray(0, 12 - prefix.length)]);
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.byteLength) offset += fs.writeSync(fd, chunk, offset, chunk.byteLength - offset);
      }
      if (!size) throw new Error("feishu_resource_empty");
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      const mime = resource.contentType?.split(";")[0]?.trim().toLowerCase();
      const mimeType = input.type === "image" ? (imageMime(prefix) ?? (mime && imageExtensions[mime] ? mime : undefined))
        : (mime && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) ? mime : "application/octet-stream");
      if (!mimeType) throw new Error("feishu_image_type_unsupported");
      const scope = createHash("sha256").update(JSON.stringify([this.chatId, input.messageId, input.resourceKey])).digest("hex");
      const fileName = name ?? `image-${scope}${imageExtensions[mimeType] ?? ".jpg"}`;
      const extension = path.extname(fileName);
      const storageExtension = input.type === "image" ? imageExtensions[mimeType] : /^\.[a-zA-Z0-9]{1,15}$/.test(extension) ? extension : ".bin";
      const filePath = path.join(this.root, `${scope}-${digest.digest("hex")}${storageExtension}`);
      fs.renameSync(temporary, filePath);
      const directory = fs.openSync(this.root, "r");
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      return { kind: input.type, path: filePath, fileName, mimeType, sizeBytes: size, quoted };
    } finally {
      clearTimeout(timer);
      resource.cancel();
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
}
