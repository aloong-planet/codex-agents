// Opt-in real model/vision evidence. Synthetic receipt only; not wallet-format or real-Feishu acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { CodexConversation } from "../src/codex-conversation.js";
import { CodexFinanceInterpreter } from "../src/finance-interpreter.js";
import { createIsolatedModelRuntime, ISOLATED_MODEL_DISABLED_FEATURES } from "../src/isolated-model-runtime.js";
import { resolveCodexExecutable, spawnStdioAppServer } from "../src/stdio-app-server-transport.js";

test.skipIf(process.env.PENNY_MODEL_LIVE !== "1")("interprets completed text and visible screenshot facts while clarifying plans and ambiguous refunds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "penny-live-"));
  const imagePath = path.join(root, "synthetic-payment.png");
  fs.copyFileSync(fileURLToPath(new URL("./fixtures/finance/synthetic-payment.png", import.meta.url)), imagePath);
  const runtime = createIsolatedModelRuntime({ root, scope: "penny-test", readableRoots: [root] });
  const conversation = new CodexConversation(() => spawnStdioAppServer(resolveCodexExecutable(process.env), ISOLATED_MODEL_DISABLED_FEATURES, runtime),
    120_000, undefined, undefined, 120_000, { permissionProfile: runtime.permissionProfile, structuredOutputSupported: true, webSearch: "disabled" });
  try {
    const model = process.env.PENNY_TEST_MODEL ?? "gpt-5.6-luna";
    const available = (await conversation.listModels()).find((item) => item.model === model);
    expect(available, "The production-compatible test model must be available").toBeDefined();
    const interpreter = new CodexFinanceInterpreter(conversation, runtime.cwd, () => ({ model, effort: "low" }));
    const base = { occurredAt: Date.parse("2026-11-06T12:00:00+08:00"), images: [], context: { records: [], previews: [], recent: [] } };
    const record = await interpreter.interpret({ ...base, text: "帮我记账：今天午饭已支付 35 元。" });
    console.info(JSON.stringify({ scenario: "completed_text", model, command: record }));
    expect(record).toMatchObject({ kind: "record", book: "personal", entries: [{ kind: "expense", amount: expect.stringMatching(/^35(?:\.00)?$/u), currency: "CNY" }] });
    for (const text of ["我打算明天买电脑，大概 8000 元。", "收到 40 元退款。原来的交易是哪笔我还没说。"] ) {
      const result = await interpreter.interpret({ ...base, text });
      console.info(JSON.stringify({ scenario: "ambiguous_text", text, command: result }));
      expect(result.kind).toBe("clarify");
    }
    const image = await interpreter.interpret({ ...base, images: [imagePath], text: "请识别图中的实际付款信息，先给我预览。" });
    console.info(JSON.stringify({ scenario: "synthetic_image", command: image }));
    expect(image).toMatchObject({ kind: "preview", book: "personal", entries: [{ kind: "expense", amount: "28.50", date: "2026-11-06", status: "settled" }] });
  } finally { await conversation.close(); await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}, 480000);
