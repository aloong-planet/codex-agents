import { DiagnosticFileStore, type DiagnosticFileOptions } from "./diagnostic-file-store.js";

let store: DiagnosticFileStore;
let now: number | undefined;
let batchBytes = 65_536;
process.on("message", async (message: { type: string; directory: string; options: DiagnosticFileOptions;
  entries: Array<{ signal: "traces" | "checkpoints" | "metrics"; line: string }>; now?: number }) => {
  try {
    now = message.now;
    if (message.type === "init") {
      batchBytes = Math.min(message.options.maxRecordBytes ?? 65_536, message.options.maxFileBytes ?? 20 * 1024 ** 2);
      store = new DiagnosticFileStore(message.directory, { ...message.options, now: () => now ?? Date.now() });
    } else if (message.type === "append") {
      let group: { signal: "traces" | "checkpoints" | "metrics"; line: string; count: number } | undefined;
      for (const entry of message.entries) {
        if (group && (group.signal !== entry.signal || Buffer.byteLength(group.line) + Buffer.byteLength(entry.line) > batchBytes)) {
          store.appendLines(group.signal, group.line, group.count); group = undefined;
        }
        if (group) { group.line += entry.line; group.count++; }
        else group = { ...entry, count: 1 };
      }
      if (group) store.appendLines(group.signal, group.line, group.count);
    } else if (message.type === "maintain") await store.maintain();
    else if (message.type === "close") await store.close();
    await store.flush();
    process.send?.({ health: store.stats() });
  } catch { process.exit(1); }
});
process.on("disconnect", () => process.exit(0));
