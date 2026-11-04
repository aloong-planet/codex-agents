/** Only explicit transport/stream failures may enter automatic recovery. */
export class ModelConnectionError extends Error {
  constructor(cause: Error, readonly kind: "transport" | "stream" = "transport") { super(cause.message, { cause }); this.name = "ModelConnectionError"; }
}
export class ModelProtocolError extends Error {}

export function modelTurnError(value: unknown, fallback: string): Error {
  const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const message = typeof error.message === "string" ? error.message : fallback;
  const info = error.codexErrorInfo;
  if (info && typeof info === "object") {
    const record = info as Record<string, unknown>;
    for (const kind of ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected"]) {
      if (!Object.hasOwn(record, kind)) continue;
      const detail = record[kind] as { httpStatusCode?: unknown } | null;
      const status = detail?.httpStatusCode;
      if (status === undefined || status === null || (typeof status === "number" && status >= 500)) {
        return new ModelConnectionError(new Error(message), "stream");
      }
    }
  }
  return new Error(message);
}

export class ModelRecoveryBudget {
  private attempts = 0;
  readonly deadline = Date.now() + 60_000;
  remaining(): number { return Math.max(0, this.deadline - Date.now()); }
  claim(): number {
    if (this.attempts >= 3 || this.remaining() <= 0) throw new Error("model_recovery_exhausted");
    return ++this.attempts;
  }
}
