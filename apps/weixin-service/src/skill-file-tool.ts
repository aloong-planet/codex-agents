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
    const selected = this.skills.map((ref) => ({ ref, stored: this.library.version(ref) }));
    const chosen = selected.find(({ ref, stored }) => stored?.name === value.skill || ref.id === value.skill);
    if (!chosen) {
      const names = selected.flatMap(({ stored }) => stored ? [stored.name] : []);
      return failure("skill_unknown", `本轮没有 skill「${value.skill}」。可以读取的 skill：${names.join("、")}。`);
    }
    if (!chosen.stored) return this.unavailable(chosen.ref);
    if (!value.path) return answer({ skill: chosen.stored.name, files: chosen.stored.files.map(({ path, script }) => ({ path, script })) });
    return this.read(chosen.ref, chosen.stored, value.path, (value.offset as number | undefined) ?? 0);
  }

  turnOwner(context: DynamicToolContext): "model" | "workflow" {
    return this.skills.length && !context.namespace ? "model" : this.host.turnOwner?.(context) ?? "model";
  }

  private read(ref: SkillRef, stored: StoredSkill, file: string, offset: number): DynamicToolResult {
    let content: Buffer;
    try { content = this.library.readFile(ref, file); }
    catch (error) {
      if (!(error instanceof SkillFileUnavailable)) throw error;
      if (error.reason === "not_found") return failure("skill_file_not_found", `skill「${stored.name}」里没有文件 ${file}。不填 path 可以列出它的文件。`);
      return this.unavailable(ref);
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
    catch { return failure("skill_file_not_text", "这个文件不是文本文件，无法读取。"); }
    // Counted in characters, so that no part of a file ends inside one.
    const characters = [...text];
    if (offset > characters.length) return failure("skill_file_offset_invalid", `offset 超出了文件长度（共 ${characters.length} 个字符）。`);
    const end = Math.min(characters.length, offset + SKILL_FILE_CHARACTERS);
    return answer({ skill: stored.name, path: file, offset, text: characters.slice(offset, end).join(""),
      ...(end < characters.length ? { nextOffset: end, note: `文件还有 ${characters.length - end} 个字符没有读，用 offset=${end} 继续读取。` } : {}) });
  }

  private unavailable(ref: SkillRef): DynamicToolResult {
    try { this.report(`skill_file_integrity_failed:${ref.id}`); } catch { /* Reporting cannot change the answer. */ }
    return failure("skill_file_unavailable", "这个文件现在读不了。");
  }
}
