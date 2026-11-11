import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, type Page } from "@playwright/test";

import { test } from "./fixtures.js";

// Skill 管理 (docs/specs/skill-library.md) in a real browser, against the fixture service with Feishu dispatch and real
// folders. The library's rules are covered by tests/skill-library.test.ts, the API by tests/skill-library-api.test.ts and the
// running service by tests/skill-library.integration.test.ts; these journeys check that the page, the API and the library are
// wired together, and that the page words each state as the owner confirmed it.
// The profile's skill checkboxes belong to the team page and are driven in team-management.spec.ts.
const SAM_APP = "cli_0123456789abcdef";
const LONG = { timeout: 15_000 };
// Feishu dispatch with the three seeded teams, so that a profile can select a skill.
const dispatchChannel = { channel: "feishu", owner: { memoryAccountId: "fixture-bot", bindings: [
  { channel: "weixin", accountId: "fixture-bot", target: "fixture-user@im.wechat", senderId: "fixture-user@im.wechat" },
  { channel: "feishu", accountId: SAM_APP, target: "oc_private", senderId: "ou_owner" }] },
  taskScope: { accountId: "fixture-bot", target: "fixture-user@im.wechat" },
  feishu: { appId: SAM_APP, appSecret: "fixture-secret", groups: [{ chatId: "oc_alpha", allowedSenderIds: ["ou_owner"] }],
    dispatch: { groupChatIds: ["oc_alpha"], agents: [{ id: "sam" }, { id: "alice", appId: "cli_aaaaaaaaaaaaaaaa", appSecret: "fixture-alice" },
      { id: "bill", appId: "cli_bbbbbbbbbbbbbbbb", appSecret: "fixture-bill" }, { id: "jack", appId: "cli_cccccccccccccccc", appSecret: "fixture-jack" }] } } };
test.use({ fixtureStart: { channelConfiguration: dispatchChannel, env: { WORKFLOW_FIXTURE_FEISHU_ONBOARDING: JSON.stringify({ chats: { oc_alpha: { name: "银河护卫队" } } }) } } });

type Server = { url: string; cookie: string };
const SPARK = "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z";
const skillMd = (name: string, description: string, body = "body-v1") => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;
const sources: string[] = [];
test.afterEach(() => {
  for (const directory of sources.splice(0)) {
    for (const entry of fs.readdirSync(directory)) { try { fs.chmodSync(path.join(directory, entry), 0o700); } catch { /* Not there any more. */ } }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
/** A skill folder with a reference and a script, under a fresh temporary directory. */
function folder(name: string, description: string, files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-e2e-")); sources.push(root);
  const source = path.join(root, name);
  for (const [file, content] of Object.entries({ "SKILL.md": skillMd(name, description), "references/rules.md": "rules\n", "scripts/check.py": "print(1)\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), content);
  }
  return source;
}
async function post<T = Record<string, unknown>>(server: Server, pathname: string, body: unknown): Promise<T> {
  const response = await fetch(`${server.url}${pathname}`, { method: "POST", headers: { cookie: server.cookie, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
const read = async <T>(server: Server, pathname: string) => await (await fetch(`${server.url}${pathname}`, { headers: { cookie: server.cookie } })).json() as T;
/** Imports a folder through the API, as setup for journeys that are not about importing. */
async function importViaApi(server: Server, source: string): Promise<string> {
  const { preview } = await post<{ preview: { fingerprint: string } }>(server, "/api/skills/read", { folder: source });
  return (await post<{ id: string }>(server, "/api/skills/import", { folder: source, confirmed: preview.fingerprint })).id;
}
type TeamView = { version: number; teams: Array<{ id: string; teamName: string; responsibility: string; leader: unknown; bindings: Array<{ chatId: string }>;
  profiles: Array<{ id: string; name: string; noun: string; instructions: string; hostTools: string[] }> }> };
/** Bill's one profile checks the given skills, saved as the team page saves it. */
async function billSelects(server: Server, skills: string[]) {
  const view = await read<TeamView>(server, "/api/teams");
  const bill = view.teams.find(({ id }) => id === "bill")!;
  await post(server, "/api/teams/save", { basedOn: view.version, team: { id: "bill", teamName: bill.teamName, responsibility: bill.responsibility, leader: bill.leader,
    groups: bill.bindings.map(({ chatId }) => chatId),
    executorProfiles: bill.profiles.map(({ id, name, noun, instructions, hostTools }) => ({ id, name, noun, instructions, hostTools, skills })) } });
}
const drawer = (page: Page) => page.locator("#asl-drawer");
const row = (page: Page, name: string) => page.locator("#asl-rows tr").filter({ has: page.getByRole("button", { name: new RegExp(`^${name}`) }) });
const cells = (page: Page, name: string) => row(page, name).locator("td");
const openImport = async (page: Page, source: string) => {
  await page.getByRole("button", { name: "从文件夹导入" }).click();
  await drawer(page).getByLabel("文件夹路径").fill(source);
  await drawer(page).getByRole("button", { name: "读取文件夹" }).click();
};

test("imports a folder typed in the import drawer only from its confirmation card, and lists it in the table", async ({ page, fixtureServer }, testInfo) => {
  const source = folder("trip-check", "逐段核对站名、换乘与开放时间");
  await page.goto("/console/skills");

  // agent-console::US-002/AC-01 and CON-003: the Skill 管理 entry, with the spark icon, selected on its page.
  await expect(page.locator(".acv-side-nav .acv-nav-item")).toHaveText(["团队总览", "团队管理", "MCP 管理", "Skill 管理"]);
  const entry = page.locator('.acv-nav-item[aria-current="page"]');
  await expect(entry).toHaveText("Skill 管理");
  await expect(entry.locator("svg path").first()).toHaveAttribute("d", SPARK);
  await expect(page.locator(".asl-actions").getByRole("link", { name: "返回团队管理" })).toHaveAttribute("href", "/console/teams");
  await expect(page.locator("#asl-rows .acv2-empty")).toHaveText(/还没有 skill。\s*点「从文件夹导入」导入本机的 skill 文件夹。/);
  await testInfo.attach("empty-table", { body: await page.screenshot(), contentType: "image/png" });

  await page.getByRole("button", { name: "从文件夹导入" }).click();
  await expect(drawer(page).locator("#asl-kind")).toHaveText("从文件夹导入");
  await expect(drawer(page).locator("#asl-title")).toHaveText("导入 skill");
  const readButton = drawer(page).getByRole("button", { name: "读取文件夹" });
  await expect(readButton).toBeDisabled();
  await drawer(page).getByLabel("文件夹路径").fill(source);
  await readButton.click();

  const preview = drawer(page).locator(".asl-preview");
  await expect(preview.locator("h3")).toHaveText("trip-check");
  await expect(preview.locator(".asl-desc")).toHaveText("逐段核对站名、换乘与开放时间");
  await expect(preview.locator(".acf-sub")).toHaveText("将导入 3 个文件其中 1 个是脚本文件");
  await expect(preview.locator(".acv5-list li")).toHaveText(["SKILL.md", "references/rules.md", "scripts/check.py脚本"]);
  await expect(preview.locator(".acf-grant")).toHaveText("确认导入 这些文件会复制进本系统的 Skill 库；之后修改来源文件夹，要重新导入才会生效。执行者只读取 SKILL.md；其他文件会一并复制，但执行者目前读不到，脚本也不会运行。");
  await testInfo.attach("import-confirmation", { body: await page.screenshot(), contentType: "image/png" });

  // Closing the card copies nothing.
  await page.keyboard.press("Escape");
  await expect(drawer(page)).toBeHidden();
  expect(await read<{ skills: unknown[] }>(fixtureServer, "/api/skills")).toEqual({ skills: [] });

  await openImport(page, source);
  await drawer(page).getByRole("button", { name: "确认导入" }).click();
  // The drawer turns into the new skill's details.
  await expect(drawer(page).locator("#asl-kind")).toHaveText("Skill");
  await expect(drawer(page).locator("#asl-title")).toHaveText("trip-check");
  await expect(page.locator(".acv5-panel-head small")).toHaveText("1 个");
  await expect(cells(page, "trip-check")).toHaveText([/^trip-check逐段核对站名、换乘与开放时间$/, source, "3 个 · 含脚本", /^\d\d-\d\d \d\d:\d\d$/, "与来源一致", "未使用"]);
  await expect(row(page, "trip-check")).toHaveAttribute("aria-selected", "true");
  await testInfo.attach("imported-skill", { body: await page.screenshot(), contentType: "image/png" });
});

test("says why a folder cannot be imported, and imports nothing that changed after it was read", async ({ page, fixtureServer }, testInfo) => {
  const error = drawer(page).locator(".asl-error");
  await importViaApi(fixtureServer, folder("trip-check", "逐段核对"));
  await page.goto("/console/skills");

  const bare = folder("no-skill", "x");
  fs.rmSync(path.join(bare, "SKILL.md"));
  await openImport(page, bare);
  await expect(error).toHaveText("这个文件夹里没有 SKILL.md，无法导入。请确认选的是 skill 的根目录。");
  // A new path is a folder not read yet: the refusal goes.
  await drawer(page).getByLabel("文件夹路径").fill(path.join(bare, "absent"));
  await expect(error).toHaveCount(0);
  await drawer(page).getByRole("button", { name: "读取文件夹" }).click();
  await expect(error).toHaveText("找不到或读不了这个文件夹，无法导入。请确认填的是 skill 的根目录。");

  await drawer(page).getByLabel("文件夹路径").fill(folder("nameless", "x", { "SKILL.md": "---\ndescription: 做法\n---\n" }));
  await drawer(page).getByRole("button", { name: "读取文件夹" }).click();
  await expect(error).toHaveText("SKILL.md 里缺少 name 或 description，无法导入。请确认选的是 skill 的根目录。");

  const linked = folder("linked", "x");
  fs.symlinkSync("../../shared-notes", path.join(linked, "references", "shared"));
  fs.symlinkSync("/usr/local/bin/run.sh", path.join(linked, "scripts", "run.sh"));
  await drawer(page).getByLabel("文件夹路径").fill(linked);
  await drawer(page).getByRole("button", { name: "读取文件夹" }).click();
  await expect(error).toHaveText("这个文件夹里有 2 个符号链接，无法导入：references/shared → ../../shared-notesscripts/run.sh → /usr/local/bin/run.sh符号链接可能指向文件夹以外的文件。请换成实际文件后重新读取。");
  await testInfo.attach("symbolic-links-refused", { body: await page.screenshot(), contentType: "image/png" });

  await drawer(page).getByLabel("文件夹路径").fill(folder("trip-check", "同名的另一个"));
  await drawer(page).getByRole("button", { name: "读取文件夹" }).click();
  await expect(error).toHaveText("已有同名 skill「trip-check」。要更新它，请在它的详情里重新导入；或换一个文件夹。");

  // Read, then changed before the confirmation: the card's files are no longer the folder's.
  const moving = folder("meal-plan", "按预算安排菜单");
  await drawer(page).getByLabel("文件夹路径").fill(moving);
  await drawer(page).getByRole("button", { name: "读取文件夹" }).click();
  await expect(drawer(page).locator(".asl-preview h3")).toHaveText("meal-plan");
  fs.writeFileSync(path.join(moving, "references", "rules.md"), "changed since the read\n");
  await drawer(page).getByRole("button", { name: "确认导入" }).click();
  await expect(error).toHaveText("文件夹在读取之后有变化，没有导入。请重新读取后再确认。");
  await expect(drawer(page).locator(".asl-preview")).toHaveCount(0);
  expect((await read<{ skills: Array<{ name: string }> }>(fixtureServer, "/api/skills")).skills.map(({ name }) => name)).toEqual(["trip-check"]);
});

test("counts the files that changed in the source, re-imports them from a card that says what requests get, and says when the source is gone", async ({ page, fixtureServer }, testInfo) => {
  const source = folder("trip-check", "逐段核对站名与换乘");
  const id = await importViaApi(fixtureServer, source);
  await billSelects(fixtureServer, [id]);
  fs.writeFileSync(path.join(source, "SKILL.md"), skillMd("trip-check", "逐段核对站名、换乘与开放时间", "body-v2"));
  fs.writeFileSync(path.join(source, "references", "added.md"), "new\n");
  fs.rmSync(path.join(source, "scripts", "check.py"));
  await page.goto("/console/skills");

  await expect(cells(page, "trip-check").nth(4)).toHaveText("3 个文件已变化");
  await expect(cells(page, "trip-check").nth(5)).toHaveText("1 个能力档");
  await page.getByRole("button", { name: /^trip-check/ }).click();
  const compare = drawer(page).locator(".acf-section", { has: page.getByRole("heading", { name: "与来源文件夹比较" }) });
  await expect(compare.locator(".acf-section-note")).toHaveText("来源文件夹里有 3 个文件与导入时不同。");
  await compare.getByRole("button", { name: "重新导入" }).click();
  await expect(compare.locator(".acf-grant")).toContainText("确认重新导入 将用来源文件夹里的新内容替换这 3 个文件：SKILL.mdreferences/added.md（新增）scripts/check.py（已删除）"
    + "使用它的 1 个能力档，新事务使用新内容；进行中的事务保持原内容。");
  await testInfo.attach("re-import-confirmation", { body: await page.screenshot(), contentType: "image/png" });
  // Cancelling keeps the copy as it was.
  await compare.getByRole("button", { name: "取消" }).click();
  await expect(compare.locator(".acf-grant")).toHaveCount(0);
  await compare.getByRole("button", { name: "重新导入" }).click();
  await compare.getByRole("button", { name: "确认重新导入" }).click();
  await expect(compare.locator(".acf-section-note")).toHaveText("已重新导入，与来源文件夹一致。");
  await expect(cells(page, "trip-check")).toHaveText([/^trip-check逐段核对站名、换乘与开放时间$/, source, "3 个", /^\d\d-\d\d \d\d:\d\d$/, "与来源一致", "1 个能力档"]);

  // The source cannot be read, then is moved away: the state says which, and re-import is not offered.
  fs.chmodSync(source, 0o000);
  await compare.getByRole("button", { name: "重新检查" }).click();
  await expect(cells(page, "trip-check").nth(4)).toHaveText("读不了来源文件夹");
  await expect(compare.locator(".acf-section-note")).toHaveText(`读不了来源文件夹 ${source}，暂时无法重新导入。已导入的副本照常可用，能力档不受影响；恢复读取权限后重新检查。`);
  await expect(compare.getByRole("button", { name: "重新导入" })).toHaveCount(0);
  fs.chmodSync(source, 0o700);
  fs.renameSync(source, `${source}-moved`);
  await compare.getByRole("button", { name: "重新检查" }).click();
  await expect(cells(page, "trip-check").nth(4)).toHaveText("找不到来源文件夹");
  await expect(compare.locator(".acf-section-note")).toHaveText(`找不到来源文件夹 ${source}，可能已移动或删除，暂时无法重新导入。已导入的副本照常可用，能力档不受影响；把文件夹放回原处后重新检查。`);
  await expect(compare.getByRole("button", { name: "重新导入" })).toHaveCount(0);
  await testInfo.attach("source-missing", { body: await page.screenshot(), contentType: "image/png" });
  // The copy is still there for the profile that selects it: the three files of the re-import, the script no longer among them.
  expect((await read<{ skills: Array<{ files: Array<{ path: string }> }> }>(fixtureServer, "/api/skills")).skills[0]!.files.map((file) => file.path))
    .toEqual(["SKILL.md", "references/added.md", "references/rules.md"]);
});

test("shows a skill's source, files and the profiles that use it, keeps a skill in use from being deleted, and deletes an unused one after an inline confirmation", async ({ page, fixtureServer }, testInfo) => {
  const usedSource = folder("trip-check", "逐段核对站名与换乘");
  const used = await importViaApi(fixtureServer, usedSource);
  const spareSource = folder("meal-plan", "按预算安排菜单");
  await importViaApi(fixtureServer, spareSource);
  await billSelects(fixtureServer, [used]);
  await page.goto("/console/skills");
  await expect(page.locator("#asl-rows .acv5-name")).toHaveText([/^meal-plan/, /^trip-check/]);

  await page.getByRole("button", { name: /^trip-check/ }).click();
  const section = (title: string) => drawer(page).locator(".acf-section", { has: page.getByRole("heading", { name: title, exact: true }) });
  await expect(section("来源").locator(".asl-desc")).toHaveText("逐段核对站名与换乘");
  await expect(section("来源").locator(".asl-code")).toHaveText(usedSource);
  await expect(section("来源").locator(".acf-sub").nth(1)).toHaveText(/^已导入 3 个文件导入于 \d\d-\d\d \d\d:\d\d$/);
  await expect(section("来源").locator(".acv5-list li")).toHaveText(["SKILL.md", "references/rules.md", "scripts/check.py脚本"]);
  await expect(section("与来源文件夹比较").locator(".acf-section-note")).toHaveText("与来源文件夹一致。");
  await expect(section("使用情况").locator(".acv5-list li span")).toHaveText(["Bill · 生活团队能力档：能力档 1"]);
  await expect(section("删除").locator(".acf-section-note")).toHaveText("被 1 个能力档使用。先在团队管理解绑，才能删除。");
  await expect(section("删除").getByRole("button", { name: "删除 skill" })).toBeDisabled();
  await testInfo.attach("skill-in-use", { body: await page.screenshot(), contentType: "image/png" });

  // The profile's link opens the team page on that team, where the skill is unchecked.
  await section("使用情况").getByRole("link", { name: "去团队管理解绑" }).click();
  await expect(page).toHaveURL(/\/console\/teams\?team=bill$/);
  await expect(page.locator("[data-editor] h2")).toHaveText("Bill · 生活团队", LONG);
  await page.goBack();

  await page.getByRole("button", { name: /^meal-plan/ }).click();
  await expect(section("使用情况").locator(".acf-section-note")).toHaveText("还没有能力档使用它。");
  await expect(section("删除").locator(".acf-section-note")).toHaveText("没有能力档使用它，可以删除。来源文件夹不受影响。");
  await section("删除").getByRole("button", { name: "删除 skill" }).click();
  await expect(section("删除").locator(".acf-inline-confirm")).toContainText("从 Skill 库删除「meal-plan」；来源文件夹不受影响。");
  await section("删除").getByRole("button", { name: "取消" }).click();
  await expect(page.locator("#asl-rows .acv5-name")).toHaveCount(2);
  await section("删除").getByRole("button", { name: "删除 skill" }).click();
  await section("删除").getByRole("button", { name: "确认删除" }).click();
  await expect(drawer(page)).toBeHidden();
  await expect(page.locator("#asl-rows .acv5-name")).toHaveText([/^trip-check/]);
  expect(fs.readFileSync(path.join(spareSource, "SKILL.md"), "utf8")).toBe(skillMd("meal-plan", "按预算安排菜单"));
});
