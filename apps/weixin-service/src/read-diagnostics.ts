import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { diagnosticFileList } from "./diagnostic-files.js";
import { diagnosticAttributes } from "./local-diagnostics.js";

type Query = { since?: number; traceId?: string; runRef?: string; maxBytes?: number; maxRecords?: number };
type RecordValue = { kind: "span" | "checkpoint" | "metric"; name: string; recordedAt: number; traceId?: string; spanId?: string; parentSpanId?: string; instanceId: string; sequence: number; attributes: ReturnType<typeof diagnosticAttributes>; startTimeUnixMs?: number; endTimeUnixMs?: number; status?: number; health: ReturnType<typeof diagnosticAttributes> };

/** Bounded, read-only evidence reader. Rejects malformed records; diagnostic attributes are not redacted. */
export async function readDiagnostics(directory: string, query: Query = {}) {
  const records: RecordValue[] = [];
  let malformed = 0, unreadable = 0, bytesRead = 0, budgetLimited = false;
  let files: Awaited<ReturnType<typeof diagnosticFileList>>;
  try {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error("invalid directory");
    files = await diagnosticFileList(directory);
  } catch { return { records, evidence: "unavailable" as const, malformed, unreadable: 1, budgetLimited: false, unfinished: [], warning: "诊断目录不可读取；不能据此判断业务是否成功。" }; }
  const maxBytes = Math.min(200 * 1024 ** 2, positive(query.maxBytes, 8 * 1024 ** 2));
  const maxRecords = Math.min(10_000, positive(query.maxRecords, 200));
  const since = query.since ?? Date.now() - 86_400_000;
  for (const file of files.sort((a, b) => Number(b.name.split("-")[1]) - Number(a.name.split("-")[1]))) {
    if (bytesRead >= maxBytes || records.length >= maxRecords) { budgetLimited = true; break; }
    try {
      const handle = await fs.open(path.join(directory, file.name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        // Tail each file so recent evidence remains accessible within a bounded query.
        const size = (await handle.stat()).size;
        const count = Math.min(size, maxBytes - bytesRead);
        const buffer = Buffer.alloc(count);
        const read = await handle.read(buffer, 0, count, size - count);
        bytesRead += read.bytesRead;
        let lines = buffer.subarray(0, read.bytesRead).toString("utf8").split("\n");
        if (count < size) { lines.shift(); budgetLimited = true; }
        if (lines.at(-1) !== "") malformed += 1;
        lines.pop(); // Incomplete final writes are evidence gaps, not records.
        lines = lines.reverse();
        for (const line of lines) {
          if (Buffer.byteLength(line) > 65_536) { malformed += 1; continue; }
          let record: RecordValue | undefined;
          try { record = project(JSON.parse(line)); } catch { /* Do not echo raw data. */ }
          if (!record) { malformed += 1; continue; }
          if (record.recordedAt < since || (query.traceId && record.traceId !== query.traceId) || (query.runRef && record.attributes.runRef !== query.runRef)) continue;
          if (records.length >= maxRecords) { budgetLimited = true; break; }
          records.push(record);
        }
      } finally { await handle.close(); }
    } catch { unreadable += 1; }
  }
  records.sort((a, b) => a.recordedAt - b.recordedAt || a.sequence - b.sequence);
  const ended = new Set(records.filter((r) => r.kind === "span").map((r) => `${r.traceId}:${r.spanId}`));
  const unfinished = records.filter((r) => r.kind === "checkpoint" && r.name.endsWith(".start") && !ended.has(`${r.traceId}:${r.spanId}`)).map((r) => ({ name: r.name, traceId: r.traceId, spanId: r.spanId }));
  const dropped = records.some((r) => Number(r.health.dropped ?? 0) > 0 || Number(r.health.failures ?? 0) > 0 || Number(r.attributes.transportDropped ?? 0) > 0);
  const rotated = records.some((r) => Number(r.health.removed ?? 0) > 0);
  return { records, evidence: records.length ? "observed" as const : "not_found_in_retained_files" as const, malformed, unreadable, budgetLimited, dropped, rotated, unfinished,
    warning: "仅查询当前保留文件。缺失可能源于轮转、丢弃、进程退出或查询预算；未闭合记录不代表仍在运行，须对照持久 Run/Effect。accepted 不证明手机收到。" };
}

function positive(value: number | undefined, fallback: number) { return value && Number.isSafeInteger(value) && value > 0 ? value : fallback; }
function project(value: unknown): RecordValue | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (![1, 2].includes(Number(row.version)) || !["span", "checkpoint", "metric"].includes(String(row.kind)) || typeof row.name !== "string" || !row.name || typeof row.recordedAt !== "number" || !Number.isFinite(row.recordedAt) || typeof row.instanceId !== "string" || !/^[a-f0-9-]{36}$/u.test(row.instanceId) || typeof row.sequence !== "number") return;
  const record: RecordValue = { kind: row.kind as RecordValue["kind"], name: row.name, recordedAt: row.recordedAt, instanceId: row.instanceId, sequence: row.sequence, attributes: diagnosticAttributes(object(row.attributes)), health: diagnosticAttributes(object(row.health)) };
  for (const key of ["traceId", "spanId", "parentSpanId"] as const) if (typeof row[key] === "string" && new RegExp(`^[a-f0-9]{${key === "traceId" ? 32 : 16}}$`, "u").test(row[key])) record[key] = row[key];
  for (const key of ["startTimeUnixMs", "endTimeUnixMs", "status"] as const) if (typeof row[key] === "number" && Number.isFinite(row[key])) record[key] = row[key];
  return record;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
