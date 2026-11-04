import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { ROOT_CONTEXT, SpanStatusCode, trace, context, propagation, createContextKey, type Span, type SpanContext, type Attributes } from "@opentelemetry/api";
import { AlwaysOnSampler, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { DiagnosticFiles } from "./diagnostic-files.js";
import type { WorkflowToolTraceEvent } from "./workflow-tool-host.js";
import type { CodexServiceState } from "./codex-service-store.js";
import { RuntimeMetrics } from "./runtime-metrics.js";

const REFERENCE_CONTEXT = createContextKey("weixin.diagnostics.references");
const OWNER_CONTEXT = createContextKey("weixin.diagnostics.owner");
const REFERENCE_FIELDS = new Set(["accountRef", "targetRef", "inboundRef", "runRef", "effectRef", "itemOrdinal", "itemTotal"]);
export type DiagnosticSpan = {
  context: SpanContext;
  checkpoint(name: string, attributes: Record<string, unknown>): void;
  end(attributes: Record<string, unknown>): void;
};
let networkOwner: string | undefined;
let sharedHttpInstrumentation: HttpInstrumentation | undefined;
function isNetwork(scope: string): boolean { return scope === "@opentelemetry/instrumentation-http" || scope === "@opentelemetry/instrumentation-undici"; }
function observedHost(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "weixin.qq.com" || host.endsWith(".weixin.qq.com"); }
/** Local diagnostic records, NOT standard OTLP JSON. Attributes are not redacted. */
export class LocalDiagnostics {
  private readonly storage = new AsyncLocalStorage<Span>();
  private readonly instanceId = crypto.randomUUID();
  private sequence = 0;
  private readonly provider: NodeTracerProvider;
  private readonly instrumentations: Array<UndiciInstrumentation | HttpInstrumentation> = [];
  private readonly runtimeContexts = new Map<string, { parent: Span; stages: Map<string, Span | null>; lastProgressAt?: number }>();
  private closed = false;
  private metrics?: RuntimeMetrics;

  constructor(readonly files: DiagnosticFiles) {
    this.provider = new NodeTracerProvider({
      sampler: new AlwaysOnSampler(),
      spanLimits: { attributeCountLimit: 64, eventCountLimit: 0, linkCountLimit: 8 },
      spanProcessors: [{
        onStart: (span, parent) => {
          if (!span.instrumentationScope.name.startsWith("@opentelemetry/instrumentation-")) return;
          const refs = parent.getValue(REFERENCE_CONTEXT);
          if (refs && typeof refs === "object") span.setAttributes(diagnosticAttributes(refs as Record<string, unknown>));
          if (isNetwork(span.instrumentationScope.name)) this.checkpoint("http.client.start", refs && typeof refs === "object" ? refs as Record<string, unknown> : {}, span.spanContext());
        },
        onEnd: () => {}, shutdown: async () => {}, forceFlush: async () => {},
      }, new SimpleSpanProcessor({
        export: (spans, callback) => {
          try { for (const span of spans) this.exportSpan(span); } catch { /* Diagnostics never affect execution. */ }
          callback({ code: 0 });
        },
        shutdown: async () => { await files.flush(); },
      })],
    });
    try { if (!networkOwner) {
      networkOwner = this.instanceId;
      this.provider.register({
        contextManager: new AsyncLocalStorageContextManager(),
        propagator: { inject: () => {}, extract: (ctx) => ctx, fields: () => [] },
      });
      const undici = new UndiciInstrumentation({
        enabled: false, requireParentforSpans: true,
        ignoreRequestHook: (request) => context.active().getValue(OWNER_CONTEXT) !== this.instanceId || !observedHost(new URL(request.origin).hostname),
        requestHook: (span, request) => span.setAttribute("method", request.method),
        responseHook: (span, { response }) => span.setAttribute("httpStatus", response.statusCode),
      });
      const httpConfig: ConstructorParameters<typeof HttpInstrumentation>[0] = {
        enabled: false, disableIncomingRequestInstrumentation: true, requireParentforOutgoingSpans: true,
        ignoreOutgoingRequestHook: (request) => context.active().getValue(OWNER_CONTEXT) !== this.instanceId || !observedHost(String(request.hostname ?? request.host ?? "").split(":")[0]!),
        responseHook: (span, response) => { if (response.statusCode) span.setAttribute("httpStatus", response.statusCode); },
      };
      // The SDK retains require hooks across disable; reuse their cached module exports on re-enable.
      const http = sharedHttpInstrumentation ??= new HttpInstrumentation(httpConfig);
      http.setConfig(httpConfig);
      undici.setTracerProvider(this.provider);
      http.setTracerProvider(this.provider);
      this.instrumentations.push(undici, http);
      undici.setConfig({ ...undici.getConfig(), enabled: true });
      http.setConfig({ ...http.getConfig(), enabled: true });
      undici.enable();
      http.enable();
      const require = createRequire(import.meta.url);
      require("node:http");
      require("node:https");
      syncBuiltinESMExports();
    } } catch {
      this.stopNetwork();
      this.checkpoint("service.lifecycle", { status: "unavailable", errorCode: "operation_failed" });
    }
    try {
      this.metrics = new RuntimeMetrics((name, attributes) => {
        this.files.append("metrics", {
          version: 2, kind: "metric", instanceId: this.instanceId, sequence: ++this.sequence,
          recordedAt: Date.now(), name,
          attributes: diagnosticAttributes({ ...attributes, processRole: "service", pid: process.pid }), health: files.stats(),
        }, "background");
      });
    } catch { this.checkpoint("runtime.metrics.unavailable", { status: "unavailable" }); }
  }

  current(): SpanContext | undefined { return this.storage.getStore()?.spanContext(); }

  /** Event-driven boundaries need an explicit handle; never change the caller's active context. */
  startSpan(name: string, attributes: Record<string, unknown>, parent = this.current()): DiagnosticSpan | undefined {
    if (this.closed) return;
    try {
      const inherited = context.active().getValue(REFERENCE_CONTEXT);
      const refs = { ...(inherited && typeof inherited === "object" ? Object.fromEntries(Object.entries(inherited).filter(([key]) => REFERENCE_FIELDS.has(key))) : {}), ...diagnosticAttributes(attributes) };
      const span = this.provider.getTracer("codex-weixin", "1").startSpan(name, { attributes: refs },
        parent ? trace.setSpanContext(ROOT_CONTEXT, parent) : ROOT_CONTEXT);
      const spanContext = span.spanContext();
      this.checkpoint(`${name}.start`, refs, spanContext);
      let ended = false;
      return { context: spanContext,
        checkpoint: (event, values) => this.checkpoint(event, { ...refs, ...values }, spanContext),
        end: (result) => {
        if (ended) return;
        ended = true;
        try {
          span.setAttributes(diagnosticAttributes(result));
          if (result.status === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
          this.checkpoint(`${name}.end`, { ...refs, ...result }, spanContext);
        } finally { span.end(); }
      } };
    } catch { return; } // Instrumentation setup is not an operation failure.
  }

  references(values: { accountId?: string; target?: string; eventKey?: string; runId?: string; effectId?: string }): Attributes {
    const output: Attributes = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== "string") continue;
      const field = ({ accountId: "accountRef", target: "targetRef", eventKey: "inboundRef", runId: "runRef", effectId: "effectRef" } as Record<string, string>)[key];
      if (field) output[field] = value;
    }
    return output;
  }

  async run<T>(name: string, attributes: Record<string, unknown>, action: () => Promise<T>, parent?: SpanContext): Promise<T> {
    if (this.closed) return action();
    const parentSpan = parent ?? this.current();
    const inherited = context.active().getValue(REFERENCE_CONTEXT);
    const refs = { ...(inherited && typeof inherited === "object" ? Object.fromEntries(Object.entries(inherited).filter(([key]) => REFERENCE_FIELDS.has(key))) : {}), ...diagnosticAttributes(attributes) };
    const span = this.provider.getTracer("codex-weixin", "1").startSpan(name, { attributes: refs },
      parentSpan ? trace.setSpanContext(context.active(), parentSpan) : ROOT_CONTEXT);
    return context.with(trace.setSpan(context.active(), span).setValue(REFERENCE_CONTEXT, refs).setValue(OWNER_CONTEXT, this.instanceId), () => this.storage.run(span, async () => {
      this.checkpoint(`${name}.start`, refs);
      try { return await action(); }
      catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); this.checkpoint(`${name}.end`, { status: "failed", errorCode: "operation_failed" }); throw error; }
      finally {
        span.end();
        for (const [id, runtime] of this.runtimeContexts) {
          if (runtime.parent !== span) continue;
          for (const child of runtime.stages.values()) if (child) { child.setAttribute("status", "unknown"); child.end(); }
          this.runtimeContexts.delete(id);
        }
      }
    }));
  }

  checkpoint(name: string, attributes: Record<string, unknown> = {}, parent?: SpanContext): void {
    if (this.closed) return;
    try {
      const context = parent ?? this.current();
      this.files.append("checkpoints", {
        version: 2, kind: "checkpoint", instanceId: this.instanceId, sequence: ++this.sequence,
        recordedAt: Date.now(), name,
        traceId: context?.traceId, spanId: context?.spanId, attributes: diagnosticAttributes(attributes), health: this.files.stats(),
      });
    } catch { /* Never surface telemetry failure in a user operation. */ }
  }

  result(attributes: Record<string, unknown>): void {
    try {
    this.storage.getStore()?.setAttributes(diagnosticAttributes(attributes));
    const refs = context.active().getValue(REFERENCE_CONTEXT);
    if (refs && typeof refs === "object") Object.assign(refs, diagnosticAttributes(Object.fromEntries(Object.entries(attributes).filter(([key]) => ["runRef", "effectRef", "itemOrdinal", "itemTotal"].includes(key)))));
    if (["failed", "rejected", "unknown", "outcome_unknown", "interrupted", "blocked"].includes(String(attributes.status))) this.storage.getStore()?.setStatus({ code: SpanStatusCode.ERROR });
    } catch { /* Diagnostics cannot replace a channel outcome. */ }
  }

  toolResult(event: WorkflowToolTraceEvent): void {
    const attributes: Record<string, unknown> = {
      toolId: event.toolId, toolVersion: event.toolVersion, executionClass: event.executionClass,
      waitMs: event.waitMs, durationMs: event.durationMs, resultBytes: event.resultBytes,
      resultSuccess: event.resultSuccess, domainSuccess: event.resultSuccess && !event.errorCode,
      errorCode: event.errorCode, ownerBefore: event.ownerBefore, ownerAfter: event.ownerAfter,
      runRef: event.runRef,
      ...event.resultSummary, unknownKeyCount: event.argumentSummary.unknownKeyCount,
    };
    for (const [key, value] of Object.entries(event.argumentSummary.queryOptions ?? {})) {
      if (key === "sort" && value && typeof value === "object") { attributes.sortField = value.field; attributes.sortDirection = value.direction; }
      else attributes[key] = value;
    }
    for (const key of ["query", "pattern", "cursor"]) attributes[`${key}Length`] = event.argumentSummary.stringLengths?.[key];
    for (const key of ["scopeRefs", "include", "exclude"]) attributes[`${key}Count`] = event.argumentSummary.arrayLengths?.[key];
    attributes.queryInputs = event.argumentSummary.queryInputs;
    this.storage.getStore()?.setAttributes(diagnosticAttributes(attributes));
    if (!event.resultSuccess || event.errorCode) this.storage.getStore()?.setStatus({ code: SpanStatusCode.ERROR });
    this.checkpoint("tool.result", attributes);
  }

  runtime(run: CodexServiceState["runtimeRuns"][number]): void {
    try {
      const parent = this.runtimeContexts.get(run.runId)?.parent ?? this.storage.getStore();
      if (!parent || this.closed) return;
      let context = this.runtimeContexts.get(run.runId);
      if (!context) { context = { parent, stages: new Map() }; this.runtimeContexts.set(run.runId, context); }
      parent.setAttribute("status", run.phase);
      parent.setAttributes(this.references({ runId: run.runId }));
      if (["failed", "interrupted"].includes(run.phase)) parent.setStatus({ code: SpanStatusCode.ERROR });
      for (const [group, timings] of [["runtime", run.timings], ["agent", run.agentTimings]] as const) {
        for (const timing of timings) {
          const id = `${group}:${timing.stage}:${timing.startedAt}:${"correlationHash" in timing ? timing.correlationHash ?? "" : ""}`;
          if (context.stages.get(id) === null) continue;
          let span = context.stages.get(id);
          if (!span) {
            if (context.stages.size >= 128) continue;
            span = this.provider.getTracer("codex-weixin", "1").startSpan("runtime.stage", { startTime: timing.startedAt, attributes: diagnosticAttributes({ stage: timing.stage }) }, trace.setSpan(ROOT_CONTEXT, parent));
            context.stages.set(id, span);
            this.checkpoint("runtime.stage.start", { stage: timing.stage }, span.spanContext());
          }
          if (timing.completedAt !== undefined) {
            span.setAttributes(diagnosticAttributes({ status: timing.outcome }));
            if (timing.outcome === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
            span.end(timing.completedAt);
            context.stages.set(id, null);
          }
        }
      }
      this.checkpoint("runtime.stage", { status: run.phase }, parent.spanContext());
    } catch { /* Existing durable runtime remains authoritative. */ }
  }

  progress(runId: string, activity: "protocol_progress" | "agent_message_delta"): void {
    const runtime = this.runtimeContexts.get(runId);
    if (!runtime || this.closed) return;
    const now = Date.now();
    if (runtime.lastProgressAt !== undefined && now - runtime.lastProgressAt < 1000) return;
    runtime.lastProgressAt = now;
    this.checkpoint("runtime.stage", { activity, status: "running" }, runtime.parent.spanContext());
  }

  async close() {
    if (this.closed) return;
    this.checkpoint("service.lifecycle", { status: "stopping" });
    this.closed = true;
    await this.metrics?.close();
    this.stopNetwork();
    await this.provider.forceFlush().catch(() => {});
    await this.provider.shutdown().catch(() => {});
    await this.files.close();
  }

  private stopNetwork(): void {
    for (const instrumentation of this.instrumentations) { try { instrumentation.disable(); } catch { /* Partial SDK initialization must not prevent cleanup. */ } }
    try { syncBuiltinESMExports(); } catch { /* No business effect. */ }
    if (networkOwner === this.instanceId) { networkOwner = undefined; trace.disable(); context.disable(); propagation.disable(); }
  }

  private exportSpan(span: ReadableSpan) {
    const network = isNetwork(span.instrumentationScope.name);
    this.files.append("traces", {
      version: 2, kind: "span", instanceId: this.instanceId, sequence: ++this.sequence, recordedAt: Date.now(),
      name: network ? "http.client" : span.name, traceId: span.spanContext().traceId, spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      startTimeUnixMs: span.startTime[0] * 1000 + span.startTime[1] / 1e6,
      endTimeUnixMs: span.endTime[0] * 1000 + span.endTime[1] / 1e6,
      status: span.status.code, attributes: diagnosticAttributes(span.attributes), health: this.files.stats(),
    });
  }
}

/** Adapt values to OTel attribute types without field/value allowlists or semantic rewriting. */
export function diagnosticAttributes(values: Record<string, unknown>): Attributes {
  return Object.fromEntries(Object.entries(values).flatMap<[string, Attributes[string]]>(([key, value]) => {
    if (value === undefined) return [];
    if (typeof value === "string" || typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))) return [[key, value]];
    if (Array.isArray(value) && value.every((item) => typeof item === typeof value[0] &&
        (typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))))) return [[key, [...value]]];
    try {
      const encoded = JSON.stringify(value);
      return encoded === undefined ? [] : [[key, encoded]];
    } catch { return []; } // Non-serializable diagnostics must not break the business operation.
  }));
}
