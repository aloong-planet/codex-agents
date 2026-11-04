import { emitKeypressEvents, type Key } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { PairingIO } from "./feishu-pairing.js";

type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?(mode: boolean): unknown };
/** One prompt at a time; hidden input is never echoed or passed as a process argument. */
export class PairingTerminal implements PairingIO {
  constructor(private readonly input: TerminalInput, private readonly output: Writable) {
    if (!input.isTTY || !input.setRawMode) throw Error("pairing_terminal_required");
    emitKeypressEvents(input);
  }
  write(text: string): void { this.output.write(text + "\n"); }
  ask(prompt: string, options: { secret?: boolean; signal: AbortSignal }): Promise<string> {
    options.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      let value = "", finished = false;
      const wasRaw = this.input.isRaw ?? false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true; this.input.off("keypress", keypress); this.input.off("end", ended); this.input.off("error", failed);
        options.signal.removeEventListener("abort", aborted);
        this.input.setRawMode!(wasRaw); this.input.pause(); this.output.write("\n");
        if (error) reject(error); else resolve(value);
      };
      const aborted = () => finish(Error("pairing_cancelled"));
      const ended = () => finish(Error("pairing_cancelled"));
      const failed = () => finish(Error("pairing_terminal_failed"));
      const keypress = (text: string | undefined, key: Key) => {
        if ((key.ctrl && (key.name === "c" || key.name === "d"))) { finish(Error("pairing_cancelled")); return; }
        if (key.name === "return" || key.name === "enter") { finish(); return; }
        if (key.name === "backspace") { const points = Array.from(value); if (points.length) { points.pop(); value = points.join(""); if (!options.secret) this.output.write("\b \b"); } return; }
        if (key.ctrl && key.name === "u") { if (!options.secret) this.output.write("\b \b".repeat(Array.from(value).length)); value = ""; return; }
        if (!key.ctrl && !key.meta && text && !Array.from(text).some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) && value.length + text.length <= 512) {
          value += text; if (!options.secret) this.output.write(text);
        }
      };
      this.input.on("keypress", keypress); this.input.once("end", ended); this.input.once("error", failed);
      options.signal.addEventListener("abort", aborted, { once: true });
      this.input.setRawMode!(true); this.input.resume();
      this.output.write(prompt);
      if (options.signal.aborted) aborted();
    });
  }
}
