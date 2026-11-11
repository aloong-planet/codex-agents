import type { PrivateReplier, PrivateTurnInput } from "./private-conversations.js";

/** Where fixture private replies come from: the output injected for an agent's next reply, released at once or when the fixture says. */
export type FixturePrivateReplySource = { privateReply(agentId: string): Promise<string> | undefined };
export type FixturePrivateTurn = { agentId: string; input: PrivateTurnInput };

/** The default reply when none was injected: it quotes the message, so a case can tell which message a reply answers. */
export function fixtureDefaultPrivateReply(input: PrivateTurnInput): string {
  return JSON.stringify({ message: `收到：${input.message}` });
}

/**
 * Explicit fixture mode only: substitutes the model's raw output with the injected one, which the production parser still checks,
 * and records the input each reply turn was given, so cases can see what an agent would have read.
 */
export class FixturePrivateReplier implements PrivateReplier {
  readonly turns: FixturePrivateTurn[] = [];
  constructor(private readonly source: FixturePrivateReplySource) {}

  async reply(input: PrivateTurnInput): Promise<string> {
    this.turns.push(structuredClone({ agentId: input.agent.id, input }));
    if (this.turns.length > 40) this.turns.shift();
    return await (this.source.privateReply(input.agent.id) ?? Promise.resolve(fixtureDefaultPrivateReply(input)));
  }
}
