import { expect, it } from "vitest";
import { NewsHttpError, retryNewsRead } from "../src/news-read-retry.js";

it("aborts a backoff without another request and records its planned attempt", async () => {
  const controller = new AbortController(), events: Array<Record<string, unknown>> = [];
  let calls = 0;
  const result = retryNewsRead(async () => { calls++; throw new NewsHttpError(429, "1", "busy"); }, controller.signal,
    (event, attributes) => { events.push({ event, ...attributes }); controller.abort(); });
  await expect(result).rejects.toThrow();
  expect(calls).toBe(1);
  expect(events).toEqual([{ event: "request.retry", attempt: 2, code: "HTTP_429", delayMs: 1000 }]);
});

it("rejects a read that completes after cancellation", async () => {
  const controller = new AbortController();
  await expect(retryNewsRead(async () => { controller.abort(); return "late"; }, controller.signal)).rejects.toThrow();
});
