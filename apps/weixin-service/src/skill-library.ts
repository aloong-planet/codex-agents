import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConsoleBrowser } from "./console-access.js";
import type { ConsoleAudit } from "./console-audit.js";

/** One imported file: its path inside the skill folder with `/` separators, its size, its content hash and whether it is a script. */
export type SkillFile = Readonly<{ path: string; size: number; sha256: string; script: boolean }>;
/** One version of a skill, as a profile in a definitions version refers to it. */
export type SkillRef = Readonly<{ id: string; version: number }>;
/** A stored version of a skill: what SKILL.md said, where it came from, when, and every copied file. */
export type StoredSkill = SkillRef & Readonly<{ name: string; description: string; source: string; importedAt: number; files: readonly SkillFile[] }>;
/** What reading a folder found, before anything is copied; `fingerprint` names exactly these files with these contents. */
export type SkillPreview = Readonly<{ folder: string; name: string; description: string; files: ReadonlyArray<Readonly<{ path: string; script: boolean }>>; fingerprint: string }>;
/** A profile that selects a skill, as the skill's details list it. */
export type SkillUse = Readonly<{ teamId: string; leader: string; teamName: string; profile: string }>;
export type SkillFileChange = Readonly<{ path: string; change: "changed" | "added" | "removed" }>;
/**
 * A skill's copy against its source folder now: the same files with the same contents; some files changed, added or
 * removed, with the fingerprint a re-import of exactly that state confirms; or a source that is gone or cannot be read.
 */
export type SourceState = Readonly<{ state: "same" } | { state: "changed"; files: readonly SkillFileChange[]; fingerprint: string } | { state: "missing" } | { state: "unreadable" }>;
export type SkillActor = Readonly<{ browser?: ConsoleBrowser }>;
/**
 * A skill as the console's table and details show it (skill-library::US-002, US-003). It carries no file content. `refused` is
 * there when an Executor's runtime did not load the current version, with Codex's message when it gave one (skill-library::REQ-002).
 */
export type SkillView = Readonly<{ id: string; name: string; description: string; source: string; importedAt: string;
  files: ReadonlyArray<Readonly<{ path: string; script: boolean }>>; state: SourceState; usedBy: readonly SkillUse[]; refused?: SkillLoadRefusal }>;
/** That a runtime's App Server did not list a version when the runtime started, and its message for the SKILL.md, if any. */
export type SkillLoadRefusal = Readonly<{ reason?: string }>;

/**
 * Why the library refuses: `folder`, the path is missing, not a folder, not absolute or unreadable; `skill_md`, no SKILL.md
 * at its root; `front_matter`, SKILL.md lacks a name or a description; `bom`, SKILL.md starts with a byte order mark;
 * `name_length`, its name is too long; `links`, entries that are not files or folders; `duplicate`, another skill has the
 * name; `changed`, the folder is not what was confirmed; `in_use`, profiles select the skill; `uses_unknown`, it cannot be told
 * whether any does; `unknown`, no such skill.
 */
export type SkillRefusalKind = Readonly<{ kind: "folder" | "skill_md" | "front_matter" | "bom" | "name_length" | "changed" | "uses_unknown" | "unknown" } | { kind: "links"; links: readonly string[] }
  | { kind: "duplicate"; name: string } | { kind: "in_use"; uses: number }>;
export class SkillRefusal extends Error {
  /** `cause` is the file-system error behind a `folder` refusal, which tells a missing source from an unreadable one. */
  constructor(readonly refusal: SkillRefusalKind, cause?: unknown) { super(`skill_library_${refusal.kind}`, cause === undefined ? undefined : { cause }); }
}

export type SkillLibraryOptions = Readonly<{
  /** The library's own directory under the service's state directory; no file grant reaches it (ADR-0029). */
  directory: string;
  audit: ConsoleAudit;
  /**
   * The profiles of the current definitions that select a skill; undefined while that cannot be told. The skill is then shown
   * with no uses, and it is not deleted.
   */
  usedBy?(id: string): readonly SkillUse[] | undefined;
  /** Called when a re-import made `version` a skill's current one, so that profiles selecting it follow. */
  reimported?(ref: SkillRef): void;
  /**
   * The versions (`skillKey`) a profile of the current definitions or a request that can still run refers to; undefined
   * while that cannot be told, and nothing is removed then.
   */
  needed?(): ReadonlySet<string> | undefined;
  now?: () => number;
  /** What `~` in a typed path stands for; the service's home by default. */
  home?: string;
}>;

export const skillKey = ({ id, version }: SkillRef): string => `${id}@${version}`;

const SKILL_ID = /^skill-[0-9a-f]{8}$/u;
/** The library's own temporary directories: a copy being staged, and a skill being removed. */
const LEFTOVER = /^\.(?:staging|removed)-[0-9a-f-]{36}$/u;
const SKILL_MD = "SKILL.md";
/** The longest name, in characters, under which the App Server lists a skill. */
const NAME_LIMIT = 64;
/**
 * How a file of a source folder is opened once it was seen to be a regular file: never through a link put in its place since,
 * and without waiting when a named pipe was put there, whose open would otherwise wait for a writer and hold one of the
 * process's few file-system threads. What was opened is checked to be a regular file before anything is read.
 */
const SOURCE_OPEN = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const MANIFEST = "manifest.json";
/** Beside a version's copy and manifest: that the latest runtime to start with the version did not load it. */
const REFUSED = "codex-refused.json";
const DELETED = "deleted";
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".fish", ".command", ".py", ".rb", ".pl", ".php", ".js", ".mjs", ".cjs", ".ts", ".ps1", ".bat", ".cmd"]);

/** What a walk of a folder found: its files in path order, and the entries that are neither files nor folders. */
type Scan = { files: SkillFile[]; links: Array<{ path: string; shown: string }> };

/**
 * The Skill Library (docs/specs/skill-library.md): skills imported from local folders as copies. Each import or re-import
 * stores a version of the folder with a manifest of its files and their hashes; versions are never changed once stored.
 * A profile refers to a version, so a request keeps the content it was admitted with (agent-dispatch::REQ-017/AC-01).
 * The library never takes skill content from anywhere but a folder (skill-library::REQ-001).
 */
export class SkillLibrary {
  private readonly directory: string;
  private readonly now: () => number;
  /** Every stored version by skill, and the skills the owner deleted whose versions requests may still need. */
  private readonly versions = new Map<string, Map<number, StoredSkill>>();
  private readonly deleted = new Set<string>();
  /** The versions (`skillKey`) the latest runtime to start with them did not load. */
  private readonly refusals = new Map<string, SkillLoadRefusal>();

  constructor(private readonly options: SkillLibraryOptions) {
    this.directory = options.directory;
    this.now = options.now ?? Date.now;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      const location = path.join(this.directory, entry.name);
      if (!entry.isDirectory()) continue;
      // What an interrupted import or removal left behind was never, or is no longer, part of the library. Nothing else
      // is removed here: only the names the library itself gives its temporary directories.
      if (LEFTOVER.test(entry.name)) { fs.rmSync(location, { recursive: true, force: true }); continue; }
      if (!SKILL_ID.test(entry.name)) continue;
      const stored = new Map<number, StoredSkill>();
      for (const version of fs.readdirSync(location)) {
        if (!/^[1-9][0-9]*$/u.test(version)) continue;
        // A version whose manifest cannot be read is not offered: whoever needs it is refused rather than given other content.
        try { stored.set(Number(version), JSON.parse(fs.readFileSync(path.join(location, version, MANIFEST), "utf8")) as StoredSkill); }
        catch { process.stderr.write(`skill_library_version_unreadable: ${entry.name}@${version}\n`); continue; }
        // A record that cannot be read is dropped: the next runtime with this version records it again.
        try {
          const { reason } = JSON.parse(fs.readFileSync(path.join(location, version, REFUSED), "utf8")) as { reason?: unknown };
          this.refusals.set(skillKey({ id: entry.name, version: Number(version) }), typeof reason === "string" ? { reason } : {});
        } catch { /* No record. */ }
      }
      if (!stored.size) {
        // An import that stopped between creating the skill's directory and moving its first version in leaves it empty.
        try { fs.rmdirSync(location); } catch { /* It holds something; it stays. */ }
        continue;
      }
      this.versions.set(entry.name, stored);
      if (fs.existsSync(path.join(location, DELETED))) this.deleted.add(entry.name);
    }
  }

  /** The current version of every skill in the library, in name order. */
  list(): StoredSkill[] {
    return [...this.versions.keys()].filter((id) => !this.deleted.has(id)).map((id) => this.latest(id)!)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  /** Every skill as the console shows it: its current version, its source folder compared now, and the profiles that select it. */
  async view(): Promise<SkillView[]> {
    return Promise.all(this.list().map(async ({ id, name, description, source, importedAt, files }) => ({ id, name, description, source,
      importedAt: new Date(importedAt).toISOString(), files: files.map(({ path: file, script }) => ({ path: file, script })),
      state: await this.compare(id), usedBy: this.options.usedBy?.(id) ?? [], ...this.refusalOf(id) })));
  }

  /**
   * Records how a version fared when an Executor's runtime started with it: listed by its App Server, or not, with the message it
   * gave for that SKILL.md. The latest outcome stands, so a runtime that lists the version clears an earlier refusal; a new
   * version starts with none (skill-library::REQ-002). A version no longer stored is not recorded.
   */
  recordLoading(ref: SkillRef, outcome: Readonly<{ loaded: true } | { loaded: false; reason?: string }>): void {
    if (!this.version(ref)) return;
    const key = skillKey(ref), file = path.join(this.directory, ref.id, String(ref.version), REFUSED);
    if (outcome.loaded) {
      if (!this.refusals.delete(key)) return;
      fs.rmSync(file, { force: true });
      return;
    }
    const refusal: SkillLoadRefusal = outcome.reason === undefined ? {} : { reason: outcome.reason };
    const staged = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(staged, JSON.stringify(refusal), { mode: 0o600 });
    fs.renameSync(staged, file);
    this.refusals.set(key, refusal);
  }

  private refusalOf(id: string): { refused?: SkillLoadRefusal } {
    const current = this.latest(id);
    const refusal = current && this.refusals.get(skillKey(current));
    return refusal ? { refused: refusal } : {};
  }

  /** The current version of a skill in the library; undefined for an unknown or deleted one. */
  current(id: string): StoredSkill | undefined {
    return this.deleted.has(id) ? undefined : this.latest(id);
  }

  /** A stored version, also of a re-imported or deleted skill while a request still needs it. */
  version(ref: SkillRef): StoredSkill | undefined {
    return this.versions.get(ref.id)?.get(ref.version);
  }

  /**
   * Reads a folder without copying anything (skill-library::US-001): the name and description from its SKILL.md and every
   * file an import would copy. Refused when the folder is not a skill's root, holds entries that are not files or folders,
   * or names a skill the library already has.
   */
  async read(folder: string): Promise<SkillPreview> {
    const source = this.sourcePath(folder);
    const root = await realFolder(source);
    const declared = await rootSkill(root);
    const scan = await walk(root);
    if (scan.links.length) throw new SkillRefusal({ kind: "links", links: scan.links.map(({ shown }) => shown) });
    const listed = scan.files.find((file) => file.path === SKILL_MD);
    if (!declared || !listed) throw new SkillRefusal({ kind: "skill_md" });
    // The name and description shown are those of the very SKILL.md the fingerprint names.
    if (listed.sha256 !== declared.sha256) throw new SkillRefusal({ kind: "changed" });
    this.refuseDuplicate(declared.name);
    return { folder: source, name: declared.name, description: declared.description, files: scan.files.map(({ path: file, script }) => ({ path: file, script })),
      fingerprint: fingerprint(scan.files) };
  }

  /**
   * Imports the folder as a new skill. `confirmed` is the fingerprint of the read the owner confirmed: the copy holds
   * exactly those files with those contents, or nothing is imported and the folder must be read again.
   */
  async import(folder: string, confirmed: string, actor: SkillActor): Promise<StoredSkill> {
    const source = this.sourcePath(folder);
    const staged = await this.stage(source, confirmed);
    try {
      this.refuseDuplicate(staged.name);
      let id = `skill-${randomUUID().slice(0, 8)}`;
      while (this.versions.has(id)) id = `skill-${randomUUID().slice(0, 8)}`;
      const skill = this.store(staged, { id, version: 1 }, source);
      try {
        this.audit(actor, { event: "skill_imported", skill: id, name: skill.name, version: 1, source, files: skill.files.length });
      } catch (error) { this.drop(skill); throw error; }
      return skill;
    } finally { fs.rmSync(staged.directory, { recursive: true, force: true }); }
  }

  /** A skill's copy compared with its source folder as it is now (skill-library::US-002). */
  async compare(id: string): Promise<SourceState> {
    const skill = this.current(id);
    if (!skill) throw new SkillRefusal({ kind: "unknown" });
    let scan: Scan;
    try { scan = await walk(await realFolder(skill.source)); }
    catch (error) {
      if (!(error instanceof SkillRefusal) || error.refusal.kind !== "folder") throw error;
      const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
      return { state: code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable" };
    }
    const stored = new Map(skill.files.map((file) => [file.path, file.sha256]));
    const found = new Map<string, string | null>([...scan.files.map((file) => [file.path, file.sha256] as const), ...scan.links.map((link) => [link.path, null] as const)]);
    const files: SkillFileChange[] = [
      ...[...found].flatMap(([file, hash]): SkillFileChange[] => !stored.has(file) ? [{ path: file, change: "added" }] : stored.get(file) === hash ? [] : [{ path: file, change: "changed" }]),
      ...[...stored.keys()].filter((file) => !found.has(file)).map((file): SkillFileChange => ({ path: file, change: "removed" })),
    ].sort(byPath);
    return files.length ? { state: "changed", files, fingerprint: fingerprint(scan.files, scan.links.map((link) => link.path)) } : { state: "same" };
  }

  /**
   * Imports the source folder again as the skill's next version. `confirmed` is the fingerprint of the comparison the owner
   * confirmed. Requests already admitted keep the version they started with; profiles that select the skill follow the new
   * one. The skill takes the name its SKILL.md has now, unless another skill has it.
   */
  async reimport(id: string, confirmed: string, actor: SkillActor): Promise<StoredSkill> {
    const before = this.current(id);
    if (!before) throw new SkillRefusal({ kind: "unknown" });
    const staged = await this.stage(before.source, confirmed);
    try {
      const present = this.current(id);
      if (!present) throw new SkillRefusal({ kind: "unknown" });
      if (present.version !== before.version) throw new SkillRefusal({ kind: "changed" });
      this.refuseDuplicate(staged.name, id);
      const skill = this.store(staged, { id, version: present.version + 1 }, present.source);
      const stored = new Map(present.files.map((file) => [file.path, file.sha256]));
      const changed = skill.files.filter((file) => stored.get(file.path) !== file.sha256).length + present.files.filter((file) => !skill.files.some((kept) => kept.path === file.path)).length;
      try {
        this.audit(actor, { event: "skill_reimported", skill: id, name: skill.name, version: skill.version, source: skill.source, files: skill.files.length, changed });
      } catch (error) { this.drop(skill); throw error; }
      this.options.reimported?.({ id, version: skill.version });
      this.prune();
      return skill;
    } finally { fs.rmSync(staged.directory, { recursive: true, force: true }); }
  }

  /**
   * Deletes a skill no profile selects (skill-library::US-003); its source folder is not touched. Versions that a request
   * can still run with stay stored until `prune` finds them free. Refused also while it cannot be told who selects it.
   */
  remove(id: string, actor: SkillActor): void {
    const skill = this.current(id);
    if (!skill) throw new SkillRefusal({ kind: "unknown" });
    const uses = this.options.usedBy ? this.options.usedBy(id) : [];
    if (!uses) throw new SkillRefusal({ kind: "uses_unknown" });
    if (uses.length) throw new SkillRefusal({ kind: "in_use", uses: uses.length });
    this.audit(actor, { event: "skill_deleted", skill: id, name: skill.name, version: skill.version, source: skill.source });
    fs.writeFileSync(path.join(this.directory, id, DELETED), "", { mode: 0o600 });
    this.deleted.add(id);
    this.prune();
  }

  /**
   * Removes the versions nothing needs any more: superseded versions and every version of a deleted skill, unless a
   * profile or a request that can still run refers to them. Call it whenever that may have changed.
   */
  prune(): void {
    const candidates = [...this.versions].flatMap(([id, stored]) => {
      const latest = Math.max(...stored.keys());
      return [...stored.keys()].filter((version) => this.deleted.has(id) || version < latest).map((version) => ({ id, version }));
    });
    if (!candidates.length) return;
    const needed = this.options.needed?.();
    if (!needed) return;
    for (const ref of candidates) {
      if (!needed.has(skillKey(ref))) this.drop(ref);
    }
  }

  /**
   * Writes the given versions into `directory`, one folder per skill named by its ID, each file equal to the stored one.
   * A version that is not stored, or a stored file that no longer matches its manifest, throws before the caller can run
   * with other content than the request's snapshot (skill-library::REQ-002). Returns each written skill's name with the real
   * path of its SKILL.md, the form in which a runtime's App Server lists it.
   */
  materialize(refs: readonly SkillRef[], directory: string): Array<{ name: string; path: string }> {
    const written: Array<{ name: string; path: string }> = [];
    for (const ref of refs) {
      const skill = this.version(ref);
      if (!skill) throw new Error("skill_version_unavailable");
      const from = path.join(this.directory, ref.id, String(ref.version), "files");
      for (const file of skill.files) {
        const target = path.join(directory, ref.id, ...file.path.split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (copyFileSync(path.join(from, ...file.path.split("/")), target) !== file.sha256) throw new Error("skill_version_corrupt");
      }
      written.push({ name: skill.name, path: fs.realpathSync(path.join(directory, ref.id, SKILL_MD)) });
    }
    return written;
  }

  private latest(id: string): StoredSkill | undefined {
    const stored = this.versions.get(id);
    return stored?.get(Math.max(...stored.keys()));
  }

  /** `~` and `~/…` stand for the home directory; any other path must be absolute. */
  private sourcePath(folder: string): string {
    const typed = folder.trim();
    const expanded = typed === "~" || typed.startsWith("~/") ? path.join(this.options.home ?? os.homedir(), typed.slice(1)) : typed;
    if (!path.isAbsolute(expanded)) throw new SkillRefusal({ kind: "folder" });
    return path.resolve(expanded);
  }

  private refuseDuplicate(name: string, except?: string): void {
    if (this.list().some((skill) => skill.name === name && skill.id !== except)) throw new SkillRefusal({ kind: "duplicate", name });
  }

  /**
   * Copies the folder into a staging directory of the library, hashing what it copies, and checks the copy against the
   * confirmed fingerprint: what is stored is what the owner saw listed, whatever happened to the folder since.
   */
  private async stage(source: string, confirmed: string): Promise<Readonly<{ directory: string; name: string; description: string; files: SkillFile[] }>> {
    const root = await realFolder(source);
    await rootSkill(root);
    const directory = path.join(this.directory, `.staging-${randomUUID()}`);
    try {
      const scan = await walk(root, path.join(directory, "files"));
      if (scan.links.length) throw new SkillRefusal({ kind: "links", links: scan.links.map(({ shown }) => shown) });
      if (!scan.files.some((file) => file.path === SKILL_MD)) throw new SkillRefusal({ kind: "skill_md" });
      const meta = described(fs.readFileSync(path.join(directory, "files", SKILL_MD), "utf8"));
      if (fingerprint(scan.files) !== confirmed) throw new SkillRefusal({ kind: "changed" });
      return { directory, ...meta, files: scan.files };
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Makes a staged copy a stored version: its manifest is written beside its files, and one rename puts it in place. */
  private store(staged: Readonly<{ directory: string; name: string; description: string; files: SkillFile[] }>, ref: SkillRef, source: string): StoredSkill {
    const skill: StoredSkill = { id: ref.id, version: ref.version, name: staged.name, description: staged.description, source, importedAt: this.now(), files: staged.files };
    fs.writeFileSync(path.join(staged.directory, MANIFEST), JSON.stringify(skill), { mode: 0o600 });
    fs.mkdirSync(path.join(this.directory, ref.id), { recursive: true, mode: 0o700 });
    fs.renameSync(staged.directory, path.join(this.directory, ref.id, String(ref.version)));
    const stored = this.versions.get(ref.id) ?? new Map<number, StoredSkill>();
    stored.set(ref.version, skill);
    this.versions.set(ref.id, stored);
    return skill;
  }

  /** Takes a stored version out of the library, and its skill with its last version. */
  private drop(ref: SkillRef): void {
    const stored = this.versions.get(ref.id);
    if (!stored?.delete(ref.version)) return;
    this.refusals.delete(skillKey(ref));
    const location = path.join(this.directory, ref.id);
    if (stored.size) { fs.rmSync(path.join(location, String(ref.version)), { recursive: true, force: true }); return; }
    this.versions.delete(ref.id);
    this.deleted.delete(ref.id);
    // Renamed first, so a removal that stops halfway never leaves a skill with some of its files.
    const removed = path.join(this.directory, `.removed-${randomUUID()}`);
    fs.renameSync(location, removed);
    fs.rmSync(removed, { recursive: true, force: true });
  }

  /** Every import, re-import and deletion is audited with the browser that asked, never with skill content (agent-console::REQ-004). */
  private audit(actor: SkillActor, entry: Record<string, unknown>): void {
    this.options.audit.append({ by: actor.browser ? "browser" : "service", ...(actor.browser ? { browser: { id: actor.browser.id, label: actor.browser.label } } : {}), ...entry });
  }
}

/**
 * The real folder a typed path names. The path may pass through symbolic links, or be one: the owner's skill folders are
 * often reached that way. Links inside the folder are another matter, and `walk` reports them.
 */
async function realFolder(source: string): Promise<string> {
  try {
    const root = await fs.promises.realpath(source);
    if (!(await fs.promises.stat(root)).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    return root;
  } catch (cause) { throw new SkillRefusal({ kind: "folder" }, cause); }
}

/**
 * Walks a folder without following any link, hashing every file, and copies each into `copyTo` when given. Entries that are
 * neither files nor folders are reported, not read. A folder or file that cannot be read refuses the walk.
 */
async function walk(root: string, copyTo?: string): Promise<Scan> {
  const scan: Scan = { files: [], links: [] };
  const visit = async (relative: string): Promise<void> => {
    const entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(file);
      else if (entry.isSymbolicLink()) scan.links.push({ path: file, shown: `${file} → ${await fs.promises.readlink(path.join(root, file)).catch(() => "?")}` });
      else if (!entry.isFile()) scan.links.push({ path: file, shown: `${file}（不是普通文件）` });
      else scan.files.push(await hashFile(path.join(root, file), file, copyTo === undefined ? undefined : path.join(copyTo, file)));
    }
  };
  try {
    if (copyTo !== undefined) await fs.promises.mkdir(copyTo, { recursive: true, mode: 0o700 });
    await visit("");
  } catch (cause) {
    if (cause instanceof SkillRefusal) throw cause;
    throw new SkillRefusal({ kind: "folder" }, cause);
  }
  scan.files.sort(byPath);
  return scan;
}

/** Path order by code unit, the same on every machine. */
const byPath = (left: Readonly<{ path: string }>, right: Readonly<{ path: string }>) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

/** Hashes one file, read without following a link put in its place since the walk listed it; copies it when asked. */
async function hashFile(source: string, relative: string, target: string | undefined): Promise<SkillFile> {
  const handle = await fs.promises.open(source, SOURCE_OPEN);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new SkillRefusal({ kind: "changed" });
    if (target !== undefined) await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const out = target === undefined ? undefined : await fs.promises.open(target, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let size = 0, head = "";
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        if (!size) head = chunk.subarray(0, 2).toString("latin1");
        hash.update(chunk);
        // Written from the handle's current position, so the chunks follow one another.
        if (out) await out.writeFile(chunk);
        size += bytesRead;
      }
      return { path: relative, size, sha256: hash.digest("hex"), script: isScript(relative, stat.mode, head) };
    } finally { await out?.close(); }
  } finally { await handle.close(); }
}

/** Copies one stored file, without following a link in its place, and returns the hash of what was written. */
function copyFileSync(source: string, target: string): string {
  const from = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(from).isFile()) throw new Error("skill_version_corrupt");
    const to = fs.openSync(target, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = fs.readSync(from, buffer, 0, buffer.length, null);
        if (!read) break;
        hash.update(buffer.subarray(0, read));
        for (let written = 0; written < read;) written += fs.writeSync(to, buffer, written, read - written);
      }
      return hash.digest("hex");
    } finally { fs.closeSync(to); }
  } finally { fs.closeSync(from); }
}

/**
 * Whether a file counts as a script, which the import marks for the owner: it lies under a folder named `scripts`, has a
 * script extension, may be executed, or starts with `#!`.
 */
function isScript(relative: string, mode: number, head: string): boolean {
  return relative.split("/").slice(0, -1).includes("scripts") || SCRIPT_EXTENSIONS.has(path.extname(relative).toLowerCase()) || (mode & 0o111) !== 0 || head === "#!";
}

/** Names a set of files by their paths, sizes and contents, and any entries that are not files by their paths. */
function fingerprint(files: readonly SkillFile[], others: readonly string[] = []): string {
  return createHash("sha256").update(JSON.stringify([files.map(({ path: file, size, sha256 }) => [file, size, sha256]), others])).digest("hex");
}

/** The name and description a SKILL.md declares; refused when either is missing. */
function described(text: string): Readonly<{ name: string; description: string }> {
  // The App Server lists no skill whose SKILL.md starts with a byte order mark or whose name is longer than NAME_LIMIT: a
  // runtime would get the skill and its model would never read it, so the folder is refused here instead.
  if (text.charCodeAt(0) === 0xFEFF) throw new SkillRefusal({ kind: "bom" });
  const { name, description } = frontMatter(text);
  if (!name || !description) throw new SkillRefusal({ kind: "front_matter" });
  if ([...name].length > NAME_LIMIT) throw new SkillRefusal({ kind: "name_length" });
  return { name, description };
}

/**
 * What the SKILL.md at a folder's root declares, read before anything below the folder: a folder that is not a skill, or whose
 * SKILL.md cannot be used, is refused without reading the rest, however large it is. The hash is of the bytes read. A SKILL.md
 * that is not a regular file (a link, a folder, a named pipe, a socket) gives undefined without being opened, and is left to the
 * walk, which reports it.
 */
async function rootSkill(root: string): Promise<Readonly<{ name: string; description: string; sha256: string }> | undefined> {
  const file = path.join(root, SKILL_MD);
  const gone = (cause: unknown) => (cause as NodeJS.ErrnoException).code === "ENOENT" ? new SkillRefusal({ kind: "skill_md" }) : new SkillRefusal({ kind: "folder" }, cause);
  let entry: fs.Stats;
  try { entry = await fs.promises.lstat(file); } catch (cause) { throw gone(cause); }
  if (!entry.isFile()) return undefined;
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(file, SOURCE_OPEN); }
  catch (cause) {
    // Replaced by a symbolic link since the look at it: not followed, and the walk reports it.
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") return undefined;
    throw gone(cause);
  }
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    const content = await handle.readFile();
    return { ...described(content.toString("utf8")), sha256: createHash("sha256").update(content).digest("hex") };
  } catch (cause) {
    if (cause instanceof SkillRefusal) throw cause;
    throw new SkillRefusal({ kind: "folder" }, cause);
  } finally { await handle.close(); }
}

/**
 * The `name` and `description` of a SKILL.md's front matter: the block between a first line `---` and the next `---`.
 * Each value is a plain scalar, a quoted one or a block scalar (`|`, `>`), which may continue on indented lines.
 */
export function frontMatter(text: string): Readonly<{ name?: string; description?: string }> {
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trimEnd() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end < 0) return {};
  const found: { name?: string; description?: string } = {};
  for (let index = 1; index < end; index++) {
    const key = /^(name|description):(?:[ \t]+(.*))?$/u.exec(lines[index]!);
    if (!key) continue;
    const continued: string[] = [];
    while (index + 1 < end && (/^[ \t]/u.test(lines[index + 1]!) || !lines[index + 1]!.trim())) continued.push(lines[++index]!);
    const value = scalar((key[2] ?? "").trim(), continued).trim();
    if (value) found[key[1] as "name" | "description"] = value;
  }
  return found;
}

function scalar(first: string, continued: readonly string[]): string {
  const rest = continued.map((line) => line.trim());
  if (/^[|>][+-]?$/u.test(first)) return first.startsWith("|") ? rest.join("\n") : rest.filter(Boolean).join(" ");
  const joined = [first, ...rest.filter(Boolean)].join(" ");
  if (joined.startsWith('"')) {
    const close = /^"((?:[^"\\]|\\.)*)"/u.exec(joined);
    if (!close) return joined.slice(1);
    try { return String(JSON.parse(`"${close[1]}"`)); } catch { return close[1]!; }
  }
  if (joined.startsWith("'")) return (/^'((?:[^']|'')*)'/u.exec(joined)?.[1] ?? joined.slice(1)).replaceAll("''", "'");
  return joined.replace(/\s+#.*$/u, "");
}
