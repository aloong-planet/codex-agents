import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PrivateStateStore,
  type PrivateIlinkState,
} from "../src/private-state-store.js";

const tempDirs: string[] = [];

function makeStore(): { dir: string; filePath: string; store: PrivateStateStore } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-ilink-state-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "state.json");
  return { dir, filePath, store: new PrivateStateStore(filePath) };
}

const state: PrivateIlinkState = {
  version: 1,
  accountId: "direct-bot@im.bot",
  token: "private-bot-token",
  baseUrl: "https://ilinkai.weixin.qq.com",
  userId: "owner@im.wechat",
  getUpdatesBuf: "cursor",
  contextTokens: { "owner@im.wechat": "private-context-token" },
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PrivateStateStore", () => {
  it("atomically persists and restores private state with restrictive permissions", () => {
    const { dir, filePath, store } = makeStore();

    store.save(state);

    expect(store.load()).toEqual(state);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  it("refuses to load a credential file that is readable by other users", () => {
    const { filePath, store } = makeStore();
    fs.writeFileSync(filePath, JSON.stringify(state), { mode: 0o644 });

    expect(() => store.load()).toThrow("权限不安全");
  });

  it("refuses to load credentials from a state directory accessible to other users", () => {
    const { dir, store } = makeStore();
    store.save(state);
    fs.chmodSync(dir, 0o755);

    expect(() => store.load()).toThrow("权限不安全");
  });

  it("rejects a private-network base URL before any credential is persisted", () => {
    const { store } = makeStore();

    expect(() =>
      store.save({
        ...state,
        baseUrl: "https://10.0.0.1",
      }),
    ).toThrow("私有状态格式无效");
  });

  it("persists normalized local aliases and target timing metadata", () => {
    const { store } = makeStore();

    store.save({
      ...state,
      accountLabel: "  我的个人微信  ",
      targetMetadata: {
        "owner@im.wechat": {
          label: "  Aloong  ",
          lastInboundAt: 1_723_456_789_000,
          contextUpdatedAt: 1_723_456_790_000,
          lastSendAcceptedAt: 1_723_456_791_000,
        },
      },
    });

    expect(store.load()).toMatchObject({
      accountLabel: "我的个人微信",
      targetMetadata: {
        "owner@im.wechat": {
          label: "Aloong",
          lastInboundAt: 1_723_456_789_000,
          contextUpdatedAt: 1_723_456_790_000,
          lastSendAcceptedAt: 1_723_456_791_000,
        },
      },
    });
  });

  it("rejects unsafe aliases and metadata for an unknown target", () => {
    const { store } = makeStore();

    expect(() => store.save({ ...state, accountLabel: "bad\u0000label" })).toThrow(
      "私有状态格式无效",
    );
    expect(() =>
      store.save({
        ...state,
        targetMetadata: { "unknown@im.wechat": { label: "Unknown" } },
      }),
    ).toThrow("私有状态格式无效");
  });
});
