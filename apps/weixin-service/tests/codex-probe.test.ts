import { describe, expect, it } from "vitest";

import { FIXED_PROBE_TEXT, requireThreadId } from "../src/codex-probe.js";

describe("Codex App Server probe input", () => {
  it("accepts only a Codex UUID and keeps the probe text fixed", () => {
    expect(requireThreadId("019fef94-7da4-75a2-b9fb-226af024ddcd")).toBe(
      "019fef94-7da4-75a2-b9fb-226af024ddcd",
    );
    expect(() => requireThreadId("thread-current; run something")).toThrow(
      "CODEX_THREAD_ID 格式无效",
    );
    expect(FIXED_PROBE_TEXT).toContain("APP_SERVER_BRIDGE_OK");
    expect(FIXED_PROBE_TEXT).toContain("不要调用任何工具");
  });
});
