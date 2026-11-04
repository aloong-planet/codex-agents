import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MediaExportLibrary } from "../src/media-export-library.js";
import { WorkflowMediaArtifactStore } from "../src/workflow-media-artifact-store.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

async function fixture(now = 1_000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-media-artifact-"));
  dirs.push(root);
  const home = path.join(root, "home");
  for (const name of ["Downloads", "Pictures", "Documents"]) fs.mkdirSync(path.join(home, name), { recursive: true });
  const imagePath = path.join(home, "Pictures", "trip.png");
  fs.writeFileSync(imagePath, "image");
  const library = new MediaExportLibrary(path.join(root, "grants.json"), home);
  library.configure({ rootIds: ["pictures"], confirmed: true });
  const result = await library.search({ query: "trip" });
  const artifactRoot = path.join(root, "artifacts");
  const store = new WorkflowMediaArtifactStore(artifactRoot, library, () => now, 60_000);
  return { root, home, imagePath, library, artifactRoot, store, match: result.matches[0]! };
}

describe("WorkflowMediaArtifactStore", () => {
  it("persists and revalidates an inbound image under the trusted media root", async () => {
    const value = await fixture();
    const inboundRoot = path.join(value.root, "media", "inbound");
    fs.mkdirSync(inboundRoot, { recursive: true });
    const inboundPath = path.join(inboundRoot, "received.png");
    fs.writeFileSync(inboundPath, "image");
    const store = new WorkflowMediaArtifactStore(
      value.artifactRoot,
      value.library,
      () => 1_000,
      60_000,
      inboundRoot,
    );

    const artifact = store.captureInbound({
      kind: "image",
      path: inboundPath,
      fileName: "received.png",
      mimeType: "image/png",
      sizeBytes: 5,
      quoted: false,
    });

    expect(artifact).toMatchObject({ rootId: "inbound", fileName: "received.png" });
    expect(JSON.stringify(artifact)).not.toContain(inboundRoot);
    expect(store.resolve(artifact.handle)).toBe(fs.realpathSync(inboundPath));
  });

  it("persists an opaque handle without exposing the source path", async () => {
    const { imagePath, artifactRoot, library, store, match } = await fixture();

    const artifact = store.capture(match);
    expect(artifact.handle).toMatch(/^media_[a-f0-9]{32}$/);
    expect(JSON.stringify(artifact)).not.toContain(imagePath);

    const reloaded = new WorkflowMediaArtifactStore(artifactRoot, library, () => 2_000, 60_000);
    expect(reloaded.resolve(artifact.handle)).toBe(fs.realpathSync(imagePath));
    const sidecars = fs.readdirSync(artifactRoot);
    expect(sidecars).toHaveLength(1);
    expect(fs.statSync(path.join(artifactRoot, sidecars[0]!)).mode & 0o777).toBe(0o600);
  });

  it("fails closed after expiry or directory authorization is revoked", async () => {
    const fixtureValue = await fixture();
    const artifact = fixtureValue.store.capture(fixtureValue.match);

    fixtureValue.library.configure({ rootIds: [], confirmed: true });
    expect(fixtureValue.store.resolve(artifact.handle)).toBeNull();

    const expiredLibrary = new MediaExportLibrary(path.join(fixtureValue.root, "grants.json"), fixtureValue.home);
    expiredLibrary.configure({ rootIds: ["pictures"], confirmed: true });
    const expired = new WorkflowMediaArtifactStore(fixtureValue.artifactRoot, expiredLibrary, () => 61_000, 60_000);
    expect(expired.resolve(artifact.handle)).toBeNull();
  });

  it("rejects a source file replaced by a symbolic link after capture", async () => {
    const value = await fixture();
    const artifact = value.store.capture(value.match);
    const outside = path.join(value.home, "Downloads", "outside.png");
    fs.writeFileSync(outside, "outside");
    fs.rmSync(value.imagePath);
    fs.symlinkSync(outside, value.imagePath);

    expect(value.store.resolve(artifact.handle)).toBeNull();
  });

  it("copies a prepared image snapshot into private media storage", async () => {
    const value = await fixture();
    const snapshotRoot = path.join(value.root, "file-snapshots");
    fs.mkdirSync(snapshotRoot);
    const snapshot = path.join(snapshotRoot, "photo.png");
    fs.writeFileSync(snapshot, "before");

    const handle = value.store.captureSnapshot(snapshot);
    fs.writeFileSync(snapshot, "after");

    const resolved = value.store.resolve(handle);
    expect(resolved).not.toBeNull();
    expect(fs.readFileSync(resolved!, "utf8")).toBe("before");
    expect(() => value.store.captureSnapshot(path.join(snapshotRoot, "missing.txt")))
      .toThrow("workflow_media_source_unavailable");
  });
});
