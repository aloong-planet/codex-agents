// Self-checks of the HTTP MCP test server: it must refuse what a real server refuses, or the catalog's URL-server cases
// (tests/mcp-catalog.test.ts) could pass against a server that accepts anything. Proofs are built with the client
// SDK's DpopSession, independent of the server's verifier.
import { DpopSession } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { startAuthorizationServer, startHttpTestServer, startRecordingServer, type AuthorizationServer } from "./mcp-http-test-server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function authorizationServer(dpop: boolean): Promise<AuthorizationServer> {
  const as = await startAuthorizationServer({ clientId: "client", clientSecret: "right-secret", dpop });
  cleanup.push(as.close);
  return as;
}

async function token(as: AuthorizationServer, secret: string, proof?: string) {
  const response = await fetch(`${as.issuer}/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`client:${secret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", ...(proof ? { dpop: proof } : {}) },
    body: "grant_type=client_credentials",
  });
  return { status: response.status, body: await response.json() as { access_token?: string; token_type?: string; error?: string } };
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
const post = (url: string, headers: Record<string, string>) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: initialize });

describe("the HTTP MCP test server", () => {
  it("refuses a missing or wrong required header", async () => {
    const server = await startHttpTestServer({ requireHeaders: { "X-Api-Key": "right" } });
    cleanup.push(server.close);

    expect((await post(server.url, {})).status).toBe(401);
    expect((await post(server.url, { "x-api-key": "wrong" })).status).toBe(401);
    expect((await post(server.url, { "x-api-key": "right" })).status).toBe(200);
  });

  it("issues no token for a wrong client secret", async () => {
    const as = await authorizationServer(false);

    expect(await token(as, "wrong-secret")).toMatchObject({ status: 401, body: { error: "invalid_client" } });
    expect(as.issued).toEqual([]);
    expect(await token(as, "right-secret")).toMatchObject({ status: 200, body: { token_type: "Bearer" } });
  });

  it("refuses a DPoP-bound token presented as Bearer, by another key, for another URL or with a reused proof", async () => {
    const as = await authorizationServer(true);
    const server = await startHttpTestServer({ authorizationServer: as });
    cleanup.push(server.close);
    const session = await DpopSession.create();
    const other = await DpopSession.create();

    expect(await token(as, "right-secret")).toMatchObject({ status: 400, body: { error: "invalid_dpop_proof" } });
    const granted = await token(as, "right-secret", await session.buildProof({ htm: "POST", htu: `${as.issuer}/token` }));
    expect(granted).toMatchObject({ status: 200, body: { token_type: "DPoP" } });
    const accessToken = granted.body.access_token!;
    const proof = (signer: DpopSession, htu = server.url) => signer.buildProof({ htm: "POST", htu, accessToken });

    expect((await post(server.url, { authorization: `Bearer ${accessToken}` })).status).toBe(401);
    expect((await post(server.url, { authorization: `DPoP ${accessToken}`, dpop: await proof(other) })).status).toBe(401);
    expect((await post(server.url, { authorization: `DPoP ${accessToken}`, dpop: await proof(session, `${server.origin}/elsewhere`) })).status).toBe(401);
    const once = await proof(session);
    expect((await post(server.url, { authorization: `DPoP ${accessToken}`, dpop: once })).status).toBe(200);
    expect((await post(server.url, { authorization: `DPoP ${accessToken}`, dpop: once })).status).toBe(401);
  });

  it("redirects the requests its rule matches, and the recording origin records the header names that arrive", async () => {
    const second = await startRecordingServer();
    cleanup.push(second.close);
    const server = await startHttpTestServer({ redirect: (request) => (request.rpc === "initialize" ? { status: 307, location: `${second.origin}/mcp` } : undefined) });
    cleanup.push(server.close);

    // Node's fetch follows the redirect to any origin, keeping custom headers (the catalog's transport must not).
    expect((await post(server.url, { "x-api-key": "value" })).status).toBe(404);
    expect(server.redirects).toEqual([`POST /mcp -> 307 ${second.origin}/mcp`]);
    expect(second.requests).toMatchObject([{ method: "POST", path: "/mcp", headerNames: expect.arrayContaining(["x-api-key"]) }]);
  });
});
