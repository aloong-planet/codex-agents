// The console's API as an authorized browser session calls it, for what console journeys set up and check beside the page.
// Shared by the spec files of the console pages, so that how a journey authorizes and sends a request is written once.

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
