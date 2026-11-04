import { expect, it } from "vitest";
import { assertToolTraceParity } from "../e2e/otel-tool-parity.js";

// Shape from the first live run: one rejected read, three searches, one successful send.
const observations = [
  { toolId: "files.read", resultSuccess: true, errorCode: "local_file_reference_invalid" },
  { toolId: "files.find", resultSuccess: true },
  { toolId: "files.find", resultSuccess: true },
  { toolId: "files.find", resultSuccess: true },
  { toolId: "weixin.send_files", resultSuccess: true },
];
const spans = [
  { spanId: "a", traceId: "inbound", parentSpanId: "root", attributes: { toolId: "files.read", resultSuccess: true, errorCode: "local_file_reference_invalid", domainSuccess: false, status: "rejected" } },
  { spanId: "b", traceId: "inbound", parentSpanId: "root", attributes: { toolId: "files.find", resultSuccess: true, domainSuccess: true, status: "succeeded" } },
  { spanId: "c", traceId: "inbound", parentSpanId: "root", attributes: { toolId: "files.find", resultSuccess: true, domainSuccess: true, status: "succeeded" } },
  { spanId: "d", traceId: "inbound", parentSpanId: "root", attributes: { toolId: "files.find", resultSuccess: true, domainSuccess: true, status: "succeeded" } },
  { spanId: "e", traceId: "inbound", parentSpanId: "root", attributes: { toolId: "weixin.send_files", resultSuccess: true, domainSuccess: true, status: "succeeded" } },
];
const parent = { traceId: "inbound", spanId: "root" };

it("accepts every recorded call in a recovered five-call model route", () => {
  expect(() => assertToolTraceParity(spans, observations, parent)).not.toThrow();
});

it("rejects missing and additional persisted calls", () => {
  expect(() => assertToolTraceParity(spans.slice(1), observations, parent)).toThrow("exactly once");
  expect(() => assertToolTraceParity([...spans, spans[0]!], observations, parent)).toThrow("exactly once");
});

it("rejects a duplicated span replacing a different call at the same count", () => {
  expect(() => assertToolTraceParity([spans[0]!, spans[0]!, ...spans.slice(2)], observations, parent)).toThrow("unique");
});

it("rejects cross-inbound attribution and reordered distinct calls", () => {
  expect(() => assertToolTraceParity(spans, observations, { traceId: "other", spanId: "root" })).toThrow("trace");
  expect(() => assertToolTraceParity(spans, observations, { traceId: "inbound", spanId: "other" })).toThrow("parent");
  expect(() => assertToolTraceParity([...spans].reverse(), observations, parent)).toThrow("toolId mismatch");
});

it("rejects success masking a recovered failure and changed result metadata", () => {
  const masked = structuredClone(spans);
  masked[0]!.attributes.domainSuccess = true;
  expect(() => assertToolTraceParity(masked, observations, parent)).toThrow("domain result mismatch");
  expect(() => assertToolTraceParity(spans, [{ ...observations[0]!, resultBytes: 999 }, ...observations.slice(1)], parent)).toThrow("resultBytes mismatch");
});

it("rejects empty execution evidence rather than passing an empty loop", () => {
  expect(() => assertToolTraceParity([], [], parent)).toThrow("must not be empty");
});

it("rejects a redacted error code even when the failed status and call count match", () => {
  const redacted = structuredClone(spans);
  redacted[0]!.attributes.errorCode = "other";
  expect(() => assertToolTraceParity(redacted, observations, parent)).toThrow("errorCode mismatch");
});
