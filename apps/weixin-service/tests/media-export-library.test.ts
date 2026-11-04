import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MediaExportLibrary } from "../src/media-export-library.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "media-export-home-"));
  dirs.push(home);
  for (const name of ["Downloads", "Pictures", "Documents"]) fs.mkdirSync(path.join(home, name));
  const statePath = path.join(home, ".state", "media-export-grants.json");
  return { home, statePath, library: new MediaExportLibrary(statePath, home) };
}

describe("MediaExportLibrary", () => {
  it("defaults to disabled fixed directories and persists an explicit selection", () => {
    const { home, statePath, library } = fixture();
    expect(library.getPublicState()).toMatchObject({ revision: 0, roots: [
      { id: "downloads", enabled: false, status: "available" },
      { id: "pictures", enabled: false, status: "available" },
      { id: "documents", enabled: false, status: "available" },
    ] });

    library.configure({ rootIds: ["pictures"], confirmed: true });
    const reloaded = new MediaExportLibrary(statePath, home).getPublicState();
    expect(reloaded.revision).toBe(1);
    expect(reloaded.roots.find((root) => root.id === "pictures")).toMatchObject({ enabled: true, status: "available" });
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("requires confirmation and rejects unknown or symlinked roots", () => {
    const { home, library } = fixture();
    expect(() => library.configure({ rootIds: ["pictures"], confirmed: false })).toThrow("确认");
    expect(() => library.configure({ rootIds: ["desktop"], confirmed: true })).toThrow("无效");
    fs.rmSync(path.join(home, "Pictures"), { recursive: true });
    fs.symlinkSync(path.join(home, "Downloads"), path.join(home, "Pictures"));
    expect(() => library.configure({ rootIds: ["pictures"], confirmed: true })).toThrow("不可用");
  });

  it("recursively finds only images in enabled roots without exposing absolute paths", async () => {
    const { home, library } = fixture();
    fs.mkdirSync(path.join(home, "Pictures", "Trips"));
    fs.writeFileSync(path.join(home, "Pictures", "Trips", "lake.png"), "image");
    fs.writeFileSync(path.join(home, "Pictures", "Trips", "lake.txt"), "text");
    fs.writeFileSync(path.join(home, "Downloads", "lake.jpg"), "image");
    library.configure({ rootIds: ["pictures"], confirmed: true });

    const { matches: found } = await library.search({ query: "lake", limit: 10 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ rootId: "pictures", fileName: "lake.png", relativePath: "Trips/lake.png" });
    expect(JSON.stringify(found)).not.toContain(home);
  });

  it("uses stable relative-path order when image modification times are equal", async () => {
    const { home, library } = fixture();
    const pictures = path.join(home, "Pictures");
    for (const name of ["zeta.png", "alpha.png"]) {
      const filePath = path.join(pictures, name);
      fs.writeFileSync(filePath, name);
      fs.utimesSync(filePath, 1_900_000_000, 1_900_000_000);
    }
    library.configure({ rootIds: ["pictures"], confirmed: true });

    const result = await library.search({ rootId: "pictures", limit: 1 });
    expect(result.matches.map((match) => match.relativePath)).toEqual(["alpha.png"]);
    expect(result.scanIncomplete).toBe(false);
  });

  it("filters by filename before selecting the latest modified image", async () => {
    const { home, library } = fixture();
    const pictures = path.join(home, "Pictures");
    const files = [
      ["trip-old.png", 1_700_000_000],
      ["trip-new.png", 1_800_000_000],
      ["unrelated-newest.png", 1_900_000_000],
    ] as const;
    for (const [name, mtimeSeconds] of files) {
      const filePath = path.join(pictures, name);
      fs.writeFileSync(filePath, name);
      fs.utimesSync(filePath, mtimeSeconds, mtimeSeconds);
    }
    library.configure({ rootIds: ["pictures"], confirmed: true });

    const result = await library.search({ query: "trip", rootId: "pictures", limit: 1 });
    expect(result.matches.map((match) => match.relativePath)).toEqual(["trip-new.png"]);
  });

  it("marks a scan incomplete when an authorized subtree cannot be read", async () => {
    const { home, library } = fixture();
    const blocked = path.join(home, "Pictures", "blocked");
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(home, "Pictures", "visible.png"), "visible");
    library.configure({ rootIds: ["pictures"], confirmed: true });
    fs.chmodSync(blocked, 0o000);

    const result = await library.search({ rootId: "pictures", limit: 1 }).finally(() => {
      fs.chmodSync(blocked, 0o700);
    });
    expect(result.matches).toHaveLength(1);
    expect(result.scanIncomplete).toBe(true);
  });

  it("keeps equal-mtime ordering stable across authorized root configuration order", async () => {
    const { home, statePath } = fixture();
    for (const root of ["Pictures", "Downloads"]) {
      const filePath = path.join(home, root, "same.png");
      fs.writeFileSync(filePath, root);
      fs.utimesSync(filePath, 1_900_000_000, 1_900_000_000);
    }
    const first = new MediaExportLibrary(statePath, home);
    first.configure({ rootIds: ["pictures", "downloads"], confirmed: true });
    const firstMatch = await first.search({ limit: 1 });
    first.configure({ rootIds: ["downloads", "pictures"], confirmed: true });
    const secondMatch = await first.search({ limit: 1 });

    expect(firstMatch.matches[0]?.rootId).toBe("downloads");
    expect(secondMatch.matches[0]?.rootId).toBe("downloads");
  });

  it("does not traverse a Photos Library directory in any authorized root", async () => {
    const { home, library } = fixture();
    const roots = [
      { id: "downloads", directory: "Downloads", packageName: "Downloads Library.photoslibrary" },
      { id: "pictures", directory: "Pictures", packageName: "Photos Library.PHOTOSLIBRARY" },
      { id: "documents", directory: "Documents", packageName: "Documents Library.photoslibrary" },
    ];
    for (const root of roots) {
      const originals = path.join(home, root.directory, root.packageName, "originals");
      fs.mkdirSync(originals, { recursive: true });
      fs.writeFileSync(path.join(originals, `${root.id}-private-photo.jpg`), "image");
    }
    library.configure({ rootIds: roots.map((root) => root.id), confirmed: true });

    for (const root of roots) {
      await expect(library.search({ query: `${root.id}-private-photo`, rootId: root.id })).resolves.toMatchObject({ matches: [] });
    }
  });

  it("searches an application package inside an authorized Downloads directory", async () => {
    const { home, library } = fixture();
    const resources = path.join(home, "Downloads", "Example.app", "Contents", "Resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "application-icon.png"), "image");
    library.configure({ rootIds: ["downloads"], confirmed: true });

    const result = await library.search({ query: "application-icon", rootId: "downloads" });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      rootId: "downloads",
      fileName: "application-icon.png",
      relativePath: "Example.app/Contents/Resources/application-icon.png",
    });
  });

  it("searches document packages and ordinary dotted directories", async () => {
    const { home, library } = fixture();
    const packageData = path.join(home, "Documents", "Quarterly Report.pages", "Data");
    const ordinaryDirectory = path.join(home, "Documents", "project.v2");
    fs.mkdirSync(packageData, { recursive: true });
    fs.mkdirSync(ordinaryDirectory, { recursive: true });
    fs.writeFileSync(path.join(packageData, "package-preview.png"), "image");
    fs.writeFileSync(path.join(ordinaryDirectory, "project-preview.png"), "image");
    library.configure({ rootIds: ["documents"], confirmed: true });

    const result = await library.search({ query: "preview", rootId: "documents" });
    expect(result.matches.map((match) => match.relativePath).sort()).toEqual([
      "Quarterly Report.pages/Data/package-preview.png",
      "project.v2/project-preview.png",
    ]);
  });

  it("revalidates a persisted image path against the current grant", () => {
    const { home, library } = fixture();
    const image = path.join(home, "Pictures", "persisted.png");
    fs.writeFileSync(image, "image");
    library.configure({ rootIds: ["pictures"], confirmed: true });

    expect(library.resolveAuthorizedPath(image)).toBe(fs.realpathSync(image));

    library.configure({ rootIds: [], confirmed: true });
    expect(library.resolveAuthorizedPath(image)).toBeNull();
  });

  it("rejects an old image path that resolves inside a Photos Library directory", () => {
    const { home, library } = fixture();
    const image = path.join(home, "Pictures", "Photos Library.photoslibrary", "originals", "private-photo.jpg");
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(image, "image");
    library.configure({ rootIds: ["pictures"], confirmed: true });

    expect(library.resolveAuthorizedPath(image)).toBeNull();
  });
});
