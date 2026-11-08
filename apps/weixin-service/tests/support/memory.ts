import { join } from "node:path";
import { expect } from "vitest";
import { AccountMemoryStore } from "../../src/account-memory-store.js";
import { AccountMemoryToolHost } from "../../src/account-memory-tool-host.js";

/**
 * Commits one curated fact into `accountId`'s memory in a main state directory, through the production memory tool host,
 * as a curator's accepted decision would. `id` names the evidence entry and `target` the conversation it came from.
 */
export async function seedMemory(directory: string, accountId: string, target: string, id: string, text: string): Promise<void> {
  const memory = new AccountMemoryStore(join(directory, "memory")), curator = new AccountMemoryToolHost(memory);
  expect(await curator.commit({ accountId, jobId: id, batchId: id, mutationPolicy: { mode: "free_add" }, evidenceEntryIds: [id],
    evidenceTexts: { [id]: text }, evidenceOrigins: { [id]: { eventKey: id, target } } },
  { batchId: id, basedOnRevision: memory.read(accountId).revision, decisions: [{ kind: "remember", category: "projects", value: text, evidenceEntryIds: [id], confidence: 1 }] })).toMatchObject({ status: "committed" });
}
