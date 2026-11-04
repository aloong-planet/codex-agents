import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AutoBindingFileStore } from "../src/auto-binding-store.js";

const tempDirs: string[] = [];

function makeStore(): { dir: string; filePath: string; store: AutoBindingFileStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-auto-binding-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "state.json");
  return { dir, filePath, store: new AutoBindingFileStore(filePath) };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("AutoBindingFileStore", () => {
  it("atomically persists only the non-secret automatic-binding ledger", () => {
    const { dir, filePath, store } = makeStore();
    store.save({
      version: 1,
      status: "accepted",
      accountId: "bot-a",
      target: "owner@im.wechat",
      eventKey: "event-sha256",
      updatedAt: 1_800_000_000_000,
    });

    expect(store.load()).toMatchObject({
      status: "accepted",
      accountId: "bot-a",
      target: "owner@im.wechat",
    });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
    expect(fs.readFileSync(filePath, "utf8")).not.toMatch(/token|messageText|authorization/i);
  });

  it("refuses unsafe permissions and malformed target identifiers", () => {
    const { filePath, store } = makeStore();
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, status: "idle" }), { mode: 0o644 });
    expect(() => store.load()).toThrow(/权限不安全/);

    expect(() =>
      store.save({
        version: 1,
        status: "failed",
        accountId: "bot-a",
        target: "not-a-weixin-target",
        eventKey: "event-1",
        updatedAt: 1_800_000_000_000,
        reason: "unknown",
      }),
    ).toThrow(/格式无效/);
  });
});
