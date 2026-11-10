// 团队管理 (docs/specs/team-management.md), drawn after the owner-confirmed team management prototype. The page shows the
// team view the service reports and sends one team's edit at a time; the service validates it, derives binding states,
// runs onboarding and audits every change. Every value from the service is inserted as text (agent-console::REQ-005/AC-04).
// Not built yet (ticket 11, decision D1): QR creation and the test message, MCP binding, skills, and team deletion with its
// removal panel. An existing application is the only onboarding method, so the editor shows its two steps.
// The dispatch-group form (agent-console::US-009) fills the 未配置 panel and, with dispatch, the 派单群设置 drawer; a save writes
// the channel configuration file and applies after the service restarts.
(() => {
  const { mount, tip, esc } = window.ConsoleShell;
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
  const STEP = { done: ["已完成", "acv2-badge acv2-completed"], todo: ["未开始", "acv2-badge"], review: ["等待审核", "acv2-badge acv2-waiting"], blocked: ["需处理", "acv2-badge acv2-failed"] };
  const STATUS = { fixed: ["固定", "acv2-badge"], active: ["正常接单", "acv2-badge acv2-completed"], onboarding: ["接入未完成", "acv2-badge acv2-waiting"] };
  const ANNOUNCED = { accepted: "飞书已接收", failed: "发送失败 · 不会自动重发", unknown: "发送结果未知 · 不会自动重发", pending: "正在发送", sending: "正在发送" };
  const SAVEBAR = { clean: "保存后新事务立即使用新配置。", dirty: "有未保存的修改", saved: "已保存：新事务使用新配置，进行中的事务保持原配置。", reloaded: "已重新载入最新版本，请再修改。" };
  const SAM = "sam";
  const NEW = "new";
  const $ = (id) => document.getElementById(id);

  /** The service's team view. */
  let view = null;
  let selected = null;
  /** Per list entry, the editor's copy: the edit, the definitions version it is based on, the save bar state and a refusal. */
  const drafts = new Map();
  let query = "";
  let filter = "all";
  /** The dispatch-group form: the service's view of the file, the checked groups while edited, the save bar state and a refusal. */
  const dc = { view: null, open: false, checked: null, state: "clean", refusal: null };
  const DC_BAR = { clean: "保存后重启服务才生效。", dirty: "有未保存的修改", saved: "已保存，重启服务后生效", reloaded: "已重新载入最新的配置，请再修改。" };

  async function api(path, payload) {
    const response = await fetch(path, payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (response.status === 401) { location.reload(); throw new Error("unauthorized"); }
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
  }

  const teamOf = (id) => view.teams.find((team) => team.id === id);
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
      return { teamName: "", responsibility: "", leader: { name: "", appId: "", instructions: "" }, groups: [], secretEditing: false, secret: "",
        profiles: [{ name: "能力档 1", noun: "执行者", instructions: "", hostTools: ["files.find", "files.read"].filter((tool) => tool in view.tools) }] };
    }
    const team = teamOf(id);
    return { id, teamName: team.teamName, responsibility: team.responsibility, leader: { ...team.leader }, secretEditing: false, secret: "",
      groups: team.bindings.filter(({ state }) => state !== "draining").map(({ chatId }) => chatId),
      profiles: team.profiles.map(({ id: profileId, name, noun, instructions, hostTools }) => ({ id: profileId, name, noun, instructions, hostTools: [...hostTools] })) };
  }

  const current = () => drafts.get(selected);
  function entryFor(id, note = "clean") { return { value: fromView(id), basedOn: view.version, note, refusal: null }; }

  // ---- list ----
  /** A team's state: taking work in every group it is not leaving, or not yet. */
  function stateOf(team) {
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

  // ---- onboarding: an existing application starts at the credential check ----
  const stepState = (outcome) => !outcome ? "todo" : outcome.status === "done" ? "done" : outcome.status === "review" ? "review" : "blocked";
  function credentialNote(outcome) {
    if (outcome?.status === "review") return "应用版本尚未发布，或还没有被企业管理员启用。审核通过后点「重新检查」。";
    if (outcome?.status === "action") {
      return { bad_credentials: "凭证校验没有通过：App ID 与 App Secret 不匹配。请替换 App Secret 后保存。", secret_missing: "还没有填写 App Secret。填写后保存，会自动开始检查。" }[outcome.reason]
        ?? "暂时连不上飞书，稍后点「重新检查」。";
    }
    return "确认凭证可用，读取机器人名称。";
  }
  function joinNote(chatId, outcome, credentialsDone) {
    const group = groupName(chatId);
    if (outcome?.status === "done") return "机器人已在群里。";
    if (outcome) {
      return {
        owner_only: `${group}只允许群主和管理员添加成员，Sam 无法拉入。请在飞书调整群设置，或由群主手动添加。`,
        pending_approval: `${group}开启了入群审批，Sam 的添加申请正等待群主或管理员批准；批准后点「重新检查」。`,
        refused: `飞书没有接受把机器人加入${group}。请确认应用已开启机器人能力，再点「重新检查」。`,
        not_joined: `机器人还不在${group}里。请把机器人加入该群后点「重新检查」。`,
      }[outcome.reason] ?? "暂时连不上飞书，稍后点「重新检查」。";
    }
    return credentialsDone ? "尚未检查，可点「重新检查」。" : "等待前面的步骤完成。";
  }

  function onboardingHtml(team, fixed) {
    // A binding that accepts work has passed both steps, even when it came from the local configuration without recorded checks.
    const live = (team?.bindings ?? []).filter(({ state }) => state !== "draining");
    const done = { status: "done" };
    const credentials = fixed ? done : team?.credentials ?? (live.some(({ state }) => state === "accepting") ? done : undefined);
    const joins = fixed ? view.groups.map(({ chatId }) => ({ chatId, join: done }))
      : live.map(({ chatId, state, join }) => ({ chatId, join: join ?? (state === "accepting" ? done : undefined) }));
    const first = stepState(credentials);
    const second = !joins.length ? "todo" : joins.some(({ join }) => stepState(join) === "blocked") ? "blocked" : joins.every(({ join }) => stepState(join) === "done") ? "done" : "todo";
    const rows = joins.length ? `<ul class="atm-joins">${joins.map(({ chatId, join }) => {
      const state = stepState(join);
      return `<li data-state="${state}"><div>${esc(groupName(chatId))}<small>${esc(joinNote(chatId, join, first === "done"))}</small></div><span class="${STEP[state][1]}">${STEP[state][0]}</span></li>`;
    }).join("")}</ul>` : "";
    return `<ol class="atm-onboard"><li data-state="${first}"><span class="atm-onboard-num">1</span><div>校验凭证并读取机器人信息<small>${esc(credentialNote(credentials))}</small></div><span class="${STEP[first][1]}">${STEP[first][0]}</span></li>`
      + `<li data-state="${second}"><span class="atm-onboard-num">2</span><div>加入所绑定的群<small>${joins.length ? "由 Sam 把机器人拉进每个绑定的群。" : "先在下面勾选所属群。"}</small></div><span class="${STEP[second][1]}">${STEP[second][0]}</span>${rows}</li></ol>`;
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

  function profilesHtml(draft) {
    return `<section class="acf-section"><div class="acv-tip-row"><h3>执行者能力档</h3>${tip("负责人派活时选一个能力档创建临时执行者。\n· 实际可用的工具 = 勾选的工具 ∩ 模块授权。\n· 新增的工具只对新事务生效；取消勾选立即生效。")}</div>`
      + draft.profiles.map((profile, index) => `<div class="atm-profile"><div class="atm-profile-head"><strong data-profile-title="${index}">${esc(profile.name || "未命名能力档")}</strong><button class="acv2-button" type="button" data-profile-remove="${index}">删除能力档</button></div>`
        + `<div class="acf-fields"><label class="acf-field">能力档名称<input class="acv2-input" data-profile-field="name" data-profile="${index}" value="${esc(profile.name)}" placeholder="例如：商品文案"></label>`
        + `<label class="acf-field">执行者称呼<input class="acv2-input" data-profile-field="noun" data-profile="${index}" value="${esc(profile.noun)}" placeholder="执行者"><span class="atm-noun-hint" data-noun-hint="${index}">${esc(nounHint(profile))}</span></label></div>`
        + `<label class="acf-field atm-field-gap">执行者提示词<textarea class="acf-textarea" data-profile-field="instructions" data-profile="${index}">${esc(profile.instructions)}</textarea></label>`
        + `<div class="acf-sub">工具<small>实际可用的工具 = 勾选的工具 ∩ 模块授权</small></div>${toolsHtml(profile, index)}${effectiveHtml(profile)}</div>`).join("")
      + '<div class="acf-row-actions"><button class="acv2-button" type="button" data-profile-add>新增能力档</button></div></section>';
  }

  function groupsHtml(draft, team, fixed) {
    const rows = view.groups.map(({ chatId, name }) => {
      const binding = team?.bindings.find((item) => item.chatId === chatId);
      const draining = binding?.state === "draining";
      const leaving = binding?.state === "accepting" && !draft.groups?.includes(chatId);
      const checked = fixed || (draft.groups.includes(chatId) && !draining);
      const announcement = !fixed && team?.announcements[chatId];
      return `<span class="atm-group-row"><label class="acf-check"><input type="checkbox" data-group="${esc(chatId)}" ${checked ? "checked" : ""} ${fixed || draining ? "disabled" : ""}>${esc(name)}</label>`
        + (draining ? '<span class="acv2-badge acv2-waiting">移除中 · 停止接单</span>' : leaving ? '<span class="acv2-badge">保存后移除</span>' : "")
        + (announcement ? `<p class="atm-announce" data-state="${esc(announcement.state)}">Sam 的公告：「${esc(announcement.text)}」 · ${ANNOUNCED[announcement.state] ?? ""}</p>` : "")
        + "</span>";
    }).join("");
    const preview = view.groups.map(({ chatId, name }) => `${esc(name)}：Sam 可分派给 ${(view.preview[chatId] ?? []).map((id) => esc(teamOf(id)?.leader.name ?? id)).join("、") || "暂无团队"}`).join("<br>");
    const help = fixed ? "Sam 是每个派单群固定的总协调。"
      : "团队在该群能接单时，Sam 在群里公告它加入；开始移除时公告它离开，同时更新该群各负责人的团队通讯录。\n· 接入完成前不会出现在 Sam 的分派名单里。\n· 取消勾选并保存即在该群移除：先停止接单，进行中的做完、定时任务处理完再解绑。";
    return `<section class="acf-section"><div class="acv-tip-row"><h3>所属群</h3>${tip(help)}</div><div class="atm-group-list">${rows}</div><div class="atm-roster-preview">${preview}</div></section>`;
  }

  function savebarHtml() {
    const entry = current();
    if (entry.refusal) {
      return `<div class="acf-savebar" id="atm-savebar" data-state="error"><div class="atm-save-err" role="alert"><b>无法保存</b><ul>${entry.refusal.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("")}</ul></div>`
        + `<div class="acf-row-actions">${entry.refusal.stale ? '<button class="acv2-button acv2-primary" type="button" data-reload>重新载入</button>' : '<button class="acv2-button acv2-primary" type="button" data-save>保存</button>'}</div></div>`;
    }
    return `<div class="acf-savebar" id="atm-savebar" data-state="${entry.note === "reloaded" ? "clean" : entry.note}"><span>${SAVEBAR[entry.note]}</span><button class="acv2-button acv2-primary" type="button" data-save>保存</button></div>`;
  }

  function editorHtml() {
    const fixed = selected === SAM;
    const draft = current().value;
    const team = fixed || selected === NEW ? undefined : teamOf(selected);
    const c = view.coordinator;
    const leader = fixed ? c.name : draft.leader.name || "新团队";
    const teamName = fixed ? c.teamName : draft.teamName || "待命名";
    const state = fixed ? "fixed" : team ? stateOf(team) : "onboarding";
    const head = `<div class="atm-editor-title ${tone(selected)}"><div><h2>${esc(leader)} · ${esc(teamName)}</h2><small>${fixed ? "每个派单群固定的总协调，只能修改职责与提示词"
      : `绑定在 ${esc(draft.groups.map(groupName).join("、") || "尚未绑定的群")} · ${draft.profiles.length} 个执行者能力档`}</small></div>${badge(state)}</div>`;
    const stored = fixed || Boolean(team?.secretStored);
    const secret = fixed ? '<div class="acf-secret">已保存 · 不显示</div>'
      : draft.secretEditing ? '<div class="atm-secret-input"><input class="acv2-input" type="password" data-field="secret" placeholder="粘贴 App Secret，保存后不再显示" autocomplete="off" aria-label="App Secret"><button class="acv2-button" type="button" data-secret-cancel>取消</button></div>'
        : `<div class="acf-secret">${stored ? "已保存 · 不显示" : "尚未填写"}<button class="acv2-button" type="button" data-secret-edit>${stored ? "替换" : "填写"}</button></div>`;
    const basics = `<section class="acf-section"><div class="acv-tip-row"><h3>基本信息与飞书接入</h3>${tip("负责人用自己的飞书机器人在群里发言。\n· 凭证只能写入或替换，保存后不再显示。")}</div>`
      + `<div class="acf-fields"><label class="acf-field">负责人名称<input class="acv2-input" data-field="leaderName" value="${esc(fixed ? c.name : draft.leader.name)}" placeholder="例如：Daisy" ${fixed ? "disabled" : ""}></label>`
      + `<label class="acf-field">团队名称<input class="acv2-input" data-field="teamName" value="${esc(fixed ? c.teamName : draft.teamName)}" placeholder="例如：设计团队" ${fixed ? "disabled" : ""}></label></div>`
      + '<div class="atm-mode">接入方式：已有应用，手动填写</div>'
      + `<div class="acf-fields atm-field-gap"><label class="acf-field">App ID<input class="acv2-input" data-field="appId" value="${esc(fixed ? c.appId : draft.leader.appId)}" placeholder="cli_…" ${fixed ? "disabled" : ""}></label><div class="acf-field">App Secret${secret}</div></div>`
      + onboardingHtml(team, fixed)
      + (team ? '<div class="acf-row-actions"><button class="acv2-button" type="button" data-recheck>重新检查</button></div>' : "")
      + "</section>";
    const duty = `<section class="acf-section"><div class="acv-tip-row"><h3>职责与提示词</h3>${tip(`职责会出现在 Sam 的分派名单和各负责人的团队通讯录里。\n· 提示词只给${fixed ? " Sam" : "这位负责人"}自己。`)}</div>`
      + `<label class="acf-field">职责<textarea class="acf-textarea" data-field="responsibility">${esc(draft.responsibility)}</textarea></label>`
      + `<label class="acf-field atm-field-gap">${fixed ? "Sam" : "负责人"}提示词<textarea class="acf-textarea" data-field="instructions">${esc(fixed ? draft.instructions : draft.leader.instructions)}</textarea></label></section>`;
    const profiles = fixed ? '<section class="acf-section"><h3>执行者能力档</h3><p class="acf-section-note">Sam 不执行具体事务，没有执行者能力档。</p></section>' : profilesHtml(draft);
    return `<div data-editor>${head}${basics}${duty}${profiles}${groupsHtml(draft, team, fixed)}${savebarHtml()}</div>`;
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
      return refusal.groups.map(({ chatId, requests }) => `${esc(`${dcName(chatId)}还有 ${requests.length} 项未结束的派单事务，结束后才能取消勾选：`)}<ul class="atm-dc-busy">${requests.map(({ summary, status }) => `<li>${esc(summary)}<small>${esc(DC_STATE[status] ?? status)}</small></li>`).join("")}</ul>`);
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
    selected = id;
    if (!drafts.has(id)) drafts.set(id, entryFor(id));
    renderList();
    renderEditor();
    // Another team's editor starts at its top.
    $("atm-editor").closest(".atm-scroll").scrollTop = 0;
  }

  /** Takes a new view; clean drafts follow it, while an edit in progress keeps its own copy and its base version. */
  function accept(next) {
    view = next;
    for (const [id, entry] of drafts) {
      if (id === NEW || entry.note === "dirty" || entry.refusal) continue;
      if (id !== SAM && !teamOf(id)) { drafts.delete(id); continue; }
      entry.value = fromView(id);
      entry.basedOn = view.version;
    }
    if (selected === null || (selected !== SAM && selected !== NEW && !teamOf(selected))) selected = view.teams[0]?.id ?? SAM;
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
    // An edit in progress, or a field the owner is in, is not redrawn under them.
    const focused = document.activeElement?.closest?.("[data-editor]") && document.activeElement.matches("input,textarea");
    if (current().note !== "dirty" && !current().refusal && !focused) renderEditor();
  }

  function payload() {
    const draft = current().value;
    return { ...(draft.id ? { id: draft.id } : {}), teamName: draft.teamName, responsibility: draft.responsibility,
      leader: { name: draft.leader.name, appId: draft.leader.appId, instructions: draft.leader.instructions }, groups: draft.groups,
      executorProfiles: draft.profiles.map(({ id, name, noun, instructions, hostTools }) => ({ ...(id ? { id } : {}), name, noun, instructions, hostTools })),
      ...(draft.secretEditing && draft.secret.trim() ? { secret: draft.secret } : {}) };
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
    accept(body.view);
    drafts.set(id, entryFor(id, "saved"));
    selected = id;
    renderFilter();
    renderList();
    renderEditor();
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
    if (target.closest("[data-secret-edit]")) { draft.secretEditing = true; edited(); renderEditor(); document.querySelector('[data-field="secret"]')?.focus(); return; }
    if (target.closest("[data-secret-cancel]")) { draft.secretEditing = false; draft.secret = ""; renderEditor(); return; }
    if (target.closest("[data-profile-add]")) { draft.profiles.push({ name: `能力档 ${draft.profiles.length + 1}`, noun: "执行者", instructions: "", hostTools: [] }); edited(); renderEditor(); return; }
    const remove = target.closest("[data-profile-remove]");
    if (remove) { draft.profiles.splice(Number(remove.dataset.profileRemove), 1); edited(); renderEditor(); return; }
    const recheckButton = target.closest("[data-recheck]");
    if (recheckButton) { void recheck(recheckButton); return; }
    if (target.closest("[data-save]")) { void save(); return; }
    if (target.closest("[data-reload]")) { void reload(); }
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
    const draft = current().value;
    const tool = target.dataset.tool;
    if (tool) {
      const profile = draft.profiles[Number(target.dataset.profile)];
      profile.hostTools = target.checked ? [...profile.hostTools, tool] : profile.hostTools.filter((id) => id !== tool);
      edited(); renderEditor(); return;
    }
    const group = target.dataset.group;
    if (group) {
      draft.groups = target.checked ? [...draft.groups, group] : draft.groups.filter((chatId) => chatId !== group);
      edited(); renderEditor();
    }
  });

  document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeDc(); });

  void load(true);
  // Onboarding outcomes, announcement delivery and active Assignments change in the service; the page follows them.
  setInterval(() => { if (!document.hidden) void load(false); }, 2000);
})();
