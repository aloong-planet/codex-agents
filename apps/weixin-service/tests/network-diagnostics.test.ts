import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, get } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { LocalDiagnostics } from "../src/local-diagnostics.js";
import { DiagnosticFiles } from "../src/diagnostic-files.js";
import { readDiagnostics } from "../src/read-diagnostics.js";
import { ChannelTransport } from "../src/channel-transport.js";

it("preserves wire payload and replies when diagnostics is disabled or restarted", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-parity-"));
  const bodies: string[] = [];
  const headers: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    headers.push(req.headers); let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { bodies.push(body); res.end('{"ret":0}'); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("test_listener_missing");
  const url = `http://127.0.0.1:${address.port}/sendmessage`;
  try {
    for (const enabled of [true, false, true]) {
      const diagnostics = enabled ? new LocalDiagnostics(new DiagnosticFiles(directory)) : undefined;
      try { expect(await new ChannelTransport(fetch, diagnostics).json(url, { method: "POST", headers: { Authorization: "PRIVATE_TOKEN" }, body: "PRIVATE_BODY" })).toEqual({ ret: 0 }); }
      finally { await diagnostics?.close(); }
    }
    expect(bodies).toEqual(["PRIVATE_BODY", "PRIVATE_BODY", "PRIVATE_BODY"]);
    expect(headers).toHaveLength(3);
    for (const header of headers) { expect(header.traceparent).toBeUndefined(); expect(header.baggage).toBeUndefined(); }
    const evidence = await readDiagnostics(directory);
    const network = evidence.records.filter((record) => record.kind === "span" && record.name === "http.client");
    expect(network).toHaveLength(2);
    expect(new Set(network.map((record) => record.instanceId)).size).toBe(2);
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE_");
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it("keeps concurrent timer contexts separate for native fetch and node:http and ignores requests outside a diagnostic scope", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-concurrent-"));
  const headers: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => { headers.push(req.headers); res.end("ok"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("test_listener_missing");
  const url = `http://127.0.0.1:${address.port}/PRIVATE_PATH`;
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(directory));
  try {
    await (await fetch(url)).text();
    await Promise.all([
      diagnostics.run("workflow.effect", { runRef: "11111111-2222-4333-8444-555555555555" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        await (await fetch(url)).text();
      }),
      diagnostics.run("workflow.effect", { runRef: "22222222-2222-4333-8444-555555555555" }, async () => {
        await new Promise<void>((resolve, reject) => get(url, (response) => { response.resume(); response.on("end", resolve); }).on("error", reject));
      }),
    ]);
    await diagnostics.close();
    const records = (await readDiagnostics(directory)).records;
    const network = records.filter((r) => r.kind === "span" && r.name === "http.client");
    expect(network).toHaveLength(2);
    for (const id of ["11111111-2222-4333-8444-555555555555", "22222222-2222-4333-8444-555555555555"]) {
      const root = records.find((r) => r.kind === "span" && r.name === "workflow.effect" && r.attributes.runRef === id)!;
      const child = network.find((r) => r.attributes.runRef === id);
      expect(child?.parentSpanId).toBe(root.spanId);
      expect(child?.traceId).toBe(root.traceId);
      expect(records.some((r) => r.name === "http.client.start" && r.attributes.runRef === id)).toBe(true);
    }
    expect(headers).toHaveLength(3);
    for (const header of headers) { expect(header.traceparent).toBeUndefined(); expect(header.baggage).toBeUndefined(); }
    expect(JSON.stringify(records)).toContain("/PRIVATE_PATH");
  } finally {
    await diagnostics.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// Real native fetch, real local socket, real exporter and public reader: mocks cannot prove instrumentation.
it("automatically associates native fetch failure and retains URLs without collecting headers or bodies", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "otel-network-"));
  const server = createServer((req, res) => {
    expect(req.headers.traceparent).toBeUndefined();
    expect(req.headers.baggage).toBeUndefined();
    res.writeHead(503); res.end("PRIVATE_RESPONSE");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_listener_missing");
  const diagnostics = new LocalDiagnostics(new DiagnosticFiles(directory));
  const runId = "11111111-2222-4333-8444-555555555555";
  try {
    await diagnostics.run("workflow.effect", { runRef: runId }, async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/upload?token=PRIVATE_QUERY`, {
        method: "POST", headers: { Authorization: "PRIVATE_HEADER" }, body: "PRIVATE_BODY",
      });
      expect(response.status).toBe(503);
      await response.text();
    });
    await diagnostics.close();
    const evidence = await readDiagnostics(directory, { runRef: runId });
    const parent = evidence.records.find((r) => r.kind === "span" && r.name === "workflow.effect");
    const request = evidence.records.find((r) => r.kind === "span" && r.name === "http.client");
    expect(request).toBeDefined();
    expect(request?.parentSpanId).toBe(parent?.spanId);
    expect(request?.traceId).toBe(parent?.traceId);
    expect(request?.attributes.httpStatus).toBe(503);
    expect(request?.status).toBe(2);
    const raw = (await Promise.all((await fs.readdir(directory)).map((name) => fs.readFile(path.join(directory, name), "utf8")))).join("");
    expect(raw).toContain("/upload?");
    expect(JSON.stringify(evidence)).toContain("/upload?");
    for (const sentinel of ["PRIVATE_HEADER", "PRIVATE_BODY", "PRIVATE_RESPONSE"]) {
      expect(raw).not.toContain(sentinel);
      expect(JSON.stringify(evidence)).not.toContain(sentinel);
    }
  } finally {
    await diagnostics.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
