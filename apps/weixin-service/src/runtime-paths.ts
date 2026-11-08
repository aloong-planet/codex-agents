import path from "node:path";

import { launchAgentPaths } from "./launch-agent-config.js";

export function resolvePrivateStatePath(
  env: Record<string, string | undefined>,
  homeDir: string,
): string {
  const override = env.WEIXIN_DEMO_STATE_DIR?.trim();
  const stateDir =
    override ||
    path.join(
      homeDir,
      "Library",
      "Application Support",
      "weixin-ilink-direct-demo",
    );
  return path.join(stateDir, "state.json");
}

/** Paths holding the service's own state, configuration and credentials. File tools refuse them to every target,
 * whatever the grant (workflow-runs::CON-003). */
export function serviceProtectedRoots(
  env: Record<string, string | undefined>,
  homeDir: string,
  stateDirectory: string,
  diagnosticDirectory: string,
): string[] {
  const configured = (name: string): string | undefined => env[name]?.trim() || undefined;
  const launchAgent = launchAgentPaths(homeDir);
  const penny = configured("PENNY_CONFIG_PATH");
  // Relative locations are used relative to the working directory, so they are protected there.
  return [
    stateDirectory,
    diagnosticDirectory,
    configured("CODEX_HOME") ?? path.join(homeDir, ".codex"),
    path.join(homeDir, ".agents"),
    path.join(homeDir, ".openclaw"),
    configured("CHANNEL_CONFIG_PATH") ?? path.join(stateDirectory, "channel.json"),
    launchAgent.plistPath,
    launchAgent.logDirectory,
    ...(penny ? [penny] : []),
  ].map((location) => path.resolve(location));
}
