import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, get } from "node:http";
import { once } from "node:events";

// Invoke after `pnpm build` for --dist; source and compiled ESM both use real local sockets.
const source = process.argv.includes("--dist") ? "dist" : "src";
const extension = source === "src" ? "ts" : "js";
const { LocalDiagnostics } = await import(`../${source}/local-diagnostics.${extension}`);
const { DiagnosticFiles } = await import(`../${source}/diagnostic-files.${extension}`);
const { readDiagnostics } = await import(`../${source}/read-diagnostics.${extension}`);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-startup-smoke-"));
const server = createServer((req, res) => { assert.equal(req.headers.traceparent, undefined); assert.equal(req.headers.baggage, undefined); res.end("ok"); });
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = server.address(); assert(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}/PRIVATE_PATH?token=PRIVATE_TOKEN`;
// Exercise the same initialization/shutdown sequence that exposed a missing HTTP span in Vitest.
const previous = new LocalDiagnostics(new DiagnosticFiles(path.join(directory, "previous")));
await previous.run("weixin.inbound", {}, async () => { await (await fetch(url)).text(); });
await previous.close();
const diagnostics = new LocalDiagnostics(new DiagnosticFiles(directory));
try {
  await diagnostics.run("weixin.inbound", {}, async () => {
    await (await fetch(url)).text();
    await new Promise<void>((resolve, reject) => get(url, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject));
  });
  await diagnostics.close();
  const evidence = await readDiagnostics(directory);
  assert.equal(evidence.records.filter((r: { kind: string; name: string }) => r.kind === "span" && r.name === "http.client").length, 2);
  const raw = (await Promise.all((await fs.readdir(directory)).filter((name) => name.endsWith(".jsonl")).map((name) => fs.readFile(path.join(directory, name), "utf8")))).join("");
  assert(raw.includes("/PRIVATE_PATH"));
  process.stdout.write(`${JSON.stringify({ source, networkSpans: 2, bytes: Buffer.byteLength(raw), unfinished: evidence.unfinished.length, result: "passed" })}\n`);
} finally {
  await diagnostics.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(directory, { recursive: true, force: true });
}
