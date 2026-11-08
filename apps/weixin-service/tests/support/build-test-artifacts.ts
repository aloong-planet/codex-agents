import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Diagnostics fork dist/diagnostic-writer.cjs; without it they silently drop every
// record. The file sandbox preloads dist/file-sandbox-telemetry.cjs; without it there
// is no sandbox telemetry. Build both before any worker starts, however vitest is invoked.
export function setup(): void {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/build-sandbox-telemetry.mjs", import.meta.url))], { stdio: "inherit" });
}
