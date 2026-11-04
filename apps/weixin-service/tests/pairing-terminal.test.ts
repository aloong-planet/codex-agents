// Controlled terminal streams verify visible output and input lifetime; actual OS TTY appearance remains manual acceptance.
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { PairingTerminal } from "../src/pairing-terminal.js";
function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); const chunks: string[] = []; output.on("data", chunk => chunks.push(String(chunk)));
  return { input, io: new PairingTerminal(input, output), chunks };
}
it("P06 conceals a secret, supports editing and restores raw mode", async () => {
  const h = terminal();
  const answer = h.io.ask("Secret: ", { secret: true, signal: new AbortController().signal });
  h.input.write("private-secretX\x7f\r");
  expect(await answer).toBe("private-secret");
  expect(h.chunks.join("")).toBe("Secret: \n");
  expect(h.input.isRaw).toBe(false);
  const next = h.io.ask("Confirm: ", { signal: new AbortController().signal }); h.input.write("y\r");
  expect(await next).toBe("y"); expect(h.chunks.join("")).toBe("Secret: \nConfirm: y\n");
});
it.each(["signal", "ctrl-c", "end"])("P06 %s interrupts a prompt and removes its input listener", async cause => {
  const h = terminal(); const stop = new AbortController();
  const answer = h.io.ask("Secret: ", { secret: true, signal: stop.signal });
  const rejected = expect(answer).rejects.toThrow("pairing_cancelled");
  h.input.write("hidden");
  if (cause === "signal") stop.abort(); else if (cause === "ctrl-c") h.input.write("\x03"); else h.input.end();
  await rejected; expect(h.input.isRaw).toBe(false); expect(h.input.listenerCount("keypress")).toBe(0); expect(h.chunks.join("")).not.toContain("hidden");
});
it("P06 refuses piped input instead of exposing credentials", () => {
  expect(() => new PairingTerminal(new PassThrough(), new PassThrough())).toThrow("pairing_terminal_required");
});
it("P07 enables hidden input before publishing the prompt", async () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const output = new PassThrough(); let rawAtPrompt = false;
  output.on("data", chunk => { if (String(chunk) === "Secret: ") rawAtPrompt = input.isRaw; });
  const io = new PairingTerminal(input, output);
  const answer = io.ask("Secret: ", { secret: true, signal: new AbortController().signal });
  input.write("hidden\r"); await answer;
  expect(rawAtPrompt).toBe(true);
});
