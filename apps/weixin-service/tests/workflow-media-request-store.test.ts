import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InboundTextEvent } from "../src/demo-service.js";
import type { StoredIlinkMedia } from "../src/ilink-media.js";
import { MediaExportLibrary } from "../src/media-export-library.js";
import { WorkflowMediaArtifactStore } from "../src/workflow-media-artifact-store.js";
import { WorkflowMediaRequestStore } from "../src/workflow-media-request-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function image(root: string, name: string, quoted = false): StoredIlinkMedia {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, name);
  return { kind: "image", path: filePath, fileName: name, mimeType: "image/png", sizeBytes: name.length, quoted };
}

function event(input: Partial<InboundTextEvent> & Pick<InboundTextEvent, "key" | "text">): InboundTextEvent {
  return {
    messageId: input.key,
    accountId: "account-a",
    target: "target-a",
    source: "text",
    receivedAt: 1_000,
    replyText: vi.fn(),
    ...input,
  };
}

function fixture(now = () => 1_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-media-request-"));
  dirs.push(root);
  const home = path.join(root, "home");
  for (const name of ["Downloads", "Pictures", "Documents"]) fs.mkdirSync(path.join(home, name), { recursive: true });
  const inboundRoot = path.join(root, "media", "inbound");
  fs.mkdirSync(inboundRoot, { recursive: true });
  const library = new MediaExportLibrary(path.join(root, "grants.json"), home);
  const artifacts = new WorkflowMediaArtifactStore(path.join(root, "artifacts"), library, now, 60_000, inboundRoot);
  const requests = new WorkflowMediaRequestStore(path.join(root, "requests"), artifacts, now);
  return { root, inboundRoot, requests };
}

describe("WorkflowMediaRequestStore", () => {
  it("freezes the source selected by the main model without reclassifying the user text", () => {
    const { inboundRoot, requests } = fixture();
    const current = event({
      key: "model-current",
      text: "处理一下",
      attachments: [image(inboundRoot, "chosen-by-model.png")],
    });
    requests.prepareForToolTurn(current);
    const currentRequest = requests.resolve(requests.captureFromTool(current.key, {
      kind: "image",
      source: "current",
    }));
    expect(currentRequest).toMatchObject({
      source: "inbound",
      candidates: [{ fileName: "chosen-by-model.png" }],
    });

    const local = event({ key: "model-local", text: "也把那个给我" });
    requests.prepareForToolTurn(local);
    expect(requests.resolve(requests.captureFromTool(local.key, {
      kind: "image",
      source: "local",
      query: "holiday",
      selection: "latest",
    }))).toEqual({
      source: "local",
      candidates: [],
      query: "holiday",
      selection: "latest",
    });
  });

  it("freezes quoted images ahead of current, recent and local sources", () => {
    const { inboundRoot, requests } = fixture();
    const current = image(inboundRoot, "current.png");
    const quoted = image(inboundRoot, "quoted.png", true);
    const incoming = event({
      key: "message-1",
      text: "把 Downloads 最新图片和这张图发给我",
      attachments: [current],
      quote: { attachments: [quoted] },
    });

    expect(requests.observe(incoming)).toBe("quote");
    const request = requests.resolve(requests.capture(incoming.key, { query: "最新", rootId: "downloads" }));
    expect(request).toMatchObject({ source: "inbound", candidates: [{ fileName: "quoted.png" }] });
    expect(request?.candidates).toHaveLength(1);
  });

  it("uses recent images only for an explicit recent reference and isolates account plus target", () => {
    const { inboundRoot, requests } = fixture();
    requests.observe(event({ key: "seed", text: "收到", attachments: [image(inboundRoot, "recent.png")] }));

    const recent = event({ key: "recent", text: "把刚才的图片发给我", receivedAt: 1_500 });
    expect(requests.observe(recent)).toBe("recent");
    expect(requests.resolve(requests.capture(recent.key, {}))?.candidates[0]?.fileName).toBe("recent.png");

    const other = event({ key: "other", text: "把刚才的图片发给我", target: "target-b", receivedAt: 1_500 });
    expect(requests.observe(other)).toBeNull();

    const older = event({ key: "older", text: "把刚才的图片发给我", receivedAt: 999 });
    expect(requests.observe(older)).toBeNull();
  });

  it("restores recent-image references after a service restart and expires them after ten minutes", () => {
    let currentTime = 1_000;
    const { root, inboundRoot, requests } = fixture(() => currentTime);
    requests.observe(event({ key: "seed", text: "收到", attachments: [image(inboundRoot, "restart.png")] }));

    const library = new MediaExportLibrary(path.join(root, "grants.json"), path.join(root, "home"));
    const artifacts = new WorkflowMediaArtifactStore(path.join(root, "artifacts"), library, () => currentTime, 60_000, inboundRoot);
    const restored = new WorkflowMediaRequestStore(path.join(root, "requests"), artifacts, () => currentTime);
    const recent = event({ key: "recent-after-restart", text: "把刚才的图片发给我", receivedAt: currentTime });
    expect(restored.observe(recent)).toBe("recent");

    currentTime += 10 * 60 * 1_000 + 1;
    const expired = event({ key: "expired", text: "把刚才的图片发给我", receivedAt: currentTime });
    expect(restored.observe(expired)).toBeNull();
  });

  it("freezes an explicit authorized-directory request without inventing another source", () => {
    const { requests } = fixture();
    const incoming = event({ key: "local", text: "把 Pictures 里的 holiday 图片发给我" });

    expect(requests.observe(incoming)).toBe("local");
    expect(requests.resolve(requests.capture(incoming.key, {
      query: "holiday",
      rootId: "pictures",
      caption: "周末旅行",
    }))).toEqual({
      source: "local",
      candidates: [],
      query: "holiday",
      rootId: "pictures",
      caption: "周末旅行",
    });
  });

  it("keeps an explicit user directory when an untrusted Planner slot is missing or conflicts", () => {
    const { requests } = fixture();
    const omitted = event({ key: "local-omitted", text: "把相册中最新一张图片发给我" });
    expect(requests.observe(omitted)).toBe("local");
    expect(requests.resolve(requests.capture(omitted.key, { selection: "latest" }))).toMatchObject({
      source: "local",
      rootId: "pictures",
      selection: "latest",
    });

    const conflicting = event({ key: "local-conflicting", text: "把相册中最新一张图片发给我" });
    expect(requests.observe(conflicting)).toBe("local");
    expect(requests.resolve(requests.capture(conflicting.key, {
      rootId: "downloads",
      selection: "latest",
    }))).toMatchObject({ rootId: "pictures" });
  });

  it("contains a malformed recent-image cache instead of failing unrelated inbound handling", () => {
    const { root, requests } = fixture();
    const targetKey = crypto.createHash("sha256").update("account-a\u0000target-a").digest("hex");
    fs.writeFileSync(path.join(root, "requests", "recent.json"), JSON.stringify({ [targetKey]: "not-an-array" }));

    expect(requests.observe(event({ key: "ordinary", text: "普通消息" }))).toBeNull();
    expect(requests.observe(event({ key: "recent", text: "把刚才的图片发给我" }))).toBeNull();
  });
});
