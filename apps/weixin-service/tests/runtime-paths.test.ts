import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePrivateStatePath } from "../src/runtime-paths.js";

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
