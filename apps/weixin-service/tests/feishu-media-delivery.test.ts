import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FeishuMediaDelivery, type FeishuMediaTransport } from "../src/feishu-media-delivery.js";
import { DurableEffectLedger } from "../src/durable-effect-ledger.js";
import { PersonalOwnerIdentity } from "../src/personal-owner-identity.js";

// External network is fake. Platform upload validation and phone receipt require real-channel acceptance.
// Payload shapes follow pinned SDK 1.76.0 and official image/file/post message examples.
function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-media-"));
  const snapshots = path.join(root, "snapshots"); fs.mkdirSync(snapshots);
  const filePath = path.join(snapshots, "snapshot.bin"); fs.writeFileSync(filePath, "exact snapshot");
  const owner = new PersonalOwnerIdentity({ memoryAccountId: "old-bot", bindings: [
    { channel: "feishu", accountId: "cli_0123456789abcdef", target: "oc_owner", senderId: "ou_owner" },
  ] }, "feishu");
  const ledger = new DurableEffectLedger(path.join(root, "effects.sqlite"));
  const uploads: { kind: string; bytes: string; fileName: string }[] = [];
  const messages: Parameters<FeishuMediaTransport["sendResource"]>[0][] = [];
  const transport: FeishuMediaTransport = {
    async upload(input) { uploads.push({ kind: input.kind, bytes: input.bytes.toString(), fileName: input.fileName }); return "resource_key"; },
    async sendResource(input) { messages.push(input); return { code: 0, data: { message_id: "om_media" } }; },
  };
  const config = { owner, binding: { channel: "feishu" as const, accountId: "cli_0123456789abcdef", target: "oc_owner", senderId: "ou_owner" } };
  const port = new FeishuMediaDelivery(config, transport, ledger, [snapshots], () => true);
  return { root, snapshots, filePath, owner, config, ledger, transport, port, uploads, messages,
    close() { ledger.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

it("delivers only the prepared snapshot to the bound owner and reconciles accepted operations", async () => {
  const h = harness();
  try {
    const input = { ...h.owner.conversationAddress(), filePath: h.filePath, operationId: "image-one" };
    expect(await h.port.sendImage(input)).toMatchObject({ ok: true, acceptedSegments: 1 });
    expect(h.uploads).toEqual([{ kind: "image", bytes: "exact snapshot", fileName: "snapshot.bin" }]);
    expect(h.messages).toEqual([{ chatId: "oc_owner", msgType: "image", content: '{"image_key":"resource_key"}', uuid: expect.stringMatching(/^[a-f0-9]{32}$/) }]);
    expect(await h.port.reconcile("image-one")).toEqual({ status: "accepted" });
    expect(await h.port.sendImage(input)).toMatchObject({ ok: true });
    expect(h.messages).toHaveLength(1); expect(h.uploads).toHaveLength(1);
    expect(await h.port.sendFile({ ...input, operationId: "file-one", fileName: "报告.pdf" })).toMatchObject({ ok: true });
    expect(h.uploads[1]).toEqual({ kind: "file", bytes: "exact snapshot", fileName: "报告.pdf" });
    expect(h.messages[1]).toMatchObject({ chatId: "oc_owner", msgType: "file", content: '{"file_key":"resource_key"}' });
  } finally { h.close(); }
});

it("accepts an existing authorized root when another unused snapshot root is absent", async () => {
  const h = harness();
  try {
    const port = new FeishuMediaDelivery(h.config, h.transport, h.ledger, [path.join(h.root, "not-created-yet"), h.snapshots], () => true);
    expect(await port.sendImage({ ...h.owner.conversationAddress(), filePath: h.filePath, operationId: "unused-root" })).toMatchObject({ ok: true });
    expect(h.uploads).toHaveLength(1); expect(h.messages).toHaveLength(1);
  } finally { h.close(); }
});

it("retains an uncertain send across ledger reopening without uploading or sending again", async () => {
  const h = harness();
  try {
    h.transport.sendResource = async (input) => { h.messages.push(input); throw new Error("connection lost after submission"); };
    const input = { ...h.owner.conversationAddress(), filePath: h.filePath, operationId: "uncertain-file" };
    expect(await h.port.sendFile(input)).toEqual({ ok: false, reason: "unknown", acceptedSegments: 0 });
    expect(await h.port.sendFile(input)).toEqual({ ok: false, reason: "unknown", acceptedSegments: 0 });
    const reopened = new DurableEffectLedger(path.join(h.root, "effects.sqlite"));
    try {
      const port = new FeishuMediaDelivery(h.config, h.transport, reopened, [h.snapshots], () => true);
      expect(await port.reconcile("uncertain-file")).toEqual({ status: "unknown" });
      expect(await port.sendFile(input)).toEqual({ ok: false, reason: "unknown", acceptedSegments: 0 });
      expect(h.uploads).toHaveLength(1);
      expect(h.messages).toHaveLength(1);
    } finally { reopened.close(); }
  } finally { h.close(); }
});

it("rejects unauthorized or invalid snapshots before uploading any bytes", async () => {
  const h = harness();
  try {
    const input = { ...h.owner.conversationAddress(), filePath: h.filePath, operationId: "guarded" };
    expect(await h.port.sendFile({ ...input, target: "oc_other" })).toMatchObject({ ok: false, reason: "unavailable" });
    const stopped = new FeishuMediaDelivery(h.config, h.transport, h.ledger, [h.snapshots], () => false);
    expect(await stopped.sendFile(input)).toMatchObject({ ok: false, reason: "unavailable" });
    const outside = path.join(h.root, "outside.bin"); fs.writeFileSync(outside, "private outside snapshot");
    const link = path.join(h.snapshots, "link.bin"); fs.symlinkSync(h.filePath, link);
    const empty = path.join(h.snapshots, "empty.bin"); fs.writeFileSync(empty, "");
    const large = path.join(h.snapshots, "large.bin");
    const fd = fs.openSync(large, "w"); fs.ftruncateSync(fd, 30 * 1024 * 1024 + 1); fs.closeSync(fd);
    for (const filePath of [outside, link, empty, large]) {
      expect(await h.port.sendFile({ ...input, filePath })).toMatchObject({ ok: false, reason: "rejected" });
      expect(h.uploads).toEqual([]); expect(h.messages).toEqual([]);
    }
    fs.truncateSync(large, 10 * 1024 * 1024 + 1);
    expect(await h.port.sendImage({ ...input, filePath: large })).toMatchObject({ ok: false, reason: "rejected" });
    expect(await h.port.sendFile({ ...input, fileName: "../secret" })).toMatchObject({ ok: false, reason: "rejected" });
    expect(h.uploads).toEqual([]); expect(h.messages).toEqual([]);
  } finally { h.close(); }
});

it("keeps image captions in one submission and suppresses a concurrent duplicate", async () => {
  const h = harness();
  try {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    h.transport.sendResource = async (input) => { h.messages.push(input); await barrier; return { code: 0, data: { message_id: "om_caption" } }; };
    const input = { ...h.owner.conversationAddress(), filePath: h.filePath, operationId: "caption", caption: "保留这段说明\n第二行" };
    const first = h.port.sendImage(input);
    expect(await h.port.sendImage(input)).toEqual({ ok: false, reason: "unknown", acceptedSegments: 0 });
    release();
    expect(await first).toMatchObject({ ok: true, messageId: "om_caption" });
    expect(h.uploads).toHaveLength(1);
    expect(h.messages).toEqual([{ chatId: "oc_owner", msgType: "post", uuid: expect.stringMatching(/^[a-f0-9]{32}$/),
      content: JSON.stringify({ zh_cn: { title: "", content: [[{ tag: "img", image_key: "resource_key" }], [{ tag: "text", text: "保留这段说明\n第二行" }]] } }) }]);
    expect(await h.port.reconcile("caption")).toEqual({ status: "accepted" });
  } finally { h.close(); }
});

it("distinguishes explicit platform rejection from a response without acceptance proof", async () => {
  const h = harness();
  try {
    const input = { ...h.owner.conversationAddress(), filePath: h.filePath, operationId: "rejected-file" };
    h.transport.sendResource = async (message) => { h.messages.push(message); return { code: 230001 }; };
    expect(await h.port.sendFile(input)).toEqual({ ok: false, reason: "rejected", acceptedSegments: 0 });
    expect(await h.port.reconcile("rejected-file")).toEqual({ status: "rejected", errorCode: "feishu_media_rejected" });
    expect(await h.port.sendFile(input)).toMatchObject({ ok: false, reason: "rejected" });
    expect(h.messages).toHaveLength(1);
    h.transport.sendResource = async (message) => { h.messages.push(message); return { code: 0 }; };
    expect(await h.port.sendFile({ ...input, operationId: "missing-proof" })).toEqual({ ok: false, reason: "unknown", acceptedSegments: 0 });
    expect(await h.port.reconcile("missing-proof")).toEqual({ status: "unknown" });
    expect(h.uploads).toHaveLength(2); expect(h.messages).toHaveLength(2);
  } finally { h.close(); }
});
