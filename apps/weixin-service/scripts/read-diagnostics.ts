import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { readDiagnostics } from "../src/read-diagnostics.js";

try {
  const { values } = parseArgs({ options: { directory: { type: "string" }, since: { type: "string" }, trace: { type: "string" }, run: { type: "string" }, limit: { type: "string" } } });
  const since = values.since ? Date.parse(values.since) : undefined;
  if (since !== undefined && !Number.isFinite(since)) throw new Error("invalid date");
  const result = await readDiagnostics(values.directory ?? process.env.WEIXIN_OTEL_DIRECTORY ?? path.join(os.homedir(), "Library", "Logs", "codex-weixin", "otel"), {
    ...(since !== undefined ? { since } : {}), ...(values.trace ? { traceId: values.trace } : {}), ...(values.run ? { runRef: values.run } : {}), ...(values.limit ? { maxRecords: Number(values.limit) } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.evidence === "unavailable") process.exitCode = 1;
} catch { console.error("诊断查询失败：请检查参数与目录权限；不会修改业务数据。"); process.exitCode = 1; }
