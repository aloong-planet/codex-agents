import type { DirectMarkdownVault } from "./direct-markdown-vault.js";
import type { NewsArchive } from "./news-archive.js";
import type {
  DynamicToolDefinition,
  DynamicToolHost,
  DynamicToolResult,
} from "./dynamic-tool-host.js";

type JsonRecord = Record<string, unknown>;

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringField(value: unknown, key: string): string {
  const record = object(value);
  if (!record || typeof record[key] !== "string") throw new Error("工具参数无效");
  return record[key];
}

function result(success: boolean, value: unknown): DynamicToolResult {
  return {
    success,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

function safeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EEXIST") return "Markdown 已存在，未覆盖";
  if (code === "ENOENT") return "Markdown 不存在";
  const message = error instanceof Error ? error.message : "";
  const allowed = [
    "Vault 路径",
    "Vault 目录",
    "Markdown 内容",
    "Markdown 文件",
    "Markdown 修订",
    "Markdown 已被修改",
    "搜索词",
  ];
  return allowed.some((prefix) => message.startsWith(prefix)) ? message : "Vault 操作失败";
}

const DEFINITIONS: DynamicToolDefinition[] = [
  {
    type: "function",
    name: "obsidian_search_markdown",
    description: "在用户已授权的 demo Obsidian Vault 中按文件名或正文搜索 Markdown，只返回相对路径。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "搜索词" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "obsidian_read_markdown",
    description: "读取 demo Obsidian Vault 中的一篇 Markdown，返回正文和用于安全更新的 sha256。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Vault 内相对 .md 路径" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "obsidian_create_markdown",
    description: "在 demo Obsidian Vault 新建 Markdown；若已存在则拒绝覆盖。只在用户明确要求新建时调用。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault 内相对 .md 路径" },
        content: { type: "string", description: "完整 Markdown 正文" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "obsidian_update_markdown",
    description: "用完整正文更新已读取的 Markdown；sha256 不一致时拒绝。只在用户明确要求修改时调用。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault 内相对 .md 路径" },
        content: { type: "string", description: "更新后的完整 Markdown 正文" },
        expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      required: ["path", "content", "expectedSha256"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "news_search_archive",
    description: "只在 demo Obsidian Vault 的 news/ 新闻归档中搜索。自然追问第几条时，先用 query=摘要 找最近日期的摘要，再读取定位到的正文。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "标题、来源、正文关键词；定位第几条时写 摘要" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "news_read_archive",
    description: "读取 demo Obsidian Vault 的 news/ 下摘要或正文；拒绝任何 news/ 外路径。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "news/ 开头的相对 .md 路径" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];

export class VaultAuthorization {
  private enabled = false;
  private allowedTools = new Set<string>();

  constructor(readonly name: string) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.allowedTools.clear();
  }

  beginTurn(text: string): void {
    this.allowedTools.clear();
    const refersToNews = /(?:新闻|日报|摘要|hacker\s*news|第[一二三四五六七八九十\d]+[条篇]|这篇|那篇|上面[那的]?条|文章的?(?:细节|依据|风险|做法))/i.test(text);
    if (refersToNews) {
      this.allowedTools.add("news_search_archive");
      this.allowedTools.add("news_read_archive");
    }
    const refersToVault = /(?:obsidian|vault|markdown|\.md\b|笔记|文件)/i.test(text);
    if (!refersToVault) return;
    if (/(?:搜索|查找|找一下|检索)/.test(text)) {
      this.allowedTools.add("obsidian_search_markdown");
      this.allowedTools.add("obsidian_read_markdown");
    }
    if (/(?:读取|打开|查看|看看|读一下|内容)/.test(text)) {
      this.allowedTools.add("obsidian_read_markdown");
    }
    if (/(?:新建|创建|写入|保存|记到|记录到)/.test(text)) {
      this.allowedTools.add("obsidian_create_markdown");
    }
    if (/(?:修改|更新|编辑|替换|追加|补充)/.test(text)) {
      this.allowedTools.add("obsidian_search_markdown");
      this.allowedTools.add("obsidian_read_markdown");
      this.allowedTools.add("obsidian_update_markdown");
    }
  }

  endTurn(): void {
    this.allowedTools.clear();
  }

  isToolAllowed(tool: string): boolean {
    return this.allowedTools.has(tool);
  }
}

export class VaultDynamicToolHost implements DynamicToolHost {
  constructor(
    private readonly vault: DirectMarkdownVault,
    private readonly authorization: VaultAuthorization,
    private readonly newsArchive?: NewsArchive,
  ) {}

  definitions(): DynamicToolDefinition[] {
    return DEFINITIONS.map((definition) => ({ ...definition }));
  }

  async execute(tool: string, argumentsValue: unknown): Promise<DynamicToolResult> {
    const isNewsTool = tool === "news_search_archive" || tool === "news_read_archive";
    if (!isNewsTool && !this.authorization.isEnabled()) {
      return result(false, { error: "demo Vault 权限未启用" });
    }
    if (!this.authorization.isToolAllowed(tool)) {
      return result(false, { error: "当前微信消息没有明确授权这个 Vault 操作" });
    }
    try {
      if (tool === "news_search_archive") {
        if (!this.newsArchive) return result(false, { error: "新闻归档不可用" });
        return result(true, { matches: await this.newsArchive.search(stringField(argumentsValue, "query")) });
      }
      if (tool === "news_read_archive") {
        if (!this.newsArchive) return result(false, { error: "新闻归档不可用" });
        return result(true, await this.newsArchive.read(stringField(argumentsValue, "path")));
      }
      if (tool === "obsidian_search_markdown") {
        return result(true, { paths: await this.vault.search(stringField(argumentsValue, "query")) });
      }
      if (tool === "obsidian_read_markdown") {
        return result(true, await this.vault.read(stringField(argumentsValue, "path")));
      }
      if (tool === "obsidian_create_markdown") {
        return result(true, await this.vault.create(
          stringField(argumentsValue, "path"),
          stringField(argumentsValue, "content"),
        ));
      }
      if (tool === "obsidian_update_markdown") {
        return result(true, await this.vault.update(
          stringField(argumentsValue, "path"),
          stringField(argumentsValue, "content"),
          stringField(argumentsValue, "expectedSha256"),
        ));
      }
      return result(false, { error: "未知 Vault 工具" });
    } catch (error) {
      return result(false, { error: safeError(error) });
    }
  }
}
