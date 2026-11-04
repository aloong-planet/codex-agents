import { describe, expect, it } from "vitest";

import { MainReplyProtocolError, parseMainReply, parseMainReplyFailure, parseStoredMainBusinessResult } from "../src/main-reply-result.js";

// Protocol validation only; these fixtures are not model semantic evaluations.
describe("main reply protocol", () => {
  it.each(["completed", "partial", "not_found", "needs_input", "blocked", "failed", "cancelled", "in_progress", "unknown"])("accepts the documented %s status without interpreting it", (status) => {
    expect(parseMainReply(JSON.stringify({ message: "正文", results: [{ subject: "目标", status }] })))
      .toEqual({ message: "正文", results: [{ subject: "目标", status }] });
  });

  it("preserves empty results separately from absent results", () => {
    expect(parseMainReply('{"message":"收到","results":[]}')).toEqual({ message: "收到", results: [] });
    expect(() => parseMainReply('{"message":"收到"}')).toThrow("main_reply_invalid_schema");
  });

  it("preserves mixed results, their order, and quoted text without synthesizing a summary status", () => {
    expect(parseMainReply('{"results":[{"status":"completed","subject":"查阅笔记"},{"status":"not_found","subject":"查找图片"}],"message":"  原文\\n\\"报告【终版】.md\\"。😀  "}'))
      .toEqual({ message: '  原文\n"报告【终版】.md"。😀  ', results: [
        { subject: "查阅笔记", status: "completed" }, { subject: "查找图片", status: "not_found" },
      ] });
  });

  it.each([
    ["null root", null], ["array root", []], ["string root", "收到"], ["number root", 1],
    ["missing message", { results: [] }], ["null message", { message: null, results: [] }],
    ["number message", { message: 1, results: [] }], ["empty message", { message: "", results: [] }],
    ["whitespace message", { message: " \t\n　", results: [] }],
    ["missing results", { message: "正文" }], ["null results", { message: "正文", results: null }],
    ["object results", { message: "正文", results: {} }], ["string results", { message: "正文", results: "[]" }],
    ["extra root field", { message: "正文", results: [], accountId: "forged" }],
    ...([
      ["null item", null], ["array item", []], ["string item", "completed"],
      ["missing subject", { status: "completed" }], ["null subject", { subject: null, status: "completed" }],
      ["number subject", { subject: 1, status: "completed" }], ["empty subject", { subject: "", status: "completed" }],
      ["whitespace subject", { subject: "\n　", status: "completed" }],
      ["missing status", { subject: "目标" }], ["null status", { subject: "目标", status: null }],
      ["number status", { subject: "目标", status: 0 }], ["unknown enum", { subject: "目标", status: "success" }],
      ["wrong case enum", { subject: "目标", status: "Completed" }], ["padded enum", { subject: "目标", status: "unknown " }],
      ["extra item field", { subject: "目标", status: "completed", runId: "forged" }],
    ] satisfies Array<[string, unknown]>).map(([name, item]): [string, unknown] => [name, { message: "正文", results: [item] }]),
  ])("rejects %s without coercion, stripping fields or a fallback status", (_name, value) => {
    expect(() => parseMainReply(JSON.stringify(value))).toThrow("main_reply_invalid_schema");
  });

  it.each(["", "   ", "不是JSON", '```json\n{"message":"正文","results":[]}\n```', '{"message":"正文","results":[', '{"message":"正文","results":[]} trailing'])("reports malformed final output safely: %j", (raw) => {
      expect(() => parseMainReply(raw)).toThrow(new MainReplyProtocolError("main_reply_invalid_json"));
    });

  it.each([95999, 96000, 96001])("applies the %i-byte boundary to the complete envelope", (bytes) => {
    const raw = JSON.stringify({ message: "a", results: [{ subject: "x".repeat(bytes - 63), status: "not_found" }] });
    expect(Buffer.byteLength(raw)).toBe(bytes);
    if (bytes <= 96000) expect(parseMainReply(raw).message).toBe("a");
    else expect(() => parseMainReply(raw)).toThrow("main_reply_too_large");
  });

  it("counts UTF-8 bytes, not Chinese characters, and rejects overflow before JSON parsing", () => {
    const raw = JSON.stringify({ message: "a", results: [{ subject: "中".repeat(31979), status: "not_found" }] });
    expect(Buffer.byteLength(raw)).toBe(96000);
    expect(parseMainReply(raw).results[0]?.subject).toHaveLength(31979);
    expect(() => parseMainReply(`${raw} `)).toThrow("main_reply_too_large");
    expect(() => parseMainReply("!".repeat(96001))).toThrow("main_reply_too_large");
  });

  it.each(["main_reply_invalid_json", "main_reply_invalid_schema", "main_reply_too_large"])("retains only a safe failure code: %s", (code) => {
    expect(parseMainReplyFailure(code)).toBe(code);
  });

  it.each([null, {}, 1, "unknown", "main_reply_invalid_json /private/secret", "MAIN_REPLY_INVALID_JSON"])("rejects an unrecognized recorded failure code: %j", (value) => {
    expect(() => parseMainReplyFailure(value)).toThrow("main_reply_record_invalid");
  });

  it("keeps results from a maximum-size accepted reply valid for persistence", () => {
    const raw = JSON.stringify({ message: "a", results: [{ subject: "x".repeat(95937), status: "not_found" }] });
    expect(Buffer.byteLength(raw, "utf8")).toBe(96000);
    const reply = parseMainReply(raw);
    const saved = parseStoredMainBusinessResult({ version: 1, source: "main_model", inboundKey: "a".repeat(64), results: reply.results });
    expect(saved.results).toEqual([{ subject: "x".repeat(95937), status: "not_found" }]);
  });
});
