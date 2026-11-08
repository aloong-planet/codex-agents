import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePrivateStatePath, serviceProtectedRoots } from "../src/runtime-paths.js";

describe("resolvePrivateStatePath", () => {
  it("defaults outside the OpenClaw and Git worktrees", () => {
    expect(resolvePrivateStatePath({}, "/Users/example")).toBe(
      path.join(
        "/Users/example",
        "Library",
        "Application Support",
        "weixin-ilink-direct-demo",
        "state.json",
      ),
    );
  });

  it("accepts an explicit private state directory override", () => {
    expect(
      resolvePrivateStatePath({ WEIXIN_DEMO_STATE_DIR: "/private/demo-state" }, "/Users/example"),
    ).toBe("/private/demo-state/state.json");
  });
});

describe("serviceProtectedRoots", () => {
  const state = "/Users/example/Library/Application Support/weixin-ilink-direct-demo";
  const otel = "/Users/example/Library/Logs/codex-weixin/otel";
  it.each<[string, Record<string, string>, string[], string?, string?]>([
    ["defaults", {}, [state, otel, "/Users/example/.codex", "/Users/example/.agents", "/Users/example/.openclaw", `${state}/channel.json`,
      "/Users/example/Library/LaunchAgents/com.local.codex-weixin.plist", "/Users/example/Library/Logs/codex-weixin"]],
    ["configured locations, relative ones taken from the working directory",
      { CODEX_HOME: "owner-codex", CHANNEL_CONFIG_PATH: "/etc/codex-weixin/channel.json", PENNY_CONFIG_PATH: "config/penny.json" },
      [state, otel, path.join(process.cwd(), "owner-codex"), "/Users/example/.agents", "/Users/example/.openclaw", "/etc/codex-weixin/channel.json",
        "/Users/example/Library/LaunchAgents/com.local.codex-weixin.plist", "/Users/example/Library/Logs/codex-weixin", path.join(process.cwd(), "config", "penny.json")]],
    ["relative state and diagnostics directories", {}, [path.join(process.cwd(), "state"), path.join(process.cwd(), "logs", "otel"), "/Users/example/.codex",
      "/Users/example/.agents", "/Users/example/.openclaw", path.join(process.cwd(), "state", "channel.json"),
      "/Users/example/Library/LaunchAgents/com.local.codex-weixin.plist", "/Users/example/Library/Logs/codex-weixin"], "state", "logs/otel"],
  ])("lists the service's own state, configuration and credentials: %s", (_case, env, expected, stateDirectory = state, diagnosticDirectory = otel) => {
    expect(serviceProtectedRoots(env, "/Users/example", stateDirectory, diagnosticDirectory)).toEqual(expected);
  });
});
