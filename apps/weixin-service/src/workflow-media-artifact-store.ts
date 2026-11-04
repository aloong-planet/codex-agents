import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MediaExportLibrary, MediaExportMatch } from "./media-export-library.js";
import { MAX_MEDIA_ARTIFACT_BYTES } from "./media-delivery.js";
import type { MessageAttachment } from "./channel-contract.js";

const HANDLE = /^media_[a-f0-9]{32}$/;

type StoredArtifact = {
  version: 1 | 2 | 3;
  absolutePath: string;
  expiresAt: number;
  source: "library" | "inbound" | "snapshot";
};

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

export type WorkflowMediaArtifact = {
  handle: string;
  rootId: string;
  rootName: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: number;
  expiresAt: number;
};

function parseStoredArtifact(value: unknown): StoredArtifact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (![1, 2, 3].includes(record.version as number) || typeof record.absolutePath !== "string" || !path.isAbsolute(record.absolutePath)) return null;
  if (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0) return null;
  const source = record.version === 1 ? "library" : record.source;
  if (source !== "library" && source !== "inbound" && source !== "snapshot") return null;
  return { version: record.version as 1 | 2 | 3, absolutePath: record.absolutePath, expiresAt: record.expiresAt as number, source };
}

export class WorkflowMediaArtifactStore {
  constructor(
    private readonly root: string,
    private readonly mediaLibrary: MediaExportLibrary,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly inboundRoot?: string,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
  }

  capture(match: MediaExportMatch): WorkflowMediaArtifact {
    const absolutePath = this.mediaLibrary.resolve(match.token);
    if (!absolutePath) throw new Error("workflow_media_source_unavailable");
    const handle = `media_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    const destination = this.sidecarPath(handle);
    const temporary = `${destination}.${process.pid}.tmp`;
    this.persist(destination, temporary, { version: 2, source: "library", absolutePath, expiresAt });
    return {
      handle,
      rootId: match.rootId,
      rootName: match.rootName,
      fileName: match.fileName,
      relativePath: match.relativePath,
      sizeBytes: match.sizeBytes,
      modifiedAt: match.modifiedAt,
      expiresAt,
    };
  }

  captureAuthorizedPath(candidate: string): string {
    const absolutePath = this.mediaLibrary.resolveAuthorizedPath(candidate);
    if (!absolutePath) throw new Error("workflow_media_source_unavailable");
    const handle = `media_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    const destination = this.sidecarPath(handle);
    this.persist(destination, `${destination}.${process.pid}.tmp`, {
      version: 2,
      source: "library",
      absolutePath,
      expiresAt,
    });
    return handle;
  }

  captureInbound(media: MessageAttachment): WorkflowMediaArtifact {
    if (media.kind !== "image") throw new Error("workflow_inbound_media_invalid");
    const absolutePath = this.resolveInboundPath(media.path);
    if (!absolutePath) throw new Error("workflow_inbound_media_unavailable");
    const info = fs.lstatSync(absolutePath);
    const handle = `media_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    const destination = this.sidecarPath(handle);
    this.persist(destination, `${destination}.${process.pid}.tmp`, {
      version: 2,
      source: "inbound",
      absolutePath,
      expiresAt,
    });
    return {
      handle,
      rootId: "inbound",
      rootName: "微信入站",
      fileName: path.basename(media.fileName || absolutePath),
      relativePath: path.basename(media.fileName || absolutePath),
      sizeBytes: info.size,
      modifiedAt: Math.trunc(info.mtimeMs),
      expiresAt,
    };
  }

  captureSnapshot(candidate: string, fileName = path.basename(candidate)): string {
    try {
      if (path.basename(fileName) !== fileName || !fileName || Array.from(fileName).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      }) || !IMAGE_EXTENSIONS.has(path.extname(fileName).toLocaleLowerCase("en-US"))) {
        throw new Error("workflow_media_source_unavailable");
      }
      const info = fs.lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MEDIA_ARTIFACT_BYTES) {
        throw new Error("workflow_media_source_unavailable");
      }
      const source = fs.realpathSync(candidate);
      const handle = `media_${crypto.randomBytes(16).toString("hex")}`;
      const snapshots = path.join(this.root, "snapshots");
      fs.mkdirSync(snapshots, { recursive: true, mode: 0o700 });
      const snapshotDirectory = path.join(snapshots, handle);
      fs.mkdirSync(snapshotDirectory, { mode: 0o700 });
      const snapshot = path.join(snapshotDirectory, fileName);
      fs.copyFileSync(source, snapshot, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(snapshot, 0o600);
      const descriptor = fs.openSync(snapshot, fs.constants.O_RDONLY);
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      const expiresAt = this.now() + this.ttlMs;
      const destination = this.sidecarPath(handle);
      this.persist(destination, `${destination}.${process.pid}.tmp`, {
        version: 3,
        source: "snapshot",
        absolutePath: snapshot,
        expiresAt,
      });
      return handle;
    } catch (error) {
      if (error instanceof Error && error.message === "workflow_media_source_unavailable") throw error;
      throw new Error("workflow_media_source_unavailable");
    }
  }

  resolve(handle: string): string | null {
    if (!HANDLE.test(handle)) return null;
    try {
      const info = fs.lstatSync(this.sidecarPath(handle));
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const stored = parseStoredArtifact(JSON.parse(fs.readFileSync(this.sidecarPath(handle), "utf8")));
      if (!stored || stored.expiresAt <= this.now()) return null;
      return stored.source === "library"
        ? this.mediaLibrary.resolveAuthorizedPath(stored.absolutePath)
        : stored.source === "inbound"
          ? this.resolveInboundPath(stored.absolutePath)
          : this.resolveSnapshotPath(stored.absolutePath);
    } catch {
      return null;
    }
  }

  private sidecarPath(handle: string): string {
    return path.join(this.root, `${handle}.json`);
  }

  private persist(destination: string, temporary: string, stored: StoredArtifact): void {
    fs.writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  }

  private resolveInboundPath(candidate: string): string | null {
    if (!this.inboundRoot || !path.isAbsolute(candidate)) return null;
    try {
      const root = fs.realpathSync(this.inboundRoot);
      const info = fs.lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MEDIA_ARTIFACT_BYTES) return null;
      const real = fs.realpathSync(candidate);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) return null;
      return real;
    } catch {
      return null;
    }
  }

  private resolveSnapshotPath(candidate: string): string | null {
    try {
      const root = fs.realpathSync(path.join(this.root, "snapshots"));
      const info = fs.lstatSync(candidate);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MEDIA_ARTIFACT_BYTES) return null;
      const real = fs.realpathSync(candidate);
      if (!real.startsWith(`${root}${path.sep}`)) return null;
      return real;
    } catch {
      return null;
    }
  }
}
