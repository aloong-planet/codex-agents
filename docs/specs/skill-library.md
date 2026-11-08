# Skill library

> Status: specified; not implemented.
> Related: [team management](team-management.md), [agent dispatch](agent-dispatch.md), [agent console](agent-console.md), [ADR-0027](../adr/0027-bind-host-enforced-agent-profiles.md), [ADR-0028](../adr/0028-manage-agent-teams-from-the-local-console.md).
> Pending: group runtimes skip host skill discovery, and no agent can load a skill.

## Problem Statement

Executor profiles need skills that fit their domain, while group runtimes must not inherit the owner's own skills. The owner wants to keep a library of skills in the console, choose them per profile, and always know which content agents actually load.

## Solution

A skill management page imports skills from local folders into a Skill Library, as copies. A table lists each skill with its source folder, files, import time, whether the source has changed, and how many profiles use it; each skill opens in a drawer over the page. Profiles on the team page select skills from the library. The console never edits skill content: the owner edits the folder and imports again. A skill in use cannot be deleted until every profile has unbound it.

## User Stories

### skill-library::US-001 Import a skill from a folder

As the owner, I want to import a skill folder and see exactly what will be copied, so that I know what agents will load.

- skill-library::US-001/AC-01: "从文件夹导入" opens an import drawer, where the owner enters a folder path and reads the folder.
- skill-library::US-001/AC-02: An importable folder shows the name and description from its SKILL.md and every file to be copied, with scripts marked. A confirmation card states that the files are copied, so later edits need a new import. Only confirming it imports the skill.
- skill-library::US-001/AC-03: A folder without SKILL.md at its root shows an error asking for the skill's root folder.
- skill-library::US-001/AC-04: A skill whose name already exists in the library shows an error pointing to re-import from the existing skill's details.
- skill-library::US-001/AC-05: A folder that contains symbolic links is refused, and the error lists them. Size and file count are not limited, and binary files are copied like any other file.

### skill-library::US-002 Keep a skill in step with its source folder

As the owner, I want to know when a skill's folder has changed, so that I can decide when agents get the new content.

- skill-library::US-002/AC-01: The table shows each skill's name with its description, source folder, file count with scripts noted, import time, source state and number of profiles using it.
- skill-library::US-002/AC-02: The source state says the skill matches its source, or how many files changed. When files have changed, "重新导入" shows a confirmation card that lists them. For a skill in use, the card says that new requests use the new content and requests in progress keep the old content ([agent-dispatch::REQ-017/AC-01](agent-dispatch.md)).
- skill-library::US-002/AC-03: When the source folder is missing or unreadable, the source state says so and re-import is unavailable. The imported copy stays usable.

### skill-library::US-003 See where a skill is used, and delete it

As the owner, I want to see which profiles use a skill and remove skills I no longer need, without silently taking them away from a profile.

- skill-library::US-003/AC-01: The drawer shows the description, the source folder and the imported files, and lists the profiles that select the skill, each linking to the team page to unbind it.
- skill-library::US-003/AC-02: A skill in use shows why it cannot be deleted, and its delete action is disabled.
- skill-library::US-003/AC-03: An unused skill asks for inline confirmation; deleting it leaves the source folder untouched.

## Functional Requirements

### skill-library::REQ-001 Skill content is read-only in the console (direct acceptance)

The console never authors, uploads, pastes or edits skill content. Skills enter the library only by import from a local folder.

### skill-library::REQ-002 Executors load exactly their profile's skills (direct acceptance)

When an Executor is created, the host copies the skills its profile selects, in the versions of the request's snapshot, into that Executor's own runtime home ([agent-dispatch::REQ-016/AC-04](agent-dispatch.md)). No other skill is visible to it.

## Failure modes and boundaries

| User sequence | Required outcome / defining coverage unit |
| --- | --- |
| Owner enters a path to a file, a missing folder, or a folder without SKILL.md at its root | Error asking for the skill's root folder under skill-library::US-001/AC-03 |
| SKILL.md lacks a name or description | Not importable; same error form under skill-library::US-001/AC-03 |
| Folder contains a symbolic link, including one pointing outside the folder | Refused with the links listed under skill-library::US-001/AC-05 |
| Folder is very large or contains binary files | Imported as listed under skill-library::US-001/AC-05 |
| A skill with the same name exists | Error pointing to re-import under skill-library::US-001/AC-04 |
| Owner closes the confirmation card | Nothing is copied under skill-library::US-001/AC-02 |
| Folder changes during the read, between the read and the confirmation | The copy matches the listed files or the import fails and asks for a new read |
| Owner edits the folder after import | Agents keep the imported copy; the table shows changed files under skill-library::US-002/AC-02 |
| Owner re-imports a skill while requests use it | Running requests keep the old content under skill-library::US-002/AC-02 |
| Source folder moved or deleted | Source state shows it; the copy stays usable under skill-library::US-002/AC-03 |
| Owner deletes a skill still selected by a profile | Delete disabled under skill-library::US-003/AC-02 |
| Skill text instructs the agent to use tools its profile lacks | The host refuses them under [agent-dispatch::REQ-016](agent-dispatch.md); a skill grants no capability |

## Implementation Decisions

**Library store.** Each import stores a copy of the folder under the service's state directory, with its file list, content hashes, source path and import time. A re-import creates a new version; request snapshots refer to the version they started with, and versions no snapshot or profile needs are removed.

**Source comparison.** The table compares the stored hashes with the current source folder when the page loads or the owner re-checks. Copying refuses symbolic links and verifies that the copied files match the listed ones.

**Console API.** The page is served by the local console under [agent-console::CON-001](agent-console.md), and every import, re-import and deletion is audited under [agent-console::REQ-004](agent-console.md).

## Testing Decisions

- **Library.** Tested at its public interface with real temporary folders: import, the missing-SKILL.md and duplicate-name errors, symbolic-link refusal, binary files, change detection, an unavailable source, versioning and deletion rules.
- **Runtime boundary.** Executor creation is tested by inspecting the files in the created runtime home: only the profile's skills, in the snapshot's version.
- **Console.** HTTP-boundary tests of the library API with an authorized browser, and Playwright end-to-end tests of import, re-import and delete.

## Out of Scope

- Authoring, uploading or pasting skill content, including text-only skills.
- Following symbolic links.
