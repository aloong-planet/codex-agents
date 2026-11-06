// Feishu envelope/resource shapes reuse feishu-channel.test.ts and feishu-inbound-media.test.ts.
// The interpreter is the external model substitute: these tests do not prove real payment-image recognition or phone delivery.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { FinanceService } from "../src/finance-service.js";
import { FixtureFeishuTransport } from "../src/fixture-feishu-transport.js";
import type { FinanceConfiguration } from "../src/finance-config.js";
import type { FinanceCommand, FinanceEntry, FinanceInterpretationInput } from "../src/finance-interpreter.js";

const config: FinanceConfiguration = { appId: "cli_123456789abcdef0", appSecret: "fixture", tenantKey: "tenant_penny", ownerOpenId: "ou_pennyowner", privateChatId: "oc_privatepenny",
  webhook: { port: 4319, path: "/feishu/penny/events", encryptKey: "fixture", verificationToken: "fixture" } };
const expense: FinanceEntry = { date: null, kind: "expense", amount: "35", currency: "CNY", description: "午饭", category: "餐饮",
  selfTransferConfirmed: false, originalRef: null, unrecordedOriginal: null, status: "settled", issue: null };
const query: FinanceCommand = { kind: "query", book: "personal", from: "2026-11-01", to: "2026-11-30", category: null };
const event = (id: string, text: string) => ({ app_id: config.appId, tenant_key: config.tenantKey, sender: { sender_type: "user", sender_id: { open_id: config.ownerOpenId } },
  message: { message_id: id, chat_id: config.privateChatId, chat_type: "p2p", create_time: "1793952000000", message_type: "text", content: JSON.stringify({ text }) } });
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
function directory() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "penny-service-")); cleanups.push(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
async function start(root: string, decide: (input: FinanceInterpretationInput) => FinanceCommand) {
  const transport = new FixtureFeishuTransport(), interpret = vi.fn(async (input: FinanceInterpretationInput) => decide(input));
  const at = performance.now();
  const service = new FinanceService({ root, config, transport, interpreter: { interpret, close: async () => {} } });
  console.info(`finance service construction ${Math.round(performance.now() - at)}ms`);
  await service.start(); await transport.emit({ connection: "ready" });
  transport.bindApplications(new Map([["penny", transport]]));
  cleanups.push(() => service.close());
  return { service, transport, interpret, send: (id: string, text: string) => transport.emit({ event: event(id, text) }) };
}

test("only the bound private owner reaches bookkeeping and receives Penny's saved text result", async () => {
  const app = await start(directory(), (input) => input.text === "本月汇总" ? query : { kind: "record", evidence: input.text, book: "personal", entries: [expense] });
  const base = event("denied", "午饭 35 元");
  for (const denied of [{ ...base, app_id: "cli_other" }, { ...base, tenant_key: "other" },
    { ...base, sender: { sender_type: "app", sender_id: { open_id: config.ownerOpenId } } },
    { ...base, sender: { sender_type: "user", sender_id: { open_id: "ou_other" } } },
    { ...base, message: { ...base.message, chat_type: "group", message_type: "image", content: JSON.stringify({ image_key: "not_downloadable" }) } },
    { ...base, message: { ...base.message, chat_id: "oc_other" } }]) await app.transport.emit({ event: denied });
  expect(app.interpret).not.toHaveBeenCalled(); expect(app.transport.getTextOutbox()).toEqual([]);
  await app.send("lunch", "午饭 35 元"); await app.send("lunch", "午饭 35 元"); await app.send("summary", "本月汇总");
  expect(app.transport.getTextOutbox()).toHaveLength(2);
  expect(app.transport.getTextOutbox()[0]).toMatchObject({ chatId: "oc_privatepenny", message: expect.stringContaining("F00000001（版本 1）\n个人账 · 2026-11-06 · 支出 ¥35.00 · 午饭") });
  expect(app.transport.getTextOutbox()[1]!.message).toContain("净支出 ¥35.00");
  expect(JSON.stringify(app.service.state())).not.toMatch(/35|午饭|F00000001/u);
});

test("downloaded images stay pending until the complete revised preview is shown and confirmed", async () => {
  const bytes = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=";
  const app = await start(directory(), (input) => {
    if (input.images.length) {
      expect(input.images).toHaveLength(1);
      expect(fs.readFileSync(input.images[0]!).toString("base64")).toBe(bytes);
      return { kind: "preview", book: "personal", entries: [{ ...expense, date: "2026-11-06", amount: null, status: "unresolved", issue: "实付金额看不清" }] };
    }
    if (input.text === "金额 28 元，记经营账") {
      expect(input.context.previews[0]).toMatchObject({ id: "Q00000001", revision: 1, rows: [{ issue: expect.stringContaining("实付金额看不清") }] });
      return { kind: "revise", previewId: "Q00000001", revision: 1, book: "business", entries: [{ ...expense, date: "2026-11-06", amount: "28" }] };
    }
    return { ...query, book: input.text === "经营账汇总" ? "business" : "personal" };
  });
  const imageEvent = event("image", ""); imageEvent.message.message_type = "image"; imageEvent.message.content = JSON.stringify({ image_key: "img_fixture" });
  await app.transport.emit({ event: imageEvent, resources: [{ messageId: "image", resourceKey: "img_fixture", type: "image", contentType: "application/octet-stream", bytesBase64: bytes }] });
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("目前不能确认入账");
  await app.send("early", "确认 Q00000001/1");
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("尚未入账");
  await app.send("zero", "本月汇总"); expect(app.transport.getTextOutbox().at(-1)!.message).toContain("净支出 ¥0.00");
  await app.send("details", "金额 28 元，记经营账");
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("入账预览 · 经营账 · Q00000001/2");
  await app.send("stale", "确认 Q00000001/1"); expect(app.transport.getTextOutbox().at(-1)!.message).toContain("预览已更新");
  await app.send("confirm", "确认 Q00000001/2");
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("F00000001（版本 1）\n经营账 · 2026-11-06 · 支出 ¥28.00");
  await app.send("confirm_again", "确认 Q00000001/2");
  await app.send("business", "经营账汇总"); expect(app.transport.getTextOutbox().at(-1)!.message).toContain("净支出 ¥28.00");
  await app.send("personal", "本月汇总"); expect(app.transport.getTextOutbox().at(-1)!.message).toContain("净支出 ¥0.00");
});

test("restart after a lost send acknowledgment preserves the financial result without resending or reinterpreting it", async () => {
  const root = directory();
  const first = await start(root, (input) => ({ kind: "record", evidence: input.text, book: "personal", entries: [expense] }));
  await first.transport.emit({ applicationControl: { agentId: "penny", textOutcomes: ["unknown"] } });
  await first.send("record", "午饭 35 元");
  expect(first.service.state()).toMatchObject({ error: "penny_reply_unknown" });
  expect(first.transport.getTextOutbox()).toHaveLength(1);
  await first.service.close();
  const second = await start(root, () => query);
  await second.send("record", "午饭 35 元");
  expect(second.interpret).not.toHaveBeenCalled(); expect(second.transport.getTextOutbox()).toEqual([]);
  await second.send("summary", "本月汇总");
  expect(second.transport.getTextOutbox().at(-1)!.message).toContain("净支出 ¥35.00");
  expect(second.transport.getTextOutbox().at(-1)!.message.match(/F\d{8}/gu)).toEqual(["F00000001"]);
});

test("an explicit older reference remains correctable outside the recent context window", async () => {
  const app = await start(directory(), (input) => {
    if (input.text === "记录这 31 笔支出") return { kind: "record", evidence: input.text, book: "personal",
      entries: Array.from({ length: 31 }, (_, index) => ({ ...expense, amount: String(index + 1), description: `支出${index + 1}` })) };
    if (input.text === "更正 F00000001 为 0.50 元") {
      expect(input.context.records.find((record) => record.ref === "F00000001")).toMatchObject({ amountMinor: "100", description: "支出1" });
      return { kind: "correct", ref: "F00000001", revision: 1, evidence: input.text, book: "personal", replacement: { ...expense, amount: "0.50", description: "支出1" } };
    }
    return query;
  });
  await app.send("seed31", "记录这 31 笔支出");
  await app.send("older", "更正 F00000001 为 0.50 元");
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("F00000001（版本 2）");
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("支出 ¥0.50 · 支出1");
  await app.send("total", "本月汇总"); expect(app.transport.getTextOutbox().at(-1)!.message).toContain("净支出 ¥495.50");
});

test("an uncertain preview cannot be confirmed until the owner explicitly requests and receives it again", async () => {
  const app = await start(directory(), () => ({ kind: "preview", book: "personal", entries: [{ ...expense, date: "2026-11-06", amount: "28.50" }] }));
  const imageEvent = event("uncertain_image", ""); imageEvent.message.message_type = "image"; imageEvent.message.content = '{"image_key":"img_uncertain"}';
  await app.transport.emit({ applicationControl: { agentId: "penny", textOutcomes: ["unknown"] } });
  await app.transport.emit({ event: imageEvent, resources: [{ messageId: "uncertain_image", resourceKey: "img_uncertain", type: "image", contentType: "image/png",
    bytesBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=" }] });
  await app.transport.emit({ event: imageEvent });
  expect(app.transport.getTextOutbox()).toHaveLength(1);
  await app.send("unshown", "确认 Q00000001/1");
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("当前完整预览尚未确认送达");
  await app.send("show", "查看预览 Q00000001");
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("确认 Q00000001/1");
  await app.send("shown", "确认 Q00000001/1");
  expect(app.transport.getTextOutbox().at(-1)!.message).toContain("已入账 1 笔。\nF00000001（版本 1）");
});
