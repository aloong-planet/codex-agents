// The Skill Library at its public interface, on real temporary folders (docs/specs/skill-library.md, Testing Decisions
// "Library"). The sample folder has the shape of the owner's real skill folders: scripts at the root with and without the
// executable bit, a quoted description, front matter keys the library does not read, nested data, a vendored bundle.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AUDIT_FILE, ConsoleAudit } from "../src/console-audit.js";
import { frontMatter, skillKey, SkillLibrary, type SkillLibraryOptions, SkillRefusal, type SkillUse } from "../src/skill-library.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    // A case may have closed a folder to reading.
    try { fs.chmodSync(directory, 0o700); } catch { /* Already gone. */ }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
const temporary = (prefix: string) => { const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); directories.push(directory); return directory; };

const BINARY = Buffer.from(Array.from({ length: 1024 }, (_value, index) => index % 256));
const LARGE = Buffer.alloc(2 * 1024 * 1024 + 7, "x");
const skillMd = (name: string, body: string, description = `"生成可审阅的补丁与测试用例：不运行。 - 交付代码时使用"`) =>
  `---\nname: ${name}\ndescription: ${description}\nwhen_to_use: 交付代码时\ndisable-model-invocation: true\n---\n\n# ${name}\n\n${body}\n`;
const SAMPLE_FILES: Record<string, Buffer | string> = {
  "SKILL.md": skillMd("patch-writer", "body-v1"),
  "check-patch.mjs": "export const check = () => true;\n",
  "watch.sh": "echo watching\n",
  "tools/run": "#!/bin/sh\nexit 0\n",
  "references/testing.md": "# Testing\n",
  "assets/routing/routing.json": "{\"rules\":[]}\n",
  "template/.gitignore": "node_modules\n",
  "vendor/blob.bin": BINARY,
  "vendor/bundle.txt": LARGE,
};
const SAMPLE_PATHS = ["SKILL.md", "assets/routing/routing.json", "check-patch.mjs", "references/testing.md", "template/.gitignore", "tools/run", "vendor/blob.bin", "vendor/bundle.txt", "watch.sh"];

function write(folder: string, files: Record<string, Buffer | string>): string {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), content);
  }
  if (files["watch.sh"] !== undefined) fs.chmodSync(path.join(folder, "watch.sh"), 0o755);
  return folder;
}
/** A skill folder like the owner's, under a fresh temporary directory. */
const sample = (files: Record<string, Buffer | string> = SAMPLE_FILES) => write(path.join(temporary("skill-source-"), "patch-writer"), files);

function open(options: Partial<SkillLibraryOptions> = {}) {
  const state = temporary("skill-library-");
  const settings = { directory: path.join(state, "skill-library"), audit: new ConsoleAudit({ directory: state }), now: () => Date.parse("2026-11-11T08:00:00Z"), ...options };
  return { library: new SkillLibrary(settings), settings, state,
    audit: () => fs.existsSync(path.join(state, AUDIT_FILE)) ? fs.readFileSync(path.join(state, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [] };
}
const refusal = async (action: Promise<unknown>) => {
  try { await action; } catch (error) { if (error instanceof SkillRefusal) return error.refusal; throw error; }
  throw new Error("not refused");
};
const refused = (action: () => void) => {
  try { action(); } catch (error) { if (error instanceof SkillRefusal) return error.refusal; throw error; }
  throw new Error("not refused");
};
const BROWSER = { browser: { id: "browser-1", label: "Chrome · macOS", authorizedAt: "2026-11-11T07:00:00.000Z", lastUsedAt: "2026-11-11T07:00:00.000Z" } };
const digest = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");
/** Every file under a directory by path, with the hash of its bytes: comparing megabytes of buffers is slow. */
function tree(directory: string): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(file); else found[file] = digest(fs.readFileSync(path.join(directory, file)));
    }
  };
  visit("");
  return found;
}
const expected = (files: Record<string, Buffer | string>, prefix: string) =>
  Object.fromEntries(Object.entries(files).map(([file, content]) => [prefix ? `${prefix}/${file}` : file, digest(content)]));
async function imported(library: SkillLibrary, folder: string) {
  return library.import(folder, (await library.read(folder)).fingerprint, BROWSER);
}

describe("importing a folder", () => {
  it("reads the name, the description and every file with scripts marked, and copies nothing until the read is confirmed", async () => {
    const { library } = open();
    const folder = sample();
    const preview = await library.read(folder);
    expect(preview).toMatchObject({ folder, name: "patch-writer", description: "生成可审阅的补丁与测试用例：不运行。 - 交付代码时使用" });
    expect(preview.files.map((file) => file.path)).toEqual(SAMPLE_PATHS);
    // A script by its extension, by its executable bit, and by its first line; data and the vendored bundle are not.
    expect(preview.files.filter((file) => file.script).map((file) => file.path)).toEqual(["check-patch.mjs", "tools/run", "watch.sh"]);
    expect(library.list()).toEqual([]);

    const skill = await library.import(folder, preview.fingerprint, BROWSER);
    expect(skill).toMatchObject({ version: 1, name: "patch-writer", source: folder, importedAt: Date.parse("2026-11-11T08:00:00Z") });
    expect(skill.files.map(({ path: file, size }) => [file, size])).toEqual(SAMPLE_PATHS.map((file) => [file, Buffer.from(SAMPLE_FILES[file]!).length]));
    expect(skill.files.find((file) => file.path === "vendor/blob.bin")!.sha256).toBe(digest(BINARY));
    expect(library.list()).toEqual([skill]);
    // The copy is the folder, byte for byte: binary and large files like any other.
    const home = temporary("skill-home-");
    library.materialize([skill], home);
    expect(tree(home)).toEqual(expected(SAMPLE_FILES, skill.id));
  });

  it("reads a folder whose typed path is itself a link, as the owner's skill folders are reached, and one under ~", async () => {
    const home = temporary("skill-owner-home-");
    const { library } = open({ home });
    const real = sample();
    fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(real, path.join(home, ".claude", "skills", "patch-writer"));
    const preview = await library.read("~/.claude/skills/patch-writer");
    expect(preview.folder).toBe(path.join(home, ".claude", "skills", "patch-writer"));
    expect(preview.files.map((file) => file.path)).toEqual(SAMPLE_PATHS);
  });

  it.each([
    ["a missing folder", (root: string) => path.join(root, "absent"), "folder"],
    ["a file", (root: string) => path.join(root, "patch-writer", "SKILL.md"), "folder"],
    ["a path that is not absolute", () => "agent-skills/patch-writer", "folder"],
    ["a folder with SKILL.md only below its root", (root: string) => write(path.join(root, "nested"), { "patch-writer/SKILL.md": skillMd("patch-writer", "x") }), "skill_md"],
    ["a SKILL.md without front matter", (root: string) => write(path.join(root, "plain"), { "SKILL.md": "# patch-writer\n" }), "front_matter"],
    ["a SKILL.md without a name", (root: string) => write(path.join(root, "nameless"), { "SKILL.md": "---\ndescription: 写补丁\n---\n" }), "front_matter"],
    ["a SKILL.md with an empty description", (root: string) => write(path.join(root, "undescribed"), { "SKILL.md": "---\nname: patch-writer\ndescription:\n---\n" }), "front_matter"],
  ])("refuses %s, asking for the skill's root folder", async (_what, folderOf, kind) => {
    const { library } = open();
    const folder = folderOf(path.dirname(sample()));
    expect(await refusal(library.read(folder))).toEqual({ kind });
    expect(await refusal(library.import(folder, "anything", BROWSER))).toEqual({ kind });
    expect(library.list()).toEqual([]);
  });

  it("refuses a folder that names a skill the library already has, at the read and at the import", async () => {
    const { library } = open();
    const first = sample();
    const preview = await library.read(first);
    const second = sample();
    const again = await library.read(second);
    await library.import(first, preview.fingerprint, BROWSER);
    expect(await refusal(library.read(second))).toEqual({ kind: "duplicate", name: "patch-writer" });
    expect(await refusal(library.import(second, again.fingerprint, BROWSER))).toEqual({ kind: "duplicate", name: "patch-writer" });
    expect(library.list()).toHaveLength(1);
  });

  it("refuses a folder with symbolic links and lists each with its target, also one pointing outside or nowhere", async () => {
    const { library, settings } = open();
    const folder = sample();
    const outside = path.join(path.dirname(folder), "shared-notes");
    fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "secret.md"), "outside");
    fs.symlinkSync("../../shared-notes", path.join(folder, "references", "shared"));
    fs.symlinkSync(path.join(outside, "secret.md"), path.join(folder, "notes.md"));
    fs.symlinkSync("testing.md", path.join(folder, "references", "alias.md"));
    fs.symlinkSync("nowhere", path.join(folder, "tools", "broken"));
    const links = [`notes.md → ${path.join(outside, "secret.md")}`, "references/alias.md → testing.md", "references/shared → ../../shared-notes", "tools/broken → nowhere"];
    expect(await refusal(library.read(folder))).toEqual({ kind: "links", links });
    expect(await refusal(library.import(folder, "anything", BROWSER))).toEqual({ kind: "links", links });
    expect(library.list()).toEqual([]);
    // Nothing of the refused folder stays in the library's directory, the linked file least of all.
    expect(tree(settings.directory)).toEqual({});
  });

  it.each([
    ["a file's content changed", (folder: string) => fs.writeFileSync(path.join(folder, "references", "testing.md"), "# Changed\n"), { kind: "changed" }],
    ["a file was added", (folder: string) => fs.writeFileSync(path.join(folder, "references", "added.md"), "new"), { kind: "changed" }],
    ["a file was removed", (folder: string) => fs.rmSync(path.join(folder, "check-patch.mjs")), { kind: "changed" }],
    ["a file became a link", (folder: string) => { fs.rmSync(path.join(folder, "watch.sh")); fs.symlinkSync("/etc/hosts", path.join(folder, "watch.sh")); }, { kind: "links", links: ["watch.sh → /etc/hosts"] }],
  ])("imports nothing when %s between the read and the confirmation", async (_what, change, why) => {
    const { library, settings } = open();
    const folder = sample();
    const preview = await library.read(folder);
    change(folder);
    expect(await refusal(library.import(folder, preview.fingerprint, BROWSER))).toEqual(why);
    expect(library.list()).toEqual([]);
    expect(tree(settings.directory)).toEqual({});
  });
});

describe("keeping a skill in step with its source", () => {
  it("says which files changed, were added or were removed, and re-imports exactly the compared state as the next version", async () => {
    const reimported: unknown[] = [];
    const { library } = open({ reimported: (ref) => reimported.push(ref) });
    const folder = sample();
    const first = await imported(library, folder);
    expect(await library.compare(first.id)).toEqual({ state: "same" });

    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("patch-writer", "body-v2"));
    fs.writeFileSync(path.join(folder, "references", "added.md"), "new");
    fs.rmSync(path.join(folder, "check-patch.mjs"));
    const state = await library.compare(first.id);
    expect(state).toMatchObject({ state: "changed", files: [{ path: "SKILL.md", change: "changed" }, { path: "check-patch.mjs", change: "removed" }, { path: "references/added.md", change: "added" }] });
    // The copy does not move until the owner confirms.
    expect(library.current(first.id)).toEqual(first);

    const second = await library.reimport(first.id, (state as { fingerprint: string }).fingerprint, BROWSER);
    expect(second).toMatchObject({ id: first.id, version: 2, source: folder });
    expect(second.files.map((file) => file.path)).toEqual(SAMPLE_PATHS.filter((file) => file !== "check-patch.mjs").concat("references/added.md").sort());
    expect(library.list()).toEqual([second]);
    expect(reimported).toEqual([{ id: first.id, version: 2 }]);
    expect(await library.compare(first.id)).toEqual({ state: "same" });
  });

  it("keeps the earlier version's content for whoever still refers to it, and writes each version as it was imported", async () => {
    const needed = new Set<string>();
    const { library } = open({ needed: () => needed });
    const folder = sample();
    const first = await imported(library, folder);
    needed.add(skillKey(first));
    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("patch-writer", "body-v2"));
    const second = await library.reimport(first.id, ((await library.compare(first.id)) as { fingerprint: string }).fingerprint, BROWSER);

    const before = temporary("skill-home-"), after = temporary("skill-home-");
    library.materialize([{ id: first.id, version: 1 }], before);
    library.materialize([second], after);
    expect(tree(before)).toEqual(expected(SAMPLE_FILES, first.id));
    expect(tree(after)[`${first.id}/SKILL.md`]).toBe(digest(skillMd("patch-writer", "body-v2")));
  });

  it("re-imports nothing when the source is not what was compared", async () => {
    const { library } = open();
    const folder = sample();
    const first = await imported(library, folder);
    fs.writeFileSync(path.join(folder, "references", "testing.md"), "# Second\n");
    const state = await library.compare(first.id) as { fingerprint: string };
    fs.writeFileSync(path.join(folder, "references", "testing.md"), "# Third\n");
    expect(await refusal(library.reimport(first.id, state.fingerprint, BROWSER))).toEqual({ kind: "changed" });
    expect(library.list()).toEqual([first]);
  });

  it("counts a link that appeared in the source as a change, and refuses to re-import it", async () => {
    const { library } = open();
    const folder = sample();
    const first = await imported(library, folder);
    fs.symlinkSync("/etc/hosts", path.join(folder, "references", "hosts"));
    const state = await library.compare(first.id);
    expect(state).toMatchObject({ state: "changed", files: [{ path: "references/hosts", change: "added" }] });
    expect(await refusal(library.reimport(first.id, (state as { fingerprint: string }).fingerprint, BROWSER))).toEqual({ kind: "links", links: ["references/hosts → /etc/hosts"] });
    expect(library.list()).toEqual([first]);
  });

  it("takes the name its SKILL.md has now, unless another skill has that name", async () => {
    const { library } = open();
    const folder = sample();
    const first = await imported(library, folder);
    const other = await imported(library, sample({ "SKILL.md": skillMd("code-review", "x", "定位问题并给出补丁建议") }));

    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("code-review", "renamed"));
    const taken = await library.compare(first.id) as { fingerprint: string };
    expect(await refusal(library.reimport(first.id, taken.fingerprint, BROWSER))).toEqual({ kind: "duplicate", name: "code-review" });
    expect(library.current(first.id)).toEqual(first);

    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("patch-drafts", "renamed"));
    const free = await library.compare(first.id) as { fingerprint: string };
    expect((await library.reimport(first.id, free.fingerprint, BROWSER)).name).toBe("patch-drafts");
    expect(library.list().map((skill) => skill.name)).toEqual(["code-review", "patch-drafts"]);
    expect(other.name).toBe("code-review");
  });

  it("says when the source folder is gone or cannot be read, refuses to re-import then, and keeps the copy usable", async () => {
    const { library } = open();
    const folder = sample();
    const skill = await imported(library, folder);
    fs.chmodSync(folder, 0o000);
    expect(await library.compare(skill.id)).toEqual({ state: "unreadable" });
    expect(await refusal(library.reimport(skill.id, "anything", BROWSER))).toEqual({ kind: "folder" });
    fs.chmodSync(folder, 0o700);
    fs.renameSync(folder, `${folder}-moved`);
    expect(await library.compare(skill.id)).toEqual({ state: "missing" });
    expect(await refusal(library.reimport(skill.id, "anything", BROWSER))).toEqual({ kind: "folder" });
    const home = temporary("skill-home-");
    library.materialize([skill], home);
    expect(tree(home)).toEqual(expected(SAMPLE_FILES, skill.id));
  });
});

describe("deleting a skill", () => {
  const use: SkillUse = { teamId: "alice", leader: "Alice", teamName: "运营团队", profile: "商品文案" };

  it("refuses while a profile selects it, and deletes an unused one without touching its source folder", async () => {
    let uses: SkillUse[] = [use, { ...use, profile: "经营分析" }];
    const { library, settings } = open({ usedBy: () => uses, needed: () => new Set() });
    const folder = sample();
    const skill = await imported(library, folder);
    expect(refused(() => library.remove(skill.id, BROWSER))).toEqual({ kind: "in_use", uses: 2 });
    expect(library.list()).toEqual([skill]);

    uses = [];
    library.remove(skill.id, BROWSER);
    expect(library.list()).toEqual([]);
    expect(library.current(skill.id)).toBeUndefined();
    expect(refused(() => library.remove(skill.id, BROWSER))).toEqual({ kind: "unknown" });
    expect(tree(settings.directory)).toEqual({});
    expect(tree(folder)).toEqual(expected(SAMPLE_FILES, ""));
    // Its name is free again.
    expect((await imported(library, folder)).name).toBe("patch-writer");
  });

  it("keeps the versions that a request can still run with, of a re-imported and of a deleted skill, and removes them once nothing needs them", async () => {
    const live = new Set<string>();
    let known = true;
    const { library, settings } = open({ needed: () => known ? live : undefined });
    const folder = sample();
    const first = await imported(library, folder);
    live.add(skillKey(first));
    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("patch-writer", "body-v2"));
    const second = await library.reimport(first.id, ((await library.compare(first.id)) as { fingerprint: string }).fingerprint, BROWSER);
    expect(library.version(first)).toEqual(first);

    library.remove(first.id, BROWSER);
    // Deleted for the owner, still there for the request admitted with version 1; version 2 had no one.
    expect(library.list()).toEqual([]);
    expect(library.version(first)).toEqual(first);
    expect(library.version(second)).toBeUndefined();
    const home = temporary("skill-home-");
    library.materialize([first], home);
    expect(tree(home)).toEqual(expected(SAMPLE_FILES, first.id));

    // While the requests cannot be asked, nothing is removed.
    known = false;
    live.clear();
    library.prune();
    expect(library.version(first)).toEqual(first);
    known = true;
    library.prune();
    expect(library.version(first)).toBeUndefined();
    expect(tree(settings.directory)).toEqual({});
  });
});

describe("the library's records", () => {
  it("audits every import, re-import and deletion with the browser that asked, and never with a file's content", async () => {
    const { library, audit, state } = open({ needed: () => new Set() });
    const folder = sample();
    const skill = await imported(library, folder);
    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("patch-writer", "body-v2"));
    fs.rmSync(path.join(folder, "check-patch.mjs"));
    await library.reimport(skill.id, ((await library.compare(skill.id)) as { fingerprint: string }).fingerprint, BROWSER);
    library.remove(skill.id, BROWSER);
    const browser = { id: "browser-1", label: "Chrome · macOS" };
    expect(audit().map(({ at: _at, ...entry }) => entry)).toEqual([
      { by: "browser", browser, event: "skill_imported", skill: skill.id, name: "patch-writer", version: 1, source: folder, files: 9 },
      { by: "browser", browser, event: "skill_reimported", skill: skill.id, name: "patch-writer", version: 2, source: folder, files: 8, changed: 2 },
      { by: "browser", browser, event: "skill_deleted", skill: skill.id, name: "patch-writer", version: 2, source: folder },
    ]);
    expect(fs.readFileSync(path.join(state, AUDIT_FILE), "utf8")).not.toContain("body-v");
  });

  it("stores nothing when the change cannot be audited", async () => {
    const { library, settings, state } = open();
    const folder = sample();
    const preview = await library.read(folder);
    fs.mkdirSync(path.join(state, AUDIT_FILE));
    await expect(library.import(folder, preview.fingerprint, BROWSER)).rejects.toThrow();
    expect(library.list()).toEqual([]);
    expect(tree(settings.directory)).toEqual({});
  });

  it("finds its skills again when it is opened anew, and clears what an interrupted import left", async () => {
    const { library, settings } = open({ needed: () => undefined });
    const folder = sample();
    const first = await imported(library, folder);
    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("patch-writer", "body-v2"));
    const second = await library.reimport(first.id, ((await library.compare(first.id)) as { fingerprint: string }).fingerprint, BROWSER);
    fs.mkdirSync(path.join(settings.directory, ".staging-0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9", "files"), { recursive: true });
    fs.writeFileSync(path.join(settings.directory, ".staging-0f1e2d3c-4b5a-6978-8695-a4b3c2d1e0f9", "files", "SKILL.md"), "half");
    fs.mkdirSync(path.join(settings.directory, "skill-00000000"));

    const reopened = new SkillLibrary(settings);
    expect(reopened.list()).toEqual([second]);
    expect(reopened.version(first)).toEqual(first);
    expect(fs.readdirSync(settings.directory)).toEqual([first.id]);
  });

  it("refuses to write a version whose stored file no longer matches its manifest, or that is not stored", async () => {
    const { library, settings } = open();
    const skill = await imported(library, sample());
    expect(() => library.materialize([{ id: skill.id, version: 7 }], temporary("skill-home-"))).toThrow("skill_version_unavailable");
    fs.writeFileSync(path.join(settings.directory, skill.id, "1", "files", "references", "testing.md"), "# Tampered\n");
    expect(() => library.materialize([skill], temporary("skill-home-"))).toThrow("skill_version_corrupt");
  });
});

describe("SKILL.md front matter", () => {
  it.each([
    ["plain values", "---\nname: trip-check\ndescription: 逐段核对站名与换乘 # 内部备注\n---\nbody", { name: "trip-check", description: "逐段核对站名与换乘" }],
    ["a double-quoted value with a colon and an escape", "---\nname: \"trip-check\"\ndescription: \"核对：站名\\t换乘\"\n---\n", { name: "trip-check", description: "核对：站名\t换乘" }],
    ["a single-quoted value", "---\nname: 'trip-check'\ndescription: 'it''s checked'\n---\n", { name: "trip-check", description: "it's checked" }],
    ["a folded block and a continued plain value", "---\nname: trip-check\ndescription: >-\n  逐段核对\n  站名与换乘\nwhen_to_use: 出行\n  之前\n---\n", { name: "trip-check", description: "逐段核对 站名与换乘" }],
    ["Windows line ends and a byte order mark", "﻿---\r\nname: trip-check\r\ndescription: 核对\r\n---\r\n", { name: "trip-check", description: "核对" }],
    ["no closing line", "---\nname: trip-check\ndescription: 核对\n", {}],
    ["keys only in the body", "# trip-check\n\nname: trip-check\ndescription: 核对\n", {}],
  ])("reads %s", (_what, text, found) => {
    expect(frontMatter(text)).toEqual(found);
  });
});
