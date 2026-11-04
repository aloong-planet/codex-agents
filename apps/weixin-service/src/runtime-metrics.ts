import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { AggregationTemporality, DataPointType, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

/** Official runtime collection. The callback is a local, bounded sink, never OTLP/network. */
export class RuntimeMetrics {
  private readonly provider: MeterProvider;
  private readonly instrumentation: RuntimeNodeInstrumentation;
  private closing?: Promise<void>;

  constructor(emit: (name: string, attributes: Record<string, unknown>) => void, intervalMs = 30_000) {
    const reader = new PeriodicExportingMetricReader({
      exportIntervalMillis: intervalMs, exportTimeoutMillis: Math.min(intervalMs, 500),
      cardinalityLimits: { default: 128 },
      exporter: {
        export: (data, callback) => {
          try {
            for (const scope of data.scopeMetrics) for (const metric of scope.metrics) {
              // Unsampled event-loop delay can contain NaN. Omit it, not a fabricated zero/null.
              const dataPoints = metric.dataPoints.filter((point) => {
                try { JSON.stringify(point, (_key, value) => { if (typeof value === "number" && !Number.isFinite(value)) throw new Error("unsampled"); return value; }); return true; }
                catch { return false; }
              });
              if (!dataPoints.length) continue;
              emit(metric.descriptor.name, {
                instrumentation: scope.scope.name, unit: metric.descriptor.unit,
                dataPointType: DataPointType[metric.dataPointType],
                aggregationTemporality: AggregationTemporality[metric.aggregationTemporality],
                ...("isMonotonic" in metric ? { isMonotonic: metric.isMonotonic } : {}),
                dataPoints: JSON.stringify(dataPoints),
              });
            }
          } catch { /* Metrics cannot fail a business operation. */ }
          callback({ code: 0 });
        },
        forceFlush: async () => {}, shutdown: async () => {},
      },
    });
    this.provider = new MeterProvider({ readers: [reader] });
    this.instrumentation = new RuntimeNodeInstrumentation({ enabled: false, captureUncaughtException: false });
    this.instrumentation.setMeterProvider(this.provider);
    this.instrumentation.enable();
  }

  close(): Promise<void> {
    // Reader shutdown collects once more while the collectors are still enabled.
    return this.closing ??= this.provider.shutdown().catch(() => {}).finally(() => this.instrumentation.disable());
  }
}
