import type { InboundTextEvent } from "./demo-service.js";
import type { WorkflowNoteArtifactStore } from "./workflow-note-artifact-store.js";
import type { WorkflowEngine, WorkflowTemplate } from "./workflow-engine.js";
import type { InboundWorkflowControl } from "./weixin-codex-service.js";
import { WEIXIN_FILE_WORKFLOW_MESSAGES } from "./weixin-workflow-messages.js";

export const WEIXIN_NOTE_SEARCH_WORKFLOW: WorkflowTemplate = {
  id: "notes.search-from-weixin",
  version: 1,
  maxSteps: 1,
  maxDepth: 1,
  maxParallelism: 1,
  effectBudget: { read: 1 },
  steps: [{
    id: "search",
    capability: "notes.search-request",
    capabilityVersion: 1,
    input: { scopeId: "vault" },
    triggerInputBindings: { requestHandle: "noteRequest" },
    timeoutMs: 10_000,
  }],
};
export const WEIXIN_NOTE_SEND_FILE_WORKFLOW: WorkflowTemplate = {
  id: "notes.send-file-from-weixin", version: 1, maxSteps: 2, maxDepth: 2, maxParallelism: 1,
  effectBudget: { read: 1, external_send: 1 },
  steps: [
    { id: "export", capability: "notes.export_file", capabilityVersion: 1, input: { scopeId: "vault" }, triggerInputBindings: { noteHandle: "selectedNote" }, timeoutMs: 10_000 },
    { id: "send", capability: "weixin.send_file", capabilityVersion: 1, dependsOn: ["export"], inputBindings: { fileHandle: { dependency: "export", path: ["fileHandle"] } }, timeoutMs: 45_000 },
  ],
};

export class WeixinWorkflowRouter implements InboundWorkflowControl {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly noteArtifacts: WorkflowNoteArtifactStore,
  ) {}

  async tryHandle(event: InboundTextEvent): ReturnType<InboundWorkflowControl["tryHandle"]> {
    const selection = /^(?:请)?(?:发送|发出|发给我|查看)笔记\s+(?:([a-f0-9]{6})\s+)?(\d{1,2})\s*$/u.exec(event.text.trim());
    if (selection) return this.sendSelection(event, selection[1], Number(selection[2]));
    const query = noteSearchQuery(event.text);
    if (query === null && isBareNoteSearchIntent(event.text)) {
      return { handled: true, outcome: "needs_input", reply: "请告诉我需要搜索的关键词。" };
    }
    if (query === null) return { handled: false };
    try {
      const request = this.noteArtifacts.captureSearchRequest(event.key, query);
      const submission = await this.engine.submit({
        triggerId: event.key,
        source: "weixin",
        occurredAt: event.receivedAt,
        requestedWorkflowId: WEIXIN_NOTE_SEARCH_WORKFLOW.id,
        accountRef: event.accountId,
        targetRef: event.target,
        inputRefs: { noteRequest: request.handle },
      });
      const run = this.engine.get(submission.runId);
      if (run?.status !== "succeeded") {
        return {
          handled: true,
          outcome: "failed",
          reply: run?.errorCode === "workflow_notes_permission_denied" || run?.errorCode === "workflow_module_permission_denied"
            ? WEIXIN_FILE_WORKFLOW_MESSAGES.permissionDenied
            : "笔记搜索未完成，请稍后重新发送。",
        };
      }
      const output = this.engine.getStepOutput(submission.runId, "search");
      const matches = safeMatches(output);
      if (matches === null) {
        return { handled: true, outcome: "failed", reply: "笔记搜索结果格式异常，本次没有展示任何内容。" };
      }
      if (matches.length === 0) return {
        handled: true,
        outcome: "succeeded",
        reply: WEIXIN_FILE_WORKFLOW_MESSAGES.notFound,
      };
      const pending = this.noteArtifacts.captureSelection(event.key, event.accountId, event.target, matches);
      return { handled: true, outcome: "needs_input", reply: `找到 ${matches.length} 篇笔记：\n${matches.map((item, index) => `${index + 1}. ${item.fileName}`).join("\n")}\n\n回复“发送笔记 ${pending.reference} 序号”，例如“发送笔记 ${pending.reference} 1”。` };
    } catch {
      return { handled: true, outcome: "failed", reply: "笔记搜索未完成，请稍后重新发送。" };
    }
  }

  private async sendSelection(event: InboundTextEvent, reference: string | undefined, ordinal: number): ReturnType<InboundWorkflowControl["tryHandle"]> {
    const selected = this.noteArtifacts.selectNote(event.accountId, event.target, reference, ordinal);
    if (selected === "ambiguous") return { handled: true, outcome: "needs_input", reply: "有多批笔记等待选择，请带上搜索结果中的六位引用。" };
    if (selected === "missing") return { handled: true, outcome: "needs_input", reply: "没有找到对应的待选笔记，请重新搜索。" };
    try {
      const submission = await this.engine.submit({ triggerId: event.key, source: "weixin", occurredAt: event.receivedAt, requestedWorkflowId: WEIXIN_NOTE_SEND_FILE_WORKFLOW.id, accountRef: event.accountId, targetRef: event.target, inputRefs: { selectedNote: selected.noteHandle } });
      const run = this.engine.get(submission.runId);
      if (run?.status !== "succeeded") return { handled: true, outcome: "failed", reply: run?.status === "outcome_unknown" ? WEIXIN_FILE_WORKFLOW_MESSAGES.sendUnknown : WEIXIN_FILE_WORKFLOW_MESSAGES.sendFailed };
      this.noteArtifacts.completeSelection(selected.selectionHandle);
      return { handled: true, outcome: "succeeded", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.sent };
    } catch { return { handled: true, outcome: "failed", reply: WEIXIN_FILE_WORKFLOW_MESSAGES.sendFailed }; }
  }
}

function isBareNoteSearchIntent(text: string): boolean {
  const normalized = text.trim();
  return /^(?:请)?(?:帮我)?(?:搜索|查找|检索)(?:一下)?(?:我的)?(?:Obsidian\s*)?(?:笔记|[Vv]ault)(?:中|里)?[：:]?$/u.test(normalized) ||
    /^(?:请)?(?:帮我)?(?:在)?(?:我的)?(?:Obsidian\s*)?(?:笔记|[Vv]ault)(?:中|里)?(?:搜索|查找|检索)[：:]?$/u.test(normalized);
}

function noteSearchQuery(text: string): string | null {
  const normalized = text.trim();
  const patterns = [
    /^(?:请)?(?:帮我)?(?:搜索|查找|检索)(?:一下)?(?:我的)?(?:Obsidian\s*)?(?:笔记|[Vv]ault)(?:中|里)?[：:\s]+(.+)$/u,
    /^(?:请)?(?:帮我)?(?:在)?(?:我的)?(?:Obsidian\s*)?(?:笔记|[Vv]ault)(?:中|里)?(?:搜索|查找|检索)[：:\s]+(.+)$/u,
  ];
  for (const pattern of patterns) {
    const query = pattern.exec(normalized)?.[1]?.trim();
    if (query && Buffer.byteLength(query, "utf8") <= 500) return query;
  }
  return null;
}

function safeMatches(output: unknown): Array<{ noteHandle: string; fileName: string }> | null {
  if (!output || typeof output !== "object" || !Array.isArray((output as { matches?: unknown }).matches)) return null;
  const matches = (output as { matches: unknown[] }).matches;
  if (matches.length > 20) return null;
  const names: Array<{ noteHandle: string; fileName: string }> = [];
  for (const match of matches) {
    if (!match || typeof match !== "object" || typeof (match as { fileName?: unknown }).fileName !== "string" || typeof (match as { noteHandle?: unknown }).noteHandle !== "string") return null;
    const safe = Array.from((match as { fileName: string }).fileName)
      .map((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127 ? " " : character)
      .slice(0, 120)
      .join("")
      .trim();
    if (!safe) return null;
    names.push({ noteHandle: (match as { noteHandle: string }).noteHandle, fileName: safe });
  }
  return names;
}
