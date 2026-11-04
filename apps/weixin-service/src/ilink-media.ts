import crypto from "node:crypto";
import { ChannelTransport } from "./channel-transport.js";
import fs from "node:fs";
import path from "node:path";

export const MAX_ILINK_MEDIA_BYTES = 100 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PER_TARGET = 100;
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

export type IlinkMediaKind = "image" | "voice" | "file" | "video";
export type StoredIlinkMedia = {
  kind: IlinkMediaKind;
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  quoted: boolean;
};

type MediaIndexEntry = StoredIlinkMedia & { targetHash: string; createdAt: number; messageKey: string };

export function parseIlinkAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error("微信媒体 AES key 格式无效");
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
export function aesEcbPaddedSize(size: number): number { return Math.ceil((size + 1) / 16) * 16; }

export function classifyLocalMedia(filePath: string): { kind: Exclude<IlinkMediaKind, "voice">; mimeType: string; fileName: string } {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"].includes(ext)) return { kind: "image", mimeType: mimeAndExtension("image", fileName).mime, fileName };
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(ext)) return { kind: "video", mimeType: mimeAndExtension("video", fileName).mime, fileName };
  return { kind: "file", mimeType: mimeAndExtension("file", fileName).mime, fileName };
}

export async function uploadEncryptedMedia(input: { buffer: Buffer; uploadUrl: string; aesKey: Buffer; fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>; signal?: AbortSignal; transport?: ChannelTransport }): Promise<string> {
  if (input.buffer.byteLength > MAX_ILINK_MEDIA_BYTES) throw new Error("微信媒体超过 100 MiB");
  const url = safeCdnUrl(input.uploadUrl);
  return (input.transport ?? new ChannelTransport(input.fetcher ?? fetch)).upload(url, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(encryptAesEcb(input.buffer, input.aesKey)), ...(input.signal ? { signal: input.signal } : {}) });
}

function safeCdnUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      (url.hostname !== "weixin.qq.com" && !url.hostname.endsWith(".weixin.qq.com"))) {
    throw new Error("微信媒体 CDN 地址无效");
  }
  return url;
}

function mimeAndExtension(kind: IlinkMediaKind, fileName?: string): { mime: string; ext: string } {
  const ext = fileName ? path.extname(path.basename(fileName)).toLowerCase() : "";
  if (kind === "image") return { mime: "image/jpeg", ext: ext || ".jpg" };
  if (kind === "voice") return { mime: "audio/silk", ext: ext || ".silk" };
  if (kind === "video") return { mime: "video/mp4", ext: ext || ".mp4" };
  const known: Record<string, string> = { ".pdf": "application/pdf", ".txt": "text/plain", ".zip": "application/zip", ".csv": "text/csv" };
  return { mime: known[ext] ?? "application/octet-stream", ext: ext || ".bin" };
}

export function pcmBytesToWav(pcm: Uint8Array, sampleRate = 24_000): Buffer {
  const output = Buffer.alloc(44 + pcm.byteLength);
  output.write("RIFF", 0); output.writeUInt32LE(output.length - 8, 4); output.write("WAVE", 8);
  output.write("fmt ", 12); output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22); output.writeUInt32LE(sampleRate, 24); output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34); output.write("data", 36); output.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(output, 44);
  return output;
}

async function transcodeSilk(value: Buffer): Promise<Buffer | null> {
  try {
    const { decode } = await import("silk-wasm");
    const decoded = await decode(value, 24_000);
    return pcmBytesToWav(decoded.data, 24_000);
  } catch { return null; }
}

async function limitedBody(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error("微信媒体下载失败");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ILINK_MEDIA_BYTES) throw new Error("微信媒体超过 100 MiB");
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ILINK_MEDIA_BYTES) {
      await reader.cancel();
      throw new Error("微信媒体超过 100 MiB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export class IlinkMediaStore {
  private readonly mediaRoot: string;
  private readonly indexPath: string;
  constructor(
    root: string,
    private readonly fetcher: (input: string | URL, init?: RequestInit) => Promise<Response> = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.mediaRoot = path.join(root, "media", "inbound");
    this.indexPath = path.join(root, "media", "index.json");
  }

  async materialize(input: {
    kind: IlinkMediaKind; fullUrl?: string; encryptQueryParam?: string; aesKeyBase64?: string; target: string;
    messageKey: string; quoted: boolean; fileName?: string;
  }): Promise<StoredIlinkMedia> {
    const resolvedUrl = input.fullUrl ?? (input.encryptQueryParam ? `${ILINK_CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(input.encryptQueryParam)}` : "");
    if (!resolvedUrl) throw new Error("微信媒体 CDN 地址缺失");
    const url = safeCdnUrl(resolvedUrl);
    const encrypted = await limitedBody(await this.fetcher(url));
    let plain = input.aesKeyBase64
      ? decryptAesEcb(encrypted, parseIlinkAesKey(input.aesKeyBase64))
      : encrypted;
    if (plain.byteLength > MAX_ILINK_MEDIA_BYTES) throw new Error("微信媒体超过 100 MiB");
    const targetHash = crypto.createHash("sha256").update(input.target).digest("hex").slice(0, 24);
    const directory = path.join(this.mediaRoot, targetHash);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    let { mime, ext } = mimeAndExtension(input.kind, input.fileName);
    if (input.kind === "voice") {
      const wav = await transcodeSilk(plain);
      if (wav) { plain = wav; mime = "audio/wav"; ext = ".wav"; }
    }
    const fileName = `${input.messageKey.slice(0, 24)}-${input.quoted ? "quoted" : "main"}${ext}`;
    const filePath = path.join(directory, fileName);
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, plain, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    const saved: StoredIlinkMedia = { kind: input.kind, path: filePath, fileName: input.fileName ? path.basename(input.fileName) : fileName, mimeType: mime, sizeBytes: plain.byteLength, quoted: input.quoted };
    const entries = this.readIndex().filter((entry) => entry.path !== filePath);
    entries.push({ ...saved, targetHash, createdAt: this.now(), messageKey: input.messageKey });
    this.writeIndex(entries);
    this.cleanup();
    return saved;
  }

  cleanup(): void {
    const cutoff = this.now() - RETENTION_MS;
    const kept: MediaIndexEntry[] = [];
    const grouped = new Map<string, MediaIndexEntry[]>();
    for (const entry of this.readIndex()) {
      if (entry.createdAt < cutoff) { this.safeDelete(entry.path); continue; }
      const group = grouped.get(entry.targetHash) ?? [];
      group.push(entry); grouped.set(entry.targetHash, group);
    }
    for (const group of grouped.values()) {
      group.sort((a, b) => b.createdAt - a.createdAt);
      kept.push(...group.slice(0, MAX_PER_TARGET));
      for (const entry of group.slice(MAX_PER_TARGET)) this.safeDelete(entry.path);
    }
    this.writeIndex(kept);
  }

  private readIndex(): MediaIndexEntry[] {
    try { const value = JSON.parse(fs.readFileSync(this.indexPath, "utf8")); return Array.isArray(value) ? value : []; }
    catch { return []; }
  }
  private writeIndex(entries: MediaIndexEntry[]): void {
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temp = `${this.indexPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temp, this.indexPath); fs.chmodSync(this.indexPath, 0o600);
  }
  private safeDelete(filePath: string): void {
    try {
      const relative = path.relative(this.mediaRoot, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return;
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(filePath);
    } catch { /* already absent */ }
  }
}
