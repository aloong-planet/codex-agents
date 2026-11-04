import type { CodexNewsRun } from "../../src/codex-news-researcher.js";

/** Scripted positive model verdict for tests of selection/recovery, not a semantic content oracle. */
export function withArticleAssessment(run: CodexNewsRun): CodexNewsRun {
  return async (input) => {
    const output = await run(input);
    const line = input.prompt.split("\n").find((value) => value.startsWith("正文数据："));
    if (!line) return output;
    const body = JSON.parse(line.slice("正文数据：".length)) as { markdown: string };
    const result = JSON.parse(output) as { assessment?: unknown; items?: unknown[] };
    if (result.assessment !== undefined) return output;
    return JSON.stringify({ ...result, assessment: { status: result.items?.length ? "matched" : "insufficient", evidence: body.markdown.slice(0, 500) } });
  };
}
