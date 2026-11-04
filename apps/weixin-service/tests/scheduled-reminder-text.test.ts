import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScheduledTasks, type ScheduledTasksOptions } from "../src/scheduled-tasks.js";
import { WorkflowToolHost } from "../src/workflow-tool-host.js";
import { createProductionWorkflowToolCatalog } from "../src/workflow-tool-catalog.js";
import type { TrustedWorkflowTurn } from "../src/workflow-tool-host.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const turn: TrustedWorkflowTurn = { accountId: "fixture", target: "user@im.wechat", eventKey: "create", occurredAt: 0, originalTextRef: "request", attachmentRefs: [] };
function setup(options: Partial<ScheduledTasksOptions> = {}, legacy = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-reminder-text-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (legacy) fs.copyFileSync(new URL("./fixtures/scheduled-reminder-legacy.sqlite", import.meta.url), path.join(dir, "tasks.sqlite"));
  let clock = Date.parse("2026-10-15T02:00:00Z");
  const outbox: string[] = [];
  let original = "每分钟提醒我活动一下，只发送文字提醒";
  const open = () => {
    const service = new ScheduledTasks({ databasePath: path.join(dir, "tasks.sqlite"), now: () => clock,
      readOriginalText: () => original,
      channel: { state: () => ({ enabled: true, credentialStatus: "usable", credentialGeneration: "b", contextGeneration: "c" }),
        send: async ({ message }) => { outbox.push(message); return { ok: true }; } }, ...options });
    cleanups.push(() => service.close()); return service;
  };
  return { service: open(), open, outbox, setOriginal: (value: string) => { original = value; }, advance: () => { clock += 60_000; } };
}
function call(service: ScheduledTasks, tool: string, args: Record<string, unknown>, eventKey = tool) {
  return service.execute({ toolId: `schedules.${tool}`, toolVersion: 1, arguments: args }, { ...turn, eventKey });
}
const createArgs = { name: "活动提醒", instruction: "提醒用户活动一下", reminderText: "你应该活动一下了", reminderMode: "natural", intervalSeconds: 60, sourceText: "每分钟提醒我活动一下，只发送文字提醒" };

describe("saved receiver-facing reminder text", () => {
  it("previews, persists and repeatedly sends the complete recipient-facing body without management text or framing", async () => {
    const { service, open, advance, outbox } = setup();
    const result = await call(service, "create", createArgs) as { task: { id: string } };
    expect(result).toMatchObject({ status: "created", task: { instruction: "提醒用户活动一下", reminderText: "你应该活动一下了", reminderMode: "natural" } });
    expect(await call(service, "read_text", { reference: result.task.id, field: "reminderText" })).toMatchObject({ text: "你应该活动一下了" });
    service.close(); const restarted = open(); advance(); await restarted.tick(); advance(); await restarted.tick();
    expect(outbox).toEqual(["你应该活动一下了", "你应该活动一下了"]);
    expect(await call(restarted, "inspect", { reference: result.task.id })).toMatchObject({ totalOccurrences: 2, history: [{ body: "你应该活动一下了", delivery: "accepted" }, { body: "你应该活动一下了", delivery: "accepted" }] });
  });
  it("rejects missing, empty, oversized and invented verbatim bodies before creating a task", async () => {
    const { service } = setup({ limits: { maxBodyBytes: 32 } });
    const missing = { name: "活动提醒", instruction: "提醒用户活动一下", intervalSeconds: 60, sourceText: createArgs.sourceText };
    const invalid = [missing, { ...createArgs, reminderText: "  \n" }, { ...createArgs, reminderText: "长".repeat(11) }, { ...createArgs, reminderMode: "verbatim" }];
    const codes = ["reminder_text_required", "invalid_settings", "output_too_large", "verbatim_source_mismatch"];
    for (const [index, args] of invalid.entries()) expect(await call(service, "create", args)).toMatchObject({ status: "error", code: codes[index] });
    expect(await call(service, "list", {})).toMatchObject({ total: 0 });
  });

  it("atomically edits paused content, preserves exact whitespace and rejects changed replay payloads", async () => {
    const { service, setOriginal, outbox } = setup();
    const created = await call(service, "create", createArgs) as { task: { id: string } };
    expect(await call(service, "create", { ...createArgs, reminderText: "另一句话" })).toMatchObject({ code: "request_conflict" });
    const reference = created.task.id;
    await call(service, "disable", { reference, expectedRevision: 1, sourceText: createArgs.sourceText });
    setOriginal('改为原样提醒：“  我今天不加班\n明天再说  ”，保持停用');
    const base = { reference, expectedRevision: 2, sourceText: '改为原样提醒：“  我今天不加班\n明天再说  ”，保持停用' };
    expect(await call(service, "edit", { ...base, instruction: "只改指令" }, "incomplete")).toMatchObject({ code: "reminder_text_required" });
    expect(await call(service, "inspect", { reference })).toMatchObject({ task: { revision: 2, reminderText: "你应该活动一下了" } });
    const edit = { ...base, instruction: "提醒用户指定原文", reminderMode: "verbatim", reminderText: "  我今天不加班\n明天再说  " };
    expect(await call(service, "edit", edit)).toMatchObject({ status: "updated", task: { revision: 3, enabled: false, reminderText: "  我今天不加班\n明天再说  ", schedule: { firstAt: "2026-10-15T02:01:00.000Z" } } });
    expect(await call(service, "edit", edit)).toMatchObject({ replayed: true, task: { revision: 3 } });
    expect(await call(service, "edit", { ...edit, reminderText: "我今天不加班" })).toMatchObject({ code: "request_conflict" });
    await call(service, "edit", { ...base, expectedRevision: 3, name: "原文提醒" }, "rename");
    await call(service, "run_now", { ...base, expectedRevision: 4 }, "manual"); await service.tick();
    expect(outbox).toEqual(["  我今天不加班\n明天再说  "]);
    expect(await call(service, "inspect", { reference })).toMatchObject({ task: { enabled: false, instruction: "提醒用户指定原文", reminderText: "  我今天不加班\n明天再说  " } });
  });

  it("keeps a real legacy store and old cache unchanged until an explicit content edit", async () => {
    const { service, advance, outbox } = setup({}, true);
    const reference = "task_ebf1b3b7-2a0d-482e-be0b-e376f120e254";
    const sourceText = createArgs.sourceText;
    expect(await call(service, "create", { name: "活动提醒", instruction: sourceText, intervalSeconds: 60, sourceText })).toMatchObject({ task: { id: reference, enabled: false, revision: 2, reminderTextAvailable: false } });
    await call(service, "edit", { reference, expectedRevision: 2, sourceText, name: "旧提醒" }, "rename-legacy");
    expect(await call(service, "inspect", { reference })).toMatchObject({ task: { reminderTextAvailable: false }, history: [{ body: "提醒：活动提醒\n\n每分钟提醒我活动一下，只发送文字提醒" }] });
    expect(await call(service, "edit", { reference, expectedRevision: 3, sourceText, instruction: "提醒用户活动", reminderMode: "natural", reminderText: "你应该活动一下了" }, "upgrade")).toMatchObject({ task: { enabled: false, revision: 4, reminderText: "你应该活动一下了" } });
    advance(); advance(); await service.tick(); expect(outbox).toEqual([]);
    await call(service, "enable", { reference, expectedRevision: 4, sourceText }); await service.tick();
    expect(outbox).toEqual(["提醒：活动提醒\n\n每分钟提醒我活动一下，只发送文字提醒"]);
    advance(); await service.tick();
    expect(outbox).toEqual(["提醒：活动提醒\n\n每分钟提醒我活动一下，只发送文字提醒", "你应该活动一下了"]);
  });

  it("reads long exact bodies in Unicode pages and sends every character without a title", async () => {
    const { service, setOriginal, advance, outbox } = setup();
    const body = "🌻".repeat(4100) + "\n  我今天不加班  ";
    const sourceText = `每分钟原样提醒：“${body}”`; setOriginal(sourceText);
    const created = await call(service, "create", { ...createArgs, reminderMode: "verbatim", reminderText: body, sourceText }) as { task: { id: string } };
    expect(created).toMatchObject({ status: "created", task: { reminderTextAvailable: true, reminderTextCharacters: 4111 } });
    expect(created.task).not.toHaveProperty("reminderText");
    expect(await call(service, "read_text", { reference: created.task.id, field: "reminderText", offset: 4000 })).toMatchObject({ text: "🌻".repeat(100) + "\n  我今天不加班  " });
    expect(await service.execute({ toolId: "schedules.read_text", toolVersion: 1, arguments: { reference: created.task.id, field: "reminderText" } }, { ...turn, target: "foreign" })).toMatchObject({ status: "not_found" });
    advance(); await service.tick();
    expect(outbox).toHaveLength(3); expect(outbox.join("")).toBe("🌻".repeat(4100) + "\n  我今天不加班  ");
  });

  it("freezes already claimed content and leaves saved text unchanged by time-only edits", async () => {
    const { service, outbox } = setup();
    const created = await call(service, "create", createArgs) as { task: { id: string } };
    const reference = created.task.id, sourceText = createArgs.sourceText;
    await call(service, "run_now", { reference, expectedRevision: 1, sourceText });
    expect(await call(service, "edit", { reference, expectedRevision: 1, sourceText, instruction: "提醒用户休息", reminderText: "你该休息了", reminderMode: "natural" })).toMatchObject({ status: "updated" });
    await service.tick(); expect(outbox).toEqual(["你应该活动一下了"]);
    expect(await call(service, "edit", { reference, expectedRevision: 2, sourceText, intervalSeconds: 120 }, "time-only")).toMatchObject({ task: { reminderText: "你该休息了", revision: 3 } });
    expect(await call(service, "edit", { reference, expectedRevision: 3, sourceText, reminderText: "错误正文", reminderMode: "natural" }, "body-only")).toMatchObject({ code: "instruction_required" });
    await call(service, "run_now", { reference, expectedRevision: 3, sourceText }, "second-manual"); await service.tick();
    expect(outbox).toEqual(["你应该活动一下了", "你该休息了"]);
    expect(await call(service, "inspect", { reference })).toMatchObject({ task: { reminderText: "你该休息了", revision: 3 } });
  });
  it("keeps independent instruction and body previews inside the tool result budget with five histories", async () => {
    const { service, advance } = setup();
    const created = await call(service, "create", { ...createArgs, instruction: "意".repeat(5300), reminderText: "文".repeat(2660) }) as { task: { id: string } };
    for (let index = 0; index < 5; index++) { advance(); await service.tick(); }
    const host = new WorkflowToolHost(createProductionWorkflowToolCatalog({ files: false, media: false, schedules: true }), { submit: async () => { throw new Error("unexpected workflow"); } }, service);
    const binding = host.bind("budget", turn);
    try {
      const detail = await host.execute("inspect", { reference: created.task.id }, { namespace: "schedules", threadId: "budget", turnId: "t" });
      expect(detail.success).toBe(true);
      const payload = JSON.parse(detail.contentItems[0]!.text);
      expect(payload).toMatchObject({ ok: true });
      const data = payload.data;
      expect(data).toMatchObject({ task: { reminderText: "文".repeat(2660), instructionAvailable: true }, totalOccurrences: 5 });
      expect(data.history).toHaveLength(5);
      expect(await call(service, "read_text", { reference: created.task.id, field: "instruction", offset: 4000 })).toMatchObject({ text: "意".repeat(1300), totalCharacters: 5300 });
    } finally { binding.release(); }
  });
});
