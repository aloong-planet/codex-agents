import { requireThreadId, runCodexProbe } from "./codex-probe.js";
import {
  resolveCodexExecutable,
  spawnStdioAppServer,
} from "./stdio-app-server-transport.js";

async function main(): Promise<void> {
  const threadId = requireThreadId(process.env.CODEX_THREAD_ID);
  const executable = resolveCodexExecutable(process.env);
  const reply = await runCodexProbe(spawnStdioAppServer(executable), threadId);
  process.stdout.write(`${reply}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Codex App Server 探针失败";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
