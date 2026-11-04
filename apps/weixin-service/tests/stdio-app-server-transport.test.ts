import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  buildStdioAppServerArgs,
  StdioAppServerTransport,
  type AppServerProcess,
} from "../src/stdio-app-server-transport.js";

class FakeProcess extends EventEmitter implements AppServerProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("StdioAppServerTransport", () => {
  it("disables only the explicitly selected App Server features", () => {
    expect(buildStdioAppServerArgs(["plugins", "skill_search"])).toEqual([
      "app-server",
      "--disable", "plugins",
      "--disable", "skill_search",
      "--stdio",
    ]);
    expect(buildStdioAppServerArgs()).toEqual(["app-server", "--stdio"]);
  });

  it("writes and parses newline-delimited JSON without exposing stderr", async () => {
    const child = new FakeProcess();
    const transport = new StdioAppServerTransport(child);
    const sent = new Promise<string>((resolve) =>
      child.stdin.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8"))),
    );
    const received = new Promise<unknown>((resolve) => transport.onMessage(resolve));

    transport.send({ method: "initialize", id: 1, params: {} });
    child.stderr.write("private diagnostic that must stay internal\n");
    child.stdout.write('{"id":1,"result":{"ok":true}}\n');

    await expect(sent).resolves.toBe('{"method":"initialize","id":1,"params":{}}\n');
    await expect(received).resolves.toEqual({ id: 1, result: { ok: true } });

    transport.close();
    expect(child.killed).toBe(true);
  });

  it("reports a child-process startup error through the transport exit seam", async () => {
    const child = new FakeProcess();
    const transport = new StdioAppServerTransport(child);
    const exited = new Promise<Error | undefined>((resolve) => transport.onExit(resolve));

    child.emit("error", new Error("spawn failed"));

    await expect(exited).resolves.toEqual(new Error("spawn failed"));
  });
});
