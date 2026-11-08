import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { createIsolatedModelRuntime } from "../src/isolated-model-runtime.js";
import { createScheduledResearch } from "../src/scheduled-research.js";
import { processWaitLimitMs } from "./support/process-wait.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const input = () => ({ name: "工具周报", instruction: "研究工具更新，附来源", timezone: "Asia/Shanghai", plannedAt: "2026-10-16T13:00:00Z", signal: new AbortController().signal });
function executable(script: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "research-child-test-")); dirs.push(dir);
  const file = path.join(dir, "codex-fixture");
  fs.writeFileSync(file, `#!${process.execPath}\n${script}`, { mode: 0o700 }); return { file, dir };
}
// A child the product is expected to stop outlives every case limit, but still exits on its
// own if a failed case never stops it.
const unstoppedChildExit = "setTimeout(() => process.exit(0), 60_000);";
// Waiting for a child to get ready is a process wait (tests/support/process-wait.ts).
// Children publish markers by rename, so a marker that exists is complete.
async function readyMarker(marker: string) {
  await expect.poll(() => fs.existsSync(marker), { timeout: processWaitLimitMs }).toBe(true);
  return JSON.parse(fs.readFileSync(marker, "utf8"));
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
process.on('SIGTERM', () => {});
fs.writeFileSync('PID.tmp', JSON.stringify(process.pid)); fs.renameSync('PID.tmp', 'PID');
console.log(JSON.stringify({type:'item.completed',item:{type:'web_search'}}));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({body:'迟到报告。',sources:[{title:'来源',url:'https://example.com'}]}));
${unstoppedChildExit}`);
  // Capture the real child identity outside its disposable workspace.
  const marker = path.join(dir, "pid.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("'PID.tmp'", JSON.stringify(`${marker}.tmp`)).replaceAll("'PID'", JSON.stringify(marker)));
  // The deadline is a product timer that starts at spawn; hold it until the child is ignoring
  // SIGTERM (tests/support/process-wait.ts).
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let pid: number | undefined;
  try {
    const pending = createScheduledResearch({ executable: file, timeoutMs: 1200 })(input());
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(pending).rejects.toThrow("research_timeout");
    pid = await readyMarker(marker);
    await vi.advanceTimersByTimeAsync(1200); // Deadline: SIGTERM, which the child ignores.
    expect(settled).toBe(false); // No rejection while the child is still running.
    expect(() => process.kill(pid!, 0)).not.toThrow();
    await vi.advanceTimersByTimeAsync(1000); // Escalation: SIGKILL, the only way this child ends within the case limit.
    await rejected;
    expect(() => process.kill(pid!, 0)).toThrow();
    pid = undefined;
  } finally {
    vi.useRealTimers();
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
}, processWaitLimitMs + 5_000);

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
fs.writeFileSync('READY.tmp', JSON.stringify({pid:process.pid,cwd:process.cwd()})); fs.renameSync('READY.tmp', 'READY');
${unstoppedChildExit}`);
  const marker = path.join(dir, "ready.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replaceAll("'READY.tmp'", JSON.stringify(`${marker}.tmp`)).replaceAll("'READY'", JSON.stringify(marker)));
  const controller = new AbortController();
  const pending = createScheduledResearch({ executable: file })({ ...input(), signal: controller.signal });
  const rejected = expect(pending).rejects.toThrow("research_cancelled");
  const observed = await readyMarker(marker); controller.abort(); await rejected;
  expect(() => process.kill(observed.pid, 0)).toThrow(); expect(fs.existsSync(observed.cwd)).toBe(false);
}, processWaitLimitMs + 5_000);

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


// What `codex debug models --bundled` prints (codex-cli 0.167.0-alpha.3.2), trimmed to one model.
const BUNDLED_CATALOG = JSON.stringify({ models: [{ slug: "gpt-5.6-luna", tool_mode: "code_mode_only", apply_patch_tool_type: "freeform", multi_agent_version: "v1" }] });

it("runs group research with an isolated home and mandatory named permission profile", async () => {
  const { file, dir } = executable(`const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'debug') { process.stdout.write(${JSON.stringify(BUNDLED_CATALOG)}); process.exit(0); }
if (args.includes('-P')) { console.error("unexpected argument '-P' found"); process.exit(2); }
const catalog = args.find((value) => value.startsWith('model_catalog_json='));
const installed = catalog && fs.existsSync(JSON.parse(catalog.slice('model_catalog_json='.length))) ? JSON.parse(fs.readFileSync(JSON.parse(catalog.slice('model_catalog_json='.length)), 'utf8')) : null;
fs.writeFileSync('INVOCATION', JSON.stringify({args, cwd:process.cwd(), home:process.env.CODEX_HOME, leaked:process.env.OWNER_PRIVATE_TOKEN, toolMode: installed?.models?.[0]?.tool_mode ?? null}));
console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',action:{type:'search'}}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'web_search',action:{type:'open_page',url:'https://example.com/release'}}}));
fs.writeFileSync(args[args.indexOf('-o')+1], JSON.stringify({body:'Group research report.',sources:[{title:'Release',url:'https://example.com/release'}]}));`);
  const recorded = path.join(dir, "invocation.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("'INVOCATION'", JSON.stringify(recorded)));
  const destination = { accountId: "feishu.bot.test", target: "feishu.group.alpha" };
  const run = createScheduledResearch({ executable: file, groupRuntime: (address) => {
    expect(address).toEqual({ accountId: "feishu.bot.test", target: "feishu.group.alpha" });
    return createIsolatedModelRuntime({ root: path.join(dir, "runtime"), scope: "alpha", authHome: path.join(dir, "no-auth"),
      environment: { PATH: process.env.PATH, HOME: dir, OWNER_PRIVATE_TOKEN: "never-inherit" } });
  } });
  expect(await run({ ...input(), destination })).toBe("Group research report.\n\n来源：\n[1] Release：https://example.com/release");
  const observed = JSON.parse(fs.readFileSync(recorded, "utf8"));
  expect(observed.home).toBe(path.join(dir, "runtime", "alpha", "codex-home"));
  expect(observed.cwd).toBe(fs.realpathSync(path.join(dir, "runtime", "alpha", "workspace")));
  expect(observed).not.toHaveProperty("leaked");
  expect(observed.args).toContain('default_permissions="group"');
  expect(observed.args).toEqual(expect.arrayContaining(["tools.experimental_request_user_input.enabled=false", "agents.enabled=false"]));
  // The runtime's direct-mode catalog was installed before the research process started.
  expect(observed.toolMode).toBe("direct");
  expect(observed.args).not.toContain("--ignore-user-config");
  expect(observed.args).not.toContain("--sandbox");
  expect(JSON.parse(observed.args.at(-1))).not.toHaveProperty("destination");
  await expect(createScheduledResearch({ executable: file })({ ...input(), destination })).rejects.toThrow("research_runtime_unavailable");
});

it("does not start group research when the runtime's model catalog cannot be derived", async () => {
  const { file, dir } = executable(`const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'debug') process.exit(1);
fs.writeFileSync('INVOCATION', JSON.stringify({ args }));`);
  const recorded = path.join(dir, "invocation.json");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("'INVOCATION'", JSON.stringify(recorded)));
  const run = createScheduledResearch({ executable: file, groupRuntime: () => createIsolatedModelRuntime({ root: path.join(dir, "runtime"), scope: "alpha",
    authHome: path.join(dir, "no-auth"), environment: { PATH: process.env.PATH, HOME: dir } }) });
  await expect(run({ ...input(), destination: { accountId: "feishu.bot.test", target: "feishu.group.alpha" } })).rejects.toThrow("research_runtime_unavailable");
  expect(fs.existsSync(recorded)).toBe(false);
});
