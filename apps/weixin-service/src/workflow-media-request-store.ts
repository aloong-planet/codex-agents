import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { InboundContent as InboundTextEvent } from "./channel-contract.js";
import type { WorkflowJsonValue } from "./workflow-gateway.js";
import type { MessageAttachment } from "./channel-contract.js";
import type { WorkflowMediaArtifact, WorkflowMediaArtifactStore } from "./workflow-media-artifact-store.js";

const HANDLE = /^mediareq_[a-f0-9]{32}$/;
const RECENT_TTL_MS = 10 * 60 * 1_000;
const MAX_RECENT = 5;
const REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;
type LocalRootId = "downloads" | "pictures" | "documents";
const ROOT_IDS = new Set<LocalRootId>(["downloads", "pictures", "documents"]);

type SourceKind = "quote" | "current" | "recent" | "local";
type RecentImage = MessageAttachment & { observedAt: number };
type PendingRequest = { source: SourceKind; images: MessageAttachment[]; rootId?: LocalRootId };
type PreparedToolTurn = {
  referenced: MessageAttachment[];
  current: MessageAttachment[];
  recent: MessageAttachment[];
};
type StoredRequest = WorkflowMediaRequest & { version: 1; expiresAt: number };

export type WorkflowMediaRequest = {
  source: "inbound" | "local";
  candidates: WorkflowMediaArtifact[];
  query?: string;
  rootId?: "downloads" | "pictures" | "documents";
  caption?: string;
  selection?: "latest";
};

export class WorkflowMediaRequestStore {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly preparedToolTurns = new Map<string, PreparedToolTurn>();
  private readonly recentPath: string;

  constructor(
    private readonly root: string,
    private readonly artifacts: WorkflowMediaArtifactStore,
    private readonly now: () => number = Date.now,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
    this.recentPath = path.join(root, "recent.json");
  }

  observe(event: InboundTextEvent): SourceKind | null {
    const current = imageAttachments(event.attachments ?? []);
    if (current.length > 0) this.remember(event, current);

    const quote = imageAttachments(event.quote?.attachments ?? []);
    let source: PendingRequest | null = null;
    if (quote.length > 0) source = { source: "quote", images: quote };
    else if (current.length > 0) source = { source: "current", images: current };
    else if (/(?:刚才|上一张|最近)/u.test(event.text)) {
      const recent = this.recentFor(event);
      if (recent.length > 0) source = { source: "recent", images: recent };
    } else if (isExplicitLocalSource(event.text)) {
      const rootId = explicitLocalRoot(event.text);
      source = { source: "local", images: [], ...(rootId ? { rootId } : {}) };
    }
    if (source) this.pending.set(event.key, source);
    else this.pending.delete(event.key);
    return source?.source ?? null;
  }

  prepareForToolTurn(event: InboundTextEvent): void {
    const current = imageAttachments(event.attachments ?? []);
    if (current.length > 0) this.remember(event, current);
    this.preparedToolTurns.set(event.key, {
      referenced: imageAttachments(event.quote?.attachments ?? []),
      current,
      recent: this.recentFor(event),
    });
  }

  captureFromTool(triggerId: string, input: Record<string, WorkflowJsonValue>): string {
    const prepared = this.preparedToolTurns.get(triggerId);
    if (!prepared) throw new Error("workflow_media_source_missing");
    if (input.kind !== "image" ||
        (input.source !== "referenced" && input.source !== "current" &&
         input.source !== "recent" && input.source !== "local")) {
      throw new Error("workflow_media_tool_arguments_invalid");
    }
    const images = input.source === "local" ? [] : prepared[input.source];
    if (input.source !== "local" && images.length === 0) {
      throw new Error("workflow_media_source_missing");
    }
    const caption = boundedString(input.caption, 12_000);
    const query = boundedString(input.query, 200);
    const request: WorkflowMediaRequest = input.source === "local"
      ? {
          source: "local",
          candidates: [],
          ...(query ? { query } : {}),
          ...(caption ? { caption } : {}),
          ...(input.selection === "latest" ? { selection: "latest" as const } : {}),
        }
      : {
          source: "inbound",
          candidates: images.flatMap((image) => {
            try { return [this.artifacts.captureInbound(image)]; }
            catch { return []; }
          }),
          ...(caption ? { caption } : {}),
        };
    if (request.source === "inbound" && request.candidates.length === 0) {
      throw new Error("workflow_media_source_unavailable");
    }
    const handle = `mediareq_${crypto.randomBytes(16).toString("hex")}`;
    this.writeJson(this.requestPath(handle), { version: 1, ...request, expiresAt: this.now() + REQUEST_TTL_MS });
    this.preparedToolTurns.delete(triggerId);
    return handle;
  }

  capture(triggerId: string, slots: Record<string, WorkflowJsonValue>): string {
    const pending = this.pending.get(triggerId);
    if (!pending) throw new Error("workflow_media_source_missing");
    const caption = boundedString(slots.caption, 12_000);
    const query = boundedString(slots.query, 200);
    const request: WorkflowMediaRequest = pending.source === "local"
      ? {
          source: "local",
          candidates: [],
          ...(query ? { query } : {}),
          ...(pending.rootId
            ? { rootId: pending.rootId }
            : typeof slots.rootId === "string" && ROOT_IDS.has(slots.rootId as LocalRootId)
              ? { rootId: slots.rootId as LocalRootId }
              : {}),
          ...(caption ? { caption } : {}),
          ...(slots.selection === "latest" ? { selection: "latest" as const } : {}),
        }
      : {
          source: "inbound",
          candidates: pending.images.flatMap((image) => {
            try { return [this.artifacts.captureInbound(image)]; }
            catch { return []; }
          }),
          ...(caption ? { caption } : {}),
        };
    const handle = `mediareq_${crypto.randomBytes(16).toString("hex")}`;
    this.writeJson(this.requestPath(handle), { version: 1, ...request, expiresAt: this.now() + REQUEST_TTL_MS });
    this.pending.delete(triggerId);
    return handle;
  }

  resolve(handle: string): WorkflowMediaRequest | null {
    if (!HANDLE.test(handle)) return null;
    try {
      const info = fs.lstatSync(this.requestPath(handle));
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const value = JSON.parse(fs.readFileSync(this.requestPath(handle), "utf8")) as Partial<StoredRequest>;
      if (value.version !== 1 || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= this.now() ||
          (value.source !== "inbound" && value.source !== "local") || !Array.isArray(value.candidates)) return null;
      return {
        source: value.source,
        candidates: value.candidates as WorkflowMediaArtifact[],
        ...(typeof value.query === "string" ? { query: value.query } : {}),
        ...(typeof value.rootId === "string" && ROOT_IDS.has(value.rootId)
          ? { rootId: value.rootId as "downloads" | "pictures" | "documents" }
          : {}),
        ...(typeof value.caption === "string" ? { caption: value.caption } : {}),
        ...(value.selection === "latest" ? { selection: "latest" as const } : {}),
      };
    } catch {
      return null;
    }
  }

  release(triggerId: string): void {
    this.pending.delete(triggerId);
    this.preparedToolTurns.delete(triggerId);
  }

  private remember(event: InboundTextEvent, images: MessageAttachment[]): void {
    const recent = this.readRecent();
    const key = targetHash(event.accountId, event.target);
    const observedAt = event.receivedAt;
    const active = (recent[key] ?? []).filter((entry) => isWithinRecentWindow(observedAt, entry.observedAt));
    const deduplicated = new Map<string, RecentImage>();
    for (const image of images) deduplicated.set(image.path, { ...image, observedAt });
    for (const image of active) if (!deduplicated.has(image.path)) deduplicated.set(image.path, image);
    recent[key] = [...deduplicated.values()].slice(0, MAX_RECENT);
    this.writeJson(this.recentPath, recent);
  }

  private recentFor(event: InboundTextEvent): MessageAttachment[] {
    return (this.readRecent()[targetHash(event.accountId, event.target)] ?? [])
      .filter((entry) => isWithinRecentWindow(event.receivedAt, entry.observedAt))
      .slice(0, MAX_RECENT)
      .map(({ kind, path: filePath, fileName, mimeType, sizeBytes, quoted }) => ({
        kind, path: filePath, fileName, mimeType, sizeBytes, quoted,
      }));
  }

  private readRecent(): Record<string, RecentImage[]> {
    try {
      const info = fs.lstatSync(this.recentPath);
      if (!info.isFile() || info.isSymbolicLink()) return {};
      const value = JSON.parse(fs.readFileSync(this.recentPath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter((entry): entry is [string, RecentImage[]] =>
            Array.isArray(entry[1]) && entry[1].every(isRecentImage)
          ),
      );
    } catch {
      return {};
    }
  }

  private requestPath(handle: string): string {
    return path.join(this.root, `${handle}.json`);
  }

  private writeJson(destination: string, value: unknown): void {
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  }
}

function imageAttachments(attachments: MessageAttachment[]): MessageAttachment[] {
  return attachments.filter((attachment) => attachment.kind === "image");
}

function isRecentImage(value: unknown): value is RecentImage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return entry.kind === "image" && typeof entry.path === "string" && typeof entry.fileName === "string" &&
    typeof entry.mimeType === "string" && typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes) &&
    typeof entry.quoted === "boolean" && typeof entry.observedAt === "number" && Number.isFinite(entry.observedAt);
}

function isWithinRecentWindow(at: number, observedAt: number): boolean {
  const age = at - observedAt;
  return age >= 0 && age <= RECENT_TTL_MS;
}

function isExplicitLocalSource(text: string): boolean {
  return /(?:Downloads?|下载|Pictures?|图片目录|相册|Documents?|文档目录|文档|(?:^|[\\/])[^\s]+\.(?:jpe?g|png|gif|webp|bmp)\b|\b[^\s]+\.(?:jpe?g|png|gif|webp|bmp)\b)/iu.test(text);
}

function explicitLocalRoot(text: string): LocalRootId | undefined {
  const matches = new Set<LocalRootId>();
  if (/(?:Downloads?|下载)/iu.test(text)) matches.add("downloads");
  if (/(?:Pictures?|图片目录|相册)/iu.test(text)) matches.add("pictures");
  if (/(?:Documents?|文档目录|文档)/iu.test(text)) matches.add("documents");
  return matches.size === 1 ? [...matches][0] : undefined;
}

function boundedString(value: WorkflowJsonValue | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

function targetHash(accountId: string, target: string): string {
  return crypto.createHash("sha256").update(`${accountId}\u0000${target}`).digest("hex");
}
