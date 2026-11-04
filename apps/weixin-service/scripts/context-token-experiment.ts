import os from "node:os";
import path from "node:path";

import {
  ContextTokenExpiryExperiment,
  FileContextTokenExperimentStore,
} from "../src/context-token-expiry-experiment.js";
import { PrivateStateStore } from "../src/private-state-store.js";
import { resolvePrivateStatePath } from "../src/runtime-paths.js";

const command = process.argv[2];
if (command !== "activate" && command !== "status") {
  throw new Error("用法：context-token-experiment <activate|status>");
}

const statePath = resolvePrivateStatePath(process.env, os.homedir());
const experimentStore = new FileContextTokenExperimentStore(
  path.join(path.dirname(statePath), "context-token-expiry-experiment.json"),
);

if (command === "status") {
  const state = experimentStore.load();
  process.stdout.write(`${JSON.stringify({
    status: state.status,
    baselineContextUpdatedAt: state.baselineContextUpdatedAt ?? null,
    nextProbeAt: state.nextProbeAt ?? null,
    attemptedProbes: state.attemptedProbes,
    acceptedProbes: state.acceptedProbes,
    expiredAfterMs: state.expiredAfterMs ?? null,
  })}\n`);
  process.exit(0);
}

const privateState = new PrivateStateStore(statePath).load();
if (!privateState) throw new Error("尚未建立微信直连账户");
const candidates = Object.entries(privateState.targetMetadata ?? {})
  .filter(([target, metadata]) => Boolean(privateState.contextTokens[target] && metadata.contextUpdatedAt))
  .sort((left, right) => (right[1].contextUpdatedAt ?? 0) - (left[1].contextUpdatedAt ?? 0));
const selected = candidates[0];
if (!selected?.[1].contextUpdatedAt) throw new Error("尚未发现带 context 时间的入站目标");

const experiment = new ContextTokenExpiryExperiment({
  channel: {
    getSnapshot: () => ({
      accounts: [{ accountId: privateState.accountId, credentialStatus: "usable" }],
      targets: [{
        accountId: privateState.accountId,
        target: selected[0],
        contextUpdatedAt: selected[1].contextUpdatedAt,
      }],
    }),
    sendText: async () => ({ ok: false, reason: "unavailable" }),
  },
  store: experimentStore,
  wakeLock: { start: () => true, stop: () => {} },
});
experiment.activate({
  accountId: privateState.accountId,
  target: selected[0],
  baselineContextUpdatedAt: selected[1].contextUpdatedAt,
});
await experiment.close();
process.stdout.write(`${JSON.stringify({
  status: "scheduled",
  baselineContextUpdatedAt: selected[1].contextUpdatedAt,
  firstProbeAt: selected[1].contextUpdatedAt + 23 * 3_600_000,
  cutoffAt: selected[1].contextUpdatedAt + 48 * 3_600_000,
})}\n`);
