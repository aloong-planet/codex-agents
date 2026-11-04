import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { createScheduledResearch } from "../src/scheduled-research.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const input = () => ({ name: "工具周报", instruction: "研究工具更新，附来源", timezone: "Asia/Shanghai", plannedAt: "2026-10-16T13:00:00Z", signal: new AbortController().signal });
function executable(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-child-test-")); dirs.push(dir);
  const file = path.join(dir, "codex-fixture");
  fs.writeFileSync(file, `#!${process.execPath}\n${script}`, { mode: 0o700 }); return { file, dir };
}
it("runs in an isolated directory, requires completed search, and returns the complete sourced report", async () => {
  const { file, dir } = executable(`const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify("PLACEHOLDER")}, JSON.stringify({ args, cwd: process.cwd() }));
console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',action:{type:'search'},query:'工具更新'}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',action:{type:'open_page',url:'https://example.com/release'}}}));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({body:'研究结论：新能力仍有适用边界。',sources:[{title:'官方发布',url:'https://example.com/release'}]}));`);
  const recorded = path.join(dir, "invocation.json"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"PLACEHOLDER"', JSON.stringify(recorded)));
  expect(await createScheduledResearch({ executable: file })(input())).toBe("研究结论：新能力仍有适用边界。\n\n来源：\n[1] 官方发布：https://example.com/release");
  const invocation = JSON.parse(fs.readFileSync(recorded, "utf8"));
  expect(invocation.cwd).not.toBe(process.cwd());
  expect(fs.existsSync(invocation.cwd)).toBe(false);
  expect(invocation.args).toEqual(expect.arrayContaining(["--ignore-user-config", "--ignore-rules", "--ephemeral", "--search", "read-only"]));
  for (const feature of ["shell_tool", "unified_exec", "plugins", "apps", "multi_agent", "hooks", "browser_use", "computer_use", "memories"]) {
    expect(invocation.args.some((value: string, index: number) => value === "--disable" && invocation.args[index + 1] === feature)).toBe(true);
  }
});

it("stops a timed-out process before rejecting, even when it ignores termination", async () => {
  const { file, dir } = executable(`const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync('pid.json', JSON.stringify(process.pid));
process.on('SIGTERM', () => {});
console.log(JSON.stringify({type:'item.completed',item:{type:'web_search'}}));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({body:'迟到报告。',sources:[{title:'来源',url:'https://example.com'}]}));
setTimeout(() => process.exit(0), 3000);`);
  // Capture the real child identity outside its disposable workspace.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("'pid.json'", JSON.stringify(path.join(dir, "pid.json"))));
  await expect(createScheduledResearch({ executable: file, timeoutMs: 1200 })(input())).rejects.toThrow("research_timeout");
  const pid = JSON.parse(fs.readFileSync(path.join(dir, "pid.json"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

it.each([
  ["search snippets without reading", "search_only", { body: "只看了摘要。", sources: [{ title: "来源", url: "https://example.com" }] }, "research_source_read_missing"],
  ["no search", "", { body: "没有检索的内容。", sources: [{ title: "来源", url: "https://example.com" }] }, "research_search_missing"],
  ["empty report", "search", { body: " ", sources: [{ title: "来源", url: "https://example.com" }] }, "research_output_invalid"],
  ["unsafe link", "search", { body: "报告。", sources: [{ title: "来源", url: "file:///private/data" }] }, "research_output_invalid"],
  ["truncated report", "search", { body: "观点尚未说完...", sources: [{ title: "来源", url: "https://example.com" }] }, "research_output_invalid"],
  ["oversized report", "search", { body: "长".repeat(22000), sources: [{ title: "来源", url: "https://example.com" }] }, "output_too_large"],
] as const)("rejects %s without returning a replacement report", async (_name, search, report, code) => {
  const { file } = executable(`const fs = require('node:fs'); const args = process.argv.slice(2);
${search ? "console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',action:{type:'search'}}}));" : ""}
${search === "search" ? "console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',action:{type:'open_page',url:'https://example.com'}}}));" : ""}
fs.writeFileSync(args[args.indexOf('-o')+1], ${JSON.stringify(JSON.stringify(report))});`);
  await expect(createScheduledResearch({ executable: file })(input())).rejects.toThrow(code);
});

it("cancels on external revocation, waits for exit and removes its isolated workspace", async () => {
  const { file, dir } = executable(`const fs = require('node:fs');
fs.writeFileSync('READY', JSON.stringify({pid:process.pid,cwd:process.cwd()}));
setInterval(() => {}, 100);`);
  const marker = path.join(dir, "ready.json"); fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("'READY'", JSON.stringify(marker)));
  const controller = new AbortController();
  const pending = createScheduledResearch({ executable: file })({ ...input(), signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow("research_cancelled");
  await expect.poll(() => fs.existsSync(marker)).toBe(true);
  const observed = JSON.parse(fs.readFileSync(marker, "utf8")); controller.abort(); await rejected;
  expect(() => process.kill(observed.pid, 0)).toThrow(); expect(fs.existsSync(observed.cwd)).toBe(false);
});

it("classifies startup and quota failure without exposing raw process diagnostics", async () => {
  await expect(createScheduledResearch({ executable: "/no-such-research-executable" })(input())).rejects.toThrow("research_start_failed");
  const { file } = executable("console.error('Private credential details: quota exceeded'); process.exit(1);");
  await expect(createScheduledResearch({ executable: file })(input())).rejects.toThrow(/^research_usage_limit$/u);
});

it("retains the unavailable runtime cause in a completed OTel trace when the CLI exits successfully without search", async () => {
  const { file, dir } = executable(`console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable features.code_mode_host and install codex-code-mode-host.'}}));`);
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(path.join(dir, "otel")));
  try {
    await expect(createScheduledResearch({ executable: file, diagnostics })(input())).rejects.toThrow("research_runtime_unavailable");
    await diagnostics.close();
    const evidence = await readDiagnostics(path.join(dir, "otel"));
    const span = evidence.records.find((record) => record.kind === "span" && record.name === "scheduled.research.process");
    expect(span).toMatchObject({ status: 2, attributes: { status: "failed", errorCode: "research_runtime_unavailable", exitCode: 0, webSearchCount: 0 } });
    expect(evidence.unfinished).toEqual([]);
  } finally { await diagnostics.close(); }
});
