import { vi } from "vitest";
import type { CodexConversation } from "../../src/codex-conversation.js";

/**
 * An external App Server conversation for dispatch unit cases: the only part those cases substitute. Its default reply
 * follows MAIN_REPLY_OUTPUT_SCHEMA; Coordinator and Team Leader cases pass their own structured replies.
 */
export function conversation(threadId: string, finalText = '{"message":"已整理好商品文案。","results":[]}') {
  return {
    startOrResume: vi.fn<CodexConversation["startOrResume"]>().mockResolvedValue(threadId),
    runTurn: vi.fn<CodexConversation["runTurn"]>().mockResolvedValue({ owner: "model_owned", finalText }),
    releaseThread: vi.fn<CodexConversation["releaseThread"]>(),
    interruptThread: vi.fn<CodexConversation["interruptThread"]>().mockResolvedValue(undefined),
    close: vi.fn<CodexConversation["close"]>().mockResolvedValue(undefined),
  };
}
