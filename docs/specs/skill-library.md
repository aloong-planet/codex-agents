# Skill library

> Status: implemented. The Skill 管理 page imports, re-imports and deletes skills, profiles select them on the team page, every Executor runtime is created with exactly its profile's skills, and an Executor reads its skills' other files through a read-only tool.
> Related: [team management](team-management.md), [agent dispatch](agent-dispatch.md), [agent console](agent-console.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md), [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md), [ADR-0029](../adr/0029-keep-service-state-outside-every-file-grant.md), [ADR-0031](../adr/0031-compact-executor-runtime-homes-to-their-rollouts.md).

## Problem Statement

Executor profiles need skills that fit their domain, while group runtimes must not inherit the owner's own skills. The owner wants to keep a library of skills in the console, choose them per profile, and always know which content agents actually load.

## Solution

A skill management page imports skills from local folders into a Skill Library, as copies. A table lists each skill with its source folder, files, import time, whether the source has changed, and how many profiles use it; each skill opens in a drawer over the page. Profiles on the team page select skills from the library. The console never edits skill content: the owner edits the folder and imports again. A skill in use cannot be deleted until every profile has unbound it. An Executor works by the SKILL.md of each skill its profile selects, and reads the skill's other files, read-only, when it needs them.

## User Stories

### skill-library::US-001 Import a skill from a folder

As the owner, I want to import a skill folder and see exactly what will be copied, so that I know what agents will load.

- skill-library::US-001/AC-01: "从文件夹导入" opens an import drawer, where the owner enters a folder path and reads the folder.
- skill-library::US-001/AC-02: An importable folder shows the name and description from its SKILL.md and every file to be copied, with scripts marked. A confirmation card states that the files are copied, so later edits need a new import, and what an Executor does with them: 「这些文件会复制进本系统的 Skill 库；之后修改来源文件夹，要重新导入才会生效。执行者按 SKILL.md 工作，需要时可以读取其他文件，但不能修改；脚本不会运行。」 Only confirming it imports the skill.
- skill-library::US-001/AC-03: A folder without SKILL.md at its root shows an error asking for the skill's root folder: 「这个文件夹里没有 SKILL.md，无法导入。请确认选的是 skill 的根目录。」
- skill-library::US-001/AC-04: A skill whose name already exists in the library shows an error pointing to re-import from the existing skill's details: 「已有同名 skill「<名称>」。要更新它，请在它的详情里重新导入；或换一个文件夹。」
- skill-library::US-001/AC-05: A folder that contains symbolic links is refused, and the error lists them, each with its target: 「这个文件夹里有 <n> 个符号链接，无法导入：」, the list, then 「符号链接可能指向文件夹以外的文件。请换成实际文件后重新读取。」 Size and file count are not limited, and binary files are copied like any other file.

### skill-library::US-002 Keep a skill in step with its source folder

As the owner, I want to know when a skill's folder has changed, so that I can decide when agents get the new content.

- skill-library::US-002/AC-01: The table shows each skill's name with its description, source folder, file count with scripts noted, import time, source state and number of profiles using it. An empty library shows 「还没有 skill。」 with 「点「从文件夹导入」导入本机的 skill 文件夹。」
- skill-library::US-002/AC-02: The source state says the skill matches its source (「与来源一致」), or how many files changed (「<n> 个文件已变化」): files whose content differs, files only the source has and files only the copy has. When files have changed, "重新导入" shows a confirmation card that lists them, a file only the source has marked 「（新增）」 and a file only the copy has 「（已删除）」. For a skill in use, the card says that new requests use the new content and requests in progress keep the old content ([agent-dispatch::REQ-017/AC-01](agent-dispatch.md)).
- skill-library::US-002/AC-03: When the source folder is missing or unreadable, the source state says so and re-import is unavailable. The imported copy stays usable. A missing folder shows 「找不到来源文件夹」 with 「找不到来源文件夹 <路径>，可能已移动或删除，暂时无法重新导入。已导入的副本照常可用，能力档不受影响；把文件夹放回原处后重新检查。」; one that cannot be read shows 「读不了来源文件夹」 with 「读不了来源文件夹 <路径>，暂时无法重新导入。已导入的副本照常可用，能力档不受影响；恢复读取权限后重新检查。」

### skill-library::US-003 See where a skill is used, and delete it

As the owner, I want to see which profiles use a skill and remove skills I no longer need, without silently taking them away from a profile.

- skill-library::US-003/AC-01: The drawer shows the description, the source folder and the imported files, and lists the profiles that select the skill, each linking to the team page to unbind it.
- skill-library::US-003/AC-02: A skill in use shows why it cannot be deleted, and its delete action is disabled.
- skill-library::US-003/AC-03: An unused skill asks for inline confirmation; deleting it leaves the source folder untouched.

## Functional Requirements

### skill-library::REQ-001 Skill content is read-only in the console (direct acceptance)

The console never authors, uploads, pastes or edits skill content. Skills enter the library only by import from a local folder.

### skill-library::REQ-002 Executors load exactly their profile's skills (direct acceptance)

When an Executor is created, the host copies the skills its profile selects, in the versions of the request's snapshot, into that Executor's own runtime home ([agent-dispatch::REQ-016/AC-04](agent-dispatch.md)). It copies them again whenever that Executor's runtime is created for a retry, because a released home keeps only its rollouts ([ADR-0031](../adr/0031-compact-executor-runtime-homes-to-their-rollouts.md)). No other skill is visible to it. The host puts every copied skill on each of the Executor's turns, which is how its model reads each SKILL.md.

### skill-library::REQ-003 Executors read their skills' other files (direct acceptance)

An Executor whose profile selects at least one skill has a host tool, `read_skill_file`, that lists the files of one of those skills and reads one of them, in the versions of the request's snapshot. It reads only files of those versions, as they were imported, and never writes, runs or reaches anything else: no other skill, no other version and no other part of its runtime home. A script is read as text and never run. An Executor whose profile selects no skill is offered no such tool.

## Failure modes and boundaries

| User sequence | Required outcome / defining coverage unit |
| --- | --- |
| Owner enters a path to a file, a missing folder, or a folder without SKILL.md at its root | Error asking for the skill's root folder under skill-library::US-001/AC-03. A path that is missing, not a folder or unreadable shows 「找不到或读不了这个文件夹，无法导入。请确认填的是 skill 的根目录。」 |
| Owner enters a path that is not absolute and is neither `~` nor starts with `~/` | Refused as a path that cannot be found, with the same words |
| The typed path is itself a symbolic link to a folder, or passes through one | The folder it leads to is read, because the owner's skill folders are reached this way. Only links inside the folder are refused under skill-library::US-001/AC-05 |
| Owner enters a large folder that is not a skill | Refused for its missing SKILL.md before anything below the folder is read |
| SKILL.md lacks a name or description | Not importable; same error form under skill-library::US-001/AC-03: 「SKILL.md 里缺少 name 或 description，无法导入。请确认选的是 skill 的根目录。」 |
| SKILL.md starts with a byte order mark | Not importable, at an import and at a re-import, because the App Server would not list the skill: 「SKILL.md 开头有字节顺序标记（BOM），Codex 读不了它，无法导入。请另存为不带 BOM 的 UTF-8 后重新读取。」 |
| SKILL.md's name is longer than 64 characters | Not importable, at an import and at a re-import, because the App Server would not list the skill: 「SKILL.md 里的 name 超过 64 个字符，Codex 读不了它，无法导入。请改短后重新读取。」 |
| SKILL.md has a shape the App Server refuses for a reason not measured (Implementation Decisions: what a folder holds) | The skill is imported, written to the Executor's home and carried on its turns, but the App Server puts nothing of it before the model, and the turn does not fail or report it |
| Folder contains a symbolic link, including one pointing outside the folder | Refused with the links listed under skill-library::US-001/AC-05 |
| Folder contains an entry that is neither a file nor a folder, such as a socket or a named pipe, also as its SKILL.md | Refused and listed with the links, as 「<路径>（不是普通文件）」. The entry is not opened: opening a named pipe would wait without end |
| Folder is very large or contains binary files | Imported as listed under skill-library::US-001/AC-05 |
| A skill with the same name exists | Error pointing to re-import under skill-library::US-001/AC-04 |
| Owner closes the confirmation card | Nothing is copied under skill-library::US-001/AC-02 |
| Folder changes during the read, between the read and the confirmation | The copy matches the listed files or the import fails and asks for a new read: 「文件夹在读取之后有变化，没有导入。请重新读取后再确认。」 |
| Owner edits the folder after import | Agents keep the imported copy; the table shows changed files under skill-library::US-002/AC-02 |
| Owner re-imports a skill while requests use it | Running requests keep the old content under skill-library::US-002/AC-02 |
| Source changes between the comparison the card showed and its confirmation | Nothing is re-imported: 「文件夹在核对之后有变化，没有重新导入。请重新检查后再确认。」, and the page shows the source as it is now |
| Source gains a symbolic link or loses its SKILL.md after import | The link counts as a changed file; a re-import is refused with the import's error for that case |
| Source's SKILL.md names the skill differently at a re-import | The skill takes the new name and description. When another skill has that name, nothing is re-imported: 「来源里的 SKILL.md 现在叫「<名称>」，与已有的 skill 同名，没有重新导入。」 |
| Source folder moved or deleted | Source state shows it; the copy stays usable under skill-library::US-002/AC-03 |
| Owner deletes a skill still selected by a profile | Delete disabled under skill-library::US-003/AC-02; the service refuses it as well: 「被 <n> 个能力档使用。先在团队管理解绑，才能删除。」 |
| Owner re-imports or deletes a skill that a request admitted earlier still names, such as a failed request that can be retried | The version the request was admitted with stays stored until the request can no longer run, and a retry's Executor gets it under skill-library::REQ-002 |
| Owner unchecks every dispatch group, so the service runs without dispatch ([agent-console::US-009](agent-console.md)), and opens Skill 管理 | The stored teams' profiles still count as uses, so a skill one of them selects cannot be deleted; no version is removed while dispatch is off, and a re-import adds its version. Once dispatch is on again, profiles follow the newest version and what nothing needs is removed |
| The service runs without dispatch and cannot read its stored team definitions, such as from a damaged registry file | The service starts all the same, and cannot tell which profiles select a skill until its next start. Skill 管理 looks as it does for unused skills: each shows 「未使用」. A deletion is refused: 「读不了已保存的团队配置，无法确认是否还有能力档在使用它，暂时不能删除。」 Import and re-import work, and no version is removed |
| Owner acts on a skill another page has deleted | 「这个 skill 已不存在，请刷新页面。」 |
| An import, re-import or deletion cannot be written to the audit | Nothing is stored or deleted ([agent-console::REQ-004](agent-console.md)) |
| Service stops during an import, a re-import or a deletion | The library holds the skill as it was before or as it is after, never part of it; what the interrupted step left is cleared at the next start |
| A stored version is missing, or a stored file no longer matches what was imported, when an Executor is created | No runtime is started and the Assignment fails, rather than running with other content |
| An Executor's runtime home still holds skills of an earlier run or of an interrupted compaction | Removed when the runtime is created, before the profile's skills are written, under skill-library::REQ-002 |
| Skill text instructs the agent to use tools its profile lacks | The host refuses them under [agent-dispatch::REQ-016](agent-dispatch.md); a skill grants no capability |
| A skill keeps instructions in files other than SKILL.md, or ships scripts | The files are copied; an Executor reads them when it needs them and runs nothing under skill-library::REQ-003, and the import card says so under skill-library::US-001/AC-02 |
| An Executor asks for a path outside its skill, such as one with `..`, an absolute path, or a file of another skill or of its runtime home | Refused as a file the skill does not have, under skill-library::REQ-003: 「skill「<名称>」里没有文件 <路径>。不填 path 可以列出它的文件。」 |
| An Executor names a skill its profile does not select | Refused, naming the skills it can read: 「本轮没有 skill「<名称>」。可以读取的 skill：<名称>、…。」 |
| An Executor reads a binary file of its skill | Refused: 「这个文件不是文本文件，无法读取。」 |
| An Executor reads a file longer than 100,000 characters | It gets the first 100,000 with the offset to continue from, and reads on from there; no part ends inside a character |
| A stored version no longer holds what was imported when an Executor reads from it: a file or a folder replaced by a link, changed bytes, a removed file | Changed outside the service. The read is refused (「这个文件现在读不了。」), and the service writes `skill_file_integrity_failed:<skill ID>` to its standard error, with no path or content. Neither this nor any other refusal of the tool is audited or counts as a refused tool of the profile |

## Implementation Decisions

**What a folder holds.** A skill is a folder with a file named `SKILL.md` at its root. Its name and description are the `name` and `description` of that file's front matter: the block between a first line `---` and the next line `---`. Each value is a plain scalar, a single- or double-quoted one, or a block scalar (`|`, `>`), and may continue on indented lines; other keys are not read. Every regular file at any depth is part of the skill, hidden files included, each named by its path from the root with `/` separators and listed in code-unit order; empty folders are not kept. A file counts as a script, which the page marks, when it lies under a folder named `scripts`, has one of the extensions `.sh .bash .zsh .fish .command .py .rb .pl .php .js .mjs .cjs .ts .ps1 .bat .cmd`, has an executable permission bit, or starts with `#!`.

The root SKILL.md is read before anything below the folder, and only when it is a regular file. A file of the source folder is opened without following a link and without waiting, and is read only when what was opened is a regular file. The library refuses what the Codex App Server would not list, as measured on the installed App Server on 2026-11-11: a SKILL.md that starts with a byte order mark, and a name of more than 64 characters. The same measurement found it to list a SKILL.md with CRLF line ends, a description of 5,000 characters, a name with spaces or Chinese characters, and a colon in a plain description. Its rules were not read beyond these shapes.

**Library store.** The library is the directory `skill-library` in the service's state directory, which no file grant reaches ([ADR-0029](../adr/0029-keep-service-state-outside-every-file-grant.md)).
- Each skill has a directory named by its ID, `skill-` and eight hexadecimal characters. The ID never changes, whatever the skill is renamed to.
- Each import or re-import adds a version directory named `1`, `2`, and so on. It holds `files/`, the copy, and `manifest.json`: the ID, the version, the name, the description, the source path as typed with `~` expanded, the import time in milliseconds, and for each file its path, size, SHA-256 and whether it is a script. A version is never changed; the highest is the current one.
- A deleted skill has an empty file `deleted` in its directory. It is in no list and its name is free again; its versions stay only as long as a request needs them.
- A copy is made in a temporary directory of the library and moved into place by one rename, so a version is there whole or not at all. Temporary directories left by a stopped service are removed at start.

**Confirmation.** Reading a folder returns a fingerprint of its files: their paths, sizes and SHA-256 hashes. The import copies the folder while hashing what it copies, never following a link, and stores the copy only when its fingerprint equals the one the owner confirmed. A re-import works the same way with the fingerprint of the comparison the card showed. The page sends a folder path and a fingerprint, never content.

**Source comparison.** The page compares each skill's current version with its source folder when it opens, after each change and on 「重新检查」, by the files' hashes; it does not refresh on a timer, because a comparison reads the whole folder. A symbolic link in the source counts as a changed file.

**Snapshots.** A profile's selection is stored in the team definitions as skill IDs with versions, so a request's definitions version fixes the content its Executors load ([agent-dispatch::REQ-017/AC-01](agent-dispatch.md)). A team save stores each checked skill in the library's current version. A re-import appends a definitions version in which every profile that selects the skill names the new version; a start does the same for any profile left on an earlier one.

**Version removal.** A superseded version, and every version of a deleted skill, is removed once no profile of the current definitions names it and no request that is neither completed nor cancelled was admitted under a definitions version that names it. The service checks this after a re-import, after a deletion, whenever dispatch work ends and at start. A service that runs without dispatch reads neither the earlier definitions versions nor the stored requests, so it removes no version.

**Uses.** The profiles that select a skill are those of the current team definitions. A service that runs without dispatch has no team management, while the teams stay stored for when dispatch is enabled again; it reads the stored definitions once at start, since nothing can save a team meanwhile, and counts their profiles as uses. When it cannot read them, the uses are unknown until the next start, and it deletes no skill.

**Runtime home.** Every creation of an Executor's runtime removes the three places its App Server reads the runtime's own skills from: `skills` in its Codex home, and `.agents/skills` in its HOME and in its workspace. It then writes each skill of the profile into `skills/<skill ID>/` of the Codex home and checks every written file against the manifest. The App Server only lists such a skill to the model by name and description. Each Executor turn therefore carries every written skill as a skill input item naming its SKILL.md, and the App Server puts that file's text into the turn. The Executor reads the skill's other files through its tool, not from its runtime home.

**Reading a skill's files.** `read_skill_file` takes `skill`, a skill's name or ID, an optional `path`, relative to the skill's root as the import listed it, and an optional `offset`.
- Without a path it lists the version's files, each marked when it is a script. With one it returns the file's text, at most 100,000 characters from `offset`, counted in characters, with the offset to continue from when more remains.
- It reads from the Skill Library's store, never from the runtime home. A path must be exactly one the version's manifest lists. The file is opened without following a link, the folder it lies in must be the version's own, and its bytes must hash to the manifest's SHA-256. A file that is not valid UTF-8 is not text.
- A version a request names stays stored while the request can run (Version removal), so its files are there for each of its Executors.
- It is a function without a namespace beside the Executor's host and MCP proxy tools, which every other call still goes to. A profile that selects a skill has the tool in its tool contract, so a thread started before the tool existed is not resumed for it; a profile that selects none keeps its contract and its sessions.
- Its refusals are ordinary tool errors, which the model can correct, and are not audited.

**Console API.** The page is served by the local console under [agent-console::CON-001](agent-console.md).
- `GET /api/skills` lists the skills with their source states and uses. `POST /api/skills/read` reads a folder path, `POST /api/skills/import` imports it with the confirmed fingerprint, and `POST /api/skills/<ID>/reimport` and `POST /api/skills/<ID>/delete` act on one skill.
- A refusal answers 400, or 409 when the library's state forbids the change, or 404 for a skill that is gone, with the sentence the page shows.
- Every import, re-import and deletion is audited under [agent-console::REQ-004](agent-console.md) as `skill_imported`, `skill_reimported` or `skill_deleted`, with the skill's ID, name, version and source path. An import and a re-import also give the number of files, and a re-import the number of changed files.

## Testing Decisions

- **Library.** Tested at its public interface with real temporary folders: import, the missing-SKILL.md and duplicate-name errors, symbolic-link refusal, binary files, change detection, an unavailable source, versioning and deletion rules.
- **Runtime boundary.** Inspecting the files in the created runtime home tests that the profile's skills are there in the snapshot's version, and real main records each Executor turn's input items, so a case asserts that every turn carries each of those skills. That no other skill is visible is tested on the real App Server, because what it lists also depends on the runtime's HOME and on Codex's bundled skills: the runtime's skill listing and the model request it builds, captured by a loopback fake model endpoint (`apps/weixin-service/tests/fixtures/isolated-runtime-probe.ts`), contain only the profile's skills, and naming any other skill injects nothing. The same case shows that a turn that neither names nor carries the profile's skill holds none of its SKILL.md, and that the turn as the host sends it holds it. Another opt-in case there lists the SKILL.md shapes of Implementation Decisions (what a folder holds) on the installed App Server, so a Codex upgrade shows whether the library's two refusals still match what it lists.
- **Reading files.** The tool is tested at its public interface over a real library: listing, reading in the snapshot's version, paths outside the skill, another skill, a binary file, a long file, and a store changed by a link, by bytes or by a removed file. Real main shows that Executors whose profile selects a skill are offered the tool and read their request's version, a retry after a re-import included, that one whose profile selects none is not offered it, and that a changed store is reported on standard error. The real-model suite has an Executor follow a rule found only in a reference file that its SKILL.md points to.
- **Console.** HTTP-boundary tests of the library API with an authorized browser, and Playwright end-to-end tests of import, re-import and delete.

## Out of Scope

- Authoring, uploading or pasting skill content, including text-only skills.
- Following symbolic links inside a skill folder.
- An Executor running a skill's scripts, or changing a skill's files: its tool only reads, and it has no shell of its own. Only a tool of an MCP server that the owner attached to its profile can reach further ([mcp-catalog](mcp-catalog.md)).
