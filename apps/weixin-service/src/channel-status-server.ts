import { createServer } from "node:http";

import { ConsoleAccess } from "./console-access.js";
import type { ConsoleRoutes } from "./console-routes.js";

/** Read-only local status; the fixture ingress exists only when explicitly supplied by the host. */
export function createChannelStatusServer(
  state: () => unknown,
  fixture?: { emit(input: unknown): Promise<void> },
  access: ConsoleAccess = new ConsoleAccess(),
  consoleRoutes?: ConsoleRoutes,
) {
  return createServer(access.guard(async (request, response, context) => {
    if (await consoleRoutes?.handle(request, response, context)) return;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) { response.writeHead(403); response.end('{"error":"forbidden"}'); return; }
    // The console's home is the team overview; a login link lands on "/" (agent-console Implementation Decisions: console home).
    if (request.method === "GET" && request.url === "/") { response.writeHead(302, { location: "/console" }); response.end(); return; }
    if (request.method === "GET" && request.url === "/api/state") {
      response.end(JSON.stringify(state())); return;
    }
    if (fixture && request.method === "POST" && request.url === "/api/fixture/inbound") {
      if (request.headers.origin !== `http://${host}` || !request.headers["content-type"]?.startsWith("application/json")) {
        response.writeHead(403); response.end('{"error":"forbidden"}'); return;
      }
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += data.length;
          if (size > 128 * 1024) throw new Error("body_too_large");
          chunks.push(data);
        }
        await fixture.emit(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.end('{"accepted":true,"simulated":true}');
      } catch { response.writeHead(400); response.end('{"error":"fixture_request_invalid"}'); }
      return;
    }
    response.writeHead(404); response.end('{"error":"not_found"}');
  }, { fixtureMode: fixture !== undefined }));
}
