import path from "node:path";

export interface SnapshotLifecycle {
  prepare(threadId: string, turnId: string): string;
  complete(snapshotId: string): unknown;
}

export type PermissionRequest = {
  threadId?: unknown;
  turnId?: unknown;
  permissions?: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class NativeWriteGuard {
  readonly name = "工作区 + demo Vault";
  private readonly snapshotsByTurn = new Map<string, string>();
  private readonly roots: string[];
  private writeEnabled = false;

  constructor(roots: string[], private readonly snapshots: SnapshotLifecycle) {
    this.roots = roots.map((root) => path.resolve(root));
  }

  async request(params: PermissionRequest): Promise<Record<string, unknown>> {
    if (!this.writeEnabled) throw new Error("本地执行写权限尚未启用");
    if (typeof params.threadId !== "string" || typeof params.turnId !== "string") {
      throw new Error("权限请求缺少任务信息");
    }
    const permissions = record(params.permissions);
    const network = record(permissions?.network);
    if (network?.enabled === true) throw new Error("不允许 shell 网络权限");
    const fileSystem = record(permissions?.fileSystem);
    const requestedPaths = this.requestedWritePaths(fileSystem);
    if (requestedPaths.length === 0) throw new Error("未请求可识别的写权限");
    for (const requestedPath of requestedPaths) {
      if (!this.roots.some((root) => this.isInside(root, requestedPath))) {
        throw new Error("写权限请求越界");
      }
    }
    const key = this.turnKey(params.threadId, params.turnId);
    if (this.snapshotsByTurn.has(key)) throw new Error("当前 turn 已授予过写权限");
    const snapshotId = this.snapshots.prepare(params.threadId, params.turnId);
    this.snapshotsByTurn.set(key, snapshotId);
    return {
      permissions: {
        fileSystem: {
          entries: this.roots.map((root) => ({
            access: "write",
            path: { type: "path", path: root },
          })),
        },
        network: { enabled: false },
      },
      scope: "turn",
      strictAutoReview: true,
    };
  }

  isEnabled(): boolean {
    return this.writeEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.writeEnabled = enabled;
  }

  complete(threadId: string, turnId: string): void {
    const key = this.turnKey(threadId, turnId);
    const snapshotId = this.snapshotsByTurn.get(key);
    if (!snapshotId) return;
    this.snapshotsByTurn.delete(key);
    this.snapshots.complete(snapshotId);
  }

  private requestedWritePaths(fileSystem: Record<string, unknown> | null): string[] {
    const paths: string[] = [];
    if (Array.isArray(fileSystem?.write)) {
      for (const value of fileSystem.write) {
        if (typeof value !== "string") throw new Error("写权限路径格式无效");
        paths.push(path.resolve(value));
      }
    }
    if (Array.isArray(fileSystem?.entries)) {
      for (const value of fileSystem.entries) {
        const entry = record(value);
        if (entry?.access !== "write") continue;
        const filePath = record(entry.path);
        if (filePath?.type !== "path" || typeof filePath.path !== "string") {
          throw new Error("不允许 glob 或特殊路径写权限");
        }
        paths.push(path.resolve(filePath.path));
      }
    }
    return paths;
  }

  private isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}\u0000${turnId}`;
  }
}
