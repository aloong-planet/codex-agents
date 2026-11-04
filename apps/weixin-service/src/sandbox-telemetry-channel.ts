import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";
import type { LocalDiagnostics } from "./local-diagnostics.js";
import { diagnosticAttributes } from "./local-diagnostics.js";
import type { SandboxWorkerIdentity } from "./sandbox-instrumentation.js";

export function sandboxTelemetryPreload(diagnostics?: LocalDiagnostics): string | undefined {
  if (!diagnostics) return;
  const file = fileURLToPath(new URL("../dist/file-sandbox-telemetry.cjs", import.meta.url));
  if (existsSync(file)) return file;
  diagnostics.checkpoint("runtime.metrics.unavailable", { reason: "preload_missing", processRole: "file_sandbox" });
}

/** Bounded observation channel, deliberately independent of the business frame parser. */
export function consumeSandboxTelemetry(stream: Readable, diagnostics: LocalDiagnostics, pid: number | undefined, moduleId: string, identity?: SandboxWorkerIdentity): void {
  const instanceId = identity?.workerInstanceId ?? crypto.randomUUID();
  let input = "", sequence = 0, discarded = false, dropped = 0;
  stream.setEncoding("utf8");
  stream.on("error", () => diagnostics.checkpoint("runtime.metrics.unavailable", { reason: "channel_failed", pid, moduleId, processRole: "file_sandbox" }));
  stream.on("end", () => {
    if (input || discarded) dropped++;
    if (dropped) diagnostics.checkpoint("telemetry.channel", { transportDropped: dropped, pid, moduleId, processRole: "file_sandbox" });
  });
  stream.on("data", (chunk: string) => {
    // Oversized lines are discarded through their newline, not parsed as partial JSON.
    for (const part of chunk.split(/(?<=\n)/u)) {
      if (discarded || Buffer.byteLength(input) + Buffer.byteLength(part) > 65_536) {
        if (!discarded) dropped++;
        input = ""; discarded = !part.endsWith("\n");
        continue;
      }
      input += part;
      if (!input.endsWith("\n")) continue;
      try {
        const row = JSON.parse(input) as Record<string, unknown>;
        if (!["metric", "checkpoint"].includes(String(row.kind)) || typeof row.name !== "string" || !row.name) { dropped++; continue; }
        const attributes = row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes) ? row.attributes as Record<string, unknown> : {};
        diagnostics.files.append(row.kind === "metric" ? "metrics" : "checkpoints", {
          version: 2, kind: row.kind, name: row.name, instanceId, sequence: ++sequence, recordedAt: Date.now(),
          attributes: diagnosticAttributes({ ...attributes, ...identity, processRole: "file_sandbox", pid, moduleId, transportDropped: row.transportDropped }),
          health: diagnostics.files.stats(),
        }, row.kind === "checkpoint" ? "normal" : "background");
      } catch { dropped++; } // Malformed telemetry is not a failed file operation.
      finally { input = ""; }
    }
  });
}
