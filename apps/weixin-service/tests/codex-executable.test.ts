import { existsSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveCodexExecutable } from "../src/stdio-app-server-transport.js";

// Filesystem boundary: these are the two layouts observed in installed ChatGPT bundles.
vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("Bundled Codex executable resolution", () => {
  it("recovers an obsolete explicit bundled path using the relocated application binary", () => {
    vi.mocked(existsSync).mockImplementation((candidate) =>
      candidate === "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
    expect(resolveCodexExecutable({ CODEX_BIN: "/Applications/ChatGPT.app/Contents/Resources/codex" }))
      .toBe("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  });

  it.each([
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ])("finds the installed default layout at %s", (installed) => {
    vi.mocked(existsSync).mockImplementation((candidate) => candidate === installed);
    expect(resolveCodexExecutable({})).toBe(installed);
  });

  it("honors a working explicit executable even when a bundled binary exists", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    expect(resolveCodexExecutable({ CODEX_BIN: " /custom/codex " })).toBe("/custom/codex");
  });

  it("does not silently replace a missing custom executable with a bundled binary", () => {
    vi.mocked(existsSync).mockImplementation((candidate) => candidate !== "/missing/custom-codex");
    expect(() => resolveCodexExecutable({ CODEX_BIN: "/missing/custom-codex" })).toThrow(/找不到本机 Codex/u);
  });

  it("fails when neither known bundle layout is installed", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => resolveCodexExecutable({})).toThrow(/找不到本机 Codex/u);
  });
});
