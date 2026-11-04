import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type ManifestEntry = { hash: string; size: number };
type Manifest = Record<string, ManifestEntry>;

export type SnapshotChange = {
  root: string;
  relativePath: string;
  kind: "created" | "modified" | "deleted";
};

type SnapshotRecord = {
  id: string;
  threadId: string;
  turnId: string;
  createdAt: number;
  roots: string[];
  before: Record<string, Manifest>;
  after?: Record<string, Manifest>;
  changes?: SnapshotChange[];
};

const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);

function hash(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export class TurnSnapshotStore {
  constructor(
    private readonly stateRoot: string,
    private readonly roots: string[],
    private readonly maxBytes = 50 * 1024 * 1024,
  ) {}

  prepare(threadId: string, turnId: string): string {
    const id = crypto.randomUUID();
    const directory = this.snapshotDirectory(id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    let totalBytes = 0;
    const before: Record<string, Manifest> = {};
    try {
      this.roots.forEach((root, rootIndex) => {
        const manifest: Manifest = {};
        before[String(rootIndex)] = manifest;
        this.walk(root, "", (source, relativePath, stat) => {
          totalBytes += stat.size;
          if (totalBytes > this.maxBytes) throw new Error("写前快照超过快照预算，已拒绝写权限");
          manifest[relativePath] = { hash: hash(source), size: stat.size };
          const destination = path.join(directory, "files", String(rootIndex), relativePath);
          fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
          fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(destination, 0o600);
        });
      });
      this.writeRecord({ id, threadId, turnId, createdAt: Date.now(), roots: this.roots, before });
      return id;
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  complete(id: string): { changes: SnapshotChange[] } {
    const record = this.readRecord(id);
    const after: Record<string, Manifest> = {};
    const changes: SnapshotChange[] = [];
    record.roots.forEach((root, rootIndex) => {
      const key = String(rootIndex);
      const manifest: Manifest = {};
      after[key] = manifest;
      this.walk(root, "", (source, relativePath, stat) => {
        manifest[relativePath] = { hash: hash(source), size: stat.size };
      });
      const paths = new Set([...Object.keys(record.before[key] ?? {}), ...Object.keys(manifest)]);
      for (const relativePath of paths) {
        const beforeEntry = record.before[key]?.[relativePath];
        const afterEntry = manifest[relativePath];
        if (!beforeEntry && afterEntry) changes.push({ root, relativePath, kind: "created" });
        else if (beforeEntry && !afterEntry) changes.push({ root, relativePath, kind: "deleted" });
        else if (beforeEntry?.hash !== afterEntry?.hash) changes.push({ root, relativePath, kind: "modified" });
      }
    });
    this.writeRecord({ ...record, after, changes });
    return { changes };
  }

  restore(id: string): void {
    const record = this.readRecord(id);
    if (!record.after || !record.changes) throw new Error("快照尚未完成，不能恢复");
    for (const change of record.changes) {
      const rootIndex = record.roots.indexOf(change.root);
      if (rootIndex < 0) throw new Error("快照根目录无效");
      const current = path.join(change.root, change.relativePath);
      const afterEntry = record.after[String(rootIndex)]?.[change.relativePath];
      const currentHash = fs.existsSync(current) && fs.lstatSync(current).isFile() ? hash(current) : undefined;
      if (currentHash !== afterEntry?.hash) throw new Error(`恢复冲突：${change.relativePath}`);
    }
    for (const change of record.changes) {
      const rootIndex = record.roots.indexOf(change.root);
      const destination = path.join(change.root, change.relativePath);
      const beforeEntry = record.before[String(rootIndex)]?.[change.relativePath];
      if (!beforeEntry) {
        fs.rmSync(destination, { force: true });
        continue;
      }
      const source = path.join(this.snapshotDirectory(id), "files", String(rootIndex), change.relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
  }

  private walk(
    root: string,
    relativeDirectory: string,
    visit: (file: string, relativePath: string, stat: fs.Stats) => void,
  ): void {
    if (!fs.existsSync(root)) return;
    const directory = path.join(root, relativeDirectory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = path.join(relativeDirectory, entry.name);
      const file = path.join(root, relativePath);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`快照不跟随符号链接：${relativePath}`);
      if (stat.isDirectory()) this.walk(root, relativePath, visit);
      else if (stat.isFile()) visit(file, relativePath, stat);
    }
  }

  private snapshotDirectory(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("快照 ID 无效");
    return path.join(this.stateRoot, "turn-snapshots", id);
  }

  private writeRecord(record: SnapshotRecord): void {
    const file = path.join(this.snapshotDirectory(record.id), "manifest.json");
    fs.writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }

  private readRecord(id: string): SnapshotRecord {
    return JSON.parse(fs.readFileSync(path.join(this.snapshotDirectory(id), "manifest.json"), "utf8")) as SnapshotRecord;
  }
}
