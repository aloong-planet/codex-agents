// Calls to the console's API as the authorized owner, shared by the journeys of the console's pages: what a journey sets up
// or reads beside the page it drives.
export type ConsoleService = { url: string; cookie: string };

/** POSTs JSON as the owner and returns the answer; a refused request fails the journey with its route, status and body. */
export async function post(server: ConsoleService, pathname: string, body: unknown) {
  const response = await fetch(`${server.url}${pathname}`, { method: "POST", headers: { cookie: server.cookie, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** GETs a JSON route as the owner. */
export const read = async <T>(server: ConsoleService, pathname: string) => await (await fetch(`${server.url}${pathname}`, { headers: { cookie: server.cookie } })).json() as T;

/** Registers an MCP server with the line its confirmation card shows, as setup for journeys that are not about registration, and returns that line. */
export async function registerMcpServer(server: ConsoleService, definition: Record<string, unknown>): Promise<string> {
  const { launchLine } = await post(server, "/api/mcp/preview", { server: definition });
  await post(server, "/api/mcp/servers", { server: definition, confirmed: launchLine });
  return launchLine as string;
}
