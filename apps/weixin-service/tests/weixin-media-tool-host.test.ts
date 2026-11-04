import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InboundTextEvent } from "../src/demo-service.js";
import { MediaExportLibrary } from "../src/media-export-library.js";
import { WeixinMediaToolHost } from "../src/weixin-media-tool-host.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-tool-")); dirs.push(root);
  const file = path.join(root, "answer.png"); fs.writeFileSync(file, "image");
  const replyMedia = vi.fn(async () => ({ ok: true as const, messageId: "media-1" }));
  const event = { key: "a".repeat(64), accountId: "bot@im.bot", target: "owner@im.wechat", messageId: "m1", source: "text", text: "把图片发给我", receivedAt: 1, replyText: vi.fn(), replyMedia } satisfies InboundTextEvent;
  return { root, file, event, replyMedia };
}

describe("WeixinMediaToolHost", () => {
  it("recognizes an explicit image return request without a caller-computed permission flag", async () => {
    const { root, file, event, replyMedia } = fixture(); const host = new WeixinMediaToolHost();
    event.text = "请把这张图片回发给我";
    const binding = host.bind("thread-1", event, [root]);

    await expect(host.execute("weixin_send_media", { path: file }, { threadId: "thread-1", turnId: "turn-1" })).resolves.toMatchObject({ success: true });
    expect(replyMedia).toHaveBeenCalledWith(fs.realpathSync(file), undefined);
    binding.release();
  });

  it("allows an explicitly requested recent image from the same account and target", async () => {
    const { file, event, replyMedia } = fixture(); const host = new WeixinMediaToolHost();
    const imageEvent = {
      ...event,
      key: "b".repeat(64),
      text: "看看这张图片",
      attachments: [{ kind: "image" as const, path: file, fileName: "answer.png", mimeType: "image/png", sizeBytes: 5, quoted: false }],
    };
    host.bind("thread-1", imageEvent, []).release();

    const requestEvent = { ...event, key: "c".repeat(64), text: "把刚才的图片发回来" };
    const binding = host.bind("thread-1", requestEvent, []);

    expect(binding.promptLines).toContain(`近期图片 1：${fs.realpathSync(file)}`);
    await expect(host.execute("weixin_send_media", { path: file }, { threadId: "thread-1", turnId: "turn-2" })).resolves.toMatchObject({ success: true });
    expect(replyMedia).toHaveBeenCalledWith(fs.realpathSync(file), undefined);
    binding.release();
  });

  it("sends only from an explicitly authorized active turn", async () => {
    const { root, file, event, replyMedia } = fixture(); const host = new WeixinMediaToolHost();
    const binding = host.bind("thread-1", event, [root]);
    await expect(host.execute("weixin_send_media", { path: file }, { threadId: "thread-1", turnId: "turn-1" })).resolves.toMatchObject({ success: true });
    expect(replyMedia).toHaveBeenCalledWith(fs.realpathSync(file), undefined);
    binding.release();
    await expect(host.execute("weixin_send_media", { path: file }, { threadId: "thread-1", turnId: "turn-1" })).resolves.toMatchObject({ success: false });
  });

  it("fails closed without explicit intent or for paths outside allowed roots", async () => {
    const { root, file, event, replyMedia } = fixture(); const host = new WeixinMediaToolHost();
    event.text = "帮我看看这张图片";
    host.bind("thread-1", event, [root]);
    await host.execute("weixin_send_media", { path: file }, { threadId: "thread-1", turnId: "turn-1" });
    expect(replyMedia).not.toHaveBeenCalled();
  });

  it("does not expose a recent image to another target", async () => {
    const { file, event } = fixture(); const host = new WeixinMediaToolHost();
    host.bind("thread-1", {
      ...event,
      text: "看看图片",
      attachments: [{ kind: "image", path: file, fileName: "answer.png", mimeType: "image/png", sizeBytes: 5, quoted: false }],
    }, []).release();
    const otherTarget = { ...event, target: "second@im.wechat", text: "把刚才的图片发回来" };

    const binding = host.bind("thread-2", otherTarget, []);
    expect(binding.promptLines).toEqual([]);
    await expect(host.execute("weixin_send_media", { path: file }, { threadId: "thread-2", turnId: "turn-2" })).resolves.toMatchObject({ success: false });
  });

  it("does not mistake a description of an incoming image for an outbound request", async () => {
    const { file, event, replyMedia } = fixture(); const host = new WeixinMediaToolHost();
    host.bind("thread-1", {
      ...event,
      text: "看看图片",
      attachments: [{ kind: "image", path: file, fileName: "answer.png", mimeType: "image/png", sizeBytes: 5, quoted: false }],
    }, []).release();

    const binding = host.bind("thread-1", { ...event, text: "分析刚才发来的图片" }, []);
    expect(binding.promptLines).toEqual([]);
    await expect(host.execute("weixin_send_media", { path: file }, { threadId: "thread-1", turnId: "turn-2" })).resolves.toMatchObject({ success: false });
    expect(replyMedia).not.toHaveBeenCalled();
  });

  it("expires recent images after ten minutes", async () => {
    let clock = 1_000; const { file, event } = fixture(); const host = new WeixinMediaToolHost(() => clock);
    host.bind("thread-1", {
      ...event,
      text: "看看图片",
      attachments: [{ kind: "image", path: file, fileName: "answer.png", mimeType: "image/png", sizeBytes: 5, quoted: false }],
    }, []).release();
    clock += 10 * 60 * 1000 + 1;

    const binding = host.bind("thread-1", { ...event, text: "把刚才的图片发回来" }, []);
    expect(binding.promptLines).toEqual([]);
    await expect(host.execute("weixin_send_media", { path: file }, { threadId: "thread-1", turnId: "turn-2" })).resolves.toMatchObject({ success: false });
  });

  it("finds an authorized library image by opaque id and sends it in the active turn", async () => {
    const { root, event, replyMedia } = fixture();
    const home = path.join(root, "home");
    for (const name of ["Downloads", "Pictures", "Documents"]) fs.mkdirSync(path.join(home, name), { recursive: true });
    const image = path.join(home, "Pictures", "holiday.png");
    fs.writeFileSync(image, "image");
    const library = new MediaExportLibrary(path.join(root, "grants.json"), home);
    library.configure({ rootIds: ["pictures"], confirmed: true });
    const host = new WeixinMediaToolHost(Date.now, library);
    const binding = host.bind("thread-1", { ...event, text: "把 Pictures 里的 holiday 图片发给我" }, []);

    expect(binding.promptLines).toContain(
      "微信图片外发目录已授权：Pictures。必须使用 weixin_find_images 查找，禁止使用 shell、exec 或普通文件工具读取这些目录；取得 mediaId 后使用 weixin_send_image 发送。",
    );

    const found = await host.execute("weixin_find_images", { query: "holiday" }, { threadId: "thread-1", turnId: "turn-1" });
    expect(found.success).toBe(true);
    const payload = JSON.parse((found.contentItems[0] as { text: string }).text) as { matches: Array<{ mediaId: string }>; };
    expect(payload.matches).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain(home);
    await expect(host.execute("weixin_send_image", { mediaId: payload.matches[0]!.mediaId }, { threadId: "thread-1", turnId: "turn-1" })).resolves.toMatchObject({ success: true });
    expect(replyMedia).toHaveBeenCalledWith(fs.realpathSync(image), undefined);
    binding.release();
  });

  it("invalidates a found image when its directory grant is revoked before send", async () => {
    const { root, event, replyMedia } = fixture();
    const home = path.join(root, "home");
    for (const name of ["Downloads", "Pictures", "Documents"]) fs.mkdirSync(path.join(home, name), { recursive: true });
    fs.writeFileSync(path.join(home, "Pictures", "private.png"), "image");
    const library = new MediaExportLibrary(path.join(root, "grants.json"), home);
    library.configure({ rootIds: ["pictures"], confirmed: true });
    const host = new WeixinMediaToolHost(Date.now, library);
    host.bind("thread-1", { ...event, text: "把 private 图片发给我" }, []);
    const found = await host.execute("weixin_find_images", { query: "private" }, { threadId: "thread-1", turnId: "turn-1" });
    const payload = JSON.parse((found.contentItems[0] as { text: string }).text) as { matches: Array<{ mediaId: string }> };

    library.configure({ rootIds: [], confirmed: true });
    await expect(host.execute("weixin_send_image", { mediaId: payload.matches[0]!.mediaId }, { threadId: "thread-1", turnId: "turn-1" })).resolves.toMatchObject({ success: false });
    expect(replyMedia).not.toHaveBeenCalled();
  });
});
