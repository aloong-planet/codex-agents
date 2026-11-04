import assert from "node:assert/strict";

type ToolObservation = { toolId: string; resultSuccess: boolean; errorCode?: string; [key: string]: unknown };
type ToolSpan = { spanId?: string; traceId?: string; parentSpanId?: string; attributes: Record<string, unknown> };

// Compare independent ToolHost events with the persisted OTel export, not a planned model route.
export function assertToolTraceParity(spans: ToolSpan[], observations: ToolObservation[], parent: { traceId: string; spanId: string }): void {
  assert.ok(observations.length > 0, "tool execution evidence must not be empty");
  assert.equal(spans.length, observations.length, "OTel must record every executed tool exactly once");
  assert.equal(new Set(spans.map((span) => span.spanId)).size, spans.length, "tool span IDs must be unique");
  spans.forEach((span, index) => {
    const event = observations[index]!;
    assert.equal(span.traceId, parent.traceId, "tool trace must belong to this inbound");
    assert.equal(span.parentSpanId, parent.spanId, "tool parent must be this inbound");
    for (const field of ["toolId", "toolVersion", "resultSuccess", "errorCode", "resultBytes", "durationMs", "waitMs", "ownerBefore", "ownerAfter"]) {
      assert.equal(span.attributes[field], event[field], `tool ${index + 1}: ${field} mismatch`);
    }
    const succeeded = event.resultSuccess && !event.errorCode;
    assert.equal(span.attributes.domainSuccess, succeeded, `tool ${index + 1}: domain result mismatch`);
    assert.equal(span.attributes.status, succeeded ? "succeeded" : "rejected", `tool ${index + 1}: status mismatch`);
  });
}
