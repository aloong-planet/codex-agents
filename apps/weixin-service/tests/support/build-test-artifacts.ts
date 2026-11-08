import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Diagnostics fork dist/diagnostic-writer.cjs and the file sandbox preloads
// dist/file-sandbox-telemetry.cjs. Without them, diagnostics drop every record
// silently. Build them before any worker starts, whichever way vitest is invoked.
export function setup(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/build-sandbox-telemetry.mjs", import.meta.url))], { stdio: "inherit" });
}
