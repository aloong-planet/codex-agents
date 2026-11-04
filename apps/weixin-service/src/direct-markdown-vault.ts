import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_NOTE_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 100_000;

export type VaultRevision = { path: string; sha256: string };
export type VaultNote = VaultRevision & { content: string };

function sha256(content: Buffer | string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

const SEARCH_TERM_ALIAS_GROUPS = [
  ["agent", "代理", "智能体"],
] as const;

function queryTermVariants(term: string): readonly string[] {
  return SEARCH_TERM_ALIAS_GROUPS.find((group) => group.some((alias) => alias === term)) ?? [term];
}

function extractQueryTerms(value: string): string[] {
  return Array.from(new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .split(/[^\p{Letter}\p{Number}]+/u)
      .map(normalizeSearchText)
      .filter(Boolean),
  ));
}

function matchesEveryQueryTerm(candidate: string, terms: readonly string[]): boolean {
  return terms.length >= 2 && terms.every((term) => (
    queryTermVariants(term).some((variant) => candidate.includes(variant))
  ));
}

function isWithinOneEdit(left: string[], right: string[]): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  const longer = left.length >= right.length ? left : right;
  const shorter = left.length >= right.length ? right : left;
  let longerIndex = 0;
  let shorterIndex = 0;
  let edits = 0;
  while (longerIndex < longer.length && shorterIndex < shorter.length) {
    if (longer[longerIndex] === shorter[shorterIndex]) {
      longerIndex += 1;
      shorterIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    longerIndex += 1;
    if (longer.length === shorter.length) shorterIndex += 1;
  }
  return edits + (longer.length - longerIndex) <= 1;
}

function isApproximateTitleMatch(title: string, needle: string): boolean {
  const query = Array.from(needle);
  if (query.length < 6 || query.length > 64) return false;
  const candidate = Array.from(title).slice(0, 512);
  const minimumWindow = Math.max(1, query.length - 1);
  const maximumWindow = Math.min(candidate.length, query.length + 1);
  for (let windowLength = minimumWindow; windowLength <= maximumWindow; windowLength += 1) {
    for (let index = 0; index <= candidate.length - windowLength; index += 1) {
      if (isWithinOneEdit(candidate.slice(index, index + windowLength), query)) return true;
    }
  }
  return false;
}

function validateRelativeMarkdownPath(input: string): string[] {
  if (
    !input ||
    input.includes("\0") ||
    input.includes("\\") ||
    path.posix.isAbsolute(input) ||
    !input.endsWith(".md")
  ) throw new Error("Vault 路径必须是相对 Markdown 路径");
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Vault 路径包含不允许的目录");
  }
  return parts;
}

function validateRelativeDirectory(input: string): string[] {
  if (!input || input.includes("\0") || input.includes("\\") || path.posix.isAbsolute(input)) {
    throw new Error("Vault 目录必须是相对路径");
  }
  const parts = input.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error("Vault 目录包含不允许的路径");
  }
  return parts;
}

function ensureWriteSize(content: string): Buffer {
  const encoded = Buffer.from(content, "utf8");
  if (encoded.byteLength > MAX_WRITE_BYTES) throw new Error("Markdown 内容过大");
  return encoded;
}

export class DirectMarkdownVault {
  private readonly root: string;

  constructor(root: string) {
    const rootStat = fs.lstatSync(root);
    const metadataStat = fs.lstatSync(path.join(root, ".obsidian"));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !metadataStat.isDirectory()) {
      throw new Error("Obsidian Vault 不可用");
    }
    this.root = fs.realpathSync(root);
  }

  async search(query: string): Promise<string[]> {
    return this.searchFrom(this.root, [], query);
  }

  async searchForSelection(query: string): Promise<string[]> {
    return this.searchForSelectionFrom(this.root, [], query);
  }

  async searchWithin(relativeDirectory: string, query: string, newestFirst = false): Promise<string[]> {
    const parts = validateRelativeDirectory(relativeDirectory);
    await this.assertSafeExistingPath(parts);
    const directory = path.join(this.root, ...parts);
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Vault 目录不安全");
    return this.searchFrom(directory, parts, query, newestFirst);
  }

  async searchForSelectionWithin(relativeDirectory: string, query: string): Promise<string[]> {
    const parts = validateRelativeDirectory(relativeDirectory);
    await this.assertSafeExistingPath(parts);
    const directory = path.join(this.root, ...parts);
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Vault 目录不安全");
    return this.searchForSelectionFrom(directory, parts, query);
  }

  private async searchFrom(
    directory: string,
    relativeParts: string[],
    query: string,
    newestFirst = false,
  ): Promise<string[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || Buffer.byteLength(needle, "utf8") > 500) throw new Error("搜索词无效");
    const matches: string[] = [];
    let scanned = 0;
    const visit = async (directory: string, relativeParts: string[]): Promise<void> => {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (scanned >= 2000 || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const nextParts = [...relativeParts, entry.name];
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute, nextParts);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        scanned += 1;
        const relative = nextParts.join("/");
        let matched = relative.toLocaleLowerCase().includes(needle);
        if (!matched) {
          const note = await this.read(relative);
          matched = note.content.toLocaleLowerCase().includes(needle);
        }
        if (matched) matches.push(relative);
      }
    };
    await visit(directory, relativeParts);
    matches.sort();
    if (newestFirst) matches.reverse();
    return matches.slice(0, 20);
  }

  private async searchForSelectionFrom(
    directory: string,
    relativeParts: string[],
    query: string,
  ): Promise<string[]> {
    const needle = normalizeSearchText(query.trim());
    const queryTerms = extractQueryTerms(query.trim());
    if (!needle || Buffer.byteLength(needle, "utf8") > 500) throw new Error("搜索词无效");
    const paths: string[] = [];
    let scanned = 0;
    const visit = async (currentDirectory: string, currentParts: string[]): Promise<void> => {
      const entries = await fs.promises.readdir(currentDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (scanned >= 2000 || entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const nextParts = [...currentParts, entry.name];
        const absolute = path.join(currentDirectory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute, nextParts);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        scanned += 1;
        paths.push(nextParts.join("/"));
      }
    };
    await visit(directory, relativeParts);

    const metadataMatches = paths.flatMap((relativePath) => {
      const title = normalizeSearchText(path.basename(relativePath, ".md"));
      const normalizedPath = normalizeSearchText(relativePath);
      const score = title === needle
        ? 500
        : title.includes(needle)
          ? 450
          : matchesEveryQueryTerm(title, queryTerms)
            ? 425
            : normalizedPath.includes(needle)
              ? 400
              : matchesEveryQueryTerm(normalizedPath, queryTerms)
                ? 375
                : isApproximateTitleMatch(title, needle)
                  ? 300
                  : 0;
      return score === 0 ? [] : [{ relativePath, score }];
    });
    if (metadataMatches.length > 0) {
      return metadataMatches
        .sort((left, right) => right.score - left.score || (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0))
        .slice(0, 20)
        .map((match) => match.relativePath);
    }

    const contentMatches: string[] = [];
    for (const relativePath of paths) {
      const note = await this.read(relativePath);
      if (normalizeSearchText(note.content).includes(needle)) contentMatches.push(relativePath);
    }
    return contentMatches.sort().slice(0, 20);
  }

  async read(relativePath: string): Promise<VaultNote> {
    const parts = validateRelativeMarkdownPath(relativePath);
    const absolutePath = path.join(this.root, ...parts);
    await this.assertSafeExistingPath(parts);
    const handle = await fs.promises.open(
      absolutePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) throw new Error("Markdown 文件不可读取");
      const content = await handle.readFile();
      return { path: parts.join("/"), content: content.toString("utf8"), sha256: sha256(content) };
    } finally {
      await handle.close();
    }
  }

  async create(relativePath: string, content: string): Promise<VaultRevision> {
    const parts = validateRelativeMarkdownPath(relativePath);
    const encoded = ensureWriteSize(content);
    const directoryParts = parts.slice(0, -1);
    await this.ensureSafeDirectories(directoryParts);
    const directory = path.join(this.root, ...directoryParts);
    if (await fs.promises.realpath(directory) !== directory) throw new Error("Vault 目录不安全");
    const absolutePath = path.join(this.root, ...parts);
    const handle = await fs.promises.open(
      absolutePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    try {
      await handle.writeFile(encoded);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { path: parts.join("/"), sha256: sha256(encoded) };
  }

  async update(relativePath: string, content: string, expectedSha256: string): Promise<VaultRevision> {
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error("Markdown 修订值无效");
    const parts = validateRelativeMarkdownPath(relativePath);
    const encoded = ensureWriteSize(content);
    await this.assertSafeExistingPath(parts);
    const absolutePath = path.join(this.root, ...parts);
    const originalStat = await fs.promises.lstat(absolutePath);
    if (!originalStat.isFile() || originalStat.isSymbolicLink() || originalStat.size > MAX_NOTE_BYTES) {
      throw new Error("Markdown 文件不可更新");
    }
    const original = await this.read(parts.join("/"));
    if (original.sha256 !== expectedSha256) throw new Error("Markdown 已被修改，请重新读取后再试");

    const temporary = path.join(path.dirname(absolutePath), `.vault-write-${crypto.randomUUID()}.tmp`);
    let temporaryExists = false;
    try {
      const handle = await fs.promises.open(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        originalStat.mode & 0o777,
      );
      temporaryExists = true;
      try {
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const currentStat = await fs.promises.lstat(absolutePath);
      if (
        currentStat.isSymbolicLink() ||
        currentStat.dev !== originalStat.dev ||
        currentStat.ino !== originalStat.ino ||
        currentStat.size !== originalStat.size ||
        currentStat.mtimeMs !== originalStat.mtimeMs
      ) throw new Error("Markdown 已被修改，请重新读取后再试");
      await fs.promises.rename(temporary, absolutePath);
      temporaryExists = false;
      return { path: parts.join("/"), sha256: sha256(encoded) };
    } finally {
      if (temporaryExists) await fs.promises.unlink(temporary).catch(() => {});
    }
  }

  private async assertSafeExistingPath(parts: string[]): Promise<void> {
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      const stat = await fs.promises.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Vault 路径不允许符号链接");
    }
  }

  private async ensureSafeDirectories(parts: string[]): Promise<void> {
    let current = this.root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const stat = await fs.promises.lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Vault 目录不安全");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.promises.mkdir(current, { mode: 0o755 });
        const created = await fs.promises.lstat(current);
        if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("Vault 目录不安全");
      }
    }
  }
}
