import { describe, expect, it } from "vitest";

import {
  MAX_WEIXIN_SEGMENTS,
  MAX_WEIXIN_TEXT_CODE_POINTS,
  segmentWeixinText,
} from "../src/weixin-text-segmenter.js";

function codePoints(value: string): number {
  return Array.from(value).length;
}

describe("segmentWeixinText", () => {
  it("keeps a single message unchanged through the 1,500-code-point boundary", () => {
    const message = "微".repeat(MAX_WEIXIN_TEXT_CODE_POINTS);

    expect(segmentWeixinText(message)).toEqual({
      segments: [message],
      truncated: false,
      originalLength: MAX_WEIXIN_TEXT_CODE_POINTS,
    });
  });

  it("numbers every segment and keeps the prefix inside the limit", () => {
    const plan = segmentWeixinText("a".repeat(MAX_WEIXIN_TEXT_CODE_POINTS + 1));

    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0]).toMatch(/^\[1\/2\]\n/);
    expect(plan.segments[1]).toMatch(/^\[2\/2\]\n/);
    expect(plan.segments.every((segment) => codePoints(segment) <= 1_500)).toBe(true);
    expect(plan.truncated).toBe(false);
  });

  it("prefers paragraph boundaries near the end of a segment", () => {
    const firstParagraph = "甲".repeat(1_000);
    const secondParagraph = "乙".repeat(700);
    const plan = segmentWeixinText(`${firstParagraph}\n\n${secondParagraph}`);

    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0]).toBe(`[1/2]\n${firstParagraph}`);
    expect(plan.segments[1]).toBe(`[2/2]\n${secondParagraph}`);
  });

  it("hard-splits emoji without producing broken surrogate pairs", () => {
    const message = "😀".repeat(1_700);
    const plan = segmentWeixinText(message);

    expect(plan.segments).toHaveLength(2);
    expect(plan.segments.join("")).not.toContain("\uFFFD");
    for (const segment of plan.segments) {
      expect(codePoints(segment)).toBeLessThanOrEqual(1_500);
      expect(/^[\uDC00-\uDFFF]/u.test(segment)).toBe(false);
      expect(/[\uD800-\uDBFF]$/u.test(segment)).toBe(false);
    }
  });

  it("caps the plan at eight segments and puts an explicit marker in the last one", () => {
    const plan = segmentWeixinText("长".repeat(20_000));

    expect(plan.segments).toHaveLength(MAX_WEIXIN_SEGMENTS);
    expect(plan.truncated).toBe(true);
    expect(plan.segments.at(-1)).toMatch(/（内容过长，已截断）$/);
    expect(plan.segments.every((segment) => codePoints(segment) <= 1_500)).toBe(true);
    expect(plan.originalLength).toBe(20_000);
  });

  it("rejects an empty logical message", () => {
    expect(() => segmentWeixinText("  \n\t  ")).toThrow("微信正文不能为空");
  });
});
