import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolvePrivateStatePath } from "../../../apps/weixin-service/src/runtime-paths.js";
import { defaultStateDirectory } from "../src/console-control-client.js";

describe("console control client", () => {
  // The installed plugin finds the service's control channel through this default, so it must stay the
  // service's own state directory for the same environment.
  it.each([
    ["the default directory", {}],
    ["an override with surrounding spaces", { WEIXIN_DEMO_STATE_DIR: "  /private/demo-state  " }],
  ])("looks for the control channel in the service's state directory: %s", (_name, env) => {
    expect(defaultStateDirectory(env, "/Users/example")).toBe(path.dirname(resolvePrivateStatePath(env, "/Users/example")));
  });
});
