import fs from "node:fs";

import { build } from "esbuild";

const outfile = "dist/server.mjs";

await build({
  entryPoints: ["src/server.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: true,
  legalComments: "none",
  packages: "bundle",
  banner: { js: "#!/usr/bin/env node" },
});

const bundled = fs.readFileSync(outfile, "utf8");
fs.writeFileSync(outfile, bundled.replace(/[ \t]+$/gm, ""));
