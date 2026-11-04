import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCodexCliNewsRun } from "../src/codex-news-researcher.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
it("stops a news process on scheduler cancellation before returning and removes its workspace", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "news-process-test-")); directories.push(directory);
  const marker = path.join(directory, "child.json"), executable = path.join(directory, "news-child");
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs'); const args=process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,cwd:process.cwd(),args}));
console.log(JSON.stringify({type:'item.completed',item:{type:'web_search'}}));
fs.writeFileSync(args[args.indexOf('-o')+1], '{"items":[]}');
setTimeout(()=>process.exit(0),1500);\n`, { mode: 0o700 });
  const controller = new AbortController();
  const request = { prompt: "只读取公开新闻", schema: {}, signal: controller.signal };
  const pending = createCodexCliNewsRun({ executable })(request);
  const checked = expect(pending).rejects.toThrow("research_cancelled");
  await expect.poll(() => fs.existsSync(marker)).toBe(true);
  const observed = JSON.parse(fs.readFileSync(marker, "utf8")); controller.abort(); await checked;
  expect(() => process.kill(observed.pid, 0)).toThrow(); expect(fs.existsSync(observed.cwd)).toBe(false);
  for (const feature of ["shell_tool", "unified_exec", "plugins", "apps", "multi_agent", "browser_use", "computer_use"]) {
    expect(observed.args.some((arg: string, index: number) => arg === "--disable" && observed.args[index + 1] === feature)).toBe(true);
  }
});
