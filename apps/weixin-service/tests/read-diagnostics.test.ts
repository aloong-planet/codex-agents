import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { readDiagnostics } from "../src/read-diagnostics.js";

it("preserves legacy attributes and reports malformed, truncated, unavailable and unfinished records", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-read-"));
  const sink = new DiagnosticFiles(directory);
  const diagnostics = new LocalDiagnostics(sink);
  try {
    await diagnostics.run("tool.call", { toolId: "files.read" }, async () => {
      await sink.flush();
      const pending = await readDiagnostics(directory);
      expect(pending.unfinished).toHaveLength(1);
      expect(pending.unfinished[0]?.name).toBe("tool.call.start");
    });
    await diagnostics.close();
    const file = (await fs.readdir(directory)).find((name) => name.startsWith("traces-"))!;
    const original = await fs.readFile(path.join(directory, file), "utf8");
    const record = JSON.parse(original.trim());
    record.version = 1; // Legacy records retain the data that was actually saved.
    record.attributes.prompt = "PRIVATE_PROMPT";
    await fs.writeFile(path.join(directory, file), `${JSON.stringify(record)}\ninvalid PRIVATE_BODY\npartial`);
    const result = await readDiagnostics(directory);
    expect(result.records.filter((r) => r.kind === "span")).toHaveLength(1);
    expect(result.malformed).toBe(2);
    expect(result.records.find((r) => r.kind === "span")?.attributes.prompt).toBe("PRIVATE_PROMPT");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
    expect(result.unfinished).toEqual([]);
    expect((await readDiagnostics(directory, { maxBytes: 8 })).budgetLimited).toBe(true);
    expect((await readDiagnostics(directory, { traceId: "0".repeat(32) })).evidence).toBe("not_found_in_retained_files");
    expect((await readDiagnostics(path.join(directory, "missing"))).evidence).toBe("unavailable");
  } finally { await diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

it("preserves already flushed start evidence after a real writer is killed without claiming completion", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-crash-"));
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { DiagnosticFiles } from './src/diagnostic-files.ts';
    import { LocalDiagnostics } from './src/local-diagnostics.ts';
    const sink = new DiagnosticFiles(process.env.OTEL_TEST_DIRECTORY);
    const diag = new LocalDiagnostics(sink);
    await diag.run('tool.call', {toolId:'files.find'}, async () => {
      await sink.flush(); process.stdout.write('ready');
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `], { env: { ...process.env, OTEL_TEST_DIRECTORY: directory }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const ready = await once(child.stdout!, "data");
    expect(String(ready[0])).toBe("ready");
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const result = await readDiagnostics(directory);
    expect(result.unfinished).toHaveLength(1);
    expect(result.records.some((r) => r.kind === "span")).toBe(false);
    const restarted = new DiagnosticFiles(directory, { retentionMs: 1, now: () => Date.now() + 60_000 });
    await restarted.close();
    expect(await fs.readdir(directory)).toEqual([]);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await fs.rm(directory, { recursive: true, force: true }); }
}, 10_000);
