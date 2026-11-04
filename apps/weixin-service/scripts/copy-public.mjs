import fs from "node:fs";
import { URL } from "node:url";
import "./build-sandbox-telemetry.mjs";

fs.cpSync(new URL("../src/public", import.meta.url), new URL("../dist/public", import.meta.url), {
  recursive: true,
});
fs.copyFileSync(
  new URL("../src/file-sandbox-worker.mjs", import.meta.url),
  new URL("../dist/file-sandbox-worker.mjs", import.meta.url),
);
