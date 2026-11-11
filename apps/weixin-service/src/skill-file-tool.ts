import { createHash } from "node:crypto";
import type { ExecutorToolHost } from "./agent-dispatch-executor.js";
import type { DynamicToolContext, DynamicToolDefinition, DynamicToolResult } from "./dynamic-tool-host.js";
import { SkillFileUnavailable, type SkillLibrary, type SkillRef, type StoredSkill } from "./skill-library.js";

/** The host tool through which an Executor reads the files of its skills (skill-library::REQ-003). */
export const SKILL_FILE_TOOL = "read_skill_file";
/** The most characters one call returns; a longer file is read on from the `offset` the answer names. */
export const SKILL_FILE_CHARACTERS = 100_000;

const DEFINITION: DynamicToolDefinition = { type: "function", name: SKILL_FILE_TOOL,
  description: `读取本轮所用 skill 的文件，只读。skill 填 skill 的名称；path 填相对 skill 根目录的路径，如 references/guide.md，不填则列出这个 skill 的全部文件。一次最多返回 ${SKILL_FILE_CHARACTERS} 个字符，没读完时按返回的 offset 接着读。脚本只能读取文字，不会运行。`,
  inputSchema: { type: "object", additionalProperties: false, required: ["skill"],
    properties: { skill: { type: "string" }, path: { type: "string" }, offset: { type: "integer", minimum: 0 } } } };

const failure = (code: string, message: string): DynamicToolResult =>
  ({ success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: { code, message, retryable: false } }) }] });
/** How many characters a decoded string holds: each pair of surrogates is one. Decoded text holds no lone surrogate. */
function codePoints(text: string): number {
  let low = 0;
  for (let index = 0; index < text.length; index++) { const unit = text.charCodeAt(index); if (unit >= 0xDC00 && unit <= 0xDFFF) low++; }
  return text.length - low;
}
const answer = (body: Record<string, unknown>): DynamicToolResult => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify(body) }] });

/**
 * An Executor's tools together with `read_skill_file`, offered only when its profile selects a skill in its request's
 * definitions version (skill-library::REQ-003). The tool reaches the files of exactly those versions in the Skill Library,
 * read-only, and nothing else: no other skill, no other version and no part of the runtime home. Every other call goes to the
 * Executor's own tools unchanged.
 * - A path is one the version's manifest lists, or the call is refused; the library checks that the store still holds what
 *   was imported. A refusal is an ordinary tool error: it is not audited and does not count as a refusal of the profile.
 * - When the store holds something else, which only a change made outside the service can cause, `report` gets
 *   `skill_file_integrity_failed:<skill ID>`, without the path or any content.
 */
export class SkillFileToolHost implements ExecutorToolHost {
  constructor(private readonly host: ExecutorToolHost, private readonly library: Pick<SkillLibrary, "version" | "readFile">,
    private readonly skills: readonly SkillRef[], private readonly report: (code: string) => void) {}

  definitions(): DynamicToolDefinition[] {
    return this.skills.length ? [...this.host.definitions(), DEFINITION] : this.host.definitions();
  }

  /** The Executor's own contract, also with the tool: a profile that selects no skill keeps its contract, and so its sessions. */
  contractHash(): string {
    if (!this.skills.length) return this.host.contractHash();
    return createHash("sha256").update(JSON.stringify([this.host.contractHash(), SKILL_FILE_TOOL])).digest("hex");
  }

  grantsMcp(): boolean { return this.host.grantsMcp?.() ?? false; }

  async execute(tool: string, argumentsValue: unknown, context?: DynamicToolContext): Promise<DynamicToolResult> {
    if (!this.skills.length || tool !== SKILL_FILE_TOOL || context?.namespace) return this.host.execute(tool, argumentsValue, context);
    const value = argumentsValue as { skill?: unknown; path?: unknown; offset?: unknown } | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.skill !== "string" || !value.skill
      || (value.path !== undefined && typeof value.path !== "string") || (value.offset !== undefined && !(Number.isSafeInteger(value.offset) && (value.offset as number) >= 0))) {
      return failure("skill_file_arguments_invalid", "参数必须是 JSON 对象：skill 填 skill 的名称，path 与 offset 可以不填。");
    }
    // Every version a request names stays stored while the request can run, and its runtime is not created without them.
    const selected = this.skills.flatMap((ref) => { const stored = this.library.version(ref); return stored ? [{ ref, stored }] : []; });
    const chosen = selected.find(({ ref, stored }) => stored.name === value.skill || ref.id === value.skill);
    if (!chosen) return failure("skill_unknown", `本轮没有 skill「${value.skill}」。可以读取的 skill：${selected.map(({ stored }) => stored.name).join("、")}。`);
    if (!value.path) return answer({ skill: chosen.stored.name, files: chosen.stored.files.map(({ path, script }) => ({ path, script })) });
    return this.read(chosen.ref, chosen.stored, value.path, (value.offset as number | undefined) ?? 0);
  }

  turnOwner(context: DynamicToolContext): "model" | "workflow" {
    return this.skills.length && !context.namespace ? "model" : this.host.turnOwner?.(context) ?? "model";
  }

  /**
   * The file's characters from `offset`, decoded as its parts arrive: only those characters are kept, whatever the file's size.
   * Characters, not bytes or code units, are counted, so that no answer ends inside one.
   */
  private async read(ref: SkillRef, stored: StoredSkill, file: string, offset: number): Promise<DynamicToolResult> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const end = offset + SKILL_FILE_CHARACTERS, kept: string[] = [];
    let total = 0, text = true;
    const count = (piece: string) => {
      const characters = codePoints(piece);
      if (total + characters <= offset || total >= end) { total += characters; return; }
      for (const character of piece) { if (total >= offset && total < end) kept.push(character); total++; }
    };
    try {
      await this.library.readFile(ref, file, (part) => {
        if (!text) return;
        try { count(decoder.decode(part, { stream: true })); } catch { text = false; }
      });
      if (text) { try { count(decoder.decode()); } catch { text = false; } }
    } catch (error) {
      if (!(error instanceof SkillFileUnavailable)) throw error;
      if (error.reason === "not_found") return failure("skill_file_not_found", `skill「${stored.name}」里没有文件 ${file}。不填 path 可以列出它的文件。`);
      return this.unavailable(ref);
    }
    if (!text) return failure("skill_file_not_text", "这个文件不是文本文件，无法读取。");
    if (offset > total) return failure("skill_file_offset_invalid", `offset 超出了文件长度（共 ${total} 个字符）。`);
    const last = Math.min(total, end);
    return answer({ skill: stored.name, path: file, offset, text: kept.join(""),
      ...(last < total ? { nextOffset: last, note: `文件还有 ${total - last} 个字符没有读，用 offset=${last} 继续读取。` } : {}) });
  }

  private unavailable(ref: SkillRef): DynamicToolResult {
    try { this.report(`skill_file_integrity_failed:${ref.id}`); } catch { /* Reporting cannot change the answer. */ }
    return failure("skill_file_unavailable", "这个文件现在读不了。");
  }
}
