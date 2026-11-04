import { CodexConversation, type CodexUserInput, type FrozenTurnPolicy, type CodexTurnObserver, type CodexTurnModel } from "../../src/codex-conversation.js";
import type { AppServerMessage } from "../../src/codex-app-server-client.js";

export type ScriptedModelReply = (threadId: string, input: string | CodexUserInput[], policy?: FrozenTurnPolicy,
  onProgress?: CodexTurnObserver, model?: CodexTurnModel) => Promise<string>;

/** Legacy service-unit response scripts replace the external peer, not binding cleanup.
 * Production-equivalent file/ownership tests use FixtureAppServerTransport and real executors.
 */
export function scriptedTurnRunner(answer: ScriptedModelReply): CodexConversation["runTurn"] {
  return async (threadId, input, policy, onProgress, model) => {
    let emit: (message: AppServerMessage) => void = () => {};
    let closed = false;
    const conversation = new CodexConversation(() => ({
      onMessage: (listener) => { emit = listener; return () => { emit = () => {}; }; },
      onExit: () => () => {},
      close: () => { closed = true; },
      send: (message) => {
        if (message.method === "initialize" || message.method === "thread/start") {
          queueMicrotask(() => emit({ id: message.id!, result: message.method === "initialize" ? {} : { thread: { id: threadId } } }));
        } else if (message.method === "turn/start") {
          queueMicrotask(() => {
            emit({ id: message.id!, result: { turn: { id: "scripted-turn" } } });
            void answer(threadId, message.params!.input as CodexUserInput[], policy, (event) => {
              if (event.kind !== "turn_submitted") onProgress?.(event);
            }, model).then((text) => {
              if (closed) return;
              emit({ method: "item/completed", params: { threadId, turnId: "scripted-turn", item: { type: "agentMessage", text, phase: "final_answer" } } });
              emit({ method: "turn/completed", params: { threadId, turn: { id: "scripted-turn", status: "completed" } } });
            }, () => emit({ method: "error", params: { threadId, turnId: "scripted-turn", error: { message: "scripted failure" }, willRetry: false } }));
          });
        }
      },
    }));
    try {
      await conversation.startOrResume(undefined, "/workspace");
      return await conversation.runTurn(threadId, input, policy, onProgress, model);
    } finally { await conversation.close(); }
  };
}
