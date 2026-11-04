import { CodexAppServerClient, type AppServerTransport } from "./codex-app-server-client.js";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FIXED_PROBE_TEXT =
  "这是由本机微信 Demo 通过 Codex App Server 发起的连通性探针。请只回复 APP_SERVER_BRIDGE_OK，不要调用任何工具，不要读取文件，不要执行命令，也不要添加解释。";

export function requireThreadId(value: string | undefined): string {
  const threadId = value?.trim() ?? "";
  if (!THREAD_ID.test(threadId)) throw new Error("CODEX_THREAD_ID 格式无效");
  return threadId;
}

export async function runCodexProbe(
  transport: AppServerTransport,
  threadId: string,
  timeoutMs = 120_000,
): Promise<"APP_SERVER_BRIDGE_OK"> {
  const reply = await new CodexAppServerClient(transport, timeoutMs).runTurn({
    threadId,
    text: FIXED_PROBE_TEXT,
  });
  if (reply !== "APP_SERVER_BRIDGE_OK") {
    throw new Error("Codex App Server 返回了非预期探针回复");
  }
  return reply;
}
