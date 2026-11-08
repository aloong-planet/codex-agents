// Real Streamable HTTP MCP servers and OAuth authorization servers for the MCP Catalog tests (unit, HTTP and browser).
// The MCP side is the official server SDK, so the wire format does not come from our own client. Each case starts its
// own listeners on 127.0.0.1, because what they record is per case.
//
// - startAuthorizationServer: RFC 8414 metadata and a client_credentials token endpoint taking client_secret_basic.
//   With `dpop`, a token request must carry a valid DPoP proof (RFC 9449) and the token is bound to its key.
// - startHttpTestServer: one MCP endpoint at /mcp. It can require fixed headers, answer 403 echoing the header values
//   it received (so that they reach the client's error text), or require OAuth tokens from an authorization server,
//   presented as Bearer or, for DPoP-bound tokens, as DPoP with a fresh proof. Its protected-resource metadata names the
//   authorization server, or `advertiseIssuer` when a case needs it to name another one.
//
// Both record what reached them. Self-checks: mcp-http-test-server.test.ts.
import crypto from "node:crypto";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

type Handler = (request: Request) => Promise<Response>;

const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest();

async function listen(handler: Handler, port = 0): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? "GET", headers, ...(body ? { body } : {}) });
      const response = await handler(request).catch((error: unknown) => new Response(String(error), { status: 500 }));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

/** RFC 7638 thumbprint of an EC public key. */
function thumbprint(jwk: { crv?: string; kty?: string; x?: string; y?: string }): string {
  return b64url(sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}

/**
 * Verifies a DPoP proof (RFC 9449 §4.3) for ES256 keys: signature by the embedded key, `typ`, `htm`, `htu` without
 * query, `iat` within five minutes, a `jti` never seen before and, for a resource request, `ath`.
 * Returns the key's thumbprint, or the reason for refusing it.
 */
async function verifyProof(proof: string | null, expected: { htm: string; htu: string; accessToken?: string }, seen: Set<string>): Promise<{ jkt: string } | { refused: string }> {
  if (!proof) return { refused: "no DPoP proof" };
  const [head, body, signature] = proof.split(".");
  if (!head || !body || !signature) return { refused: "malformed proof" };
  const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { typ?: string; alg?: string; jwk?: JsonWebKey & { crv?: string; x?: string; y?: string } };
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { htm?: string; htu?: string; iat?: number; jti?: string; ath?: string };
  if (header.typ !== "dpop+jwt" || header.alg !== "ES256" || !header.jwk) return { refused: "unsupported proof header" };
  const key = await crypto.subtle.importKey("jwk", header.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signature, "base64url"), Buffer.from(`${head}.${body}`));
  if (!valid) return { refused: "bad proof signature" };
  const url = new URL(expected.htu);
  if (claims.htm !== expected.htm || claims.htu !== `${url.origin}${url.pathname}`) return { refused: "proof for another request" };
  if (typeof claims.iat !== "number" || Math.abs(Date.now() / 1000 - claims.iat) > 300) return { refused: "stale proof" };
  if (!claims.jti || seen.has(claims.jti)) return { refused: "replayed proof" };
  seen.add(claims.jti);
  if (expected.accessToken !== undefined && claims.ath !== b64url(sha256(expected.accessToken))) return { refused: "proof for another token" };
  return { jkt: thumbprint(header.jwk) };
}

export type TokenRequest = { clientId: string; clientSecret: string; scope: string | null; dpop: boolean; granted: boolean };
export type IssuedToken = { token: string; type: "Bearer" | "DPoP"; jkt?: string; scope: string | null };

export type AuthorizationServer = {
  issuer: string;
  /** Whether tokens are bound to a DPoP key. */
  dpop: boolean;
  /** Every request that reached it, as `METHOD path`. */
  requests: string[];
  tokenRequests: TokenRequest[];
  issued: IssuedToken[];
  /** DPoP proof identifiers already used, shared with the resource servers that accept its tokens. */
  seenProofs: Set<string>;
  close: () => Promise<void>;
};

export async function startAuthorizationServer(options: { clientId: string; clientSecret: string; dpop?: boolean }): Promise<AuthorizationServer> {
  const as: Omit<AuthorizationServer, "issuer" | "close"> = { dpop: options.dpop === true, requests: [], tokenRequests: [], issued: [], seenProofs: new Set() };
  let issuer = "";
  const { origin, close } = await listen(async (request) => {
    const url = new URL(request.url);
    as.requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer,
        // RFC 8414 lets a server that serves no authorization-endpoint grant omit this, but the client SDK's metadata
        // schema refuses a document without it (invalid_type at authorization_endpoint), so it is published.
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
        ...(options.dpop ? { dpop_signing_alg_values_supported: ["ES256"] } : {}),
      });
    }
    if (request.method === "POST" && url.pathname === "/token") {
      const [scheme, encoded] = (request.headers.get("authorization") ?? "").split(" ");
      const [clientId = "", clientSecret = ""] = scheme === "Basic" && encoded
        ? Buffer.from(encoded, "base64").toString("utf8").split(":").map((part) => decodeURIComponent(part))
        : [];
      const form = new URLSearchParams(await request.text());
      const scope = form.get("scope");
      const proof = request.headers.get("dpop");
      const record: TokenRequest = { clientId, clientSecret, scope, dpop: proof !== null, granted: false };
      as.tokenRequests.push(record);
      if (form.get("grant_type") !== "client_credentials") return json({ error: "unsupported_grant_type" }, 400);
      if (clientId !== options.clientId || clientSecret !== options.clientSecret) return json({ error: "invalid_client" }, 401);
      let jkt: string | undefined;
      if (options.dpop) {
        const checked = await verifyProof(proof, { htm: "POST", htu: `${issuer}/token` }, as.seenProofs);
        if ("refused" in checked) return json({ error: "invalid_dpop_proof", error_description: checked.refused }, 400);
        jkt = checked.jkt;
      }
      const token: IssuedToken = { token: crypto.randomBytes(24).toString("base64url"), type: jkt ? "DPoP" : "Bearer", ...(jkt ? { jkt } : {}), scope };
      as.issued.push(token);
      record.granted = true;
      return json({ access_token: token.token, token_type: token.type, expires_in: 3600, ...(scope ? { scope } : {}) }, 200, { "cache-control": "no-store" });
    }
    return new Response("not found", { status: 404 });
  });
  issuer = origin;
  return { ...as, issuer, close };
}

export type McpRequestRecord = {
  method: string;
  /** How the request was authorized: none, Bearer or DPoP; `refused` when the server turned it away. */
  scheme: "none" | "Bearer" | "DPoP" | "refused";
  token?: string;
  /** The values of the required (or echoed) headers as they arrived. */
  headers: Record<string, string | null>;
};

export type HttpTestServer = {
  url: string;
  origin: string;
  requests: McpRequestRecord[];
  /** Bodies of the 403 answers sent in `echoHeaders` mode. */
  forbiddenBodies: string[];
  close: () => Promise<void>;
};

export type HttpTestServerOptions = {
  /** Headers every MCP request must carry with exactly these values. */
  requireHeaders?: Record<string, string>;
  /** Answers every MCP request with 403 and a body naming these headers' received values. */
  echoHeaders?: string[];
  /** Tokens from this authorization server are required; DPoP-bound ones must be presented as DPoP. */
  authorizationServer?: AuthorizationServer;
  /** The issuer the protected-resource metadata names, when it must differ from `authorizationServer`. */
  advertiseIssuer?: string;
  /** Announce `tools.listChanged`, as a server that would notify on its GET stream (which this one does not offer). */
  listChanged?: boolean;
  /** Listen on this port, for a case that first finds the URL unreachable. */
  port?: number;
};

const TOOLS = [
  { name: "whoami", description: "Returns how this request was authorized.", inputSchema: { type: "object" as const, properties: {} } },
  { name: "lookup", description: "Finds an item.", inputSchema: { type: "object" as const, properties: { q: { type: "string" } } } },
];

export async function startHttpTestServer(options: HttpTestServerOptions = {}): Promise<HttpTestServer> {
  const record = { requests: [] as McpRequestRecord[], forbiddenBodies: [] as string[] };
  const as = options.authorizationServer;
  let origin = "";
  const resourceMetadata = () => `${origin}/.well-known/oauth-protected-resource/mcp`;

  /** Checks the request's credentials; returns the scheme and scope, or the refusal to send. */
  async function authorize(request: Request): Promise<{ scheme: McpRequestRecord["scheme"]; token?: string; scope?: string | null } | { refuse: Response; token?: string }> {
    for (const [name, value] of Object.entries(options.requireHeaders ?? {})) {
      if (request.headers.get(name) !== value) return { refuse: new Response("missing or wrong header", { status: 401 }) };
    }
    if (options.echoHeaders) {
      const body = `forbidden: ${options.echoHeaders.map((name) => `${name}=${request.headers.get(name)}`).join(", ")}`;
      record.forbiddenBodies.push(body);
      return { refuse: new Response(body, { status: 403 }) };
    }
    if (!as) return { scheme: "none" };
    const challenge = (error?: string) => new Response(JSON.stringify({ error: error ?? "invalid_token" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": `${as.dpop ? "DPoP" : "Bearer"} resource_metadata="${resourceMetadata()}"${error ? `, error="${error}"` : ""}` },
    });
    const [scheme, token] = (request.headers.get("authorization") ?? "").split(" ");
    const issued = as.issued.find((item) => item.token === token);
    if (!scheme || !token || !issued) return { refuse: challenge(), ...(token ? { token } : {}) };
    if (issued.type === "DPoP") {
      if (scheme !== "DPoP") return { refuse: challenge("invalid_token"), token };
      const checked = await verifyProof(request.headers.get("dpop"), { htm: request.method, htu: request.url, accessToken: token }, as.seenProofs);
      if ("refused" in checked || checked.jkt !== issued.jkt) return { refuse: challenge("invalid_dpop_proof"), token };
      return { scheme: "DPoP", token, scope: issued.scope };
    }
    if (scheme !== "Bearer") return { refuse: challenge(), token };
    return { scheme: "Bearer", token, scope: issued.scope };
  }

  const { origin: listening, close } = await listen(async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      if (!as) return new Response("not found", { status: 404 });
      return json({ resource: `${origin}/mcp`, authorization_servers: [options.advertiseIssuer ?? as.issuer], bearer_methods_supported: ["header"] });
    }
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    const headerNames = [...Object.keys(options.requireHeaders ?? {}), ...(options.echoHeaders ?? [])];
    const headers = Object.fromEntries(headerNames.map((name) => [name, request.headers.get(name)]));
    const checked = await authorize(request);
    if ("refuse" in checked) {
      record.requests.push({ method: request.method, scheme: "refused", ...(checked.token ? { token: checked.token } : {}), headers });
      return checked.refuse;
    }
    record.requests.push({ method: request.method, scheme: checked.scheme, ...(checked.token ? { token: checked.token } : {}), headers });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405, headers: { allow: "POST" } });
    // Stateless: a server and a transport per request, as the SDK documents for Streamable HTTP without sessions.
    const server = new Server({ name: "catalog-http-test-server", version: "2.0.1" }, { capabilities: { tools: options.listChanged ? { listChanged: true } : {} } });
    server.setRequestHandler("tools/list", async () => ({ tools: TOOLS }));
    server.setRequestHandler("tools/call", async (call) => {
      const text = call.params.name === "whoami"
        ? JSON.stringify({ scheme: checked.scheme, scope: checked.scope ?? null, headers: Object.keys(options.requireHeaders ?? {}) })
        : `called ${call.params.name}`;
      return { content: [{ type: "text", text }] };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  }, options.port);
  origin = listening;
  return { url: `${origin}/mcp`, origin, ...record, close };
}

/** A loopback port that nothing listens on (it was free a moment ago), for a URL that is unreachable at first. */
export async function freePort(): Promise<number> {
  const probe = await listen(async () => new Response(""));
  const port = Number(new URL(probe.origin).port);
  await probe.close();
  return port;
}
