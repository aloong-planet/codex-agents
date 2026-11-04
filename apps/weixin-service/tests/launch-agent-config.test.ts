import { describe, expect, it } from "vitest";

import {
  LAUNCH_AGENT_LABEL,
  buildLaunchAgentPlist,
  launchAgentInstallPlan,
  launchAgentPaths,
} from "../src/launch-agent-config.js";

describe("LaunchAgent configuration", () => {
  it("builds one persistent non-watch service without shell-profile loading", () => {
    const paths = launchAgentPaths("/Users/demo");
    const plist = buildLaunchAgentPlist({
      workingDirectory: "/Users/demo/git/codex-weixin/apps/weixin-service",
      pnpmPath: "/Users/demo/Library/pnpm/pnpm",
      nodePath: "/opt/homebrew/bin/node",
      codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      homeDirectory: "/Users/demo",
    });

    expect(LAUNCH_AGENT_LABEL).toBe("com.local.codex-weixin");
    expect(paths).toEqual({
      plistPath: "/Users/demo/Library/LaunchAgents/com.local.codex-weixin.plist",
      logDirectory: "/Users/demo/Library/Logs/codex-weixin",
      stdoutPath: "/Users/demo/Library/Logs/codex-weixin/stdout.log",
      stderrPath: "/Users/demo/Library/Logs/codex-weixin/stderr.log",
    });
    expect(plist).toContain("<string>com.local.codex-weixin</string>");
    expect(plist).toContain("<string>/Users/demo/Library/pnpm/pnpm</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Standard</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("<key>StandardOutPath</key>");
    expect(plist).toContain("<key>StandardErrorPath</key>");
    expect(plist).toContain("<key>CODEX_BIN</key>");
    expect(plist).not.toContain("tsx watch");
    expect(plist).not.toContain("pnpm dev");
    expect(plist).not.toContain("/bin/zsh");
    expect(plist).not.toContain("context_token");
  });

  it("escapes paths before writing XML", () => {
    const plist = buildLaunchAgentPlist({
      workingDirectory: "/Users/demo/A&B <service>",
      pnpmPath: "/Users/demo/pnpm",
      nodePath: "/opt/homebrew/bin/node",
      codexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      homeDirectory: "/Users/demo",
    });

    expect(plist).toContain("/Users/demo/A&amp;B &lt;service&gt;");
    expect(plist).not.toContain("A&B <service>");
  });

  it("installs by replacing only its own label and lets RunAtLoad start once", () => {
    expect(launchAgentInstallPlan("/Users/demo", 501)).toEqual({
      domain: "gui/501",
      job: "gui/501/com.local.codex-weixin",
      oldJob: "gui/501/com.local.weixin-real-channel-demo",
      plistPath: "/Users/demo/Library/LaunchAgents/com.local.codex-weixin.plist",
      bootoutArguments: ["bootout", "gui/501/com.local.codex-weixin"],
      bootstrapArguments: [
        "bootstrap",
        "gui/501",
        "/Users/demo/Library/LaunchAgents/com.local.codex-weixin.plist",
      ],
    });
  });
});
