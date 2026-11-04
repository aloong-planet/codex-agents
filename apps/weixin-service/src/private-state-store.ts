import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type PrivateIlinkState = {
  version: 1;
  bindingGeneration?: string;
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
  getUpdatesBuf: string;
  contextTokens: Record<string, string>;
  accountLabel?: string;
  targetMetadata?: Record<string, PrivateTargetMetadata>;
};

export type PrivateTargetMetadata = {
  contextGeneration?: string;
  label?: string;
  lastInboundAt?: number;
  contextUpdatedAt?: number;
  lastSendAcceptedAt?: number;
};

const ACCOUNT_ID = /^[A-Za-z0-9._@-]{1,200}$/;
const TARGET_ID = /^[A-Za-z0-9._-]+@im\.wechat$/;
const MAX_SECRET_CHARS = 32 * 1024;
const MAX_LABEL_CHARS = 80;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      (url.hostname === "weixin.qq.com" || url.hostname.endsWith(".weixin.qq.com"))
    );
  } catch {
    return false;
  }
}

function normalizeLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("私有状态格式无效");
  const label = value.trim();
  if (!label) return undefined;
  if (Array.from(label).length > MAX_LABEL_CHARS || hasControlCharacter(label)) {
    throw new Error("私有状态格式无效");
  }
  return label;
}

function normalizeTimestamp(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error("私有状态格式无效");
  }
  return value as number;
}

function parseState(value: unknown): PrivateIlinkState {
  if (!isRecord(value) || value.version !== 1) throw new Error("私有状态格式无效");
  if (typeof value.accountId !== "string" || !ACCOUNT_ID.test(value.accountId)) {
    throw new Error("私有状态格式无效");
  }
  if (
    typeof value.token !== "string" ||
    !value.token ||
    value.token.length > MAX_SECRET_CHARS ||
    typeof value.baseUrl !== "string" ||
    !isSafeHttpsUrl(value.baseUrl) ||
    typeof value.getUpdatesBuf !== "string" ||
    value.getUpdatesBuf.length > MAX_SECRET_CHARS ||
    !isRecord(value.contextTokens)
  ) {
    throw new Error("私有状态格式无效");
  }
  if (
    value.userId !== undefined &&
    (typeof value.userId !== "string" || !TARGET_ID.test(value.userId))
  ) {
    throw new Error("私有状态格式无效");
  }

  if (value.bindingGeneration !== undefined && (typeof value.bindingGeneration !== "string" || !/^[a-f0-9-]{36}$/u.test(value.bindingGeneration))) throw new Error("私有状态格式无效");

  const contextTokens: Record<string, string> = {};
  const entries = Object.entries(value.contextTokens);
  if (entries.length > 100) throw new Error("私有状态格式无效");
  for (const [target, token] of entries) {
    if (
      !TARGET_ID.test(target) ||
      typeof token !== "string" ||
      !token ||
      token.length > MAX_SECRET_CHARS
    ) {
      throw new Error("私有状态格式无效");
    }
    contextTokens[target] = token;
  }

  const accountLabel = normalizeLabel(value.accountLabel);
  let targetMetadata: Record<string, PrivateTargetMetadata> | undefined;
  if (value.targetMetadata !== undefined) {
    if (!isRecord(value.targetMetadata)) throw new Error("私有状态格式无效");
    const metadataEntries = Object.entries(value.targetMetadata);
    if (metadataEntries.length > 100) throw new Error("私有状态格式无效");
    const normalizedMetadata: Record<string, PrivateTargetMetadata> = {};
    for (const [target, metadata] of metadataEntries) {
      if (!contextTokens[target] || !isRecord(metadata)) {
        throw new Error("私有状态格式无效");
      }
      if (metadata.contextGeneration !== undefined && (typeof metadata.contextGeneration !== "string" || !/^[a-f0-9-]{36}$/u.test(metadata.contextGeneration))) throw new Error("私有状态格式无效");
      const label = normalizeLabel(metadata.label);
      const lastInboundAt = normalizeTimestamp(metadata.lastInboundAt);
      const contextUpdatedAt = normalizeTimestamp(metadata.contextUpdatedAt);
      const lastSendAcceptedAt = normalizeTimestamp(metadata.lastSendAcceptedAt);
      const normalized: PrivateTargetMetadata = {
        ...(metadata.contextGeneration ? { contextGeneration: metadata.contextGeneration as string } : {}),
        ...(label ? { label } : {}),
        ...(lastInboundAt ? { lastInboundAt } : {}),
        ...(contextUpdatedAt ? { contextUpdatedAt } : {}),
        ...(lastSendAcceptedAt ? { lastSendAcceptedAt } : {}),
      };
      if (Object.keys(normalized).length > 0) normalizedMetadata[target] = normalized;
    }
    if (Object.keys(normalizedMetadata).length > 0) targetMetadata = normalizedMetadata;
  }

  return {
    version: 1,
    ...(value.bindingGeneration ? { bindingGeneration: value.bindingGeneration as string } : {}),
    accountId: value.accountId,
    token: value.token,
    baseUrl: value.baseUrl,
    ...(value.userId ? { userId: value.userId } : {}),
    getUpdatesBuf: value.getUpdatesBuf,
    contextTokens,
    ...(accountLabel ? { accountLabel } : {}),
    ...(targetMetadata ? { targetMetadata } : {}),
  };
}

export class PrivateStateStore {
  constructor(private readonly filePath: string) {}

  load(): PrivateIlinkState | null {
    if (!fs.existsSync(this.filePath)) return null;
    const fileStat = fs.lstatSync(this.filePath);
    const directoryStat = fs.statSync(path.dirname(this.filePath));
    if (
      !fileStat.isFile() ||
      fileStat.isSymbolicLink() ||
      (fileStat.mode & 0o077) !== 0 ||
      (directoryStat.mode & 0o077) !== 0
    ) {
      throw new Error("私有状态文件权限不安全");
    }
    try {
      return parseState(JSON.parse(fs.readFileSync(this.filePath, "utf8")));
    } catch (error) {
      if (error instanceof Error && error.message.includes("权限不安全")) throw error;
      throw new Error("私有状态格式无效");
    }
  }

  save(state: PrivateIlinkState): void {
    const normalized = parseState(state);
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);

    const temporaryPath = path.join(dir, `.state-${crypto.randomUUID()}.tmp`);
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
        // The temporary file may not have been created or may already be renamed.
      }
      throw error;
    }
  }
}
