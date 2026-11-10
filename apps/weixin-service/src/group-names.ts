import type { ApplicationCredentials, OnboardingPlatform } from "./team-onboarding.js";

/** How long a group name the platform could not give is not asked for again, unless the owner saves or rechecks a team in that group. */
const NAME_RETRY_MS = 10 * 60_000;

/**
 * Feishu group names read with the Coordinator's application (team-management Implementation Decisions: group names). A name the
 * platform cannot give falls back to the chat ID and is asked for again after NAME_RETRY_MS, so pages that poll do not call the
 * platform each time; concurrent lookups of a group share one call. Team management and the dispatch-group form share one instance.
 */
export class GroupNames {
  /** Group names by chat ID; a lookup that gave none is kept with the time it may be asked again. */
  private readonly names = new Map<string, Readonly<{ name?: string; retryAt: number }>>();
  /** Lookups in progress, shared by concurrent views. */
  private readonly lookups = new Map<string, Promise<void>>();

  constructor(private readonly platform: OnboardingPlatform, private readonly coordinator: ApplicationCredentials, private readonly now: () => number = Date.now) {}

  /** The names the platform gave for these groups, looking up each one unless it is known or a failed lookup is recent. */
  async of(chatIds: readonly string[]): Promise<Readonly<Record<string, string>>> {
    await Promise.all(chatIds.map((chatId) => this.lookUp(chatId)));
    return Object.fromEntries(chatIds.flatMap((chatId) => { const name = this.names.get(chatId)?.name; return name ? [[chatId, name]] : []; }));
  }

  /** Forgets failed lookups of these groups, so a fix the owner just made in Feishu shows at the next view. */
  forgetFailed(chatIds: readonly string[]): void {
    for (const chatId of chatIds) if (!this.names.get(chatId)?.name) this.names.delete(chatId);
  }

  private lookUp(chatId: string): Promise<void> {
    const known = this.names.get(chatId);
    if (known && (known.name || known.retryAt > this.now())) return Promise.resolve();
    let lookup = this.lookups.get(chatId);
    if (!lookup) {
      lookup = this.platform.chatName(chatId, this.coordinator).catch(() => undefined).then((name) => {
        this.names.set(chatId, name ? { name, retryAt: Infinity } : { retryAt: this.now() + NAME_RETRY_MS });
        this.lookups.delete(chatId);
      });
      this.lookups.set(chatId, lookup);
    }
    return lookup;
  }
}
