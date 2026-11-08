import { requestConsoleControl } from "../src/console-control.js";

/**
 * Shared login helpers for whole-app tests. They use the owner's real path: a login link from the running
 * service's control channel, exchanged over HTTP for the console cookie.
 */

/** Opens a login link like a browser would and returns the cookie as a `name=value` header value. */
export async function exchangeLoginLink(link: string, userAgent?: string): Promise<string> {
  const response = await fetch(link, { redirect: "manual", headers: userAgent ? { "user-agent": userAgent } : {} });
  if (response.status !== 302) throw new Error(`login link exchange failed: HTTP ${response.status}`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (!/^codex_console_\d+=[0-9a-f]{64}$/.test(cookie)) throw new Error("login link exchange returned no console cookie");
  return cookie;
}

/** Authorizes a test client against the service that owns this state directory. */
export async function authorizeLocalService(stateDirectory: string): Promise<string> {
  const { url } = await requestConsoleControl(stateDirectory, { command: "login-link" });
  if (typeof url !== "string") throw new Error("control channel returned no login link");
  return exchangeLoginLink(url);
}
