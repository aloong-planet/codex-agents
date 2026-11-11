// 团队管理 (docs/specs/team-management.md), drawn after the owner-confirmed team management prototype. The page shows the
// team view the service reports and sends one team's edit at a time; the service validates it, derives binding states,
// runs onboarding and audits every change. Every value from the service is inserted as text (agent-console::REQ-005/AC-04).
// A team gets its Feishu application by QR creation, with six onboarding steps, or as an existing application, with the last
// three; the choice is saved with the team, and the QR code is asked for by the save that chooses it (team-management::US-002).
// A profile attaches servers of the MCP Catalog: binding one shows a confirmation card with the server's exact command or address, and
// the save carries that line, which the service checks again (team-management::US-003/AC-03, AC-04).
// Not built yet (ticket 11, decision D1): skills.
// The dispatch-group form (agent-console::US-009) fills the 未配置 panel and, with dispatch, the 派单群设置 drawer; a save writes
// the channel configuration file and applies after the service restarts.
(() => {
  const { mount, tip, esc } = window.ConsoleShell;
  const { onboardingView, SENT } = window.TeamOnboardingView;
  mount("teams");

  // Host tools by group, labelled as in the prototype. A catalog tool without a label is listed by its ID under 其他.
  const TOOL_GROUPS = [
    ["文件", [["files.find", "查找文件"], ["files.grep", "搜索文件内容"], ["files.read", "读取文件"], ["files.edit", "修改文件"], ["files.write", "新建或覆盖文件"]]],
    ["发送", [["weixin.send_files", "发送文件"], ["media.send", "发送图片"]]],
    ["定时任务", [["schedules.list", "查看任务列表"], ["schedules.inspect", "查看任务详情"], ["schedules.read_text", "读取任务正文"], ["schedules.create", "创建任务"],
      ["schedules.edit", "修改任务"], ["schedules.enable", "启用任务"], ["schedules.disable", "停用任务"], ["schedules.run_now", "立即执行"],
      ["schedules.retry_news", "重试日报"], ["schedules.delete", "删除任务"]]],
  ];
  const LABELS = Object.fromEntries(TOOL_GROUPS.flatMap(([, tools]) => tools));
  const label = (id) => LABELS[id] ?? id;
  const TONES = new Set(["sam", "alice", "bill", "jack"]);
  const STEP = { done: ["已完成", "acv2-badge acv2-completed"], todo: ["未开始", "acv2-badge"], active: ["进行中", "acv2-badge acv2-running"],
    review: ["等待审核", "acv2-badge acv2-waiting"], blocked: ["需处理", "acv2-badge acv2-failed"] };
  const STATUS = { fixed: ["固定", "acv2-badge"], active: ["正常接单", "acv2-badge acv2-completed"], onboarding: ["接入未完成", "acv2-badge acv2-waiting"],
    draining: ["停止接单 · 做完后移除", "acv2-badge acv2-waiting"], removed: ["已删除 · 历史保留", "acv2-badge"] };
  const REMOVAL = { done: ["已完成", "acv2-badge acv2-completed"], wait: ["等待中", "acv2-badge acv2-waiting"], block: ["需处理", "acv2-badge acv2-failed"] };
  const ANNOUNCED = { ...SENT, pending: SENT.sending };
  const SAVEBAR = { clean: "保存后新事务立即使用新配置。", dirty: "有未保存的修改", saved: "已保存：新事务使用新配置，进行中的事务保持原配置。", reloaded: "已重新载入最新版本，请再修改。" };
  const SAM = "sam";
  const NEW = "new";
  /** A server's connection state, in the words MCP 管理 uses for it. */
  const MCP_STATE = { connected: "已连接", connecting: "连接中", disconnected: "已断开", failed: "连接失败", disabled: "已停用" };
  const $ = (id) => document.getElementById(id);

  /** The service's team view. */
  let view = null;
  let selected = null;
  /** Per list entry, the editor's copy: the edit, the definitions version it is based on, the save bar state and a refusal. */
  const drafts = new Map();
  let query = "";
  let filter = "all";
  /** The team whose test message waits for the owner's confirmation. */
  let testConfirm = null;
  /** The profile whose 绑定 MCP list is open, with the server chosen in it and the command or address its card shows. */
  let mcpPick = null;
  /** The team a link from another page asks for (`?team=<ID>`, as an MCP server's drawer links to unbind it); taken once the view has loaded. */
  let linked = new window.URLSearchParams(location.search).get("team");
  /** The dispatch-group form: the service's view of the file, the checked groups while edited, the save bar state and a refusal. */
  const dc = { view: null, open: false, checked: null, state: "clean", refusal: null };
  const DC_BAR = { clean: "保存后重启服务才生效。", dirty: "有未保存的修改", saved: "已保存，重启服务后生效", reloaded: "已重新载入最新的配置，请再修改。" };
  /** A team whose deletion completed while its editor was open: its last view, shown until another entry is opened. */
  let gone = null;
  /** Per team, what its removals last did: the groups it was unbound from, and the result of the last action on a scheduled task. */
  const removalNotes = new Map();
  /** The team whose deletion, and the scheduled task whose deletion, waits for the owner's confirmation. */
  let deleteConfirm = null;
  let taskConfirm = null;
  /** The last refused deletion or task action; a task action's line shows in its group's panel. The next action replaces it. */
  let actionError = null;

  async function api(path, payload) {
    const response = await fetch(path, payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (response.status === 401) { location.reload(); throw new Error("unauthorized"); }
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
  }

  const teamOf = (id) => view.teams.find((team) => team.id === id);
  /** The team an editor shows: one in the view, or the one whose deletion just completed. */
  const shownTeam = (id) => teamOf(id) ?? (gone?.id === id ? gone : undefined);
  function notesOf(id) {
    if (!removalNotes.has(id)) removalNotes.set(id, { unbound: [], task: null });
    return removalNotes.get(id);
  }
  const groupName = (chatId) => view.groups.find((group) => group.chatId === chatId)?.name ?? chatId;
  const tone = (id) => `atm-tone atm-tone-${TONES.has(id) ? id : "other"}`;
  /** The catalog's host tools by group, in the order the editor lists them. */
  function toolGroups() {
    const tools = Object.keys(view.tools);
    const groups = TOOL_GROUPS.map(([heading, members]) => [heading, members.map(([id]) => id).filter((id) => tools.includes(id))]);
    const other = tools.filter((id) => !(id in LABELS));
    if (other.length) groups.push(["其他", other]);
    return groups.filter(([, ids]) => ids.length);
  }

  function fromView(id) {
    if (id === SAM) return { responsibility: view.coordinator.responsibility, instructions: view.coordinator.instructions };
    if (id === NEW) {
      return { teamName: "", responsibility: "", leader: { name: "", appId: "", instructions: "" }, groups: [], method: "qr", secretEditing: false, secret: "",
        profiles: [{ name: "能力档 1", noun: "执行者", instructions: "", hostTools: ["files.find", "files.read"].filter((tool) => tool in view.tools), mcpServers: [] }] };
    }
    const team = shownTeam(id);
    return { id, teamName: team.teamName, responsibility: team.responsibility, leader: { ...team.leader }, method: team.method, secretEditing: false, secret: "",
      groups: team.bindings.filter(({ state }) => state !== "draining").map(({ chatId }) => chatId),
      profiles: team.profiles.map(({ id: profileId, name, noun, instructions, hostTools, mcpServers }) => ({ id: profileId, name, noun, instructions, hostTools: [...hostTools],
        mcpServers: mcpServers.map((server) => ({ name: server })) })) };
  }

  const current = () => drafts.get(selected);
  function entryFor(id, note = "clean") { return { value: fromView(id), basedOn: view.version, note, refusal: null }; }

  // ---- list ----
  /** A team's state: being deleted, taking work in every group it is not leaving, or not yet. */
  function stateOf(team) {
    if (team.deleting) return "draining";
    const live = team.bindings.filter(({ state }) => state !== "draining");
    if (live.length) return live.every(({ state }) => state === "accepting") ? "active" : "onboarding";
    return team.credentials?.status === "done" ? "active" : "onboarding";
  }
  const badge = (state) => `<span class="${STATUS[state][1]}">${STATUS[state][0]}</span>`;

  function entries() {
    const c = view.coordinator;
    const list = [{ id: SAM, title: `${c.name} · ${c.teamName}`, state: "fixed", meta: "每个派单群固定", groups: view.groups.map(({ chatId }) => chatId), text: `${c.name} ${c.teamName} ${c.responsibility}` }];
    for (const team of view.teams) {
      const groups = team.bindings.map(({ chatId }) => chatId);
      list.push({ id: team.id, title: `${team.leader.name} · ${team.teamName}`, state: stateOf(team), groups, text: `${team.leader.name} ${team.teamName} ${team.responsibility}`,
        meta: `${groups.map(groupName).join("、") || "未绑定群"} · ${team.profiles.length} 个能力档 · ${team.activeAssignments} 项分工进行中` });
    }
    const added = drafts.get(NEW)?.value;
    if (added) {
      list.push({ id: NEW, title: `${added.leader.name || "新团队"} · ${added.teamName || "待命名"}`, state: "onboarding", groups: null, text: `${added.leader.name} ${added.teamName} ${added.responsibility}`,
        meta: `未保存 · ${added.profiles.length} 个能力档` });
    }
    return list;
  }

  function renderList() {
    const all = entries();
    const words = query.trim().toLowerCase();
    const shown = all.filter((entry) => (filter === "all" || entry.groups === null || entry.groups.includes(filter)) && entry.text.toLowerCase().includes(words));
    $("atm-count").textContent = `${all.length} 个`;
    $("atm-list").innerHTML = shown.map((entry) => `<button class="atm-list-item ${tone(entry.id)}" type="button" data-select="${esc(entry.id)}" aria-pressed="${selected === entry.id}"><span class="atm-list-top"><strong>${esc(entry.title)}</strong>${badge(entry.state)}</span><span class="atm-list-meta">${esc(entry.meta)}</span></button>`).join("")
      || '<div class="acv2-empty"><strong>没有匹配的团队</strong><p>换个关键词或群筛选。</p></div>';
  }

  // ---- onboarding: six steps for an application created by QR code, the last three for an existing one ----
  /** The QR area of a team in QR creation, as team-onboarding-view.js describes it. */
  function qrHtml(area, team) {
    if (area.created) return `<div class="atm-created">已创建应用 ${esc(area.created)}<small>凭证已自动保存，不显示</small></div>`;
    // The image's address changes with each code, so a new code is never drawn from the previous one.
    const box = area.image ? `<img src="/api/teams/qr?team=${esc(encodeURIComponent(team.id))}&amp;code=${Number(team.creation.codeExpiresAt)}" alt="创建应用的二维码">` : area.box;
    const refresh = area.refresh ? `<div class="acf-row-actions"><button class="acv2-button${area.refresh === "main" ? " acv2-primary" : ""}" type="button" data-qr-refresh>刷新二维码</button></div>` : "";
    return `<div class="atm-qr"><div class="atm-qr-box">${box}</div><div><p>${esc(area.text)}</p>${refresh}</div></div>`;
  }

  /**
   * The onboarding block of the selected team: how it gets its application, the application or its QR code, the steps and
   * their actions. What each of them shows is decided in team-onboarding-view.js; this draws it. Only an existing
   * application's block holds a field, so QR creation's block can be redrawn while the owner edits the rest of the team.
   */
  function onboardingBlock() {
    const fixed = selected === SAM;
    const draft = current().value;
    const team = fixed || selected === NEW ? undefined : teamOf(selected);
    const shown = onboardingView({ fixed, team, method: draft.method, groups: view.groups, confirming: testConfirm === selected });
    const qr = shown.qr;
    const rows = (items) => items.length ? `<ul class="atm-joins">${items.map(({ group, state, note }) => `<li data-state="${state}"><div>${esc(group)}<small>${esc(note)}</small></div><span class="${STEP[state][1]}">${STEP[state][0]}</span></li>`).join("")}</ul>` : "";
    const list = `<ol class="atm-onboard">${shown.steps.map(({ state, title, note, rows: items }, index) => `<li data-state="${state}"><span class="atm-onboard-num">${index + 1}</span><div>${title}<small>${esc(note)}</small></div><span class="${STEP[state][1]}">${STEP[state][0]}</span>${rows(items)}</li>`).join("")}</ol>`;
    const c = view.coordinator;
    const mode = fixed ? '<div class="atm-mode">接入方式：已有应用，手动填写</div>'
      : `<div class="atm-mode">接入方式<div class="acf-seg"><button type="button" data-method="qr" aria-pressed="${qr}">扫码一键创建</button><button type="button" data-method="existing" aria-pressed="${!qr}">已有应用，手动填写</button></div></div>`;
    const stored = fixed || Boolean(team?.secretStored);
    const secret = fixed ? '<div class="acf-secret">已保存 · 不显示</div>'
      : draft.secretEditing ? '<div class="atm-secret-input"><input class="acv2-input" type="password" data-field="secret" placeholder="粘贴 App Secret，保存后不再显示" autocomplete="off" aria-label="App Secret"><button class="acv2-button" type="button" data-secret-cancel>取消</button></div>'
        : `<div class="acf-secret">${stored ? "已保存 · 不显示" : "尚未填写"}<button class="acv2-button" type="button" data-secret-edit>${stored ? "替换" : "填写"}</button></div>`;
    const source = qr ? qrHtml(shown.area, team)
      : `<div class="acf-fields atm-field-gap"><label class="acf-field">App ID<input class="acv2-input" data-field="appId" value="${esc(fixed ? c.appId : draft.leader.appId)}" placeholder="cli_…" ${fixed ? "disabled" : ""}></label><div class="acf-field">App Secret${secret}</div></div>`;
    // The message is sent only from the confirmation below the actions.
    const confirm = shown.confirm ? `<div class="acf-inline-confirm atm-test-confirm">${esc(shown.confirm)}`
      + '<div class="acf-row-actions"><button class="acv2-button acv2-primary" type="button" data-test-ok>确认发送</button><button class="acv2-button" type="button" data-test-cancel>取消</button></div></div>' : "";
    const actions = shown.recheck ? `<div class="acf-row-actions"><button class="acv2-button" type="button" data-recheck>重新检查</button>${shown.test ? '<button class="acv2-button" type="button" data-test-open>发送测试消息…</button>' : ""}</div>${confirm}` : "";
    return `<div data-onboarding>${mode}${source}${list}${actions}</div>`;
  }

  /** QR creation moves on in the service while the owner edits other fields; its block holds no field, so it alone is redrawn. */
  function renderOnboarding() {
    const block = document.querySelector("[data-onboarding]");
    if (block && selected !== SAM && current().value.method === "qr") block.outerHTML = onboardingBlock();
  }

  // ---- editor ----
  const nounHint = (profile) => `群里称为「${(profile.noun || "执行者").trim() || "执行者"} 51」这样的称呼加编号`;

  function effectiveHtml(profile) {
    const checked = toolGroups().flatMap(([, ids]) => ids).filter((tool) => profile.hostTools.includes(tool));
    const offered = checked.filter((tool) => view.tools[tool]), ungranted = checked.filter((tool) => !view.tools[tool]);
    return `<p class="atm-effective" data-effective>实际可用：${offered.length ? offered.map((tool) => esc(label(tool))).join("、") : "无"}${ungranted.length ? `<small>${ungranted.map((tool) => esc(label(tool))).join("、")}未获模块授权，勾选了也不会提供；在本机设置里开放模块授权后才可用。</small>` : ""}</p>`;
  }

  function toolsHtml(profile, index) {
    return toolGroups().map(([heading, ids]) => `<div class="atm-tool-group"><span class="atm-tool-h">${heading}</span><div class="acf-checks">${ids.map((id) => {
      const on = profile.hostTools.includes(id);
      return `<label class="acf-check"><input type="checkbox" data-tool="${esc(id)}" data-profile="${index}" ${on ? "checked" : ""}>${esc(label(id))}${on && !view.tools[id] ? '<span class="atm-unauth">未授权</span>' : ""}</label>`;
    }).join("")}</div></div>`).join("");
  }

  const mcpKind = (server) => server.transport === "http" ? "网址" : "本机程序";
  const mcpStatus = (server) => `${MCP_STATE[server.state] ?? server.state}${server.usable ? ` · 可用 ${server.usable} 个工具` : ""}`;

  /** The 绑定 MCP list of a profile: the catalog's enabled servers it does not attach, and the confirmation card of the chosen one. */
  function mcpPickHtml(draft, profile, index) {
    if (mcpPick?.profile !== index) {
      return `<div class="acf-row-actions atm-mcp-actions"><button class="acv2-button" type="button" data-mcp-pick="${index}">绑定 MCP</button><a class="acv2-button" href="/console/mcp">去 MCP 管理登记</a></div>`;
    }
    const free = view.mcpServers.filter((server) => server.enabled && !profile.mcpServers.some(({ name }) => name === server.name));
    const chosen = free.find((server) => server.name === mcpPick.server);
    const list = free.map((server) => `<label class="acf-check"><input type="radio" name="atm-mcp-pick" data-mcp-choose="${esc(server.name)}" ${chosen === server ? "checked" : ""}><span><code>${esc(server.name)}</code><small>${mcpKind(server)} · ${esc(mcpStatus(server))} · ${esc(server.launchLine)}</small></span></label>`).join("")
      || '<p class="acf-section-note">MCP 管理里已启用的服务器都已绑定到这个能力档。</p>';
    // The card shows the line that the save will carry as confirmed.
    const card = chosen ? `<div class="acf-grant"><strong>确认授权</strong> 确认后，${esc(draft.leader.name || "新团队")} 团队「${esc(profile.name)}」创建的执行者可以使用 ${esc(chosen.name)} 的工具（mcp__${esc(chosen.name)}__…）。连接由本机服务持有，${chosen.transport === "http" ? "它连接" : "它在本机运行"}：<code>${esc(mcpPick.line)}</code>执行者拿不到它的凭证；这项能力不受模块授权限制，只对使用这个能力档的执行者生效，授权会记入配置变更记录。${chosen.state === "failed" ? "它目前连接失败，连上后工具才会提供。" : ""}</div>` : "";
    return `<div class="atm-mcp-pick">${list}${card}<div class="acf-row-actions"><button class="acv2-button acv2-primary" type="button" data-mcp-bind ${chosen ? "" : "disabled"}>确认授权并绑定</button><button class="acv2-button" type="button" data-mcp-pick-cancel>取消</button></div></div>`;
  }

  /** A profile's MCP servers: the attached ones, each with 解绑, then the 绑定 MCP list. */
  function mcpHtml(draft, profile, index) {
    const rows = profile.mcpServers.map(({ name }) => view.mcpServers.find((server) => server.name === name)).filter(Boolean)
      .map((server) => `<div class="atm-mcp"><div class="atm-mcp-main"><code>${esc(server.name)}</code><small>${mcpKind(server)} · ${esc(mcpStatus(server))} · 工具名 mcp__${esc(server.name)}__…</small><code>${esc(server.launchLine)}</code></div><button class="acv2-button" type="button" data-mcp-unbind="${esc(server.name)}" data-profile="${index}">解绑</button></div>`).join("")
      || '<p class="acf-section-note atm-mcp-none">还没有 MCP。</p>';
    return `<div class="acf-sub">MCP<small>从 MCP 管理里已登记的条目绑定；每次绑定都是一次授权；解绑立即生效</small></div>${rows}${mcpPickHtml(draft, profile, index)}`;
  }

  function profilesHtml(draft) {
    return `<section class="acf-section"><div class="acv-tip-row"><h3>执行者能力档</h3>${tip("负责人派活时选一个能力档创建临时执行者。\n· 实际可用的工具 = 勾选的工具 ∩ 模块授权。\n· MCP 会带来模块授权以外的能力，绑定前需要确认。\n· 新增的工具与 MCP 只对新事务生效；取消勾选或解绑立即生效。")}</div>`
      + draft.profiles.map((profile, index) => `<div class="atm-profile"><div class="atm-profile-head"><strong data-profile-title="${index}">${esc(profile.name || "未命名能力档")}</strong><button class="acv2-button" type="button" data-profile-remove="${index}">删除能力档</button></div>`
        + `<div class="acf-fields"><label class="acf-field">能力档名称<input class="acv2-input" data-profile-field="name" data-profile="${index}" value="${esc(profile.name)}" placeholder="例如：商品文案"></label>`
        + `<label class="acf-field">执行者称呼<input class="acv2-input" data-profile-field="noun" data-profile="${index}" value="${esc(profile.noun)}" placeholder="执行者"><span class="atm-noun-hint" data-noun-hint="${index}">${esc(nounHint(profile))}</span></label></div>`
        + `<label class="acf-field atm-field-gap">执行者提示词<textarea class="acf-textarea" data-profile-field="instructions" data-profile="${index}">${esc(profile.instructions)}</textarea></label>`
        + `<div class="acf-sub">工具<small>实际可用的工具 = 勾选的工具 ∩ 模块授权</small></div>${toolsHtml(profile, index)}${effectiveHtml(profile)}${mcpHtml(draft, profile, index)}</div>`).join("")
      + '<div class="acf-row-actions"><button class="acv2-button" type="button" data-profile-add>新增能力档</button></div></section>';
  }

  function groupsHtml(draft, team, fixed) {
    const rows = view.groups.map(({ chatId, name }) => {
      const binding = team?.bindings.find((item) => item.chatId === chatId);
      const draining = binding?.state === "draining";
      const leaving = binding?.state === "accepting" && !draft.groups?.includes(chatId);
      const checked = fixed || (draft.groups.includes(chatId) && !draining);
      const announcement = !fixed && team?.announcements[chatId];
      return `<span class="atm-group-row"><label class="acf-check"><input type="checkbox" data-group="${esc(chatId)}" ${checked ? "checked" : ""} ${fixed || draining || team?.deleting ? "disabled" : ""}>${esc(name)}</label>`
        + (draining ? '<span class="acv2-badge acv2-waiting">移除中 · 停止接单</span>' : leaving ? '<span class="acv2-badge">保存后移除</span>' : "")
        + (announcement ? `<p class="atm-announce" data-state="${esc(announcement.state)}">Sam 的公告：「${esc(announcement.text)}」 · ${ANNOUNCED[announcement.state] ?? ""}</p>` : "")
        + "</span>";
    }).join("");
    const preview = view.groups.map(({ chatId, name }) => `${esc(name)}：Sam 可分派给 ${(view.preview[chatId] ?? []).map((id) => esc(teamOf(id)?.leader.name ?? id)).join("、") || "暂无团队"}`).join("<br>");
    const help = fixed ? "Sam 是每个派单群固定的总协调。"
      : "团队在该群能接单时，Sam 在群里公告它加入；开始移除时公告它离开，同时更新该群各负责人的团队通讯录。\n· 接入完成前不会出现在 Sam 的分派名单里。\n· 取消勾选并保存即在该群移除：先停止接单，进行中的做完、定时任务处理完再解绑。";
    // A deleting team's removals are listed with its deletion; a group it was unbound from is said once, until its groups are edited.
    const removals = team && !team.deleting ? team.bindings.filter(({ removal }) => removal).map((binding) => removalHtml(team, binding)).join("")
      + (removalNotes.get(team.id)?.unbound ?? []).map((chatId) => `<p class="atm-done-note" role="status">已从${esc(groupName(chatId))}移除并解绑，历史记录保留。</p>`).join("") : "";
    return `<section class="acf-section"><div class="acv-tip-row"><h3>所属群</h3>${tip(help)}</div><div class="atm-group-list">${rows}</div>${removals}<div class="atm-roster-preview">${preview}</div></section>`;
  }

  /** What one group's removal still waits for (team-management::US-004): four steps, with the actions on its scheduled tasks. */
  function removalHtml(team, { chatId, removal }) {
    const group = esc(groupName(chatId)), leader = esc(team.leader.name);
    const targets = (view.preview[chatId] ?? []).filter((id) => id !== team.id).map(teamOf).filter(Boolean);
    const step = (state, title, note, items = "") => `<li><div>${title}<small>${note}</small></div><span class="${REMOVAL[state][1]}">${REMOVAL[state][0]}</span>${items}</li>`;
    const tasks = removal.tasks.map(({ id, name, when }) => {
      const key = `data-chat="${esc(chatId)}" data-name="${esc(name)}"`;
      return `<li><span>${esc(name)}<small>${esc(when)} · 用 ${leader} 的身份发送</small></span>${taskConfirm === id
        ? `<div class="acf-inline-confirm">删除后不再执行，已有的执行记录保留。<div class="acf-row-actions"><button class="acv2-button acf-danger-button" type="button" data-task-del-ok="${esc(id)}" ${key}>确认删除</button><button class="acv2-button" type="button" data-task-del-cancel>取消</button></div></div>`
        : `<select class="acv2-input" data-task-move="${esc(id)}" ${key} aria-label="把「${esc(name)}」转给其他团队"><option value="">转给…</option>${targets.map((target) => `<option value="${esc(target.id)}" data-name="${esc(target.leader.name)}">${esc(target.leader.name)} · ${esc(target.teamName)}</option>`).join("")}</select><button class="acv2-button" type="button" data-task-del="${esc(id)}">删除</button>`}</li>`;
    }).join("");
    const waiting = removal.waiting.map(({ requestId, label: number, summary, requester, waitingFor }) => `<li><span><a class="atm-link" href="/console?request=${esc(encodeURIComponent(requestId))}">${esc(`${number} ${summary}`)}</a><small>发起人：${requester === "owner" ? "本人" : "群成员"} · ${esc(waitingFor.join("、"))}</small></span></li>`).join("");
    const note = removalNotes.get(team.id)?.task;
    // Step 2 counts what the list row and the deletion confirmation count: the team's own queued, running and waiting Assignments.
    const held = removal.awaitingRequester, heldNote = held ? `其中 ${held} 项在等发起人回复，见第 4 步。` : "";
    return `<div class="atm-removal"><div class="atm-removal-h">${group} · 移除进行中</div><ol class="atm-removal-steps">`
      + step("done", "停止接单", `Sam 已不再分派给 ${leader}，并在${group}公告它离开；各负责人的团队通讯录已更新。`)
      + step(removal.active || held || removal.closing ? "wait" : "done", `进行中的分工 · ${removal.active + held} 项`,
        removal.active ? `做完后由 ${leader} 在群里收尾。${heldNote}` : held ? heldNote : removal.closing ? `分工已做完，${leader} 正在群里收尾。` : "已全部结束。")
      + step(removal.tasks.length ? "block" : "done", `用 ${leader} 身份发送的定时任务 · ${removal.tasks.length} 项`, removal.tasks.length ? `每项转给${group}里其他接单的团队，或删除，才能完成移除。转给后只换发送身份，计划和内容不变。` : "已全部处理。", removal.tasks.length ? `<ul class="atm-removal-items">${tasks}</ul>` : "")
      + step(removal.waiting.length ? "wait" : "done", `等待发起人确认的事务 · ${removal.waiting.length} 项`, removal.waiting.length ? "只有发起人能确认或取消；本人发起的请在群里回复，其他成员的等他们回复。" : "已全部结束。", removal.waiting.length ? `<ul class="atm-removal-items">${waiting}</ul>` : "")
      + "</ol>"
      + (note ? `<p class="atm-done-note" role="status">${esc(note)}</p>` : "")
      + (actionError?.team === team.id && actionError.chatId === chatId ? `<p class="atm-action-err" role="alert">${esc(actionError.text)}</p>` : "")
      + `<p class="atm-removal-note">以上都结束后自动从${group}解绑，历史记录保留。</p></div>`;
  }

  /** Deleting the team (team-management::US-004/AC-01): the confirmation, the removals a deletion waits for, and its completion. */
  function dangerHtml(team, removed) {
    const leader = esc(team.leader.name);
    const body = removed ? `<p class="atm-done-note" role="status">删除完成：${leader} 已从所有群移除，Sam 不再分派给它；历史记录保留。</p>`
      : team.deleting ? `<p class="acf-section-note atm-deleting-note">已停止接单：Sam 不再分派给 ${leader}。下面各群的阻塞都处理完后，团队才会被移除。</p>${team.bindings.filter(({ removal }) => removal).map((binding) => removalHtml(team, binding)).join("")}`
        : deleteConfirm === team.id ? `<div class="acf-inline-confirm">删除后 Sam 立即停止分派给 ${leader}；${team.activeAssignments ? `进行中的 ${team.activeAssignments} 项分工做完后` : "没有进行中的分工，"}从所有群移除，并在群里公告。用它身份发送的定时任务要先转给其他团队或删除。历史记录保留。<div class="acf-row-actions"><button class="acv2-button acf-danger-button" type="button" data-delete-confirm>确认删除</button><button class="acv2-button" type="button" data-delete-cancel>取消</button></div></div>`
          : '<p class="acf-section-note">删除后先停止接单，进行中的分工做完再移除。</p><button class="acv2-button acf-danger-button" type="button" data-delete>删除团队</button>';
    const refused = actionError?.team === team.id && !actionError.chatId ? `<p class="atm-action-err" role="alert">${esc(actionError.text)}</p>` : "";
    return `<section class="acf-section acf-danger"><h3>删除团队</h3>${body}${refused}</section>`;
  }

  function savebarHtml() {
    const entry = current();
    // A deleted team is saved no more.
    const saveButton = `<button class="acv2-button acv2-primary" type="button" data-save ${gone?.id === selected ? "disabled" : ""}>保存</button>`;
    if (entry.refusal) {
      return `<div class="acf-savebar" id="atm-savebar" data-state="error"><div class="atm-save-err" role="alert"><b>无法保存</b><ul>${entry.refusal.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul></div>`
        + `<div class="acf-row-actions">${entry.refusal.stale ? '<button class="acv2-button acv2-primary" type="button" data-reload>重新载入</button>' : saveButton}</div></div>`;
    }
    return `<div class="acf-savebar" id="atm-savebar" data-state="${entry.note === "reloaded" ? "clean" : entry.note}"><span>${SAVEBAR[entry.note]}</span>${saveButton}</div>`;
  }

  function editorHtml() {
    const fixed = selected === SAM;
    const draft = current().value;
    const team = fixed || selected === NEW ? undefined : shownTeam(selected);
    const removed = Boolean(team) && gone?.id === selected;
    const c = view.coordinator;
    const leader = fixed ? c.name : draft.leader.name || "新团队";
    const teamName = fixed ? c.teamName : draft.teamName || "待命名";
    const state = fixed ? "fixed" : removed ? "removed" : team ? stateOf(team) : "onboarding";
    // A group the team is being removed from stays bound until its removal completes.
    const bound = fixed ? [] : view.groups.map(({ chatId }) => chatId).filter((chatId) => draft.groups.includes(chatId) || team?.bindings.some((binding) => binding.chatId === chatId && binding.state === "draining"));
    const head = `<div class="atm-editor-title ${tone(selected)}"><div><h2>${esc(leader)} · ${esc(teamName)}</h2><small>${fixed ? "每个派单群固定的总协调，只能修改职责与提示词"
      : `绑定在 ${esc(bound.map(groupName).join("、") || "尚未绑定的群")} · ${draft.profiles.length} 个执行者能力档`}</small></div>${badge(state)}</div>`;
    const basics = `<section class="acf-section"><div class="acv-tip-row"><h3>基本信息与飞书接入</h3>${tip("负责人用自己的飞书机器人在群里发言。\n· 凭证只能写入或替换，保存后不再显示。")}</div>`
      + `<div class="acf-fields"><label class="acf-field">负责人名称<input class="acv2-input" data-field="leaderName" value="${esc(fixed ? c.name : draft.leader.name)}" placeholder="例如：Daisy" ${fixed ? "disabled" : ""}></label>`
      + `<label class="acf-field">团队名称<input class="acv2-input" data-field="teamName" value="${esc(fixed ? c.teamName : draft.teamName)}" placeholder="例如：设计团队" ${fixed ? "disabled" : ""}></label></div>`
      + onboardingBlock()
      + "</section>";
    const duty = `<section class="acf-section"><div class="acv-tip-row"><h3>职责与提示词</h3>${tip(`职责会出现在 Sam 的分派名单和各负责人的团队通讯录里。\n· 提示词只给${fixed ? " Sam" : "这位负责人"}自己。`)}</div>`
      + `<label class="acf-field">职责<textarea class="acf-textarea" data-field="responsibility">${esc(draft.responsibility)}</textarea></label>`
      + `<label class="acf-field atm-field-gap">${fixed ? "Sam" : "负责人"}提示词<textarea class="acf-textarea" data-field="instructions">${esc(fixed ? draft.instructions : draft.leader.instructions)}</textarea></label></section>`;
    const profiles = fixed ? '<section class="acf-section"><h3>执行者能力档</h3><p class="acf-section-note">Sam 不执行具体事务，没有执行者能力档。</p></section>' : profilesHtml(draft);
    return `<div data-editor>${head}${basics}${duty}${profiles}${groupsHtml(draft, team, fixed)}${team ? dangerHtml(team, removed) : ""}${savebarHtml()}</div>`;
  }

  function renderEditor() {
    $("atm-editor").innerHTML = editorHtml();
    // A typed secret stays in the field across redraws without ever being written into the markup.
    const field = document.querySelector('[data-field="secret"]');
    if (field) field.value = current().value.secret;
  }

  // ---- dispatch groups ----
  const sameGroups = (a, b) => a.length === b.length && a.every((chatId) => b.includes(chatId));
  const dcName = (chatId) => dc.view.groups.find((group) => group.chatId === chatId)?.name ?? chatId;
  const dcList = (ids) => ids.map(dcName).join("、");
  const DC_STATE = { proposed: "等待发起人确认", waiting: "等待发起人确认", queued: "处理中", running: "处理中" };

  /** The reasons of a refused save, in the order the save bar lists them (agent-console::US-009/AC-04). */
  function dcReasons(refusal) {
    if (refusal.kind === "locked") {
      return [`${esc("飞书配对向导正在使用渠道配置，暂时不能保存；配对结束后再保存。")}<br>${esc("如果没有配对命令在运行，这个锁文件可能是配对中途退出留下的：")}<code class="atm-empty-path">${esc(refusal.lockPath)}</code>${esc("确认没有配对命令运行后删除它，再保存。")}`];
    }
    if (refusal.kind === "changed") return [esc("渠道配置文件在页面载入后被修改过；为避免覆盖，本次保存没有生效。")];
    if (refusal.kind === "unfinished") {
      return refusal.groups.map(({ chatId, requests }) => `${esc(`${dcName(chatId)}还有 ${requests.length} 项未结束的派单事务，结束后才能取消勾选：`)}<ul class="atm-dc-busy">${requests.map(({ id, summary, status }) => `<li><a class="atm-link" href="/console?request=${esc(encodeURIComponent(id))}">${esc(summary)}</a><small>${esc(DC_STATE[status] ?? status)}</small></li>`).join("")}</ul>`);
    }
    return [esc(refusal.message ?? "请求失败")];
  }

  function dcFormHtml() {
    const checked = dc.checked ?? dc.view.saved;
    const rows = dc.view.groups.map(({ chatId, name }) => {
      const named = name !== chatId;
      return `<label class="acf-check atm-dc-group"><input type="checkbox" data-dc-group="${esc(chatId)}" ${checked.includes(chatId) ? "checked" : ""}><span>${named ? esc(name) : `<code>${esc(chatId)}</code>`}<small>${named ? esc(chatId) : "未取到群名，显示群 ID"}</small></span></label>`;
    }).join("");
    const compare = sameGroups(dc.view.saved, dc.view.running) ? ""
      : `<dl class="atm-dc-compare"><dt>运行中的服务</dt><dd>${esc(dcList(dc.view.running) || "未启用派单")}</dd><dt>已保存，重启后</dt><dd>${esc(dcList(dc.view.saved) || "不启用派单")}</dd></dl>`;
    const bar = dc.refusal
      ? `<div class="acf-savebar" data-state="error"><div class="atm-save-err" role="alert"><b>无法保存</b><ul>${dcReasons(dc.refusal).map((reason) => `<li>${reason}</li>`).join("")}</ul></div><div class="acf-row-actions">${dc.refusal.kind === "changed" ? '<button class="acv2-button acv2-primary" type="button" data-dc-reload>重新载入</button>' : '<button class="acv2-button acv2-primary" type="button" data-dc-save>保存</button>'}</div></div>`
      : `<div class="acf-savebar" data-state="${dc.state === "reloaded" ? "clean" : dc.state}"><span>${DC_BAR[dc.state]}</span><button class="acv2-button acv2-primary" type="button" data-dc-save>保存</button></div>`;
    return `<div class="atm-dc-groups">${rows}</div>${compare}${bar}`;
  }

  /** Draws the form where it is shown: the 未配置 panel, or the drawer when it is open. */
  function renderDc() {
    if (!view?.configured) { renderEmpty(); return; }
    $("atm-dc-drawer").hidden = !dc.open;
    if (dc.open && dc.view?.feishu) $("atm-dc-body").innerHTML = `<p class="atm-dc-intro">勾选要启用派单的飞书群。这里列出渠道配置里已允许的群；保存后重启服务生效。</p>${dcFormHtml()}`;
    renderStrip();
  }

  /** While the saved groups differ from those the running service uses, a strip above the team list says so. */
  function renderStrip() {
    const strip = $("atm-dc-pending");
    const pending = Boolean(dc.view?.feishu) && !sameGroups(dc.view.saved, dc.view.running);
    if (strip) strip.hidden = !pending;
  }

  async function loadDc() {
    const { ok, body } = await api("/api/teams/dispatch-groups");
    if (ok) dc.view = body;
    return ok;
  }

  async function saveDc() {
    const { ok, body } = await api("/api/teams/dispatch-groups", { groups: dc.checked ?? dc.view.saved, basedOn: dc.view.basedOn });
    if (ok) Object.assign(dc, { view: body, checked: null, state: "saved", refusal: null });
    else dc.refusal = body.refusal ?? { kind: "error", message: body.error };
    renderDc();
  }

  async function openDc() {
    if (!(await loadDc())) return;
    Object.assign(dc, { open: true, checked: null, refusal: null, state: dc.state === "saved" ? "saved" : "clean" });
    renderDc();
    $("atm-dc-drawer").querySelector("[data-dc-close]").focus();
  }

  function closeDc() {
    if (!dc.open) return;
    Object.assign(dc, { open: false, refusal: null });
    renderDc();
  }

  // ---- page ----
  function renderEmpty() {
    $("atm-new").hidden = true;
    $("atm-dc-open").hidden = true;
    $("atm-view").innerHTML = dc.view?.feishu
      ? `<section class="atm-panel"><div class="atm-scroll"><div class="acv2-empty"><strong>尚未配置派单群</strong><p>勾选要启用派单的飞书群，保存后重启服务生效。</p></div><div class="atm-dc-wrap">${dcFormHtml()}</div></div></section>`
      : '<section class="atm-panel"><div class="acv2-empty"><strong>尚未配置派单群</strong><p class="atm-empty-body">飞书尚未接入本机服务：请先停止服务，在终端运行 <code class="atm-empty-path">pnpm feishu:pair</code> 完成飞书配对，再回到这里选择派单群。</p></div></section>';
  }

  function renderPage() {
    $("atm-new").hidden = false;
    $("atm-dc-open").hidden = !dc.view?.feishu;
    $("atm-view").innerHTML = '<div class="atm-dc-pending" id="atm-dc-pending" role="status" hidden><span>派单群设置已保存，重启服务后生效。</span><button class="atm-link" type="button" data-dc-open>查看派单群设置</button></div>'
      + '<div class="atm-a"><section class="atm-panel"><div class="atm-panel-head">团队<small id="atm-count"></small></div>'
      + '<div class="atm-list-tools"><input class="acv2-input" id="atm-search" type="search" placeholder="搜索团队或职责" aria-label="搜索团队"><select class="acv2-input" id="atm-filter" aria-label="按群筛选"></select></div>'
      + '<div class="atm-scroll" id="atm-list"></div></section><section class="atm-panel"><div class="atm-scroll"><div class="atm-editor-wrap" id="atm-editor"></div></div></section></div>';
    $("atm-search").value = query;
    renderFilter();
    renderList();
    renderEditor();
    renderStrip();
  }

  function renderFilter() {
    if (view.groups.every(({ chatId }) => chatId !== filter)) filter = "all";
    $("atm-filter").innerHTML = `<option value="all">全部群</option>${view.groups.map(({ chatId, name }) => `<option value="${esc(chatId)}" ${filter === chatId ? "selected" : ""}>${esc(name)}</option>`).join("")}`;
  }

  function open(id) {
    if (gone && gone.id !== id) { drafts.delete(gone.id); gone = null; }
    deleteConfirm = null; taskConfirm = null; actionError = null;
    selected = id;
    testConfirm = null;
    mcpPick = null;
    if (!drafts.has(id)) drafts.set(id, entryFor(id));
    renderList();
    renderEditor();
    // Another team's editor starts at its top.
    $("atm-editor").closest(".atm-scroll").scrollTop = 0;
  }

  /**
   * Takes a new view; clean drafts follow it, while an edit in progress keeps its own copy and its base version. `deleted` is
   * the team this page just deleted. The page reads from two views in a row what a removal completed: a group the team accepted
   * work or drained in and is no longer bound to, and a deleted team that left the view while its editor was open.
   */
  function accept(next, deleted) {
    const before = view;
    view = next;
    for (const team of before?.teams ?? []) {
      const now = teamOf(team.id);
      if (!now) {
        removalNotes.delete(team.id);
        if (selected === team.id && (team.deleting || team.id === deleted)) {
          gone = { ...team, deleting: true, bindings: [], activeAssignments: 0, announcements: Object.fromEntries(Object.entries(team.announcements).filter(([, { kind }]) => kind === "leave")) };
        }
        continue;
      }
      if (now.deleting) continue;
      const unbound = team.bindings.filter(({ chatId, state }) => (state === "accepting" || state === "draining")
        && view.groups.some((group) => group.chatId === chatId) && !now.bindings.some((binding) => binding.chatId === chatId)).map(({ chatId }) => chatId);
      if (unbound.length) notesOf(team.id).unbound = unbound;
    }
    for (const [id, entry] of drafts) {
      if (id === NEW || entry.note === "dirty" || entry.refusal) continue;
      if (id !== SAM && !shownTeam(id)) { drafts.delete(id); continue; }
      entry.value = fromView(id);
      entry.basedOn = view.version;
    }
    if (linked !== null) { if (teamOf(linked)) selected = linked; linked = null; }
    if (selected === null || (selected !== SAM && selected !== NEW && !shownTeam(selected))) selected = view.teams[0]?.id ?? SAM;
    if (!drafts.has(selected)) drafts.set(selected, entryFor(selected));
  }

  async function load(first) {
    const { ok, body } = await api("/api/teams");
    if (!ok) return;
    const before = JSON.stringify(view);
    if (first) await loadDc();
    // The 未配置 panel is the form itself; the page's polling never redraws it under the owner.
    if (!body.configured) { const was = view; view = body; if (first || was?.configured !== false) renderEmpty(); return; }
    const wasConfigured = Boolean(view?.configured);
    accept(body);
    if (first || !wasConfigured) { renderPage(); return; }
    if (JSON.stringify(view) === before) return;
    renderFilter();
    renderList();
    // An edit in progress, or a field or task choice the owner is in, is not redrawn under them; QR creation's progress still is.
    const focused = document.activeElement?.closest?.("[data-editor]") && document.activeElement.matches("input,textarea,select");
    if (current().note !== "dirty" && !current().refusal && !focused) renderEditor();
    else renderOnboarding();
    followCreation();
  }

  /** A code that is being fetched arrives within moments, so the page asks again sooner than its regular poll. */
  let following = null;
  function followCreation() {
    const creation = selected === SAM || selected === NEW ? undefined : teamOf(selected)?.creation;
    if (following !== null || creation?.status !== "waiting" || creation.codeExpiresAt) return;
    following = setTimeout(() => { following = null; void load(false); }, 400);
  }

  function payload() {
    const draft = current().value;
    // In QR creation the application is the service's to set; a secret is sent only for an existing application.
    return { ...(draft.id ? { id: draft.id } : {}), teamName: draft.teamName, responsibility: draft.responsibility, method: draft.method,
      leader: { name: draft.leader.name, appId: draft.leader.appId, instructions: draft.leader.instructions }, groups: draft.groups,
      executorProfiles: draft.profiles.map(({ id, name, noun, instructions, hostTools, mcpServers }) => ({ ...(id ? { id } : {}), name, noun, instructions, hostTools, mcpServers })),
      ...(draft.method === "existing" && draft.secretEditing && draft.secret.trim() ? { secret: draft.secret } : {}) };
  }

  async function save() {
    const entry = current();
    const { ok, body } = selected === SAM
      ? await api("/api/teams/coordinator", { basedOn: entry.basedOn, coordinator: { responsibility: entry.value.responsibility, instructions: entry.value.instructions } })
      : await api("/api/teams/save", { basedOn: entry.basedOn, team: payload() });
    if (!ok) {
      entry.refusal = { reasons: body.reasons ?? [body.error ?? "请求失败"], stale: Boolean(body.stale) };
      renderEditor();
      return;
    }
    const id = selected === NEW ? body.teamId : selected;
    drafts.delete(NEW === selected ? NEW : id);
    if (removalNotes.has(id)) notesOf(id).task = null;
    accept(body.view);
    drafts.set(id, entryFor(id, "saved"));
    selected = id;
    renderFilter();
    renderList();
    renderEditor();
    followCreation();
  }

  async function reload() {
    const { ok, body } = await api("/api/teams");
    if (!ok || !body.configured) return;
    drafts.delete(selected);
    accept(body);
    drafts.set(selected, entryFor(selected, "reloaded"));
    renderList();
    renderEditor();
  }

  async function recheck(button) {
    button.disabled = true;
    const { ok, body } = await api("/api/teams/recheck", { teamId: selected });
    button.disabled = false;
    if (!ok) { current().refusal = { reasons: [body.error ?? "请求失败"], stale: false }; renderEditor(); return; }
    accept(body.view);
    renderList();
    renderEditor();
  }

  /** A refused action's line: what did not happen, then the service's sentence for the owner. */
  const refusedLine = (prefix, body) => `${prefix}${typeof body.error === "string" ? body.error : "请求失败"}`;

  async function deleteTeam(teamId) {
    deleteConfirm = null;
    const { ok, body } = await api("/api/teams/delete", { teamId });
    if (ok) { actionError = null; accept(body.view, teamId); renderFilter(); renderList(); }
    else actionError = { team: teamId, text: refusedLine("没有开始删除：", body) };
    renderEditor();
  }

  /** Moves a removal's scheduled task to the team `to`, or deletes it when no team is given. */
  async function taskAction(teamId, { chat: chatId, name }, taskId, to) {
    taskConfirm = null;
    const { ok, body } = to ? await api("/api/teams/tasks/move", { teamId, taskId, to: to.id }) : await api("/api/teams/tasks/delete", { teamId, taskId });
    const notes = notesOf(teamId);
    if (ok) {
      actionError = null;
      notes.task = to ? `已把「${name}」转给 ${to.name}：之后用 ${to.name} 的身份发送，计划和内容不变。` : `已删除定时任务「${name}」，执行记录保留。`;
      accept(body.view);
      renderFilter(); renderList();
    } else {
      notes.task = null;
      actionError = { team: teamId, chatId, text: refusedLine(to ? `没有转交「${name}」：` : `没有删除「${name}」：`, body) };
    }
    renderEditor();
  }

  /** 刷新二维码: the service answers once the new code, which the page then shows in place of the old one, is known or could not be obtained. */
  async function refreshCode(button) {
    button.disabled = true;
    const { ok, body } = await api("/api/teams/qr", { teamId: selected });
    if (!ok) { button.disabled = false; current().refusal = { reasons: [body.error ?? "请求失败"], stale: false }; renderEditor(); return; }
    accept(body.view);
    renderList();
    renderEditor();
    followCreation();
  }

  /** 确认发送: the only place the test message is sent from. */
  async function sendTest(button) {
    button.disabled = true;
    const { ok, body } = await api("/api/teams/test-message", { teamId: selected, confirmed: true });
    testConfirm = null;
    if (!ok) { current().refusal = { reasons: [body.error ?? "请求失败"], stale: false }; renderEditor(); return; }
    accept(body.view);
    renderList();
    renderEditor();
  }

  /** Marks the selected entry as edited; only the save bar is redrawn, so the field being typed in keeps its focus. */
  function edited() {
    const entry = current();
    entry.note = "dirty";
    if (entry.refusal && !entry.refusal.stale) entry.refusal = null;
    $("atm-savebar").outerHTML = savebarHtml();
  }

  // ---- events ----
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (target.closest("[data-dc-open]")) { void openDc(); return; }
    if (target.closest("[data-dc-close]")) { closeDc(); return; }
    if (target.closest("[data-dc-save]")) { void saveDc(); return; }
    if (target.closest("[data-dc-reload]")) {
      void loadDc().then((ok) => { if (ok) { Object.assign(dc, { checked: null, refusal: null, state: "reloaded" }); renderDc(); } });
      return;
    }
    const item = target.closest("[data-select]");
    if (item) { open(item.dataset.select); return; }
    if (target.closest("#atm-new")) { if (!drafts.has(NEW)) drafts.set(NEW, entryFor(NEW)); open(NEW); return; }
    if (!current()) return;
    const draft = current().value;
    const method = target.closest("[data-method]");
    if (method) {
      if (draft.method !== method.dataset.method) { draft.method = method.dataset.method; testConfirm = null; edited(); renderEditor(); }
      return;
    }
    const refreshButton = target.closest("[data-qr-refresh]");
    if (refreshButton) { void refreshCode(refreshButton); return; }
    if (target.closest("[data-test-open]")) { testConfirm = selected; renderEditor(); return; }
    if (target.closest("[data-test-cancel]")) { testConfirm = null; renderEditor(); return; }
    const sendButton = target.closest("[data-test-ok]");
    if (sendButton) { void sendTest(sendButton); return; }
    if (target.closest("[data-secret-edit]")) { draft.secretEditing = true; edited(); renderEditor(); document.querySelector('[data-field="secret"]')?.focus(); return; }
    if (target.closest("[data-secret-cancel]")) { draft.secretEditing = false; draft.secret = ""; renderEditor(); return; }
    if (target.closest("[data-profile-add]")) { draft.profiles.push({ name: `能力档 ${draft.profiles.length + 1}`, noun: "执行者", instructions: "", hostTools: [], mcpServers: [] }); edited(); renderEditor(); return; }
    const remove = target.closest("[data-profile-remove]");
    if (remove) { draft.profiles.splice(Number(remove.dataset.profileRemove), 1); mcpPick = null; edited(); renderEditor(); return; }
    const pick = target.closest("[data-mcp-pick]");
    if (pick) { mcpPick = { profile: Number(pick.dataset.mcpPick), server: null, line: "" }; renderEditor(); return; }
    if (target.closest("[data-mcp-pick-cancel]")) { mcpPick = null; renderEditor(); return; }
    // Only the card's confirmation attaches the server, and only to the draft: the team's save applies it.
    if (target.closest("[data-mcp-bind]")) {
      if (mcpPick?.server) { draft.profiles[mcpPick.profile].mcpServers.push({ name: mcpPick.server, confirmed: mcpPick.line }); mcpPick = null; edited(); renderEditor(); }
      return;
    }
    const unbind = target.closest("[data-mcp-unbind]");
    if (unbind) {
      const profile = draft.profiles[Number(unbind.dataset.profile)];
      profile.mcpServers = profile.mcpServers.filter(({ name }) => name !== unbind.dataset.mcpUnbind);
      edited(); renderEditor(); return;
    }
    const recheckButton = target.closest("[data-recheck]");
    if (recheckButton) { void recheck(recheckButton); return; }
    if (target.closest("[data-save]")) { void save(); return; }
    if (target.closest("[data-reload]")) { void reload(); return; }
    if (target.closest("[data-delete]")) { deleteConfirm = selected; actionError = null; renderEditor(); return; }
    if (target.closest("[data-delete-cancel]")) { deleteConfirm = null; renderEditor(); return; }
    if (target.closest("[data-delete-confirm]")) { void deleteTeam(selected); return; }
    const taskDelete = target.closest("[data-task-del]");
    if (taskDelete) { taskConfirm = taskDelete.dataset.taskDel; renderEditor(); return; }
    if (target.closest("[data-task-del-cancel]")) { taskConfirm = null; renderEditor(); return; }
    const taskDeleteOk = target.closest("[data-task-del-ok]");
    if (taskDeleteOk) void taskAction(selected, taskDeleteOk.dataset, taskDeleteOk.dataset.taskDelOk);
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.id === "atm-search") { query = target.value; renderList(); return; }
    if (!target.closest("[data-editor]")) return;
    const draft = current().value;
    const field = target.dataset.field;
    if (field === "secret") draft.secret = target.value;
    else if (field === "leaderName") draft.leader.name = target.value;
    else if (field === "appId") draft.leader.appId = target.value;
    else if (field === "instructions" && selected !== SAM) draft.leader.instructions = target.value;
    else if (field) draft[field] = target.value;
    const profileField = target.dataset.profileField;
    if (profileField) {
      const index = target.dataset.profile, profile = draft.profiles[Number(index)];
      profile[profileField] = target.value;
      document.querySelector(`[data-profile-title="${index}"]`).textContent = profile.name || "未命名能力档";
      document.querySelector(`[data-noun-hint="${index}"]`).textContent = nounHint(profile);
    }
    if (field || profileField) edited();
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    const dcGroup = target.dataset.dcGroup;
    if (dcGroup) {
      const checked = dc.checked ?? dc.view.saved;
      dc.checked = target.checked ? [...checked, dcGroup] : checked.filter((chatId) => chatId !== dcGroup);
      Object.assign(dc, { state: "dirty", refusal: dc.refusal?.kind === "changed" ? dc.refusal : null });
      renderDc();
      // The form is drawn again; keyboard focus stays on the group just changed.
      [...document.querySelectorAll("[data-dc-group]")].find((box) => box.dataset.dcGroup === dcGroup)?.focus();
      return;
    }
    if (target.id === "atm-filter") { filter = target.value; renderList(); return; }
    if (!target.closest("[data-editor]")) return;
    // Moving a removal's task acts at once; it is no edit of the team.
    if (target.dataset.taskMove) {
      const option = target.selectedOptions[0];
      if (target.value) void taskAction(selected, target.dataset, target.dataset.taskMove, { id: target.value, name: option.dataset.name });
      return;
    }
    const draft = current().value;
    const choice = target.dataset.mcpChoose;
    if (choice && mcpPick) {
      mcpPick = { ...mcpPick, server: choice, line: view.mcpServers.find((server) => server.name === choice)?.launchLine ?? "" };
      renderEditor();
      // The list is drawn again; keyboard focus stays on the server just chosen.
      [...document.querySelectorAll("[data-mcp-choose]")].find((radio) => radio.dataset.mcpChoose === choice)?.focus();
      return;
    }
    const tool = target.dataset.tool;
    if (tool) {
      const profile = draft.profiles[Number(target.dataset.profile)];
      profile.hostTools = target.checked ? [...profile.hostTools, tool] : profile.hostTools.filter((id) => id !== tool);
      edited(); renderEditor(); return;
    }
    const group = target.dataset.group;
    if (group) {
      draft.groups = target.checked ? [...draft.groups, group] : draft.groups.filter((chatId) => chatId !== group);
      if (removalNotes.has(selected)) notesOf(selected).unbound = [];
      edited(); renderEditor();
    }
  });

  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDc(); });

  void load(true);
  // Onboarding outcomes, announcement delivery and active Assignments change in the service; the page follows them.
  setInterval(() => { if (!document.hidden) void load(false); }, 2000);
})();
