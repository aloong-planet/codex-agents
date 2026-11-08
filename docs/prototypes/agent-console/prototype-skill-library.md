# Skill management

## Question

Can the owner maintain the console's Skill Library clearly? Skills enter the library only by import from a local folder, and executor profiles on the team page select them. The page must show:

- what an import will copy;
- when the source folder has changed and needs importing again;
- which profiles use each skill;
- why a skill in use cannot be deleted.

Skills, folders, files, import times and usages are synthetic. The page reads no local files and saves nothing.

## Structure basis

- **Console shell.** The console borrows the owner's agent-link web console UI, through the shared `agent-console-shell.js` and `agent-console` visual block:
  - a 212px left sidebar with the identity, the page navigation (团队总览, 团队管理, MCP 管理, Skill 管理, with the current page selected), and the owner's private entries in three sections (私人任务, Penny · 本人私聊, 普通私聊), each section titled with an info tip;
  - on the team overview the private entries switch the tree to private requests or open their drawer; on other pages they lead to the team overview;
  - below 900px, a menu bar opens the sidebar;
  - a page title with an info tip that holds the page description;
  - agent-link's colors and chips;
  - a right drawer over a scrim, `min(720px, 80% of the area beside the sidebar)` wide, closed by its bordered X, the scrim or Escape.
  - Info tips open a single popover attached to the page body, placed from the tip's measured position and closed by scrolling or resizing.
  - At the bottom of the sidebar, a 本机 section, whose tip covers login and the configuration audit, holds the 本机登录 entry with the number of authorized browsers. It opens a drawer above any page drawer:
    - authorized browsers, each with its label, authorization time, last use and a current-browser badge, and with 收回 behind an inline confirmation;
    - 全部收回, also behind an inline confirmation;
    - a 配置审计 section whose tip says that configuration changes, onboarding actions, authorizations and refused MCP calls go to a local audit file read from the command line. There is no audit page.
  - A browser without authorization sees only a full-window gate. It explains how to get a one-time login link (valid 2 minutes, single use) and shows no data. Revoking the current browser, or all browsers, leads to the gate.
- **Tips.** Section explanations sit in info tips beside the section titles. Status and warning lines stay inline.

### Layout

The owner chose a table with an overlay drawer.

- **Table.** One row per imported skill, with these columns:
  - name with description;
  - source folder;
  - file count, noting scripts;
  - import time;
  - source state: matches the source, N files changed, or 找不到来源文件夹;
  - how many profiles use the skill.
- **Drawer.** Selecting a name opens the skill in the shared overlay drawer.
- **Import.** "从文件夹导入" opens the same drawer for an import.
- **Navigation.** "返回团队管理" leads to `prototype-team-management.html`. The team page links here from its heading and from each profile's skill list.

### Import drawer

The owner enters the folder path and reads the folder. The result is one of:

- **Importable.** The name and description from SKILL.md, every file to be copied with scripts marked, and a confirmation card. The card says the files are copied, so later edits need a new import.
- **Missing SKILL.md.** An error asking for the skill's root folder.
- **Duplicate name.** An error pointing to re-import from the existing skill's details.
- **Symbolic links.** An error listing the links: they may point outside the folder, so the folder cannot be imported until they are replaced by real files.

The folder tip says that file count and size are not limited and binary files are copied like any other.

### Skill drawer

1. **Source.** The description from SKILL.md, the source folder and the imported files. Content cannot be edited on the page.
2. **Comparison with the source folder.**
   - When files have changed, "重新导入" shows a confirmation card listing them. For a skill in use, the card says that new requests use the new content and requests in progress keep the old content.
   - When the source folder is missing, the section says re-import is unavailable, that the imported copy stays usable and profiles are unaffected, and that putting the folder back allows a re-check. The sample 文档规范 has a missing source.
   - Otherwise the section states that the skill matches its source.
3. **Usage.** The profiles that select the skill, each with a link to the team page to unbind it.
4. **Delete.**
   - A skill in use shows why it cannot be deleted, and its delete button is disabled.
   - An unused skill asks for inline confirmation; the source folder is unaffected.

The console shell, buttons, inputs, badges, form sections, confirmation cards, catalog table and drawer come from the shared `agent-console` visual block.

## Demo scaffolding

- **Read result.** After a folder is read in the import drawer, the floating `Demo ·` bar switches the read result: importable, missing SKILL.md, duplicate name, or symbolic links. In the product the folder's contents decide this, and there is no such control. The bar is not part of the design and must not be implemented.
- **本机登录.** 已授权 / 未登录 / 链接已失效; in the product, the browser's authorization decides it.
- **Visual-only actions.** Import, re-import, re-check and delete give visual feedback only. A refresh restores the mock data.

## Uncovered dimensions

- Chinese and light appearance only. Per the project capability declaration, i18n and theming are disabled, so their checks are skipped.
- **Folder choice.** A native folder picker is not modeled; the prototype takes a typed path.
- **Audit.** Imports and deletions are audited to a local file, read from the command line (see the 本机 tip); the page shows no audit trail.
