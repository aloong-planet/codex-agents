import fs from "node:fs";
import { RuntimeMetrics } from "./runtime-metrics.js";

// Bundled as one fixed CJS preload: no node_modules/user directory read grants are needed.
// fd 3 is diagnostic-only; stdout stays the unmodified sandbox request protocol.
try {
  const output = fs.createWriteStream("", { fd: 3, autoClose: true });
  let failed = false, dropped = 0;
  output.on("error", () => { failed = true; });
  function emit(record: Record<string, unknown>): void {
    try {
      if (failed || output.destroyed) return;
      const line = JSON.stringify({ ...record, transportDropped: dropped }) + "\n";
      if (Buffer.byteLength(line) > 65_536 || output.writableLength > 256 * 1024) { dropped++; return; }
      output.write(line);
    } catch { dropped++; }
  }
  const runtime = new RuntimeMetrics((name, attributes) => emit({ kind: "metric", name, attributes }));
  process.stdin.once("end", () => {
    void runtime.close().finally(() => {
      emit({ kind: "checkpoint", name: "telemetry.transport", attributes: { dropped } });
      output.end();
    });
  });
} catch { /* Optional telemetry must not stop the fixed worker. */ }
