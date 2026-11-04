import { expect, it, vi } from "vitest";
import config from "../playwright.config.js";
import { withinInteractionBudget } from "../e2e/interaction-budget.js";
import { startFixtureServer } from "../e2e/fixture-server.js";
import net from "node:net";

it("allows 120 seconds for a complete multi-turn E2E case", () => {
  expect(config.timeout).toBe(120_000);
});

it("does not share a web server or a fixed production URL between cases", () => {
  expect(config.webServer).toBeUndefined();
  expect(config.use?.baseURL).toBeUndefined();
});

it("rejects a misspelled model mode instead of silently testing the fixture model", async () => {
  let server: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
  try {
    await expect(startFixtureServer("lvie", "fixture").then((started) => { server = started; return started; }))
      .rejects.toThrow("invalid E2E model mode");
  } finally { await server?.close(); }
});

it("clears the deadline after success and preserves an early operation failure", async () => {
  vi.useFakeTimers();
  try {
    expect(await withinInteractionBudget(async () => "completed")).toBe("completed");
    const cause = new Error("HTTP fixture failed");
    await expect(withinInteractionBudget(async () => { throw cause; })).rejects.toBe(cause);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("does not refresh the idle budget on HTTP completion without model progress", async () => {
  vi.useFakeTimers();
  try {
    const pending = withinInteractionBudget(async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const verdict = expect(pending).rejects.toThrow("interaction idle for 30000 ms");
    await vi.advanceTimersByTimeAsync(30_000);
    await verdict;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("isolates state and kills a case with an unfinished HTTP request without stopping another case", async () => {
  const first = await startFixtureServer("fixture", "fixture");
  let second: Awaited<ReturnType<typeof startFixtureServer>> | undefined;
  let socket: net.Socket | undefined;
  try {
    const response = await fetch(`${first.url}/api/fixture/workflow/inbound`, {
      method: "POST", headers: { "content-type": "application/json", origin: first.url }, body: JSON.stringify({ text: "isolation-marker" }),
    });
    expect(response.ok).toBe(true);
    expect(JSON.stringify(await (await fetch(`${first.url}/api/state`)).json())).toContain("isolation-marker");
    second = await startFixtureServer("fixture", "fixture");
    expect(second.directory).not.toBe(first.directory);
    expect(second.url).not.toBe(first.url);
    expect(second.traceFile).not.toBe(first.traceFile);
    expect(second.otelDirectory).not.toBe(first.otelDirectory);
    const secondState = await (await fetch(`${second.url}/api/state`)).json();
    expect(JSON.stringify(secondState)).not.toContain("isolation-marker");
    expect(secondState.fixtureOutbox).toEqual([]);
    socket = net.createConnection({ host: "127.0.0.1", port: Number(new URL(first.url).port) });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket!.once("connect", resolve));
    socket.write(`POST /api/fixture/workflow/inbound HTTP/1.1\r\nHost: ${new URL(first.url).host}\r\nOrigin: ${first.url}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    process.kill(first.pid, "SIGSTOP"); // This case cannot respond to graceful termination.
    await first.close();
    await expect(fetch(`${first.url}/api/state`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    expect((await fetch(`${second.url}/api/state`)).ok).toBe(true);
  } finally {
    socket?.destroy();
    try { process.kill(first.pid, "SIGCONT"); } catch (error) {
      expect(error).toMatchObject({ code: "ESRCH" });
    }
    await first.close();
    await second?.close();
  }
}, 30_000);

it("aborts a stalled interaction at 30 seconds, not the whole case budget", async () => {
  vi.useFakeTimers();
  try {
    let signal: AbortSignal | undefined;
    const pending = withinInteractionBudget(async (received) => {
      signal = received;
      await new Promise(() => {});
    });
    const verdict = expect(pending).rejects.toThrow("interaction idle for 30000 ms");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await verdict;
  } finally { vi.useRealTimers(); }
});

it("allows a streaming interaction beyond 30 seconds but expires 30 seconds after its last activity", async () => {
  vi.useFakeTimers();
  try {
    let activity = false;
    let signal: AbortSignal | undefined;
    const pending = withinInteractionBudget(async (received) => {
      signal = received;
      await new Promise(() => {});
    }, 30_000, () => { const fresh = activity; activity = false; return fresh; });
    const verdict = expect(pending).rejects.toThrow("interaction idle for 30000 ms");
    await vi.advanceTimersByTimeAsync(20_000);
    activity = true;
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await verdict;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
