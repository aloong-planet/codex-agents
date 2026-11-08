import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { requestConsoleControl } from "../src/console-control.js";
import { signalProcessGroup } from "../tests/support/process-group.js";
import { authorizeLocalService } from "./console-session.js";

let telemetryBuilt = false;

/**
 * Starts the service in fixture mode in its own state directory. The harness authorizes itself through the
 * console control channel, like the owner's login command, and exposes `cookie` for its own state reads and
 * `loginLink()` for browsers.
 */
export async function startFixtureServer(
  modelMode: string,
  routerMode: string,
  fileScanLimit?: number,
  options: { stateDirectory?: string; businessDirectory?: string; port?: number } = {},
) {
  if (![modelMode, routerMode].every((mode) => mode === "live" || mode === "fixture")) {
    throw new Error("invalid E2E model mode: use live or fixture");
  }
  if (!telemetryBuilt) {
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/build-sandbox-telemetry.mjs", import.meta.url))]);
    telemetryBuilt = true;
  }
  const directory = options.stateDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), "weixin-e2e-case-"));
  // Business files live outside the state directory, as in production, where file tools refuse the state directory.
  const businessDirectory = options.businessDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), "weixin-e2e-business-"));
  const traceFile = path.join(directory, "service.log");
  const otelDirectory = path.join(directory, "otel");
  const reservation = net.createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("fixture port unavailable");
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const url = `http://127.0.0.1:${address.port}`;
  const fd = fs.openSync(traceFile, "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, DEMO_MODE: "fixture", PORT: String(address.port),
      WORKFLOW_SIMULATOR_MODEL: modelMode, WORKFLOW_SIMULATOR_PENDING_ROUTER: routerMode,
      WORKFLOW_FIXTURE_FILE_SCAN_LIMIT: fileScanLimit === undefined ? "" : String(fileScanLimit),
      WORKFLOW_FIXTURE_STATE_DIRECTORY: directory, WORKFLOW_FIXTURE_BUSINESS_DIRECTORY: businessDirectory, WEIXIN_OTEL_DIRECTORY: otelDirectory,
      WORKFLOW_FIXTURE_TRACE_FILE: traceFile, WEIXIN_OTEL_ENABLED: "1" },
  });
  fs.closeSync(fd);
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (child.pid) signalProcessGroup(child.pid, signal);
    };
    signalGroup("SIGTERM");
    const until = Date.now() + 2_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(25);
    // Kill only this case's process group, including children left by an interrupted turn.
    signalGroup("SIGKILL");
    const killedUntil = Date.now() + 2_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < killedUntil) await delay(25);
    if (child.pid && child.exitCode === null && child.signalCode === null) throw new Error(`fixture cleanup failed: ${directory}`);
  };
  const loginLink = async () => {
    const { url: link } = await requestConsoleControl(directory, { command: "login-link" });
    if (typeof link !== "string") throw new Error("fixture control channel returned no login link");
    return link;
  };
  try {
    const until = Date.now() + 20_000;
    let cookie: string | undefined;
    while (Date.now() < until) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fixture exited; inspect ${traceFile}`);
      try {
        cookie ??= await authorizeLocalService(directory);
        const response = await fetch(`${url}/api/state`, { headers: { cookie }, signal: AbortSignal.timeout(500) });
        if (response.ok) return { url, directory, businessDirectory, traceFile, otelDirectory, pid: child.pid!, cookie, loginLink, close };
      } catch { /* bounded readiness retry */ }
      await delay(50);
    }
    throw new Error(`fixture startup exceeded 20 seconds; inspect ${traceFile}`);
  } catch (error) {
    await close();
    throw error;
  }
}
