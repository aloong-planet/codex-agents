import path from "node:path";

export const LAUNCH_AGENT_LABEL = "com.local.codex-weixin";

export type LaunchAgentConfig = {
  workingDirectory: string;
  pnpmPath: string;
  nodePath: string;
  codexPath: string;
  homeDirectory: string;
};

export function launchAgentPaths(homeDirectory: string): {
  plistPath: string;
  logDirectory: string;
  stdoutPath: string;
  stderrPath: string;
} {
  const logDirectory = path.join(homeDirectory, "Library", "Logs", "codex-weixin");
  return {
    plistPath: path.join(homeDirectory, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
    logDirectory,
    stdoutPath: path.join(logDirectory, "stdout.log"),
    stderrPath: path.join(logDirectory, "stderr.log"),
  };
}

export function launchAgentInstallPlan(homeDirectory: string, uid: number): {
  domain: string;
  job: string;
  oldJob: string;
  plistPath: string;
  bootoutArguments: string[];
  bootstrapArguments: string[];
} {
  const domain = `gui/${uid}`;
  const job = `${domain}/${LAUNCH_AGENT_LABEL}`;
  const plistPath = launchAgentPaths(homeDirectory).plistPath;
  return {
    domain,
    job,
    oldJob: `${domain}/com.local.weixin-real-channel-demo`,
    plistPath,
    bootoutArguments: ["bootout", job],
    bootstrapArguments: ["bootstrap", domain, plistPath],
  };
}

export function buildLaunchAgentPlist(config: LaunchAgentConfig): string {
  const paths = launchAgentPaths(config.homeDirectory);
  const runtimePath = [
    path.dirname(config.nodePath),
    path.dirname(config.pnpmPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].filter((entry, index, entries) => entries.indexOf(entry) === index).join(":");
  const value = (input: string): string => `<string>${escapeXml(input)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${value(LAUNCH_AGENT_LABEL)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    ${value(config.pnpmPath)}`,
    "    <string>start</string>",
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  ${value(config.workingDirectory)}`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HOME</key>",
    `    ${value(config.homeDirectory)}`,
    "    <key>PATH</key>",
    `    ${value(runtimePath)}`,
    "    <key>CODEX_BIN</key>",
    `    ${value(config.codexPath)}`,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ThrottleInterval</key>",
    "  <integer>10</integer>",
    "  <key>ProcessType</key>",
    "  <string>Standard</string>",
    "  <key>StandardOutPath</key>",
    `  ${value(paths.stdoutPath)}`,
    "  <key>StandardErrorPath</key>",
    `  ${value(paths.stderrPath)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
