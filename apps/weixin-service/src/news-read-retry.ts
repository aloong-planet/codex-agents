import { setTimeout as delay } from "node:timers/promises";
import { newsSourceError } from "./news-source.js";

export class NewsHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null, message: string) { super(message); }
}

/** Only idempotent public reads retry. Models, storage and delivery never use this policy. */
export async function retryNewsRead<T>(read: () => Promise<T>, signal?: AbortSignal, observe?: (event: string, attributes: Record<string, unknown>) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { const result = await read(); signal?.throwIfAborted(); return result; }
    catch (error) {
      signal?.throwIfAborted();
      const retryable = error instanceof NewsHttpError ? [408, 429, 500, 502, 503, 504].includes(error.status)
        : ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED", "source_deadline"].includes(newsSourceError(error));
      if (!retryable || attempt >= 2) throw error;
      const retryAfter = error instanceof NewsHttpError && error.retryAfter
        ? /^\d+(?:\.\d+)?$/.test(error.retryAfter) ? Number(error.retryAfter) * 1000 : Date.parse(error.retryAfter) - Date.now() : 0;
      const backoff = Math.min(2000, Math.max(250 * 3 ** attempt + Math.floor(Math.random() * 100), Number.isFinite(retryAfter) ? retryAfter : 0));
      observe?.("request.retry", { attempt: attempt + 2, code: error instanceof NewsHttpError ? `HTTP_${error.status}` : newsSourceError(error), delayMs: backoff });
      await delay(backoff, undefined, signal ? { signal } : undefined);
    }
  }
}
