import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

// External SDK boundary only. Real network initialization is covered separately without mocks.
vi.mock("@opentelemetry/instrumentation-undici", () => ({ UndiciInstrumentation: class { constructor() { throw new Error("PRIVATE_SDK_ERROR"); } } }));
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { readDiagnostics } from "../src/read-diagnostics.js";

it("continues business work with safe lifecycle evidence when automatic instrumentation cannot initialize", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-init-failure-"));
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(directory));
  try {
    expect(await diagnostics.run("weixin.inbound", {}, async () => "收到")).toBe("收到");
    await diagnostics.close();
    const evidence = await readDiagnostics(directory);
    expect(evidence.records.find((record) => record.name === "service.lifecycle" && record.attributes.status === "unavailable")).toBeDefined();
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_");
  } finally { await diagnostics.close(); await fs.rm(directory, { recursive: true, force: true }); }
});
