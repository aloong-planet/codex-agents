import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { createScheduledResearch } from "../src/scheduled-research.js";
import { resolveCodexExecutable } from "../src/stdio-app-server-transport.js";

// Public-docs-only opt-in test: real research CLI/web, never a Weixin account or user file.
it.skipIf(process.env.SCHEDULED_RESEARCH_LIVE !== "1")("generates sourced text with the real isolated research process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-research-live-"));
  const tracePath = path.join(root, "trace.jsonl"), wrapper = path.join(root, "research-cli");
  const executable = resolveCodexExecutable(process.env);
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(root, "otel")));
  fs.writeFileSync(wrapper, `#!${process.execPath}\nconst fs=require('node:fs');const {spawn}=require('node:child_process');const c=spawn(${JSON.stringify(executable)},process.argv.slice(2),{stdio:['ignore','pipe','inherit']});c.stdout.on('data',b=>{fs.appendFileSync(${JSON.stringify(tracePath)},b);process.stdout.write(b)});process.on('SIGTERM',()=>c.kill('SIGTERM'));c.on('close',code=>process.exit(code??1));\n`, { mode: 0o700 });
  const instruction = "检索 TypeScript 官方文档，中文解释 satisfies 运算符保留推断类型的核心意义，约200字并附官方来源。";
  try {
    const body = await createScheduledResearch({ executable: wrapper, timeoutMs: 150000, diagnostics })({ name: "TypeScript 研究验收", instruction, timezone: "Asia/Shanghai", plannedAt: "2026-10-15T02:00:00.000Z", signal: new AbortController().signal });
    const events = fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const itemTypes = [...new Set(events.filter((event) => event.type === "item.completed").map((event) => event.item.type))];
    expect(itemTypes).toContain("web_search");
    expect(itemTypes.filter((type) => !["web_search", "agent_message", "reasoning"].includes(type))).toEqual([]);
    expect(body).toContain("satisfies"); expect(body).toContain("https://www.typescriptlang.org/");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(65536);
    await diagnostics.close();
    const telemetry = await readDiagnostics(path.join(root, "otel"));
    expect(telemetry.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "scheduled.research.process", kind: "span", attributes: expect.objectContaining({ status: "generated", exitCode: 0 }) }),
      expect.objectContaining({ name: "scheduled.research.web_search", attributes: expect.objectContaining({ action: "search" }) }),
      expect.objectContaining({ name: "scheduled.research.web_search", attributes: expect.objectContaining({ action: "open_page" }) }),
    ]));
    expect(telemetry.unfinished).toEqual([]);
    const evidence = { telemetry, executedAt: new Date().toISOString(), executable, instruction, body, itemTypes, externalDelivery: "none; no channel supplied", scope: "real CLI/web using public TypeScript documentation; not adversarial-page or phone acceptance" };
    if (process.env.SCHEDULED_TASK_EVIDENCE_DIR) { fs.mkdirSync(process.env.SCHEDULED_TASK_EVIDENCE_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.SCHEDULED_TASK_EVIDENCE_DIR, "ticket-04-research-live.json"), JSON.stringify(evidence, null, 2) + "\n"); }
    console.info(JSON.stringify(evidence));
  } finally {
    await diagnostics.close();
    if (fs.existsSync(tracePath)) console.info("RESEARCH_TRACE", fs.readFileSync(tracePath, "utf8"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180000);
