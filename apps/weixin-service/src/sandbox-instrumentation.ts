import crypto from "node:crypto";
import type { DiagnosticSpan, LocalDiagnostics } from "./local-diagnostics.js";

export type SandboxWorkerIdentity = { sandboxInstanceId: string; workerInstanceId: string; generation: number };

/** Observes the public process/IPC boundary, never filesystem algorithms or payload bodies. */
export class SandboxInstrumentation {
  private readonly sandboxInstanceId = crypto.randomUUID();
  private generation = 0;
  constructor(private readonly diagnostics: LocalDiagnostics | undefined, private readonly moduleId: string) {}

  worker(): SandboxWorkerInstrumentation {
    return new SandboxWorkerInstrumentation(this.diagnostics, this.moduleId, {
      sandboxInstanceId: this.sandboxInstanceId, workerInstanceId: crypto.randomUUID(), generation: ++this.generation,
    });
  }
}

export class SandboxWorkerInstrumentation {
  pid: number | undefined;
  private readonly requests = new Map<string, DiagnosticSpan>();
  private parent?: DiagnosticSpan;
  private invalidatedBy: DiagnosticSpan | undefined;
  private reason?: string;
  private triggerRequestId: string | undefined;
  private exited = false;
  private closing = false;
  constructor(private readonly diagnostics: LocalDiagnostics | undefined, private readonly moduleId: string,
    readonly identity: SandboxWorkerIdentity) {}

  private attributes(): Record<string, unknown> {
    return { ...this.identity, moduleId: this.moduleId, pid: this.pid, processRole: "file_sandbox", observerRole: "service" };
  }

  invalidate(reason: string, requestId?: string): void {
    if (this.reason) return;
    this.reason = reason;
    this.triggerRequestId = requestId;
    this.invalidatedBy = requestId ? this.requests.get(requestId) : undefined;
    this.record("sandbox.invalidate", { reason, triggerRequestId: requestId }, requestId);
  }

  timeout(requestId: string, deadlineMs: number): void {
    this.record("sandbox.timeout", { requestId, deadlineMs }, requestId);
    this.invalidate("file_sandbox_timeout", requestId);
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.reason ??= "file_sandbox_closed";
    this.record("sandbox.close", { reason: this.reason });
  }

  exit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.record("sandbox.exit", { exitCode, signal, reason: this.reason ?? "file_sandbox_exited", triggerRequestId: this.triggerRequestId });
  }

  private record(name: string, attributes: Record<string, unknown>, requestId?: string): void {
    try {
      const owner = (requestId ? this.requests.get(requestId) : undefined) ?? this.invalidatedBy ?? this.parent;
      const values = { ...this.attributes(), ...attributes };
      if (owner) owner.checkpoint(name, values);
      else this.diagnostics?.checkpoint(name, values);
    }
    catch { /* Observation never controls process recovery. */ }
  }

  async observe<T>(stage: "init" | "execute", requestId: string, operation: string, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const span = this.diagnostics?.startSpan(`sandbox.${stage}`, { ...this.attributes(), requestId, operation });
    if (span) {
      this.requests.set(requestId, span);
      this.parent ??= span;
    }
    let status = "succeeded", errorCode: string | undefined;
    try { return await action(); }
    catch (error) {
      status = "failed";
      errorCode = sandboxDiagnosticError(error);
      throw error;
    } finally {
      try { span?.end({ ...this.attributes(), status, errorCode, durationMs: performance.now() - started,
        ...(status === "failed" && this.reason ? { reason: this.reason, triggerRequestId: this.triggerRequestId,
          failureRole: this.triggerRequestId ? requestId === this.triggerRequestId ? "trigger" : "affected" : "process" } : {}),
      }); }
      catch { /* A diagnostic sink must not change the file result. */ }
      finally { this.requests.delete(requestId); }
    }
  }
}

// Preserve technical codes, without expanding collection to arbitrary exception bodies.
export function sandboxDiagnosticError(error: unknown): string {
  if (error instanceof Error && /^[a-zA-Z][a-zA-Z0-9_]*$/u.test(error.message)) return error.message;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return error instanceof Error ? error.name : "file_sandbox_operation_failed";
}
