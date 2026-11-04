import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { IlinkMediaStore, parseIlinkAesKey, pcmBytesToWav } from "../src/ilink-media.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe("iLink media", () => {
  it("accepts both raw-base64 and base64-encoded hex AES keys", () => {
    const key = crypto.randomBytes(16);
    expect(parseIlinkAesKey(key.toString("base64"))).toEqual(key);
    expect(parseIlinkAesKey(Buffer.from(key.toString("hex")).toString("base64"))).toEqual(key);
  });

  it("wraps decoded mono PCM in a valid 24 kHz WAV container", () => {
    const wav = pcmBytesToWav(new Uint8Array([1, 2, 3, 4]));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(4);
  });

  it("downloads, decrypts and privately persists allowlisted media", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ilink-media-"));
    dirs.push(root);
    const key = crypto.randomBytes(16);
    const plain = Buffer.from("private image bytes");
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const fetcher = vi.fn(async () => new Response(encrypted, { status: 200 }));
    const store = new IlinkMediaStore(root, fetcher, () => 1_800_000_000_000);

    const saved = await store.materialize({
      kind: "image",
      fullUrl: "https://cdn.weixin.qq.com/object",
      aesKeyBase64: key.toString("base64"),
      target: "owner@im.wechat",
      messageKey: "a".repeat(64),
      quoted: false,
    });

    expect(fs.readFileSync(saved.path)).toEqual(plain);
    expect(fs.statSync(saved.path).mode & 0o077).toBe(0);
    expect(saved.kind).toBe("image");
  });

  it("rejects non-Weixin CDN URLs and payloads over 100 MiB", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ilink-media-"));
    dirs.push(root);
    const store = new IlinkMediaStore(root, vi.fn(), Date.now);
    await expect(store.materialize({
      kind: "file", fullUrl: "https://evil.example/file", aesKeyBase64: "AA==",
      target: "owner@im.wechat", messageKey: "b".repeat(64), quoted: false,
    })).rejects.toThrow(/CDN/);
  });
});
