import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOTS = [
  { id: "downloads", displayName: "Downloads", directory: "Downloads" },
  { id: "pictures", displayName: "Pictures", directory: "Pictures" },
  { id: "documents", displayName: "Documents", directory: "Documents" },
] as const;
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const APPLE_PRIVACY_DIRECTORY_EXTENSIONS = new Set([".photoslibrary"]);
const MAX_SCAN_ENTRIES = 10_000;
const MAX_RESULTS = 20;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

type StoredGrant = { id: string; canonicalPath: string };
type StoredState = { version: 1; revision: number; grants: StoredGrant[] };
export type MediaExportRootStatus = "available" | "missing" | "blocked" | "changed";
export type MediaExportPublicState = {
  revision: number;
  roots: Array<{ id: string; displayName: string; enabled: boolean; status: MediaExportRootStatus }>;
};
export type MediaExportMatch = {
  token: string;
  rootId: string;
  rootName: string;
  fileName: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: number;
};
export type MediaExportAuthorizedScope = {
  scopeId: string;
  label: string;
  directory: string;
};

function parseState(value: unknown): StoredState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("媒体目录授权状态无效");
  const state = value as Record<string, unknown>;
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0 || !Array.isArray(state.grants)) {
    throw new Error("媒体目录授权状态无效");
  }
  const grants = state.grants.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("媒体目录授权状态无效");
    const grant = item as Record<string, unknown>;
    if (typeof grant.id !== "string" || typeof grant.canonicalPath !== "string") throw new Error("媒体目录授权状态无效");
    if (!ROOTS.some((root) => root.id === grant.id) || !path.isAbsolute(grant.canonicalPath)) throw new Error("媒体目录授权状态无效");
    return { id: grant.id, canonicalPath: grant.canonicalPath };
  });
  if (new Set(grants.map((item) => item.id)).size !== grants.length) throw new Error("媒体目录授权状态无效");
  return { version: 1, revision: state.revision as number, grants };
}

export class MediaExportLibrary {
  private state: StoredState;
  private readonly resolved = new Map<string, string>();
  private readonly maxScanEntries: number;

  constructor(
    private readonly statePath: string,
    private readonly homeDir: string,
    options: { maxScanEntries?: number } = {},
  ) {
    this.maxScanEntries = options.maxScanEntries ?? MAX_SCAN_ENTRIES;
    this.state = fs.existsSync(statePath)
      ? parseState(JSON.parse(fs.readFileSync(statePath, "utf8")))
      : { version: 1, revision: 0, grants: [] };
  }

  getPublicState(): MediaExportPublicState {
    return {
      revision: this.state.revision,
      roots: ROOTS.map((root) => ({
        id: root.id,
        displayName: root.displayName,
        enabled: this.state.grants.some((grant) => grant.id === root.id),
        status: this.rootStatus(root.id),
      })),
    };
  }

  getAuthorizedScopes(): MediaExportAuthorizedScope[] {
    return this.state.grants.flatMap((grant) => {
      if (this.rootStatus(grant.id) !== "available") return [];
      const root = ROOTS.find((candidate) => candidate.id === grant.id)!;
      return [{ scopeId: grant.id, label: root.displayName, directory: grant.canonicalPath }];
    });
  }

  configure(input: { rootIds: string[]; confirmed: boolean }): MediaExportPublicState {
    if (!input.confirmed) throw new Error("请确认媒体目录外发授权");
    const ids = [...new Set(input.rootIds)];
    const grants = ids.map((id) => {
      const root = ROOTS.find((candidate) => candidate.id === id);
      if (!root) throw new Error("媒体目录授权无效");
      const candidatePath = path.join(this.homeDir, root.directory);
      try {
        const info = fs.lstatSync(candidatePath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("媒体目录不可用");
        fs.readdirSync(candidatePath, { withFileTypes: true });
        return { id, canonicalPath: fs.realpathSync(candidatePath) };
      } catch {
        throw new Error("媒体目录不可用或被 macOS 阻止");
      }
    });
    this.state = { version: 1, revision: this.state.revision + 1, grants };
    this.save();
    return this.getPublicState();
  }

  async search(input: { query?: string; rootId?: string; limit?: number }): Promise<{
    matches: MediaExportMatch[];
    truncated: boolean;
    scanIncomplete: boolean;
  }> {
    this.resolved.clear();
    const query = (input.query ?? "").normalize("NFKC").toLocaleLowerCase();
    const limit = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(input.limit ?? 10)));
    const grants = this.state.grants.filter((grant) => !input.rootId || grant.id === input.rootId);
    if (input.rootId && !ROOTS.some((root) => root.id === input.rootId)) throw new Error("媒体目录无效");
    const candidates: Array<Omit<MediaExportMatch, "token"> & { absolutePath: string }> = [];
    let scanned = 0;
    let truncated = false;
    let scanIncomplete = false;
    for (const grant of grants) {
      if (this.rootStatus(grant.id) !== "available") continue;
      const root = ROOTS.find((item) => item.id === grant.id)!;
      const queue = [grant.canonicalPath];
      while (queue.length > 0) {
        const directory = queue.shift()!;
        let entries: fs.Dirent[];
        try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); }
        catch {
          scanIncomplete = true;
          continue;
        }
        for (const entry of entries) {
          if (++scanned > this.maxScanEntries) {
            truncated = true;
            scanIncomplete = true;
            break;
          }
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const absolutePath = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (!isApplePrivacyDirectoryName(entry.name)) queue.push(absolutePath);
            continue;
          }
          if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
          const relativePath = path.relative(grant.canonicalPath, absolutePath);
          if (query && !relativePath.normalize("NFKC").toLocaleLowerCase().includes(query)) continue;
          const stat = await fs.promises.stat(absolutePath);
          candidates.push({ rootId: grant.id, rootName: root.displayName, fileName: entry.name, relativePath, sizeBytes: stat.size, modifiedAt: stat.mtimeMs, absolutePath });
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    candidates.sort((a, b) => b.modifiedAt - a.modifiedAt ||
      a.rootId.localeCompare(b.rootId) || a.relativePath.localeCompare(b.relativePath));
    const matches = candidates.slice(0, limit).map(({ absolutePath, ...candidate }) => {
      const token = crypto.randomUUID();
      this.resolved.set(token, absolutePath);
      return { token, ...candidate };
    });
    return { matches, truncated: truncated || candidates.length > limit, scanIncomplete };
  }

  resolve(token: string): string | null {
    const value = this.resolved.get(token);
    if (!value) return null;
    return this.resolveAuthorizedPath(value);
  }

  resolveAuthorizedPath(value: string): string | null {
    if (!path.isAbsolute(value)) return null;
    try {
      const info = fs.lstatSync(value);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MEDIA_BYTES) return null;
      if (!IMAGE_EXTENSIONS.has(path.extname(value).toLowerCase())) return null;
      const real = fs.realpathSync(value);
      const allowed = this.state.grants.some((grant) => this.rootStatus(grant.id) === "available"
        && (real === grant.canonicalPath || real.startsWith(`${grant.canonicalPath}${path.sep}`))
        && !hasApplePrivacyDirectoryComponent(grant.canonicalPath, real));
      return allowed ? real : null;
    } catch {
      return null;
    }
  }

  private rootStatus(id: string): MediaExportRootStatus {
    const root = ROOTS.find((candidate) => candidate.id === id)!;
    const candidatePath = path.join(this.homeDir, root.directory);
    try {
      const info = fs.lstatSync(candidatePath);
      if (!info.isDirectory() || info.isSymbolicLink()) return "changed";
      fs.readdirSync(candidatePath, { withFileTypes: true });
      const grant = this.state.grants.find((item) => item.id === id);
      if (grant && fs.realpathSync(candidatePath) !== grant.canonicalPath) return "changed";
      return "available";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" ? "missing" : "blocked";
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
    fs.chmodSync(this.statePath, 0o600);
  }
}

function isApplePrivacyDirectoryName(name: string): boolean {
  return APPLE_PRIVACY_DIRECTORY_EXTENSIONS.has(path.extname(name).toLocaleLowerCase("en-US"));
}

function hasApplePrivacyDirectoryComponent(root: string, value: string): boolean {
  const relativeDirectory = path.dirname(path.relative(root, value));
  return relativeDirectory.split(path.sep).some(isApplePrivacyDirectoryName);
}
