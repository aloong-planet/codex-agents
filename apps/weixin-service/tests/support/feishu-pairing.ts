// A scripted local pairing for the public pairing orchestration: a terminal that gives fixed answers, and an authenticated
// transport that delivers the owner's private one-time challenge as soon as the wizard displays it.
import type { PairingIO, PairingTransport } from "../../src/feishu-pairing.js";

/** The owner's private text message carrying `code` to `appId`, in the pinned SDK's im.message.receive_v1 shape (as in feishu-channel.test.ts). */
export function pairingEvent(code: string, appId: string) {
  return { app_id: appId, sender: { sender_type: "user", sender_id: { open_id: "ou_owner" } },
    message: { chat_type: "p2p", chat_id: "oc_private", message_type: "text", message_id: "om_pair", content: JSON.stringify({ text: code }) } };
}

/** A terminal answering `answers` in order, and a transport whose challenge reply comes from the owner in `appId`'s private chat. */
export function scriptedPairing(appId: string, answers: string[]) {
  const output: string[] = [];
  let handlers: Parameters<PairingTransport["start"]>[0] | undefined;
  let closed = false;
  const transport: PairingTransport = { async start(h) { handlers = h; h.ready(); }, close() { closed = true; } };
  const io: PairingIO = { async ask() { const answer = answers.shift(); if (answer === undefined) throw Error("unexpected prompt"); return answer; },
    write(text) { output.push(text); if (text.startsWith("PAIR ")) void handlers!.message(pairingEvent(text, appId)); } };
  return { io, transport, output, answers, get closed() { return closed; } };
}
