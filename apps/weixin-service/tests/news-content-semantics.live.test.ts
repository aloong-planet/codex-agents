// Explicit opt-in: only the six approved synthetic/public snippets; no network reader or Weixin channel.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { CodexHackerNewsResearcher, createCodexCliNewsRun } from "../src/codex-news-researcher.js";
import { resolveCodexExecutable } from "../src/stdio-app-server-transport.js";

const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/news-semantic-cases.json", import.meta.url), "utf8")) as { name: string; title: string; body: string; expected: string }[];
const enabled = process.env.NEWS_CONTENT_SEMANTICS_LIVE === "1";
const run = createCodexCliNewsRun({ executable: () => resolveCodexExecutable(process.env), timeoutMs: 90000 });
const results: unknown[] = [];
const outputDirectory = enabled
  ? process.env.NEWS_CONTENT_SEMANTICS_OUTPUT_DIRECTORY ?? fs.mkdtempSync(path.join(os.tmpdir(), "news-semantics-"))
  : undefined;
if (outputDirectory) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  console.info(`Live semantic evidence: ${path.join(outputDirectory, "semantic-results.json")}`);
}
it.skipIf(!enabled).each(cases)("live semantic admission: $name", async (sample) => {
  const now = Date.parse("2026-10-17T14:00:00Z");
  let raw = "", calls = 0;
  const researcher = new CodexHackerNewsResearcher(async (input) => {
    if (++calls > 1) throw new Error("live evaluation permits only one model call per approved group");
    raw = await run(input); return raw;
  }, async () => [{ id: 1, rank: 1, title: sample.title, url: "https://example.test/approved-evaluation", submittedAt: "2026-10-17T10:00:00Z", score: 10, comments: 1 }], () => now,
  async () => ({ title: sample.title, markdown: sample.body }));
  const digest = await researcher.generate({ date: "2026-10-17", windowStart: now - 86400000, windowEnd: now, selection: { generalCount: 0, hackerNewsCount: 1 } });
  results.push({ name: sample.name, expected: sample.expected, calls, raw, digest });
  fs.writeFileSync(path.join(outputDirectory!, "semantic-results.json"), JSON.stringify(results, null, 2));
  expect(calls).toBe(1);
  const assessment = JSON.parse(raw).assessment;
  if (sample.expected === "matched") {
    expect(assessment.status).toBe("matched");
    expect(digest.items).toHaveLength(1);
  } else {
    expect(sample.expected === "mismatched" ? ["mismatched"] : ["insufficient", "mismatched"]).toContain(assessment.status);
    expect(digest.items).toEqual([]);
  }
}, 100000);
