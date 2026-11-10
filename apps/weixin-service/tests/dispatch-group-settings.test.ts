import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DispatchGroupRefusal, DispatchGroupSettings, type DispatchGroupRequest } from "../src/dispatch-group-settings.js";

// The console's dispatch-group form at its public interface, on real files in a private temporary directory
// (agent-console::US-009, Implementation Decisions: dispatch groups). The running dispatch's unfinished requests, group names and
// the audit are injected; their wiring through real main is in team-management.integration.test.ts.
// Fixture shape: the channel configuration as docs/ops/feishu-agent-dispatch.md documents it and the pairing wizard writes it.
// Coverage gap: the owner's real channel.json is production data and is not read, so no real sample backs the fixture.
const SECRET = "app-secret-SENTINEL-41c9";
const WEBHOOK_KEY = "encrypt-key-SENTINEL-88a0";
const document = (dispatch?: unknown) => ({
  channel: "feishu",
  owner: { memoryAccountId: "owner-memory", bindings: [{ channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_private", senderId: "ou_owner" }] },
  taskScope: { accountId: "owner-memory", target: "oc_private" },
  feishu: { appId: "cli_0123456789abcdef", appSecret: SECRET, receiveMode: "webhook",
    webhook: { port: 4318, path: "/feishu/events", verificationToken: "verify-token", encryptKey: WEBHOOK_KEY },
    groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }, { chatId: "oc_beta", allowedSenderIds: ["ou_owner", "ou_colleague"] }],
    ...(dispatch === undefined ? {} : { dispatch }) },
  notes: { kept: ["a key the parser ignores"] },
});
const ROSTER = [{ id: "sam" }, { id: "alice", appId: "cli_1111111111111111", appSecret: "alice-secret" },
  { id: "bill", appId: "cli_2222222222222222", appSecret: "bill-secret" }, { id: "jack", appId: "cli_3333333333333333", appSecret: "jack-secret" }];

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
/** A private state directory holding channel.json, written the way the pairing wizard writes it. */
function stateWith(value: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "dispatch-groups-"));
  directories.push(directory);
  chmodSync(directory, 0o700);
  const file = join(directory, "channel.json");
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  return { directory, file, lock: `${file}.pairing-lock`, read: () => JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof document> };
}
type Options = { running?: string[]; unfinished?: Record<string, DispatchGroupRequest[]>; names?: Record<string, string> };
function settingsOn(file: string, options: Options = {}) {
  const audit: Array<Record<string, unknown>> = [];
  const settings = new DispatchGroupSettings({ file, running: options.running ?? [], unfinished: () => options.unfinished ?? {},
    names: async (chatIds) => Object.fromEntries(chatIds.flatMap((chatId) => options.names?.[chatId] ? [[chatId, options.names[chatId]]] : [])),
    audit: { tryAppend: (entry) => { audit.push(entry); return true; } } });
  return { settings, audit };
}
const BROWSER = { browser: { id: "browser-1", label: "Chrome", authorizedAt: "2026-11-10T00:00:00.000Z", lastUsedAt: "2026-11-10T00:00:00.000Z" } };

describe("dispatch-group settings", () => {
  it("writes exactly the checked groups, keeps every other key and the owner-only file, and reports the pending restart", async () => {
    const state = stateWith(document());
    const before = state.read();
    const { settings } = settingsOn(state.file);
    const { basedOn } = await settings.view() as { basedOn: string };
    const saved = await settings.save({ groups: ["oc_beta", "oc_alpha"], basedOn }, BROWSER);
    const after = state.read();
    expect(after.feishu).toEqual({ ...before.feishu, dispatch: { groupChatIds: ["oc_beta", "oc_alpha"] } });
    expect({ ...after, feishu: undefined }).toEqual({ ...before, feishu: undefined });
    expect(statSync(state.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(state.directory)).toEqual(["channel.json"]);
    expect(saved).toMatchObject({ feishu: true, saved: ["oc_beta", "oc_alpha"], running: [] });
  });

  it("changes only the group list of a hand-written roster section, and removes the section when no group is checked", async () => {
    const state = stateWith(document({ groupChatIds: ["oc_alpha", "oc_beta"], agents: ROSTER }));
    const before = state.read();
    const { settings } = settingsOn(state.file);
    await settings.save({ groups: ["oc_alpha"], basedOn: (await settings.view() as { basedOn: string }).basedOn }, BROWSER);
    expect(state.read()).toEqual({ ...before, feishu: { ...before.feishu, dispatch: { groupChatIds: ["oc_alpha"], agents: ROSTER } } });
    const off = await settings.save({ groups: [], basedOn: (await settings.view() as { basedOn: string }).basedOn }, BROWSER);
    const feishu: Record<string, unknown> = { ...before.feishu };
    delete feishu.dispatch;
    expect(state.read()).toEqual({ ...before, feishu });
    expect(off).toMatchObject({ saved: [] });
  });

  it("refuses while the pairing wizard's lock exists, or when the file changed after the page read it, leaving the file and the lock as they were", async () => {
    const state = stateWith(document());
    const { settings } = settingsOn(state.file);
    const { basedOn } = await settings.view() as { basedOn: string };
    const bytes = readFileSync(state.file);
    writeFileSync(state.lock, "", { mode: 0o600 });
    await expect(settings.save({ groups: ["oc_alpha"], basedOn }, BROWSER)).rejects.toEqual(new DispatchGroupRefusal({ kind: "locked", lockPath: state.lock }));
    expect(readFileSync(state.file).equals(bytes)).toBe(true);
    expect(existsSync(state.lock)).toBe(true);
    rmSync(state.lock);
    writeFileSync(state.file, JSON.stringify(document(), null, 4), { mode: 0o600 });
    const edited = readFileSync(state.file);
    await expect(settings.save({ groups: ["oc_alpha"], basedOn }, BROWSER)).rejects.toEqual(new DispatchGroupRefusal({ kind: "changed" }));
    expect(readFileSync(state.file).equals(edited)).toBe(true);
    expect(readdirSync(state.directory)).toEqual(["channel.json"]);
  });

  it("refuses to uncheck a group that has unfinished dispatch requests, and lists them, but never refuses checking a group", async () => {
    const state = stateWith(document({ groupChatIds: ["oc_alpha"] }));
    const unfinished: Record<string, DispatchGroupRequest[]> = { oc_alpha: [{ summary: "安排周末出行", status: "proposed" }, { summary: "整理发布说明", status: "running" }] };
    const { settings } = settingsOn(state.file, { running: ["oc_alpha"], unfinished });
    const { basedOn } = await settings.view() as { basedOn: string };
    const bytes = readFileSync(state.file);
    await expect(settings.save({ groups: ["oc_beta"], basedOn }, BROWSER)).rejects.toEqual(new DispatchGroupRefusal({ kind: "unfinished",
      groups: [{ chatId: "oc_alpha", requests: [{ summary: "安排周末出行", status: "proposed" }, { summary: "整理发布说明", status: "running" }] }] }));
    expect(readFileSync(state.file).equals(bytes)).toBe(true);
    expect(existsSync(state.lock)).toBe(false);
    await expect(settings.save({ groups: ["oc_alpha", "oc_beta"], basedOn }, BROWSER)).resolves.toMatchObject({ saved: ["oc_alpha", "oc_beta"], running: ["oc_alpha"] });
  });

  it("audits each save with the groups before and after and the browser, and never returns or audits a secret", async () => {
    const state = stateWith(document({ groupChatIds: ["oc_alpha"] }));
    const { settings, audit } = settingsOn(state.file);
    const view = await settings.view();
    const saved = await settings.save({ groups: ["oc_beta"], basedOn: (view as { basedOn: string }).basedOn }, BROWSER);
    expect(audit).toEqual([{ by: "browser", browser: { id: "browser-1", label: "Chrome" }, event: "dispatch_groups_saved", before: ["oc_alpha"], after: ["oc_beta"] }]);
    expect(JSON.stringify([view, saved, audit])).not.toMatch(/SENTINEL|verify-token/);
  });

  it("lists the allowlisted groups by name or chat ID, and says Feishu is not paired without a Feishu configuration", async () => {
    const state = stateWith(document({ groupChatIds: ["oc_beta"] }));
    const { settings } = settingsOn(state.file, { running: ["oc_alpha"], names: { oc_alpha: "银河护卫队" } });
    expect(await settings.view()).toEqual({ feishu: true, basedOn: expect.stringMatching(/^[0-9a-f]{64}$/),
      groups: [{ chatId: "oc_alpha", name: "银河护卫队" }, { chatId: "oc_beta", name: "oc_beta" }], saved: ["oc_beta"], running: ["oc_alpha"] });
    expect(await settingsOn(join(state.directory, "missing.json")).settings.view()).toEqual({ feishu: false });
    const weixin = stateWith({ channel: "weixin", owner: { memoryAccountId: "bot", bindings: [{ channel: "weixin", accountId: "bot", target: "owner@im.wechat", senderId: "owner@im.wechat" }] },
      taskScope: { accountId: "bot", target: "owner@im.wechat" } });
    expect(await settingsOn(weixin.file).settings.view()).toEqual({ feishu: false });
  });
});
