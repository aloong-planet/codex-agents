// The Skill Library API at the HTTP boundary of the real local servers, behind the real console guard with a browser
// authorized by a login link (docs/specs/skill-library.md, Testing Decisions "Console"). The library's own rules are in
// skill-library.test.ts; these cases show the routes, their refusals as the page words them, and what a request can carry.
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exchangeLoginLink } from "../e2e/console-session.js";
import { createChannelStatusServer } from "../src/channel-status-server.js";
import { ConsoleAccess } from "../src/console-access.js";
import { AUDIT_FILE, ConsoleAudit } from "../src/console-audit.js";
import { createConsoleRoutes } from "../src/console-routes.js";
import { DemoService, type ChannelSnapshot, type WeixinChannel } from "../src/demo-service.js";
import { createDemoServer } from "../src/http-server.js";
import { McpCatalog } from "../src/mcp-catalog.js";
import { SkillLibrary, type SkillUse } from "../src/skill-library.js";

const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** A Weixin channel that is never used: these cases only need the demo server to exist around the console routes. */
class IdleChannel implements WeixinChannel {
  async start(): Promise<void> {}
  getSnapshot(): ChannelSnapshot { return { accounts: [], targets: [] }; }
  onSnapshotChanged(): () => void { return () => {}; }
  updateLocalLabels(): void {}
  startLogin(): never { throw new Error("not used"); }
  sendText(): never { throw new Error("not used"); }
  close(): void {}
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function start(variant: "demo" | "status" = "status") {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-api-")));
  cleanup.push(() => fs.rmSync(work, { recursive: true, force: true }));
  const state = path.join(work, "state");
  const audit = new ConsoleAudit({ directory: state });
  const access = new ConsoleAccess({ directory: state, audit });
  const catalog = new McpCatalog({ stateDirectory: state, homeDirectory: work, audit, retryMs: 60_000, refreshMs: 0 });
  cleanup.push(() => catalog.close());
  const uses: SkillUse[] = [];
  const skills = new SkillLibrary({ directory: path.join(state, "skill-library"), audit, usedBy: () => uses, needed: () => new Set() });
  const consoleRoutes = createConsoleRoutes({ catalog, skills });
  const server: Server = variant === "demo"
    ? createDemoServer(new DemoService(new IdleChannel(), async () => ""), { access, consoleRoutes })
    : createChannelStatusServer(() => ({}), undefined, access, consoleRoutes);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  const cookie = await exchangeLoginLink(access.issueLoginLink(address.port).url, CHROME_MAC);
  const request = async (pathname: string, payload?: unknown) => {
    const response = await fetch(`${origin}${pathname}`, payload === undefined ? { headers: { cookie } }
      : { method: "POST", headers: { cookie, origin, "content-type": "application/json" }, body: JSON.stringify(payload) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const audited = () => fs.readFileSync(path.join(state, AUDIT_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => String(entry.event).startsWith("skill_"));
  return { work, state, origin, cookie, request, uses, audited };
}

const skillMd = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} 的做法\n---\n${body}\n`;
function folder(work: string, name: string, files: Record<string, string> = {}): string {
  const source = path.join(work, "sources", name);
  for (const [file, content] of Object.entries({ "SKILL.md": skillMd(name, "body-v1"), "references/rules.md": "rules\n", "scripts/check.py": "print(1)\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), content);
  }
  return source;
}
/** Every file under a directory, as paths. */
const filesUnder = (directory: string): string[] => fs.existsSync(directory)
  ? fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)) : [];

describe("Skill Library API", () => {
  it.each(["demo", "status"] as const)("imports a read folder only once it is confirmed, follows its source, and refuses to delete it while in use (%s server)", async (variant) => {
    const { work, request, uses, audited } = await start(variant);
    const source = folder(work, "trip-check");
    expect((await request("/api/skills")).body).toEqual({ skills: [] });

    const read = await request("/api/skills/read", { folder: source });
    expect(read.body.preview).toMatchObject({ folder: source, name: "trip-check", description: "trip-check 的做法",
      files: [{ path: "SKILL.md", script: false }, { path: "references/rules.md", script: false }, { path: "scripts/check.py", script: true }] });
    // Reading copied nothing.
    expect((await request("/api/skills")).body).toEqual({ skills: [] });

    const imported = await request("/api/skills/import", { folder: source, confirmed: read.body.preview.fingerprint });
    expect(imported.status).toBe(200);
    const id = imported.body.id as string;
    expect(imported.body.skills).toEqual([{ id, name: "trip-check", description: "trip-check 的做法", source, importedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/u),
      files: read.body.preview.files, state: { state: "same" }, usedBy: [] }]);

    fs.writeFileSync(path.join(source, "SKILL.md"), skillMd("trip-check", "body-v2"));
    fs.writeFileSync(path.join(source, "references", "added.md"), "new\n");
    fs.rmSync(path.join(source, "scripts", "check.py"));
    const changed = (await request("/api/skills")).body.skills[0].state;
    expect(changed).toMatchObject({ state: "changed", files: [{ path: "SKILL.md", change: "changed" }, { path: "references/added.md", change: "added" }, { path: "scripts/check.py", change: "removed" }] });
    const again = await request(`/api/skills/${id}/reimport`, { confirmed: changed.fingerprint });
    expect(again.body.skills[0]).toMatchObject({ id, state: { state: "same" }, files: [{ path: "SKILL.md", script: false }, { path: "references/added.md", script: false }, { path: "references/rules.md", script: false }] });

    const use = { teamId: "alice", leader: "Alice", teamName: "运营团队", profile: "商品文案" };
    uses.push(use);
    expect((await request("/api/skills")).body.skills[0].usedBy).toEqual([use]);
    expect(await request(`/api/skills/${id}/delete`, {})).toEqual({ status: 409, body: { error: "被 1 个能力档使用。先在团队管理解绑，才能删除。", refusal: { kind: "in_use", uses: 1 } } });
    uses.length = 0;
    expect((await request(`/api/skills/${id}/delete`, {})).body).toEqual({ deleted: id, skills: [] });
    // The source folder is the owner's: deleting the skill left it as it was.
    expect(fs.readFileSync(path.join(source, "SKILL.md"), "utf8")).toBe(skillMd("trip-check", "body-v2"));

    // agent-console::REQ-004: each change with the browser that made it.
    expect(audited().map(({ event, skill, by, browser }) => [event, skill, by, (browser as { label: string }).label])).toEqual([
      ["skill_imported", id, "browser", "Chrome · macOS"], ["skill_reimported", id, "browser", "Chrome · macOS"], ["skill_deleted", id, "browser", "Chrome · macOS"]]);
  });

  it("refuses with the words the page shows", async () => {
    const { work, request } = await start();
    const source = folder(work, "trip-check");
    const preview = (await request("/api/skills/read", { folder: source })).body.preview;
    const FOLDER = "找不到或读不了这个文件夹，无法导入。请确认填的是 skill 的根目录。";
    expect(await request("/api/skills/read", { folder: path.join(work, "absent") })).toEqual({ status: 400, body: { error: FOLDER, refusal: { kind: "folder" } } });
    expect(await request("/api/skills/read", { folder: path.join(source, "SKILL.md") })).toEqual({ status: 400, body: { error: FOLDER, refusal: { kind: "folder" } } });
    expect(await request("/api/skills/read", { folder: "sources/trip-check" })).toEqual({ status: 400, body: { error: FOLDER, refusal: { kind: "folder" } } });
    expect((await request("/api/skills/read", { folder: path.dirname(source) })).body)
      .toEqual({ error: "这个文件夹里没有 SKILL.md，无法导入。请确认选的是 skill 的根目录。", refusal: { kind: "skill_md" } });
    expect((await request("/api/skills/read", { folder: folder(work, "nameless", { "SKILL.md": "---\ndescription: 做法\n---\n" }) })).body)
      .toEqual({ error: "SKILL.md 里缺少 name 或 description，无法导入。请确认选的是 skill 的根目录。", refusal: { kind: "front_matter" } });
    const linked = folder(work, "linked");
    fs.symlinkSync("../../shared-notes", path.join(linked, "references", "shared"));
    fs.symlinkSync("/usr/local/bin/run.sh", path.join(linked, "scripts", "run.sh"));
    expect((await request("/api/skills/read", { folder: linked })).body).toEqual({
      error: "这个文件夹里有 2 个符号链接，无法导入：references/shared → ../../shared-notes；scripts/run.sh → /usr/local/bin/run.sh。符号链接可能指向文件夹以外的文件。请换成实际文件后重新读取。",
      refusal: { kind: "links", links: ["references/shared → ../../shared-notes", "scripts/run.sh → /usr/local/bin/run.sh"] } });

    // Changed between the read and the confirmation: nothing is imported.
    fs.writeFileSync(path.join(source, "references", "rules.md"), "changed\n");
    expect(await request("/api/skills/import", { folder: source, confirmed: preview.fingerprint }))
      .toEqual({ status: 409, body: { error: "文件夹在读取之后有变化，没有导入。请重新读取后再确认。", refusal: { kind: "changed" } } });
    expect((await request("/api/skills")).body).toEqual({ skills: [] });

    const id = (await request("/api/skills/import", { folder: source, confirmed: (await request("/api/skills/read", { folder: source })).body.preview.fingerprint })).body.id as string;
    const twin = folder(work, "twin", { "SKILL.md": skillMd("trip-check", "another") });
    expect(await request("/api/skills/read", { folder: twin }))
      .toEqual({ status: 409, body: { error: "已有同名 skill「trip-check」。要更新它，请在它的详情里重新导入；或换一个文件夹。", refusal: { kind: "duplicate", name: "trip-check" } } });

    // A re-import has its own words for a source that moved on after it was compared, and for a name another skill has.
    const other = folder(work, "meal-plan");
    await request("/api/skills/import", { folder: other, confirmed: (await request("/api/skills/read", { folder: other })).body.preview.fingerprint });
    const state = async () => (await request("/api/skills")).body.skills.find((skill: { id: string }) => skill.id === id).state as { fingerprint: string };
    fs.writeFileSync(path.join(source, "references", "rules.md"), "second\n");
    const compared = await state();
    fs.writeFileSync(path.join(source, "references", "rules.md"), "third\n");
    expect(await request(`/api/skills/${id}/reimport`, { confirmed: compared.fingerprint }))
      .toEqual({ status: 409, body: { error: "文件夹在核对之后有变化，没有重新导入。请重新检查后再确认。", refusal: { kind: "changed" } } });
    fs.writeFileSync(path.join(source, "SKILL.md"), skillMd("meal-plan", "renamed"));
    expect(await request(`/api/skills/${id}/reimport`, { confirmed: (await state()).fingerprint }))
      .toEqual({ status: 409, body: { error: "来源里的 SKILL.md 现在叫「meal-plan」，与已有的 skill 同名，没有重新导入。", refusal: { kind: "duplicate", name: "meal-plan" } } });

    const gone = { status: 404, body: { error: "这个 skill 已不存在，请刷新页面。", refusal: { kind: "unknown" } } };
    expect(await request("/api/skills/skill-00000000/reimport", { confirmed: compared.fingerprint })).toEqual(gone);
    expect(await request("/api/skills/skill-00000000/delete", {})).toEqual(gone);
    expect(await request("/api/skills/import", { folder: source })).toEqual({ status: 400, body: { error: "需要先读取并确认" } });
    expect(await request("/api/skills/read", { folder: ["a"] })).toEqual({ status: 400, body: { error: "文件夹路径无效" } });
  });

  // skill-library::REQ-001: a skill enters the library only from a folder. No request can author, upload or change content.
  it("takes skill content from nowhere but a folder on this computer", async () => {
    const { work, state, request } = await start();
    const source = folder(work, "trip-check");
    const preview = (await request("/api/skills/read", { folder: source })).body.preview;
    const content = { name: "injected", description: "INJECTED", files: [{ path: "SKILL.md", content: skillMd("injected", "INJECTED") }], skillMd: skillMd("injected", "INJECTED") };
    // Content without a folder is no import at all.
    expect((await request("/api/skills/import", { ...content, confirmed: preview.fingerprint })).status).toBe(400);
    expect((await request("/api/skills/read", content)).status).toBe(400);
    for (const route of ["/api/skills", "/api/skills/upload", "/api/skills/create", "/api/skills/skill-00000000", "/api/skills/skill-00000000/files", "/api/skills/skill-00000000/edit"]) {
      expect((await request(route, content)).status, route).toBe(404);
    }
    // Content beside a folder changes nothing of what the folder gives.
    const id = (await request("/api/skills/import", { folder: source, confirmed: preview.fingerprint, ...content })).body.id as string;
    expect((await request(`/api/skills/${id}/reimport`, { confirmed: preview.fingerprint, ...content })).status).toBe(200);
    const listed = (await request("/api/skills")).body.skills;
    expect(listed.map((skill: { name: string; files: Array<{ path: string }> }) => [skill.name, skill.files.map((file) => file.path)]))
      .toEqual([["trip-check", ["SKILL.md", "references/rules.md", "scripts/check.py"]]]);
    const stored = filesUnder(path.join(state, "skill-library"));
    expect(stored.length).toBeGreaterThan(0);
    for (const file of stored) expect(fs.readFileSync(file, "utf8"), file).not.toContain("INJECTED");
    // A response describes files; it never carries their content.
    expect(JSON.stringify(listed)).not.toContain("body-v1");
  });

  // agent-console::CON-001 for the new routes: an authorized browser, and the same origin for a change.
  it("answers no skill route without an authorized browser, and no change from another origin", async () => {
    const { work, origin, cookie, request } = await start();
    const source = folder(work, "trip-check");
    const post = (pathname: string, headers: Record<string, string>) => fetch(`${origin}${pathname}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ folder: source }) });
    expect((await fetch(`${origin}/api/skills`)).status).toBe(401);
    for (const route of ["/api/skills/read", "/api/skills/import", "/api/skills/skill-00000000/reimport", "/api/skills/skill-00000000/delete"]) {
      expect((await post(route, { origin })).status, route).toBe(401);
      expect((await post(route, { cookie, origin: "http://evil.example" })).status, route).toBe(403);
    }
    expect((await request("/api/skills")).body).toEqual({ skills: [] });
  });
});
