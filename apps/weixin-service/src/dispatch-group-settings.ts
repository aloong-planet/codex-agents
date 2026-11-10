import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseChannelStartupConfiguration } from "./channel-startup-config.js";
import type { TeamActor } from "./team-management.js";

/** A dispatch request that has not ended, as the save refusal lists it (agent-console::US-009/AC-04). */
export type DispatchGroupRequest = Readonly<{ summary: string; status: "proposed" | "queued" | "running" | "waiting" }>;
/** The form's view. Only chat IDs, group names and a fingerprint of the file leave the service; no secret does (agent-console::US-009/AC-06). */
export type DispatchGroupsView = Readonly<{ feishu: false }> | Readonly<{
  feishu: true;
  /** A fingerprint of the file as read; a save based on another one is refused as changed. */
  basedOn: string;
  /** The Feishu group allowlist, in file order, with the name the platform gave or the chat ID. */
  groups: ReadonlyArray<Readonly<{ chatId: string; name: string }>>;
  /** The dispatch groups the file names now, and those the running service started with. */
  saved: readonly string[];
  running: readonly string[];
}>;

type Refusal =
  | Readonly<{ kind: "locked"; lockPath: string }>
  | Readonly<{ kind: "changed" }>
  | Readonly<{ kind: "unfinished"; groups: ReadonlyArray<Readonly<{ chatId: string; requests: readonly DispatchGroupRequest[] }>> }>
  | Readonly<{ kind: "invalid" }>;
/** A save that left the file unchanged, with its reason (agent-console::US-009/AC-04). */
export class DispatchGroupRefusal extends Error {
  constructor(readonly refusal: Refusal) { super(`dispatch_groups_${refusal.kind}`); }
}

export type DispatchGroupSettingsOptions = Readonly<{
  /** The channel configuration file the service loaded. */
  file: string;
  /** The dispatch groups the running service started with. */
  running: readonly string[];
  /** The running dispatch's unfinished requests by chat ID. */
  unfinished(): Readonly<Record<string, readonly DispatchGroupRequest[]>>;
  /** Group names the platform gives, by chat ID; a group without one is left out. */
  names(chatIds: readonly string[]): Promise<Readonly<Record<string, string>>>;
  audit: Readonly<{ tryAppend(entry: Record<string, unknown>): boolean }>;
}>;

type Document = Record<string, unknown> & { feishu?: Record<string, unknown> & { dispatch?: Record<string, unknown> } };

/**
 * The dispatch-group form of 团队管理 (agent-console::US-009, Implementation Decisions: dispatch groups). A save changes only the
 * dispatch group list of the channel configuration file, the way the pairing wizard writes that file: under the wizard's lock,
 * refused when the file changed since the page read it, checked whole with the startup validation, and replaced atomically by an
 * owner-only file. It applies when the service next starts.
 */
export class DispatchGroupSettings {
  private readonly lock: string;

  constructor(private readonly options: DispatchGroupSettingsOptions) {
    this.lock = `${options.file}.pairing-lock`;
  }

  async view(): Promise<DispatchGroupsView> {
    const text = this.read();
    if (text === undefined) return { feishu: false };
    const document = this.parse(text);
    if (!document) return { feishu: false };
    const chatIds = allowlist(document);
    const names = await this.options.names(chatIds);
    return { feishu: true, basedOn: fingerprint(text), groups: chatIds.map((chatId) => ({ chatId, name: names[chatId] ?? chatId })),
      saved: savedGroups(document), running: [...this.options.running] };
  }

  /** Saves the checked groups; no group checked removes dispatch from the file. Returns the view after the save. */
  async save(input: Readonly<{ groups: unknown; basedOn: unknown }>, actor: TeamActor): Promise<DispatchGroupsView> {
    const groups = input.groups;
    if (!Array.isArray(groups) || !groups.every((chatId) => typeof chatId === "string") || new Set(groups).size !== groups.length ||
        typeof input.basedOn !== "string") throw new DispatchGroupRefusal({ kind: "invalid" });
    let descriptor: number;
    try { descriptor = fs.openSync(this.lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DispatchGroupRefusal({ kind: "locked", lockPath: this.lock });
      throw error;
    }
    fs.closeSync(descriptor);
    const temporary = path.join(path.dirname(this.options.file), `.channel-${randomUUID()}.tmp`);
    let before: readonly string[];
    try {
      const text = this.read();
      if (text === undefined || fingerprint(text) !== input.basedOn) throw new DispatchGroupRefusal({ kind: "changed" });
      const document = this.parse(text);
      if (!document?.feishu) throw new DispatchGroupRefusal({ kind: "invalid" });
      const unfinished = this.options.unfinished();
      const busy = Object.entries(unfinished).filter(([chatId, requests]) => requests.length && !groups.includes(chatId))
        .map(([chatId, requests]) => ({ chatId, requests }));
      if (busy.length) throw new DispatchGroupRefusal({ kind: "unfinished", groups: busy });
      before = savedGroups(document);
      if (groups.length) document.feishu.dispatch = { ...(document.feishu.dispatch ?? {}), groupChatIds: [...groups] };
      else delete document.feishu.dispatch;
      if (!this.parse(JSON.stringify(document))) throw new DispatchGroupRefusal({ kind: "invalid" });
      const descriptor = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(descriptor, JSON.stringify(document, null, 2) + "\n"); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      if (this.read() !== text) throw new DispatchGroupRefusal({ kind: "changed" });
      fs.renameSync(temporary, this.options.file);
    } finally {
      fs.rmSync(temporary, { force: true });
      fs.unlinkSync(this.lock);
    }
    this.options.audit.tryAppend({ by: actor.browser ? "browser" : "service", ...(actor.browser ? { browser: { id: actor.browser.id, label: actor.browser.label } } : {}),
      event: "dispatch_groups_saved", before, after: [...groups] });
    return this.view();
  }

  private read(): string | undefined {
    try { return fs.readFileSync(this.options.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  /** The document when it is a valid startup configuration with Feishu enabled. */
  private parse(text: string): Document | undefined {
    let document: Document;
    try {
      document = JSON.parse(text) as Document;
      if (!parseChannelStartupConfiguration(document).entries.some(({ channel }) => channel === "feishu")) return undefined;
    } catch { return undefined; }
    return document;
  }
}

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const allowlist = (document: Document): string[] => ((document.feishu?.groups ?? []) as Array<{ chatId: string }>).map(({ chatId }) => chatId);
const savedGroups = (document: Document): string[] => [...((document.feishu?.dispatch?.groupChatIds ?? []) as string[])];
