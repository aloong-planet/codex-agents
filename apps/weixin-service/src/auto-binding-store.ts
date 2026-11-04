import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type AutoBindingStatus =
  | "idle"
  | "awaiting_inbound"
  | "sending"
  | "accepted"
  | "failed";

export type AutoBindingRecord =
  | { version: 1; status: "idle" }
  | { version: 1; status: "awaiting_inbound"; accountId: string; updatedAt: number }
  | {
      version: 1;
      status: "sending" | "accepted" | "failed";
      accountId: string;
      target: string;
      eventKey: string;
      updatedAt: number;
      reason?: "auth_stale" | "rejected" | "unknown";
    };

export interface AutoBindingStateStore {
  load(): AutoBindingRecord;
  save(record: AutoBindingRecord): void;
}

const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_ID = /^[A-Za-z0-9._-]+@im\.wechat$/;
const EVENT_KEY = /^[A-Za-z0-9._:-]{1,256}$/;

function parseRecord(value: unknown): AutoBindingRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("自动绑定状态格式无效");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.status !== "string") {
    throw new Error("自动绑定状态格式无效");
  }
  if (record.status === "idle") return { version: 1, status: "idle" };
  if (
    typeof record.accountId !== "string" ||
    !ACCOUNT_ID.test(record.accountId) ||
    !Number.isSafeInteger(record.updatedAt) ||
    (record.updatedAt as number) <= 0
  ) {
    throw new Error("自动绑定状态格式无效");
  }
  if (record.status === "awaiting_inbound") {
    return {
      version: 1,
      status: "awaiting_inbound",
      accountId: record.accountId,
      updatedAt: record.updatedAt as number,
    };
  }
  if (!["sending", "accepted", "failed"].includes(record.status)) {
    throw new Error("自动绑定状态格式无效");
  }
  if (
    typeof record.target !== "string" ||
    !TARGET_ID.test(record.target) ||
    typeof record.eventKey !== "string" ||
    !EVENT_KEY.test(record.eventKey) ||
    (record.reason !== undefined &&
      !["auth_stale", "rejected", "unknown"].includes(String(record.reason)))
  ) {
    throw new Error("自动绑定状态格式无效");
  }
  return {
    version: 1,
    status: record.status as "sending" | "accepted" | "failed",
    accountId: record.accountId,
    target: record.target,
    eventKey: record.eventKey,
    updatedAt: record.updatedAt as number,
    ...(record.reason
      ? { reason: record.reason as "auth_stale" | "rejected" | "unknown" }
      : {}),
  };
}

export class AutoBindingFileStore implements AutoBindingStateStore {
  constructor(private readonly filePath: string) {}

  load(): AutoBindingRecord {
    if (!fs.existsSync(this.filePath)) return { version: 1, status: "idle" };
    const fileStat = fs.lstatSync(this.filePath);
    const directoryStat = fs.statSync(path.dirname(this.filePath));
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      (fileStat.mode & 0o077) !== 0 ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      throw new Error("自动绑定状态文件权限不安全");
    }
    try {
      return parseRecord(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof Error && error.message.includes("权限不安全")) throw error;
      throw new Error("自动绑定状态格式无效");
    }
  }

  save(record: AutoBindingRecord): void {
    const normalized = parseRecord(record);
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporaryPath = path.join(directory, `.auto-binding-${crypto.randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(normalized), "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not exist or may already have been renamed.
      }
      throw error;
    }
  }
}

export class MemoryAutoBindingStore implements AutoBindingStateStore {
  private record: AutoBindingRecord = { version: 1, status: "idle" };

  load(): AutoBindingRecord {
    return structuredClone(this.record);
  }

  save(record: AutoBindingRecord): void {
    this.record = structuredClone(record);
  }
}
