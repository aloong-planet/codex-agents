// The console's API as an authorized browser session calls it, for what console journeys set up and check beside the page.
// Shared by team-management.spec.ts, skill-library.spec.ts and mcp-catalog.spec.ts. Other spec files still send such requests with helpers of their own.

/** The fixture service a journey runs against: its origin and the harness's own authorized cookie. */
export type ConsoleServer = { url: string; cookie: string };

/** POSTs JSON as the authorized owner, from the console's own origin; an answer that is not a success throws with its status and body. */
export async function post<T = Record<string, unknown>>(server: ConsoleServer, pathname: string, body: unknown): Promise<T> {
  const response = await fetch(`${server.url}${pathname}`, { method: "POST", headers: { cookie: server.cookie, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** GETs a JSON route as the authorized owner. */
export const read = async <T>(server: ConsoleServer, pathname: string) => await (await fetch(`${server.url}${pathname}`, { headers: { cookie: server.cookie } })).json() as T;

/** Imports a skill folder into the Skill Library the way its page does: it reads the folder, then confirms what the read listed. Returns the skill's ID. */
export async function importSkill(server: ConsoleServer, folder: string): Promise<string> {
  const { preview } = await post<{ preview: { fingerprint: string } }>(server, "/api/skills/read", { folder });
  return (await post<{ id: string }>(server, "/api/skills/import", { folder, confirmed: preview.fingerprint })).id;
}

/** The fixture Coordinator's decision to dispatch a request to `agentId`. */
export const dispatchTo = (agentId: string, summary: string) => ({ kind: "dispatch", agentId, requestId: null, summary, message: "" });
/**
 * A text message in the dispatch group oc_alpha (银河护卫队), received by Sam's application, with the fixture Coordinator's decision
 * for it; `extra` adds fixture inputs for the turns it starts.
 */
export const groupMessage = (server: ConsoleServer, messageId: string, text: string, dispatchDecision: unknown, extra: Record<string, unknown> = {},
  from = { sender: "ou_owner", pathname: "/api/fixture/inbound" }) => post(server, from.pathname, {
  event: { app_id: "cli_0123456789abcdef", sender: { sender_type: "user", sender_id: { open_id: from.sender } },
    message: { message_id: messageId, create_time: String(Date.now()), chat_id: "oc_alpha", chat_type: "group", message_type: "text",
      content: JSON.stringify({ text }), mentions: [] } }, dispatchDecision, ...extra });

/** Registers an MCP server with the line its confirmation card shows, as setup for journeys that are not about registration, and returns that line. */
export async function registerMcpServer(server: ConsoleServer, definition: Record<string, unknown>): Promise<string> {
  const { launchLine } = await post<{ launchLine: string }>(server, "/api/mcp/preview", { server: definition });
  await post(server, "/api/mcp/servers", { server: definition, confirmed: launchLine });
  return launchLine;
}
