import { setTimeout as delay } from "node:timers/promises";

/** A private conversation as the console's API returns it (agent-console::US-006). */
export type PrivateChat = { agent: { id: string; name: string }; pending: boolean; requests: string[];
  messages: Array<{ role: "owner" | "agent"; text: string; requestId: string | null; state?: string; reason?: string }> };

/**
 * Reads `agentId`'s private conversation through `get` until its last message has its reply or has failed, as the console page
 * follows it, and returns it; throws once `timeoutMs` has run out. Shared by the whole-app cases and the real-model suite.
 */
export async function settledChat(get: (route: string) => Promise<PrivateChat>, agentId: string, timeoutMs: number, intervalMs = 30): Promise<PrivateChat> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const chat = await get(`/api/private-chats/${encodeURIComponent(agentId)}`);
    if (!chat.pending) return chat;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${agentId}'s private reply`);
    await delay(intervalMs);
  }
}
