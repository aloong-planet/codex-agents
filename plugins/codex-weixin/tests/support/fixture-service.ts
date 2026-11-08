import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Shared by the plugin's e2e files: the built service (`apps/weixin-service/dist/main.js`) in fixture mode on a
 * fixed port, with its own state directory. The plugin under test is given the same state directory, as it
 * shares the default one in production, and authorizes through the control channel the service opens there.
 */
export type FixtureService = { baseUrl: string; process: ChildProcess; stop(): Promise<void> };

export async function startFixtureService(input: { port: number; stateDirectory: string }): Promise<FixtureService> {
  const baseUrl = `http://127.0.0.1:${input.port}`;
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: path.resolve(process.cwd(), "../../apps/weixin-service"),
    env: { ...process.env, DEMO_MODE: "fixture", PORT: String(input.port), WORKFLOW_FIXTURE_STATE_DIRECTORY: input.stateDirectory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  };
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer means the service listens; the control file means the plugin can authorize.
      await fetch(`${baseUrl}/api/state`);
      if (fs.existsSync(path.join(input.stateDirectory, "console-control.json"))) return { baseUrl, process: child, stop };
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await stop();
  throw new Error("fixture service did not become ready");
}
