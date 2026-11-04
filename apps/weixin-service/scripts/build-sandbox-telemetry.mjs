import { build } from "esbuild";
import { fileURLToPath, URL } from "node:url";

export async function buildSandboxTelemetry() {
  await build({
    entryPoints: [fileURLToPath(new URL("../src/file-sandbox-telemetry.ts", import.meta.url))],
    outfile: fileURLToPath(new URL("../dist/file-sandbox-telemetry.cjs", import.meta.url)),
    bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
  });
}
await buildSandboxTelemetry();

await build({
  entryPoints: [fileURLToPath(new URL("../src/diagnostic-writer.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/diagnostic-writer.cjs", import.meta.url)),
  bundle: true, platform: "node", format: "cjs", target: "node22", legalComments: "none",
});
