import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgentPlist,
  launchAgentInstallPlan,
  launchAgentPaths,
} from "../src/launch-agent-config.js";
import { resolveCodexExecutable } from "../src/stdio-app-server-transport.js";

const action = process.argv[2];
const serviceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDirectory = os.homedir();
const uid = process.getuid?.();
if (uid === undefined) throw new Error("当前平台不支持用户级 LaunchAgent");

const pnpmPath = process.env.PNPM_BIN?.trim() || resolveExecutable("pnpm");
const nodePath = process.env.NODE_BIN?.trim() || process.execPath;
const paths = launchAgentPaths(homeDirectory);
const plan = launchAgentInstallPlan(homeDirectory, uid);

switch (action) {
  case "install":
    install();
    break;
  case "uninstall":
    uninstall();
    break;
  case "status":
    status();
    break;
  case "print":
    process.stdout.write(plist());
    break;
  default:
    throw new Error("用法：launch-agent.ts <install|uninstall|status|print>");
}

function install(): void {
  assertFile(pnpmPath, "pnpm");
  assertFile(nodePath, "Node.js");
  assertFile(resolveCodexExecutable(process.env), "Codex");
  assertFile(path.join(serviceRoot, "package.json"), "服务 package.json");
  if (launchctl(["print", plan.oldJob], true).status === 0) {
    throw new Error("旧微信 Demo LaunchAgent 仍在运行；为避免两个 4317 服务，安装已停止");
  }

  launchctl(plan.bootoutArguments, true);
  fs.mkdirSync(path.dirname(paths.plistPath), { recursive: true, mode: 0o755 });
  fs.mkdirSync(paths.logDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${paths.plistPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, plist(), { encoding: "utf8", mode: 0o644, flag: "wx" });
    fs.renameSync(temporaryPath, paths.plistPath);
    fs.chmodSync(paths.plistPath, 0o644);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  const bootstrap = launchctl(plan.bootstrapArguments, false);
  if (bootstrap.status !== 0) {
    throw new Error("LaunchAgent 安装失败");
  }
  process.stdout.write(`已安装并启动 ${LAUNCH_AGENT_LABEL}\n`);
}

function uninstall(): void {
  launchctl(plan.bootoutArguments, true);
  fs.rmSync(paths.plistPath, { force: true });
  process.stdout.write(`已停用并移除 ${LAUNCH_AGENT_LABEL}；私有状态和日志未删除。\n`);
}

function status(): void {
  const result = launchctl(["print", plan.job], true);
  if (result.status !== 0) {
    process.stdout.write(`${LAUNCH_AGENT_LABEL} 未加载\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.stdout);
}

function plist(): string {
  return buildLaunchAgentPlist({
    workingDirectory: serviceRoot,
    pnpmPath,
    nodePath,
    codexPath: resolveCodexExecutable(process.env),
    homeDirectory,
  });
}

function assertFile(filePath: string, label: string): void {
  if (!path.isAbsolute(filePath) || !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`找不到 ${label} 可执行文件`);
  }
}

function resolveExecutable(name: string): string {
  const result = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  const executable = result.status === 0 ? result.stdout.trim() : "";
  if (!executable) throw new Error(`找不到 ${name} 可执行文件`);
  return executable;
}

function launchctl(arguments_: string[], allowFailure: boolean): ReturnType<typeof spawnSync> {
  const result = spawnSync("/bin/launchctl", arguments_, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || "unknown launchctl error";
    process.stderr.write(`${reason}\n`);
  }
  return result;
}
