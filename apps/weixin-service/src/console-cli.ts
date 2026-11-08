import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { ConsoleBrowser } from "./console-access.js";
import { requestConsoleControl } from "./console-control.js";
import { resolvePrivateStatePath } from "./runtime-paths.js";

/**
 * The owner's local console command:
 *   console login [--no-open]   print a one-time login link and open it in the default browser
 *   console list                list authorized browsers
 *   console revoke <id>|all     revoke one browser or all of them
 * It talks to the running service through the owner-only control channel in the state directory.
 */
const USAGE = "用法：console login [--no-open] | console list | console revoke <浏览器 ID>|all";

function formatTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function openInBrowser(url: string): Promise<boolean> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve) => {
    const child = spawn(opener, [url], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function run(argv: string[]): Promise<number> {
  const stateDirectory = path.dirname(resolvePrivateStatePath(process.env, os.homedir()));
  const [command, ...rest] = argv;
  if (command === "login" && rest.every((flag) => flag === "--no-open")) {
    const { url } = await requestConsoleControl(stateDirectory, { command: "login-link" });
    process.stdout.write(`一次性登录链接（2 分钟内有效，只能使用一次）：\n${String(url)}\n`);
    if (!rest.includes("--no-open") && !(await openInBrowser(String(url)))) {
      process.stdout.write("没能打开默认浏览器，请把链接复制到要授权的浏览器。\n");
    }
    return 0;
  }
  if (command === "list" && rest.length === 0) {
    const browsers = (await requestConsoleControl(stateDirectory, { command: "list" })).browsers as ConsoleBrowser[];
    if (browsers.length === 0) {
      process.stdout.write("还没有授权的浏览器\n");
      return 0;
    }
    for (const browser of browsers) {
      process.stdout.write(`${browser.id}  ${browser.label}  授权于 ${formatTime(browser.authorizedAt)}  最近使用 ${formatTime(browser.lastUsedAt)}\n`);
    }
    return 0;
  }
  if (command === "revoke" && rest.length === 1) {
    const result = await requestConsoleControl(stateDirectory, { command: "revoke", target: rest[0]! });
    process.stdout.write(`已收回 ${Number(result.revoked)} 个浏览器的授权\n`);
    if (result.auditFailed === true) process.stderr.write("审计记录写入失败，这次收回没有记入审计文件\n");
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  // ConsoleControlUnavailableError carries 「本机服务未运行」.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
