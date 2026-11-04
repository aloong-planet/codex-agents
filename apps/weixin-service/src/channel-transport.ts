import type { LocalDiagnostics } from "./local-diagnostics.js";

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;
type ErrorCategory = "network" | "timeout" | "cancelled" | "http" | "provider" | "invalid_json" | "receipt_missing" | "unexpected";
class ChannelProtocolError extends Error {
  constructor(message: string, readonly category: ErrorCategory) { super(message); }
}
function errorFacts(error: unknown, signal?: AbortSignal): Record<string, unknown> {
  try {
  if (error instanceof ChannelProtocolError) return { errorCategory: error.category };
  const value = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } : {};
  if (signal?.aborted) return { errorCategory: signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled" };
  const code = value.cause?.code ?? value.code;
  if (typeof code === "string") return { errorCategory: "network", networkCode: code };
  return { errorCategory: value.name === "TypeError" ? "network" : "unexpected", networkCode: "unclassified" };
  } catch { return { errorCategory: "unexpected", networkCode: "unclassified" }; }
}
function endpointName(url: string | URL): string {
  const name = new URL(url).pathname.split("/").at(-1);
  return ({ getuploadurl: "upload_url", sendmessage: "message_submit", getupdates: "get_updates", getconfig: "get_config", sendtyping: "typing" } as Record<string, string>)[name ?? ""] ?? new URL(url).pathname;
}

/** Shared protocol seam: consumes responses once and preserves business results while observing safe classifications. */
export class ChannelTransport {
  constructor(private readonly fetcher: FetchLike, private readonly diagnostics?: LocalDiagnostics) {}
  json(url: string | URL, init?: RequestInit): Promise<Record<string, unknown>> {
    return this.observe(endpointName(url), init?.signal ?? undefined, async () => {
      const response = await this.fetcher(url, init);
      this.diagnostics?.result({ httpStatus: response.status });
      const body = await readChannelJson(response);
      const code = typeof body.ret === "number" && body.ret !== 0 ? body.ret : body.errcode;
      if (typeof code === "number" && code !== 0) this.diagnostics?.result({ status: "rejected", errorCategory: "provider", providerCode: code });
      return body;
    });
  }
  upload(url: URL, init: RequestInit): Promise<string> {
    return this.observe("media_upload", init.signal ?? undefined, async () => {
      const response = await this.fetcher(url, init);
      this.diagnostics?.result({ httpStatus: response.status });
      if (!response.ok) throw new ChannelProtocolError("微信媒体 CDN 上传失败", "http");
      const receipt = response.headers.get("x-encrypted-param");
      if (!receipt) throw new ChannelProtocolError("微信媒体 CDN 上传回执无效", "receipt_missing");
      return receipt;
    });
  }
  private observe<T>(endpoint: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    if (!this.diagnostics) return action();
    return this.diagnostics.run("channel.request", { endpoint }, async () => {
      try { return await action(); }
      catch (error) { this.diagnostics?.result({ status: "failed", ...errorFacts(error, signal) }); throw error; }
    });
  }
}

export async function readChannelJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw new ChannelProtocolError("腾讯 iLink 请求失败", "http");
  const text = await response.text();
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ChannelProtocolError("腾讯 iLink 返回格式无效", "invalid_json"); }
}
