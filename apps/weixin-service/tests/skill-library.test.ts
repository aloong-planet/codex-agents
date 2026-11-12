// The Skill Library at its public interface, on real temporary folders (docs/specs/skill-library.md, Testing Decisions
// "Library"). The sample folder has the shape of the owner's real skill folders: scripts at the root with and without the
// executable bit, a quoted description, front matter keys the library does not read, nested data, a vendored bundle.
// Gaps, each needing a file to change at a moment no case can choose: a SKILL.md rewritten between the first look at it and the
// walk of the same read (refused as changed); a SKILL.md that opens but then fails to be read; and a file removed, or replaced
// by a link or a named pipe, between being listed and being opened (opened without following and without waiting).
// A SKILL.md that the App Server refuses for a reason the library does not check is imported all the same, and caught when an
// Executor's runtime starts (skill-library, failure modes): the record of that is under "whether Codex loaded a skill" below, and
// the runtime check in agent-dispatch-executor.test.ts and skill-library.integration.test.ts. The two measured refusals are
// refused below; that the installed App Server still refuses exactly those is the opt-in case in isolated-model-runtime.test.ts,
// to be run again after a Codex upgrade.
// The tool through which an Executor reads its skills' files: that a file of hundreds of megabytes is read without being held
// whole or holding up the service is measured by no case, since memory and timing on a shared machine would make one unstable.
// A read that fails partway through a stored file is refused like a changed store, which no case can bring about.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AUDIT_FILE, ConsoleAudit } from "../src/console-audit.js";
import type { DynamicToolContext } from "../src/dynamic-tool-host.js";
import { SKILL_FILE_TOOL, SkillFileToolHost } from "../src/skill-file-tool.js";
import { frontMatter, skillKey, SkillLibrary, type SkillLibraryOptions, SkillRefusal, type SkillUse } from "../src/skill-library.js";

const directories: string[] = [];
/** What a case must undo while its folders still exist. */
const finishing: Array<() => void> = [];
afterEach(() => {
  for (const step of finishing.splice(0)) step();
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
// Each of the four script files is a script by one rule alone: its extension (check-patch.mjs), its executable bit (bin/tool),
// its first line (tools/run), and the `scripts` folder it lies in (scripts/data.txt).
const SAMPLE_FILES: Record<string, Buffer | string> = {
  "SKILL.md": skillMd("patch-writer", "body-v1"),
  "check-patch.mjs": "export const check = () => true;\n",
  "bin/tool": "tool\n",
  "tools/run": "#!/bin/sh\nexit 0\n",
  "scripts/data.txt": "data\n",
  "references/testing.md": "# Testing\n",
  "assets/routing/routing.json": "{\"rules\":[]}\n",
  "template/.gitignore": "node_modules\n",
  "vendor/blob.bin": BINARY,
  "vendor/bundle.txt": LARGE,
};
const SAMPLE_PATHS = ["SKILL.md", "assets/routing/routing.json", "bin/tool", "check-patch.mjs", "references/testing.md", "scripts/data.txt", "template/.gitignore", "tools/run",
  "vendor/blob.bin", "vendor/bundle.txt"];

function write(folder: string, files: Record<string, Buffer | string>): string {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), content);
  }
  if (files["bin/tool"] !== undefined) fs.chmodSync(path.join(folder, "bin", "tool"), 0o755);
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
    // A script by its executable bit, by its extension, by its `scripts` folder, or by its first line; data and the vendored
    // bundle are not.
    expect(preview.files.filter((file) => file.script).map((file) => file.path)).toEqual(["bin/tool", "check-patch.mjs", "scripts/data.txt", "tools/run"]);
    expect(library.list()).toEqual([]);

    const skill = await library.import(folder, preview.fingerprint, BROWSER);
    expect(skill).toMatchObject({ version: 1, name: "patch-writer", source: folder, importedAt: Date.parse("2026-11-11T08:00:00Z") });
    expect(skill.files.map(({ path: file, size }) => [file, size])).toEqual(SAMPLE_PATHS.map((file) => [file, Buffer.from(SAMPLE_FILES[file]!).length]));
    expect(skill.files.find((file) => file.path === "vendor/blob.bin")!.sha256).toBe(digest(BINARY));
    expect(library.list()).toEqual([skill]);
    // The copy is the folder, byte for byte: binary and large files like any other. What was written comes back as a runtime's
    // turns name it: the skill's name, and where its SKILL.md is.
    const home = temporary("skill-home-");
    expect(library.materialize([skill], home)).toEqual([{ name: "patch-writer", path: path.join(home, skill.id, "SKILL.md") }]);
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
    // The sample folder itself, named from the directory the service runs in: it exists there, and is refused all the same.
    ["a path that is not absolute", (root: string) => path.relative(process.cwd(), path.join(root, "patch-writer")), "folder"],
    ["a folder with SKILL.md only below its root", (root: string) => write(path.join(root, "nested"), { "patch-writer/SKILL.md": skillMd("patch-writer", "x") }), "skill_md"],
    ["a folder whose SKILL.md is itself a folder", (root: string) => write(path.join(root, "foldered"), { "SKILL.md/README.md": "x" }), "skill_md"],
    ["a folder whose SKILL.md cannot be read", (root: string) => { const folder = write(path.join(root, "closed"), { "SKILL.md": skillMd("patch-writer", "x") }); fs.chmodSync(path.join(folder, "SKILL.md"), 0o000); return folder; }, "folder"],
    ["a SKILL.md without front matter", (root: string) => write(path.join(root, "plain"), { "SKILL.md": "# patch-writer\n" }), "front_matter"],
    ["a SKILL.md without a name", (root: string) => write(path.join(root, "nameless"), { "SKILL.md": "---\ndescription: 写补丁\n---\n" }), "front_matter"],
    ["a SKILL.md with an empty description", (root: string) => write(path.join(root, "undescribed"), { "SKILL.md": "---\nname: patch-writer\ndescription:\n---\n" }), "front_matter"],
    // The two shapes the App Server was measured not to list: the skill would reach a runtime and never be read.
    ["a SKILL.md that starts with a byte order mark", (root: string) => write(path.join(root, "marked"), { "SKILL.md": `\u{FEFF}${skillMd("patch-writer", "x")}` }), "bom"],
    ["a SKILL.md whose name has 65 characters", (root: string) => write(path.join(root, "long"), { "SKILL.md": skillMd("n".repeat(65), "x") }), "name_length"],
  ])("refuses %s, asking for the skill's root folder", async (_what, folderOf, kind) => {
    const { library } = open();
    const folder = folderOf(path.dirname(sample()));
    expect(await refusal(library.read(folder))).toEqual({ kind });
    expect(await refusal(library.import(folder, "anything", BROWSER))).toEqual({ kind });
    expect(library.list()).toEqual([]);
  });

  it("imports a skill whose name has exactly 64 characters, the longest the App Server lists", async () => {
    const { library } = open();
    const name = "n".repeat(64);
    const folder = write(path.join(temporary("skill-source-"), "long"), { "SKILL.md": skillMd(name, "x") });
    expect((await imported(library, folder)).name).toBe(name);
  });

  it("refuses a folder with no SKILL.md at its root before reading what is below it", async () => {
    const { library } = open();
    const folder = write(path.join(temporary("skill-source-"), "not-a-skill"), { "data/closed.bin": "x" });
    // Unreadable: a read of it would refuse the folder as unreadable instead.
    fs.chmodSync(path.join(folder, "data"), 0o000);
    try {
      expect(await refusal(library.read(folder))).toEqual({ kind: "skill_md" });
      expect(await refusal(library.import(folder, "anything", BROWSER))).toEqual({ kind: "skill_md" });
    } finally { fs.chmodSync(path.join(folder, "data"), 0o700); }
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

  it("lists a SKILL.md that is itself a link among the refused links, and reads nothing through it", async () => {
    const { library, settings } = open();
    // Not a usable SKILL.md: read through the link, it would have the folder refused for its front matter instead.
    const elsewhere = path.join(temporary("skill-elsewhere-"), "notes.md");
    fs.writeFileSync(elsewhere, "# Notes kept outside the folder\n");
    const folder = write(path.join(temporary("skill-source-"), "linked-root"), { "references/testing.md": "# Testing\n" });
    fs.symlinkSync(elsewhere, path.join(folder, "SKILL.md"));
    const why = { kind: "links", links: [`SKILL.md → ${elsewhere}`] };
    expect(await refusal(library.read(folder))).toEqual(why);
    expect(await refusal(library.import(folder, "anything", BROWSER))).toEqual(why);
    expect(tree(settings.directory)).toEqual({});
  });

  it("refuses a folder with an entry that is neither a file nor a folder, and lists it, without opening it", async () => {
    const { library, settings } = open();
    const folder = sample();
    // A named pipe: opening it for reading would wait for a writer that never comes.
    execFileSync("mkfifo", [path.join(folder, "references", "queue")]);
    const why = { kind: "links", links: ["references/queue（不是普通文件）"] };
    expect(await refusal(library.read(folder))).toEqual(why);
    expect(await refusal(library.import(folder, "anything", BROWSER))).toEqual(why);
    expect(tree(settings.directory)).toEqual({});
  });

  // The root SKILL.md is looked at before the walk. A pipe there must not be opened: the open would wait for a writer and
  // hold one of the process's few file-system threads. A socket there cannot be opened at all.
  it.each([
    ["a named pipe", async (file: string) => {
      execFileSync("mkfifo", [file]);
      // Should a read wait on the pipe after all, a writer lets it go, so that the failed case does not keep its thread.
      finishing.push(() => { try { fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)); } catch { /* Nothing waits on it. */ } });
    }],
    ["a socket", async (file: string) => {
      const server = net.createServer();
      finishing.push(() => { server.close(); });
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(file, resolve); });
    }],
  ])("refuses a folder whose SKILL.md is %s, and lists it, without opening it", async (_what, put) => {
    const { library, settings } = open();
    // A short path: a socket's is limited to about a hundred bytes.
    const folder = write(path.join(temporary("sk-"), "s"), { "references/testing.md": "# Testing\n" });
    await put(path.join(folder, "SKILL.md"));
    const why = { kind: "links", links: ["SKILL.md（不是普通文件）"] };
    expect(await refusal(library.read(folder))).toEqual(why);
    expect(await refusal(library.import(folder, "anything", BROWSER))).toEqual(why);
    expect(tree(settings.directory)).toEqual({});
  });

  it.each([
    ["a file's content changed", (folder: string) => fs.writeFileSync(path.join(folder, "references", "testing.md"), "# Changed\n"), { kind: "changed" }],
    ["a file was added", (folder: string) => fs.writeFileSync(path.join(folder, "references", "added.md"), "new"), { kind: "changed" }],
    ["a file was removed", (folder: string) => fs.rmSync(path.join(folder, "check-patch.mjs")), { kind: "changed" }],
    ["a file became a link", (folder: string) => { fs.rmSync(path.join(folder, "bin", "tool")); fs.symlinkSync("/etc/hosts", path.join(folder, "bin", "tool")); }, { kind: "links", links: ["bin/tool → /etc/hosts"] }],
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

// skill-library::REQ-002: what an Executor's runtime made of a version when it started. The record belongs to that version, so
// the page shows it for a skill's current version only.
describe("whether Codex loaded a skill", () => {
  const view = async (library: SkillLibrary) => (await library.view()).map(({ name, refused }) => ({ name, ...(refused ? { refused } : {}) }));
  it("shows a version Codex did not load, with its reason or none, until a runtime lists that version, also when the library is opened anew", async () => {
    const { library, settings } = open();
    const patch = await imported(library, sample());
    const other = await imported(library, write(path.join(temporary("skill-source-"), "trip-check"), { "SKILL.md": skillMd("trip-check", "body") }));
    expect(await view(library)).toEqual([{ name: "patch-writer" }, { name: "trip-check" }]);

    library.recordLoading(patch, { loaded: false, reason: "invalid YAML: duplicate field `name`" });
    library.recordLoading(other, { loaded: true });
    expect(await view(library)).toEqual([{ name: "patch-writer", refused: { reason: "invalid YAML: duplicate field `name`" } }, { name: "trip-check" }]);
    // What the service holds is found again at its next start.
    expect(await view(new SkillLibrary(settings))).toEqual([{ name: "patch-writer", refused: { reason: "invalid YAML: duplicate field `name`" } }, { name: "trip-check" }]);

    library.recordLoading(other, { loaded: false });
    expect(await view(library)).toEqual([{ name: "patch-writer", refused: { reason: "invalid YAML: duplicate field `name`" } }, { name: "trip-check", refused: {} }]);
    // A later runtime that lists the same version clears its record.
    library.recordLoading(patch, { loaded: true });
    expect(await view(library)).toEqual([{ name: "patch-writer" }, { name: "trip-check", refused: {} }]);
    expect(await view(new SkillLibrary(settings))).toEqual([{ name: "patch-writer" }, { name: "trip-check", refused: {} }]);
  });

  it("starts a re-imported skill's new version without a record, whatever is recorded for the version a request still runs with", async () => {
    const needed = new Set<string>();
    const { library } = open({ needed: () => needed });
    const folder = sample();
    const first = await imported(library, folder);
    needed.add(skillKey(first));
    library.recordLoading(first, { loaded: false, reason: "invalid YAML: duplicate field `name`" });
    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("patch-writer", "body-v2"));
    await library.reimport(first.id, ((await library.compare(first.id)) as { fingerprint: string }).fingerprint, BROWSER);
    expect(await view(library)).toEqual([{ name: "patch-writer" }]);
    // A runtime of a request admitted earlier still reports on version 1; the page shows version 2.
    library.recordLoading({ id: first.id, version: 1 }, { loaded: false, reason: "invalid YAML: duplicate field `name`" });
    expect(await view(library)).toEqual([{ name: "patch-writer" }]);
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

  it("deletes nothing while it cannot be told which profiles select a skill, and shows it with no uses", async () => {
    const told: { uses?: SkillUse[] } = {};
    const { library } = open({ usedBy: () => told.uses, needed: () => new Set() });
    const skill = await imported(library, sample());
    expect(refused(() => library.remove(skill.id, BROWSER))).toEqual({ kind: "uses_unknown" });
    expect(library.list()).toEqual([skill]);
    expect((await library.view()).map(({ id, usedBy }) => [id, usedBy])).toEqual([[skill.id, []]]);
    // Told again, and unused: it goes.
    told.uses = [];
    library.remove(skill.id, BROWSER);
    expect(library.list()).toEqual([]);
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
    expect(audit().map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "at")))).toEqual([
      { by: "browser", browser, event: "skill_imported", skill: skill.id, name: "patch-writer", version: 1, source: folder, files: 10 },
      { by: "browser", browser, event: "skill_reimported", skill: skill.id, name: "patch-writer", version: 2, source: folder, files: 9, changed: 2 },
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

  it("re-imports and deletes nothing when the change cannot be audited", async () => {
    const reimported: unknown[] = [];
    const { library, settings, state } = open({ reimported: (ref) => reimported.push(ref) });
    const folder = sample();
    const skill = await imported(library, folder);
    fs.writeFileSync(path.join(folder, "SKILL.md"), skillMd("patch-writer", "body-v2"));
    const changed = await library.compare(skill.id) as { fingerprint: string };
    // The audit file gives way to a directory of its name: no entry can be appended from here on.
    fs.renameSync(path.join(state, AUDIT_FILE), path.join(state, "audit-before"));
    fs.mkdirSync(path.join(state, AUDIT_FILE));

    await expect(library.reimport(skill.id, changed.fingerprint, BROWSER)).rejects.toThrow();
    expect(library.list()).toEqual([skill]);
    expect(fs.readdirSync(path.join(settings.directory, skill.id))).toEqual(["1"]);
    // No profile was moved to a version that is not there.
    expect(reimported).toEqual([]);

    expect(() => library.remove(skill.id, BROWSER)).toThrow();
    expect(library.list()).toEqual([skill]);
    expect(new SkillLibrary(settings).list()).toEqual([skill]);
  });

  it("keeps a deleted skill deleted when it is opened anew, with the version a request still needs", async () => {
    const live = new Set<string>();
    const { library, settings } = open({ needed: () => live });
    const folder = sample();
    const skill = await imported(library, folder);
    live.add(skillKey(skill));
    library.remove(skill.id, BROWSER);

    const reopened = new SkillLibrary(settings);
    expect(reopened.list()).toEqual([]);
    expect(reopened.current(skill.id)).toBeUndefined();
    expect(reopened.version(skill)).toEqual(skill);
    // Its name is free for a new import, as it was before the restart.
    expect((await reopened.read(folder)).name).toBe("patch-writer");
    // Once nothing needs it, the reopened library removes what is left of it.
    live.clear();
    reopened.prune();
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
    ["Windows line ends", "---\r\nname: trip-check\r\ndescription: 核对\r\n---\r\n", { name: "trip-check", description: "核对" }],
    // A byte order mark is not skipped: the App Server finds no front matter behind one, and the library refuses such a file.
    ["nothing behind a byte order mark", "\u{FEFF}---\nname: trip-check\ndescription: 核对\n---\n", {}],
    ["no closing line", "---\nname: trip-check\ndescription: 核对\n", {}],
    ["keys only in the body", "# trip-check\n\nname: trip-check\ndescription: 核对\n", {}],
  ])("reads %s", (_what, text, found) => {
    expect(frontMatter(text)).toEqual(found);
  });
});

// An Executor reading the files of the skills its profile selects (skill-library::REQ-003), through the host tool that wraps its
// other tools. The inner host stands for the profile's host and MCP tools, whose own rules are tested in agent-profile.test.ts and
// mcp-proxy-tools.test.ts; here it only shows what reaches it.
describe("an Executor reading its skills' files", () => {
  const INNER = { definitions: () => [{ type: "namespace" as const, name: "files", description: "", tools: [{ type: "function" as const, name: "find", description: "", inputSchema: {} }] }],
    contractHash: () => "inner-contract", grantsMcp: () => true,
    execute: async (tool: string, _value: unknown, context?: DynamicToolContext) => ({ success: true, contentItems: [{ type: "inputText" as const, text: `inner:${context?.namespace ?? ""}.${tool}` }] }) };
  const CONTEXT = { threadId: "thread-1", turnId: "turn-1", namespace: null };
  /** The tool's answer, parsed: the JSON text of its one content item, with whether it succeeded. */
  const call = async (host: SkillFileToolHost, value: unknown) => {
    const result = await host.execute(SKILL_FILE_TOOL, value, CONTEXT);
    return { success: result.success, ...(JSON.parse(result.contentItems[0]!.text) as Record<string, unknown>) };
  };
  const failure = (code: string, message: string) => ({ success: false, ok: false, error: { code, message, retryable: false } });
  /** The library with the sample skill and another one, and a tool host for an Executor that selects the sample's first version. */
  async function selecting() {
    const opened = open(), reports: string[] = [];
    const skill = await imported(opened.library, sample());
    const other = await imported(opened.library, write(path.join(temporary("skill-source-"), "trip-check"), { "SKILL.md": skillMd("trip-check", "trip"), "references/rules.md": "trip rules\n" }));
    const host = new SkillFileToolHost(INNER, opened.library, [skill], (code) => reports.push(code));
    return { ...opened, skill, other, host, reports, stored: (file: string) => path.join(opened.settings.directory, skill.id, "1", "files", ...file.split("/")) };
  }

  it("is offered only to an Executor whose profile selects a skill, and leaves the contract and every other tool of one that selects none", async () => {
    const { library, skill } = await selecting();
    const none = new SkillFileToolHost(INNER, library, [], () => {});
    expect(none.definitions()).toEqual(INNER.definitions());
    expect(none.contractHash()).toBe("inner-contract");
    expect((await none.execute(SKILL_FILE_TOOL, { skill: "patch-writer" }, CONTEXT)).contentItems[0]!.text).toBe("inner:.read_skill_file");

    const some = new SkillFileToolHost(INNER, library, [skill], () => {});
    expect(some.definitions().map(({ name }) => name)).toEqual(["files", SKILL_FILE_TOOL]);
    expect(some.contractHash()).not.toBe("inner-contract");
    expect((await some.execute("find", {}, { ...CONTEXT, namespace: "files" })).contentItems[0]!.text).toBe("inner:files.find");
    expect(some.grantsMcp()).toBe(true);
  });

  it("leaves a turn to the workflow that claimed it through a namespaced tool, and keeps a read of a skill file the model's", async () => {
    const { library, skill } = await selecting();
    const claimed = { ...INNER, turnOwner: () => "workflow" as const };
    const host = new SkillFileToolHost(claimed, library, [skill], () => {});
    expect(host.turnOwner({ ...CONTEXT, namespace: "weixin" })).toBe("workflow");
    expect(host.turnOwner(CONTEXT)).toBe("model");
    expect(new SkillFileToolHost(claimed, library, [], () => {}).turnOwner(CONTEXT)).toBe("workflow");
  });

  it("lists and reads the files of the version its request was admitted with, scripts as text, by the skill's name or ID", async () => {
    const { library, skill, host } = await selecting();
    fs.writeFileSync(path.join(skill.source, "references", "testing.md"), "# Testing v2\n");
    const second = await library.reimport(skill.id, ((await library.compare(skill.id)) as { fingerprint: string }).fingerprint, BROWSER);

    const listed = await call(host, { skill: "patch-writer" });
    expect(listed).toEqual({ success: true, skill: "patch-writer", files: SAMPLE_PATHS.map((file) => ({ path: file, script: ["bin/tool", "check-patch.mjs", "scripts/data.txt", "tools/run"].includes(file) })) });
    expect(await call(host, { skill: "patch-writer", path: "references/testing.md" })).toEqual({ success: true, skill: "patch-writer", path: "references/testing.md", offset: 0, text: "# Testing\n" });
    expect(await call(host, { skill: skill.id, path: "check-patch.mjs" })).toMatchObject({ success: true, text: "export const check = () => true;\n" });
    const later = new SkillFileToolHost(INNER, library, [second], () => {});
    expect(await call(later, { skill: "patch-writer", path: "references/testing.md" })).toMatchObject({ success: true, text: "# Testing v2\n" });
  });

  it.each([
    ["a path that leaves the skill", (other: string) => ({ skill: "patch-writer", path: `../../../${other}/1/files/SKILL.md` }), "skill_file_not_found"],
    ["another skill's stored file by its full path", (other: string, directory: string) => ({ skill: "patch-writer", path: path.join(directory, other, "1", "files", "SKILL.md") }), "skill_file_not_found"],
    ["a skill of the library the profile does not select", () => ({ skill: "trip-check", path: "references/rules.md" }), "skill_unknown"],
    ["the ID of a skill the profile does not select", (other: string) => ({ skill: other, path: "references/rules.md" }), "skill_unknown"],
    ["arguments without a skill", () => ({ path: "SKILL.md" }), "skill_file_arguments_invalid"],
  ])("refuses %s, as an ordinary tool error", async (_what, value, code) => {
    const { other, host, reports, settings } = await selecting();
    const result = await call(host, value(other.id, settings.directory));
    expect(result).toMatchObject({ success: false, error: { code } });
    expect(result).not.toHaveProperty("text");
    expect(reports).toEqual([]);
  });

  it("tells the model which skills it can read when it names another, and how to list a skill's files when the path is wrong", async () => {
    const { host } = await selecting();
    expect(await call(host, { skill: "trip-check" })).toEqual(failure("skill_unknown", "本轮没有 skill「trip-check」。可以读取的 skill：patch-writer。"));
    expect(await call(host, { skill: "patch-writer", path: "references/missing.md" })).toEqual(failure("skill_file_not_found", "skill「patch-writer」里没有文件 references/missing.md。不填 path 可以列出它的文件。"));
  });

  it.each([
    ["a stored file replaced by a link to an outside file with the same content", (stored: (file: string) => string, outside: string) => {
      fs.writeFileSync(path.join(outside, "testing.md"), "# Testing\n");
      fs.rmSync(stored("references/testing.md"));
      fs.symlinkSync(path.join(outside, "testing.md"), stored("references/testing.md"));
    }],
    ["a stored folder replaced by a link to an outside folder with the same file", (stored: (file: string) => string, outside: string) => {
      fs.writeFileSync(path.join(outside, "testing.md"), "# Testing\n");
      fs.rmSync(stored("references"), { recursive: true });
      fs.symlinkSync(outside, stored("references"));
    }],
    // As long as the imported file, so that only its hash tells them apart.
    ["a stored file whose bytes changed", (stored: (file: string) => string) => fs.writeFileSync(stored("references/testing.md"), "# Testinx\n")],
    ["a stored file that was removed", (stored: (file: string) => string) => fs.rmSync(stored("references/testing.md"))],
    ["a stored file replaced by a folder", (stored: (file: string) => string) => { fs.rmSync(stored("references/testing.md")); fs.mkdirSync(stored("references/testing.md")); }],
  ])("refuses %s and reports the skill's store as changed outside the service, without the path", async (_what, change) => {
    const { skill, host, reports, stored } = await selecting();
    change(stored, temporary("skill-outside-"));
    expect(await call(host, { skill: "patch-writer", path: "references/testing.md" })).toEqual(failure("skill_file_unavailable", "这个文件现在读不了。"));
    expect(reports).toEqual([`skill_file_integrity_failed:${skill.id}`]);
  });

  it("refuses an empty stored file replaced by a named pipe, whose read gives the same empty bytes, and reports the skill", async () => {
    const { library, settings } = open(), reports: string[] = [];
    const skill = await imported(library, write(path.join(temporary("skill-source-"), "empty-read"), { "SKILL.md": skillMd("empty-read", "empty"), "references/empty.md": "" }));
    const host = new SkillFileToolHost(INNER, library, [skill], (code) => reports.push(code));
    const stored = path.join(settings.directory, skill.id, "1", "files", "references", "empty.md");
    fs.rmSync(stored);
    execFileSync("mkfifo", [stored]);
    expect(await call(host, { skill: "empty-read", path: "references/empty.md" })).toEqual(failure("skill_file_unavailable", "这个文件现在读不了。"));
    expect(reports).toEqual([`skill_file_integrity_failed:${skill.id}`]);
  });

  it("refuses to read from a version the library does not store", async () => {
    const { library, skill } = await selecting();
    await expect(library.readFile({ id: skill.id, version: 7 }, "SKILL.md", () => {})).rejects.toMatchObject({ reason: "integrity" });
  });

  it("refuses a file that is not text", async () => {
    const { host, reports } = await selecting();
    expect(await call(host, { skill: "patch-writer", path: "vendor/blob.bin" })).toEqual(failure("skill_file_not_text", "这个文件不是文本文件，无法读取。"));
    expect(reports).toEqual([]);
  });

  it("reads a file larger than one of the parts it is read in, with a character split between two parts, and finds a bad byte however far in", async () => {
    const { library } = open();
    // The library reads 1 MiB at a time: 中 takes the last byte of the first part and the first two of the second.
    const split = Buffer.concat([Buffer.alloc(1024 * 1024 - 1, "a"), Buffer.from("中"), Buffer.alloc(10, "b")]);
    const bad = Buffer.concat([Buffer.alloc(1024 * 1024 + 5, "a"), Buffer.from([0xFF]), Buffer.from("a")]);
    // Its last character lacks its last byte.
    const cut = Buffer.from("a中").subarray(0, 3);
    const skill = await imported(library, write(path.join(temporary("skill-source-"), "big-read"), { "SKILL.md": skillMd("big-read", "big"),
      "references/split.md": split, "references/bad.md": bad, "references/cut.md": cut }));
    const host = new SkillFileToolHost(INNER, library, [skill], () => {});
    const read = (offset: number) => call(host, { skill: "big-read", path: "references/split.md", offset });
    // 1,048,575 a, then 中, then 10 b: 1,048,586 characters.
    expect(await read(1024 * 1024 - 5)).toEqual({ success: true, skill: "big-read", path: "references/split.md", offset: 1024 * 1024 - 5, text: "aaaa中bbbbbbbbbb" });
    expect(await read(0)).toEqual({ success: true, skill: "big-read", path: "references/split.md", offset: 0, text: "a".repeat(100_000), nextOffset: 100_000,
      note: "文件还有 948586 个字符没有读，用 offset=100000 继续读取。" });
    expect(await read(1024 * 1024)).toEqual({ success: true, skill: "big-read", path: "references/split.md", offset: 1024 * 1024, text: "bbbbbbbbbb" });
    for (const file of ["references/bad.md", "references/cut.md"]) {
      expect(await call(host, { skill: "big-read", path: file })).toEqual(failure("skill_file_not_text", "这个文件不是文本文件，无法读取。"));
    }
  });

  it("returns a long file 100,000 characters at a time, never splitting one, and says where to go on", async () => {
    const { library } = open();
    const long = `${"a".repeat(99_999)}𝄞bcdef`;
    const skill = await imported(library, write(path.join(temporary("skill-source-"), "long-read"), { "SKILL.md": skillMd("long-read", "long"), "references/long.md": long }));
    const host = new SkillFileToolHost(INNER, library, [skill], () => {});
    const first = await call(host, { skill: "long-read", path: "references/long.md" });
    expect(first).toEqual({ success: true, skill: "long-read", path: "references/long.md", offset: 0, text: `${"a".repeat(99_999)}𝄞`, nextOffset: 100_000,
      note: "文件还有 5 个字符没有读，用 offset=100000 继续读取。" });
    expect(await call(host, { skill: "long-read", path: "references/long.md", offset: 100_000 })).toEqual({ success: true, skill: "long-read", path: "references/long.md", offset: 100_000, text: "bcdef" });
    expect(await call(host, { skill: "long-read", path: "references/long.md", offset: 100_006 })).toEqual(failure("skill_file_offset_invalid", "offset 超出了文件长度（共 100005 个字符）。"));
  });
});
