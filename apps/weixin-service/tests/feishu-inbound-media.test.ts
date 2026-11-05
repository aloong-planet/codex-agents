import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { FeishuInboundMedia, type FeishuResourceTransport } from "../src/feishu-inbound-media.js";

// External shapes follow pinned SDK message.get/resource.get; real platform permissions remain unverified.
it("identifies PNG bytes when the resource header is generic", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-image-type-"));
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=", "base64");
  try {
    const media = new FeishuInboundMedia(root, "oc_owner", { async getMessage() { throw new Error("unexpected"); }, async download() {
      const stream = Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]);
      return { stream, contentType: "application/octet-stream", cancel() { stream.destroy(); } };
    } });
    const result = await media.normalize({ messageId: "om_png", type: "image", content: '{"image_key":"img_png"}' });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]).toMatchObject({ mimeType: "image/png", fileName: expect.stringMatching(/^image-[a-f0-9]{64}\.png$/) });
    expect(path.extname(result.attachments![0]!.path)).toBe(".png");
    expect(fs.readFileSync(result.attachments![0]!.path)).toEqual(bytes);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("cancels a stalled resource at the deadline and removes its partial bytes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-download-deadline-"));
  const stream = new PassThrough();
  let cancelled = false;
  try {
    const media = new FeishuInboundMedia(root, "oc_owner", { async getMessage() { throw new Error("unexpected"); }, async download() {
      return { stream, cancel() { cancelled = true; stream.destroy(); } };
    } });
    const result = media.normalize({ messageId: "om_stalled", type: "file", content: '{"file_key":"file_stalled","file_name":"report.pdf"}' });
    const failure = expect(result).rejects.toThrow();
    stream.write(Buffer.from("partial"));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(cancelled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(cancelled).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  } finally { stream.destroy(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("normalizes a current image and same-chat quoted file into durable private attachments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-inbound-media-"));
  const requests: unknown[] = [];
  const transport: FeishuResourceTransport = {
    async getMessage(messageId) {
      requests.push(messageId);
      return { code: 0, data: { items: [{ message_id: "om_parent", chat_id: "oc_owner", msg_type: "file", body: { content: '{"file_key":"file_parent","file_name":"报告.pdf"}' } }] } };
    },
    async download(input) {
      requests.push(input);
      const stream = Readable.from([Buffer.from(input.type === "image" ? "image bytes" : "pdf bytes")]);
      return { stream, contentType: input.type === "image" ? "image/png" : "application/pdf", cancel() { stream.destroy(); } };
    },
  };
  try {
    const media = new FeishuInboundMedia(root, "oc_owner", transport);
    const result = await media.normalize({ messageId: "om_current", type: "image", content: '{"image_key":"img_current"}', parentId: "om_parent" });
    expect(result).toMatchObject({ source: "media", text: "", attachments: [{ kind: "image", mimeType: "image/png", sizeBytes: 11, quoted: false }],
      quote: { text: "", attachments: [{ kind: "file", fileName: "报告.pdf", sizeBytes: 9, quoted: true }] } });
    expect(result.attachments).toHaveLength(1); expect(result.quote?.attachments).toHaveLength(1);
    expect(fs.readFileSync(result.attachments![0]!.path, "utf8")).toBe("image bytes");
    expect(fs.readFileSync(result.quote!.attachments[0]!.path, "utf8")).toBe("pdf bytes");
    expect(fs.statSync(result.attachments![0]!.path).mode & 0o777).toBe(0o600);
    expect(requests).toContainEqual({ messageId: "om_current", resourceKey: "img_current", type: "image" });
    expect(requests).toContainEqual({ messageId: "om_parent", resourceKey: "file_parent", type: "file" });
    expect(JSON.stringify(result)).not.toContain("img_current"); expect(JSON.stringify(result)).not.toContain("file_parent");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("keeps group attachments separate and admits quoted resources only from that group", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-group-media-"));
  let quoteChat = "oc_alpha", downloads = 0;
  const transport: FeishuResourceTransport = {
    async getMessage() {
      return { code: 0, data: { items: [{ message_id: "om_parent", chat_id: quoteChat, msg_type: "file", body: { content: '{"file_key":"file_parent","file_name":"report.pdf"}' } }] } };
    },
    async download(input) {
      downloads++;
      const stream = Readable.from([Buffer.from(input.type === "image" ? "group image" : "group quote")]);
      return { stream, contentType: input.type === "image" ? "image/png" : "application/pdf", cancel() { stream.destroy(); } };
    },
  };
  try {
    const media = new FeishuInboundMedia(root, "oc_owner", transport);
    const alpha = media.forChat("oc_alpha"), beta = media.forChat("oc_beta");
    const current = { messageId: "om_image", type: "image", content: '{"image_key":"img_current"}' };
    const result = await alpha.normalize({ ...current, parentId: "om_parent" });
    expect(result.attachments).toHaveLength(1);
    expect(result.quote?.attachments).toHaveLength(1);
    expect(fs.readFileSync(result.attachments![0]!.path, "utf8")).toBe("group image");
    expect(fs.readFileSync(result.quote!.attachments[0]!.path, "utf8")).toBe("group quote");
    expect(path.dirname(result.attachments![0]!.path)).toBe(media.readableRoot("oc_alpha"));
    const other = await beta.normalize(current), personal = await media.normalize(current);
    expect(new Set([result.attachments![0]!.path, other.attachments![0]!.path, personal.attachments![0]!.path]).size).toBe(3);
    const before = downloads;
    quoteChat = "oc_beta";
    await expect(alpha.normalize({ ...current, parentId: "om_parent" })).rejects.toThrow("feishu_quote_invalid");
    quoteChat = "oc_owner";
    await expect(alpha.normalize({ ...current, parentId: "om_parent" })).rejects.toThrow("feishu_quote_invalid");
    expect(downloads).toBe(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("retains a long display filename without exceeding the local storage component limit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-long-name-"));
  const fileName = `x.${"a".repeat(253)}`;
  try {
    const media = new FeishuInboundMedia(root, "oc_owner", { async getMessage() { throw new Error("unexpected quote"); }, async download() {
      const stream = Readable.from([Buffer.from("file bytes")]); return { stream, cancel() { stream.destroy(); } };
    } });
    const result = await media.normalize({ messageId: "om_file", type: "file", content: JSON.stringify({ file_key: "file_long", file_name: fileName }) });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments![0]!.fileName).toBe(fileName);
    expect(fs.readFileSync(result.attachments![0]!.path, "utf8")).toBe("file bytes");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("rejects foreign quotes and invalid resources without retaining a partial download", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-invalid-media-"));
  let downloads = 0;
  let cancelled = 0;
  let mode: "empty" | "failed" | "large" = "empty";
  const block = Buffer.alloc(1024 * 1024);
  const transport: FeishuResourceTransport = {
    async getMessage() { return { code: 0, data: { items: [{ message_id: "om_parent", chat_id: "oc_foreign", msg_type: "image", body: { content: '{"image_key":"img_foreign"}' } }] } }; },
    async download() {
      downloads++;
      const stream = Readable.from((async function* () {
        if (mode === "empty") return;
        if (mode === "failed") { yield Buffer.from("partial"); throw new Error("stream interrupted"); }
        for (let n = 0; n < 101; n++) yield block;
      })());
      return { stream, cancel() { cancelled++; stream.destroy(); } };
    },
  };
  try {
    const media = new FeishuInboundMedia(root, "oc_owner", transport);
    const image = { messageId: "om_image", type: "image", content: '{"image_key":"img_owner"}' };
    await expect(media.normalize({ ...image, parentId: "om_parent" })).rejects.toThrow("feishu_quote_invalid");
    await expect(media.normalize({ ...image, content: "bad json" })).rejects.toThrow("feishu_message_invalid");
    await expect(media.normalize({ ...image, type: "file", content: '{"file_key":"file_owner","file_name":"../secret"}' })).rejects.toThrow("feishu_resource_invalid");
    expect(downloads).toBe(0);
    for (const scenario of ["empty", "failed", "large"] as const) {
      mode = scenario;
      await expect(media.normalize(image)).rejects.toThrow(scenario === "empty" ? "feishu_resource_empty" : scenario === "failed" ? "stream interrupted" : "feishu_resource_too_large");
      expect(fs.readdirSync(root)).toEqual([]);
    }
    expect(downloads).toBe(3); expect(cancelled).toBe(3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Official receive-message example is flat title/content, not outgoing post.zh_cn.
it("normalizes rich post paragraphs and image order without silently dropping unsupported content", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-post-"));
  const downloads: string[] = [];
  const content = JSON.stringify({ title: "Title", content: [
    [{ tag: "text", text: "The first row:", style: ["bold"] }, { tag: "a", href: "https://open.feishu.cn", text: "Link", style: [] }, { tag: "at", user_id: "@_user_1", user_name: "", style: [] }],
    [{ tag: "img", image_key: "img_first" }], [{ tag: "text", text: "The second row:", style: [] }], [{ tag: "img", image_key: "img_second" }],
    [{ tag: "code_block", language: "GO", text: "return 0" }], [{ tag: "emotion", emoji_type: "SMILE" }], [{ tag: "hr" }],
  ] });
  const transport: FeishuResourceTransport = {
    async getMessage() { return { code: 0, data: { items: [{ message_id: "om_post", chat_id: "oc_owner", msg_type: "post", body: { content } }] } }; },
    async download({ resourceKey }) {
      downloads.push(resourceKey);
      const stream = Readable.from([Buffer.from(resourceKey === "img_first" ? "first bytes" : "second bytes")]);
      return { stream, contentType: "image/png", cancel() { stream.destroy(); } };
    },
  };
  try {
    const media = new FeishuInboundMedia(root, "oc_owner", transport);
    const result = await media.normalize({ messageId: "om_post", type: "post", content });
    expect(result.text).toBe("Title\nThe first row:Link (https://open.feishu.cn)@_user_1\nThe second row:\nreturn 0\n[SMILE]\n---");
    expect(result.source).toBe("media");
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments!.map((item) => fs.readFileSync(item.path, "utf8"))).toEqual(["first bytes", "second bytes"]);
    expect(downloads).toEqual(["img_first", "img_second"]);
    const quote = await media.normalize({ messageId: "om_reply", type: "text", content: '{"text":"选择第二张"}', parentId: "om_post" });
    expect(quote.quote?.attachments).toHaveLength(2);
    expect(quote.quote?.attachments.map((item) => item.quoted)).toEqual([true, true]);
    expect(quote.quote?.text).toBe(result.text);
    const before = downloads.length;
    for (const invalid of [
      { title: "", content: [[{ tag: "img", image_key: "img_first" }, { tag: "media", file_key: "file_video" }]] },
      { title: "", content: [[{ tag: "text" }]] },
      { title: "", content: [[{ tag: "text", text: "x".repeat(8001) }]] },
      { title: "", content: Array.from({ length: 21 }, () => [{ tag: "img", image_key: "img_first" }]) },
    ]) await expect(media.normalize({ messageId: "om_invalid", type: "post", content: JSON.stringify(invalid) })).rejects.toThrow();
    expect(downloads).toHaveLength(before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
