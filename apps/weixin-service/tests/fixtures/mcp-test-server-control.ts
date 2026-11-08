// Controls for the real stdio MCP test server (mcp-test-server.mjs), shared by the catalog's unit, HTTP and browser
// tests. Each case gets its own tools file, start marker and fail flag in a temporary directory.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_SERVER = fileURLToPath(new URL("./mcp-test-server.mjs", import.meta.url));
/** Printed by the test server when it fails, so that masking can be checked; 22 characters. */
export const SECRET_SENTINEL = "tok-5e1f-SENTINEL-9a7c";

export type TestServerFiles = { tools: string; marker: string; failFlag: string };

export function testServerFiles(directory: string, label = "server"): TestServerFiles {
  return {
    tools: path.join(directory, `${label}-tools.json`),
    marker: path.join(directory, `${label}-started.jsonl`),
    failFlag: path.join(directory, `${label}-fail`),
  };
}

/** The test server's arguments; extra tool definitions come from `files.tools`. */
export function testServerArgs(files: TestServerFiles, options: { listChanged?: boolean } = {}): string[] {
  return [TEST_SERVER, "--tools", files.tools, "--marker", files.marker, "--fail-flag", files.failFlag, ...(options.listChanged === false ? ["--no-list-changed"] : [])];
}

export function writeTools(file: string, tools: unknown[]): void {
  fs.writeFileSync(file, JSON.stringify(tools));
}

/** Every start of the test server, oldest first, with the SECRET_TOKEN it received (null without one). */
export function starts(files: TestServerFiles): Array<{ pid: number; argv: string[]; cwd: string; secretToken: string | null }> {
  if (!fs.existsSync(files.marker)) return [];
  return fs.readFileSync(files.marker, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
