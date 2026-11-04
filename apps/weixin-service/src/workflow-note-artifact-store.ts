import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const NOTE_HANDLE = /^note_[a-f0-9]{32}$/;
const CONTENT_HANDLE = /^content_[a-f0-9]{32}$/;
const SEARCH_REQUEST_HANDLE = /^query_[a-f0-9]{32}$/;
const SELECTION_HANDLE = /^selection_[a-f0-9]{32}$/;
const MAX_READ_CONTENT_BYTES = 1024 * 1024;
const MAX_DRAFT_CONTENT_BYTES = 100_000;

type StoredArtifact =
  | { version: 1; kind: "note"; relativePath: string; expiresAt: number }
  | { version: 1; kind: "content"; noteHandle?: string; content: string; expiresAt: number }
  | { version: 1; kind: "search_request"; query: string; expiresAt: number }
  | { version: 1; kind: "selection"; ownerKey: string; candidates: Array<{ noteHandle: string; fileName: string }>; resolved: boolean; expiresAt: number };

export type WorkflowNoteHandle = { handle: string; fileName: string; expiresAt: number };
export type WorkflowNoteContentHandle = { handle: string; sizeBytes: number; expiresAt: number };
export type WorkflowNoteSearchRequestHandle = { handle: string; expiresAt: number };

function validRelativeMarkdownPath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\") || path.posix.isAbsolute(value) || !value.endsWith(".md")) return false;
  return value.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."));
}

export class WorkflowNoteArtifactStore {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.chmodSync(root, 0o700);
  }

  captureNotePath(relativePath: string): WorkflowNoteHandle {
    if (!validRelativeMarkdownPath(relativePath)) throw new Error("workflow_note_path_invalid");
    const handle = `note_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    this.write(handle, { version: 1, kind: "note", relativePath, expiresAt });
    return { handle, fileName: path.posix.basename(relativePath), expiresAt };
  }

  captureSearchRequest(triggerKey: string, query: string): WorkflowNoteSearchRequestHandle {
    const normalized = query.trim();
    if (!triggerKey || triggerKey.length > 512 || Buffer.byteLength(normalized, "utf8") > 500 || !normalized) {
      throw new Error("workflow_note_search_request_invalid");
    }
    const handle = `query_${crypto.createHash("sha256").update(triggerKey).digest("hex").slice(0, 32)}`;
    const existing = this.read(handle);
    if (existing?.kind === "search_request") {
      if (existing.query !== normalized) throw new Error("workflow_note_search_request_conflict");
      return { handle, expiresAt: existing.expiresAt };
    }
    const expiresAt = this.now() + this.ttlMs;
    this.write(handle, { version: 1, kind: "search_request", query: normalized, expiresAt });
    return { handle, expiresAt };
  }

  captureSelection(triggerKey: string, accountId: string, target: string, candidates: Array<{ noteHandle: string; fileName: string }>): { reference: string } {
    if (!triggerKey || !accountId || !target || candidates.length < 1 || candidates.length > 20 || candidates.some((item) => !NOTE_HANDLE.test(item.noteHandle))) throw new Error("workflow_note_selection_invalid");
    const handle = `selection_${crypto.createHash("sha256").update(triggerKey).digest("hex").slice(0, 32)}`;
    const ownerKey = crypto.createHash("sha256").update(`${accountId}\0${target}`).digest("hex");
    const existing = this.read(handle);
    if (!existing) this.write(handle, { version: 1, kind: "selection", ownerKey, candidates, resolved: false, expiresAt: this.now() + this.ttlMs });
    else if (existing.kind !== "selection" || existing.ownerKey !== ownerKey || JSON.stringify(existing.candidates) !== JSON.stringify(candidates)) throw new Error("workflow_note_selection_conflict");
    return { reference: handle.slice(10, 16) };
  }

  selectNote(accountId: string, target: string, reference: string | undefined, ordinal: number): { selectionHandle: string; noteHandle: string; fileName: string } | "missing" | "ambiguous" {
    const ownerKey = crypto.createHash("sha256").update(`${accountId}\0${target}`).digest("hex");
    const found: Array<{ handle: string; artifact: Extract<StoredArtifact, { kind: "selection" }> }> = [];
    for (const file of fs.readdirSync(this.root)) {
      const match = /^(selection_[a-f0-9]{32})\.json$/.exec(file);
      if (!match || (reference && match[1]!.slice(10, 16) !== reference)) continue;
      const artifact = this.read(match[1]!);
      if (artifact?.kind === "selection" && !artifact.resolved && artifact.ownerKey === ownerKey) found.push({ handle: match[1]!, artifact });
    }
    if (found.length === 0) return "missing";
    if (found.length > 1) return "ambiguous";
    const item = found[0]!.artifact.candidates[ordinal - 1];
    return item ? { selectionHandle: found[0]!.handle, ...item } : "missing";
  }

  completeSelection(handle: string): void {
    if (!SELECTION_HANDLE.test(handle)) throw new Error("workflow_note_selection_invalid");
    const artifact = this.read(handle);
    if (artifact?.kind !== "selection") throw new Error("workflow_note_selection_unavailable");
    this.write(handle, { ...artifact, resolved: true });
  }

  captureContent(noteHandle: string, content: string): WorkflowNoteContentHandle {
    if (!this.resolveNotePath(noteHandle)) throw new Error("workflow_note_handle_unavailable");
    return this.captureContentValue(content, MAX_READ_CONTENT_BYTES, noteHandle);
  }

  captureDraftContent(content: string): WorkflowNoteContentHandle {
    return this.captureContentValue(content, MAX_DRAFT_CONTENT_BYTES);
  }

  private captureContentValue(content: string, maxBytes: number, noteHandle?: string): WorkflowNoteContentHandle {
    const sizeBytes = Buffer.byteLength(content, "utf8");
    if (sizeBytes > maxBytes) throw new Error("workflow_note_content_too_large");
    const handle = `content_${crypto.randomBytes(16).toString("hex")}`;
    const expiresAt = this.now() + this.ttlMs;
    this.write(handle, { version: 1, kind: "content", ...(noteHandle ? { noteHandle } : {}), content, expiresAt });
    return { handle, sizeBytes, expiresAt };
  }

  resolveNotePath(handle: string): string | null {
    if (!NOTE_HANDLE.test(handle)) return null;
    const artifact = this.read(handle);
    return artifact?.kind === "note" && validRelativeMarkdownPath(artifact.relativePath)
      ? artifact.relativePath
      : null;
  }

  resolveContent(handle: string): string | null {
    if (!CONTENT_HANDLE.test(handle)) return null;
    const artifact = this.read(handle);
    return artifact?.kind === "content" && (!artifact.noteHandle || NOTE_HANDLE.test(artifact.noteHandle))
      ? artifact.content
      : null;
  }

  resolveSearchRequest(handle: string): string | null {
    if (!SEARCH_REQUEST_HANDLE.test(handle)) return null;
    const artifact = this.read(handle);
    return artifact?.kind === "search_request" ? artifact.query : null;
  }

  private write(handle: string, artifact: StoredArtifact): void {
    const destination = this.sidecarPath(handle);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(artifact), { mode: 0o600 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  }

  private read(handle: string): StoredArtifact | null {
    try {
      const file = this.sidecarPath(handle);
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoredArtifact>;
      if (value.version !== 1 || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= this.now()) return null;
      if (value.kind === "note" && typeof value.relativePath === "string") return value as StoredArtifact;
      if (value.kind === "content" && (value.noteHandle === undefined || typeof value.noteHandle === "string") && typeof value.content === "string") return value as StoredArtifact;
      if (value.kind === "search_request" && typeof value.query === "string") return value as StoredArtifact;
      if (value.kind === "selection" && typeof value.ownerKey === "string" && typeof value.resolved === "boolean" && Array.isArray(value.candidates)) return value as StoredArtifact;
      return null;
    } catch {
      return null;
    }
  }

  private sidecarPath(handle: string): string {
    return path.join(this.root, `${handle}.json`);
  }
}
