import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePrivateStatePath } from "./runtime-paths.js";
import { FeishuSdkTransport } from "./feishu-sdk-transport.js";
import { PairingTerminal } from "./pairing-terminal.js";
import { runFeishuPairing } from "./feishu-pairing.js";

export async function pairingMain(): Promise<void> {
  if (process.argv.includes("--help")) {
    process.stdout.write("飞书首次配对\n用法：pnpm feishu:pair\n使用原服务的 WEIXIN_DEMO_STATE_DIR；CHANNEL_CONFIG_PATH 可指定配置文件。\n请先停止正式服务。凭据在终端输入，不要放在命令参数中。\n"); return;
  }
  if (process.argv.length > 2) { process.stderr.write("不接受命令参数；使用 --help 查看用法。\n"); process.exitCode = 1; return; }
  const stop = new AbortController(); const cancel = () => stop.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const io = new PairingTerminal(process.stdin, process.stdout);
    const statePath = resolvePrivateStatePath(process.env, os.homedir());
    const configPath = path.resolve(process.env.CHANNEL_CONFIG_PATH ?? path.join(path.dirname(statePath), "channel.json"));
    const result = await runFeishuPairing({ configPath, statePath, io, signal: stop.signal, transport: credentials => new FeishuSdkTransport(credentials) });
    if (result === "cancelled") io.write("已取消。配对连接已关闭，原配置未修改。");
    process.exitCode = result === "saved" ? 0 : result === "cancelled" ? 130 : 1;
  } catch { process.stderr.write("请在本机交互式终端运行配对命令，并检查原服务的私有目录。\n"); process.exitCode = 1; }
  finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await pairingMain();
