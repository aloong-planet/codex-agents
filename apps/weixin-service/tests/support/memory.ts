import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AccountMemoryStore } from "../../src/account-memory-store.js";
import { AccountMemoryToolHost } from "../../src/account-memory-tool-host.js";
import { parseChannelStartupConfiguration } from "../../src/channel-startup-config.js";

/** These helpers also run in Playwright cases, so a refused commit throws instead of using a test framework's assertion. */
function committed(receipt: Readonly<{ status: string }>): void {
  if (receipt.status !== "committed") throw new Error(`memory seed not committed: ${JSON.stringify(receipt)}`);
}

/**
 * Commits one curated fact into `accountId`'s memory in a main state directory, through the production memory tool host,
 * as a curator's accepted decision would. `id` names the evidence entry and `target` the conversation it came from.
 */
export async function seedMemory(directory: string, accountId: string, target: string, id: string, text: string): Promise<void> {
  const memory = new AccountMemoryStore(join(directory, "memory")), curator = new AccountMemoryToolHost(memory);
  committed(await curator.commit({ accountId, jobId: id, batchId: id, mutationPolicy: { mode: "free_add" }, evidenceEntryIds: [id],
    evidenceTexts: { [id]: text }, evidenceOrigins: { [id]: { eventKey: id, target } } },
  { batchId: id, basedOnRevision: memory.read(accountId).revision, decisions: [{ kind: "remember", category: "projects", value: text, evidenceEntryIds: [id], confidence: 1 }] }));
}

/** Commits one observed event dated `localDate` into `accountId`'s memory, through the production memory tool host, as a curator would. */
export async function seedEvent(directory: string, accountId: string, target: string, id: string, localDate: string, summary: string): Promise<void> {
  const memory = new AccountMemoryStore(join(directory, "memory")), curator = new AccountMemoryToolHost(memory);
  committed(await curator.commit({ accountId, jobId: id, batchId: id, mutationPolicy: { mode: "free_add" }, evidenceEntryIds: [id],
    evidenceTexts: { [id]: `${localDate} ${summary}` }, evidenceLocalDates: { [id]: localDate }, evidenceOrigins: { [id]: { eventKey: id, target } } },
  { batchId: id, basedOnRevision: memory.read(accountId).revision, decisions: [{ kind: "record_event", eventKind: "observed", localDate, timePrecision: "date", localTime: null,
    summary, sourceText: null, planMatch: null, evidenceEntryIds: [id], confidence: 1 }] }));
}

/** The memory account a dispatch group's Coordinator recalls, as the service derives it from the channel configuration file in `directory`. */
export function groupMemoryAccount(directory: string, chatId: string): { account: string; target: string } {
  const owner = parseChannelStartupConfiguration(JSON.parse(readFileSync(join(directory, "channel.json"), "utf8"))).entries.find((entry) => entry.channel === "feishu")!.owner;
  const address = owner.groupAddress(chatId)!;
  return { account: owner.memoryScope(address.accountId, address.target), target: address.target };
}
