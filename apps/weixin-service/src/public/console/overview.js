// 团队总览 (agent-console::US-003 to US-005), laid out after the owner-confirmed prototype: for the selected dispatch group, the
// Coordinator, its Team Leaders and, under each, a dashed frame per request with that team's running or waiting Executors; and a
// drawer with a node's related records and its relationships and storage. Text from members, agents and tools is always escaped
// and set as text, so nothing in it links, loads or runs (agent-console::REQ-005/AC-04). The view is read-only.
// The same drawer holds the owner's private conversation with the Coordinator or a Team Leader (agent-console::US-006): the chat
// button beside a name opens it, and its header switches between the conversation and the agent's records. Only a reply from the
// agent renders as Markdown (REQ-005/AC-01 to AC-03, chat-markdown.js); everything else in it is plain text.
(() => {
  const { esc, tip, icon } = window.ConsoleShell;
  const { render: markdown } = window.ConsoleMarkdown;
  window.ConsoleShell.mount("overview");
  const $ = (id) => document.getElementById(id);

  // Business states of requests and Assignments: label and badge style.
  const STATUS = { proposed: ["待发起人确认", "waiting"], queued: ["排队中", "running"], running: ["执行中", "running"], waiting: ["待确认", "waiting"],
    completed: ["已完成", "completed"], partially_failed: ["部分失败", "partial"], failed: ["失败", "failed"], partially_unassigned: ["部分未落实", "unassigned"],
    cancelled: ["已取消", ""], interrupted: ["已中断", "interrupted"], blocked: ["未开始（前项失败）", ""] };
  // A report's delivery, kept apart from the business state: acceptance by the platform is not proof that anyone read it.
  const DELIVERY = { none: "尚无结果汇报", accepted: "平台已接收", queued: "正在发送", sending: "正在发送", unknown: "发送结果未知", rejected: "发送失败", cancelled: "未发送" };
  const KIND = { receipt: "开工", cross_team: "跨队指派", decision: "决策", pending: "待确认", failure: "失败", interrupted: "中断", closing: "收尾", cancelled: "取消" };
  const SOURCE = { voice: "语音", media: "图片或文件" };
  const TONES = new Set(["sam", "alice", "bill", "jack"]);
  const WARN = new Set(["waiting", "partially_failed", "failed", "partially_unassigned", "cancelled"]);
  // Tree geometry: Executor card width and gap, frame padding (plus 1px borders), gap between frames, and the canvas height.
  const CARD_W = 174, CARD_GAP = 20, FRAME_PAD = 10, FRAME_GAP = 16, BRANCH_GAP = 36, CANVAS_H = 690;
  const PRIVATE = new Set(["penny", "penny-store", "personal", "personal-store", "private-chats"]);

  let view = null, scope = null, scale = 1, fitMode = true, canvasWidth = 1120;
  const collapsed = new Set();
  // The drawer: the selected node (null: every record; undefined: closed), the expanded record, the tab and the nodes opened before.
  let selected, expandedRequest = null, tab = "records", trail = [], lastTrigger = null;
  // Records whose group-post timeline the owner opened, kept open when the records are redrawn.
  const openPosts = new Set();
  // The drawer shows a node's records or, in chat mode, the conversation with `chatAgent`. Each conversation keeps its draft,
  // its selected request and the service's view of it in the page, across closing the drawer, switching to records and to
  // another agent (agent-console::US-006/AC-02); a reload starts with empty drafts.
  let mode = "records", chatAgent = null;
  const chats = new Map();

  const tone = (id) => `ats-tone ats-tone-${TONES.has(id) ? id : "other"}`;
  const toneKey = (id) => TONES.has(id) ? id : "other";
  const badge = (status) => { const [label, style] = STATUS[status] ?? [status, ""]; return `<span class="acv2-badge${style ? ` acv2-${style}` : ""}">${esc(label)}</span>`; };
  const name = (id) => view.agents[id]?.name ?? id;
  const teamName = (id) => view.agents[id]?.teamName ?? id;
  const coordinator = () => view.coordinator?.id ?? "sam";
  const groupName = (chatId) => view.groups.find((group) => group.chatId === chatId)?.name ?? chatId;
  const active = (status) => status === "running" || status === "waiting";
  const inScope = () => view.requests.filter((request) => request.chatId === scope);
  const scopeTeams = () => view.teams.filter((team) => team.groups.includes(scope));
  const involves = (request, teamId) => request.lead === teamId || request.assignments.some((a) => a.teamId === teamId) || request.parts.some((part) => part.teamId === teamId);
  const findAssignment = (id) => { for (const request of view.requests) { const a = request.assignments.find((item) => item.id === id); if (a) return { request, a }; } return null; };
  const findRequest = (id) => view.requests.find((request) => request.id === id) ?? null;
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const stamp = (ms) => { const d = new Date(ms), now = new Date(); return d.toDateString() === now.toDateString() ? clock(ms) : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(ms)}`; };
  // The agent a node stands for, and whether the owner can chat with it: the Coordinator and the Team Leader of every defined team.
  const agentOf = (id) => id === "coordinator" ? coordinator() : id?.startsWith("team:") ? id.slice(5) : null;
  const nodeOf = (agentId) => agentId === coordinator() ? "coordinator" : `team:${agentId}`;
  const chatable = (agentId) => Boolean(agentId) && (agentId === coordinator() || view.teams.some((team) => team.id === agentId));
  // A request's result line, or what stands for it while there is none.
  const resultText = (r) => r.result ?? (r.status === "proposed" ? "等待发起人确认后开始。" : ["queued", "running", "waiting"].includes(r.status) ? "事务进行中，收尾后在这里显示结果。" : "没有记录结果。");

  // The service's view, as text, so that a poll that finds nothing new changes nothing on the page.
  let loaded = "";
  async function load() {
    let text;
    try {
      const response = await fetch("/api/overview");
      // A refused request means this browser lost its authorization: reloading shows the login card (agent-console::US-001/AC-03).
      if (response.status === 401) { location.reload(); return; }
      if (!response.ok) throw new Error(String(response.status));
      text = await response.text();
    } catch {
      if (!view) $("ats-view").innerHTML = '<div class="acv2-empty" role="alert">暂时读不到团队总览，请稍后刷新。</div>';
      return;
    }
    if (text === loaded) return;
    const first = !view;
    loaded = text;
    view = JSON.parse(text);
    // A link from elsewhere in the console, such as the dispatch-group refusal list, names a request: open its record, expanded.
    const linked = first ? findRequest(new window.URLSearchParams(location.search).get("request") ?? "") : null;
    if (linked) scope = linked.chatId;
    if (!view.groups.some((group) => group.chatId === scope)) scope = view.groups[0]?.chatId ?? null;
    if (first) { render(); if (linked) open(`req:${linked.id}`); return; }
    // Work started or ended in the service: redraw the tree and the open records, keeping where the owner was.
    const canvas = $("ats-scroll"), drawer = $("ats-drawer-scroll");
    const kept = { left: canvas?.scrollLeft ?? 0, top: canvas?.scrollTop ?? 0, drawer: drawer.scrollTop };
    render();
    if ($("ats-scroll")) { $("ats-scroll").scrollLeft = kept.left; $("ats-scroll").scrollTop = kept.top; }
    if (!$("ats-drawer").hidden && mode === "chat") renderChatLog();
    else if (!$("ats-drawer").hidden) {
      $("ats-drawer-title").textContent = title(selected);
      renderRows();
      if (!storeOf(selected)) $("ats-panel-storage").innerHTML = relation(selected);
      drawer.scrollTop = kept.drawer;
    }
  }

  // ── The tree ──
  // The frames under a Team Leader in the selected group, each with that team's running and waiting Executors (from the projection).
  const frames = (teamId) => (view.teams.find((team) => team.id === teamId)?.frames[scope] ?? []).flatMap(({ request, assignments }) => {
    const r = findRequest(request);
    return r ? [{ r, list: assignments.flatMap((id) => r.assignments.filter((a) => a.id === id)) }] : [];
  });
  function coordinatorCard() {
    const id = "coordinator", sam = coordinator();
    return `<div class="ats-card ${tone(sam)}" data-card="${id}" data-active="${selected === id}"><div class="ats-card-head"><button class="ats-name" type="button" data-open="${id}" aria-label="查看${esc(name(sam))}的记录"><strong>${esc(name(sam))}</strong></button>${chatButton(sam)}</div><button class="ats-node-button" type="button" data-open="${id}" aria-pressed="${selected === id}"><span class="ats-role">总调度 · 协调分派</span><span class="ats-bot">${esc(name(sam))} Bot</span></button></div>`;
  }
  function leaderCard(team, frameCount) {
    const id = `team:${team.id}`, c = team.counts[scope] ?? { running: 0, waiting: 0, history: 0 }, open = !collapsed.has(team.id);
    const toggle = frameCount
      ? `<button class="ats-toggle" type="button" data-toggle="${esc(team.id)}" aria-expanded="${open}">${open ? "收起事务" : `展开 ${frameCount} 项事务`}</button>`
      : `<button class="ats-toggle" type="button" data-open="${esc(id)}">查看历史记录 · ${c.history}</button>`;
    return `<div class="ats-card ${tone(team.id)}" data-card="${esc(id)}" data-active="${selected === id}"><div class="ats-card-head"><button class="ats-name" type="button" data-open="${esc(id)}" aria-label="查看${esc(name(team.id))}的记录"><strong>${esc(name(team.id))}</strong></button>${chatButton(team.id)}${team.deleting ? '<span class="acv2-badge acv2-waiting" title="不接新事务，进行中的做完后移除">删除中</span>' : ""}<span class="ats-count">${c.running + c.waiting} 活动</span></div><button class="ats-node-button" type="button" data-open="${esc(id)}" aria-pressed="${selected === id}"><span class="ats-role">${esc(teamName(team.id))}负责人 · 拆分统筹</span><span class="ats-bot">${esc(name(team.id))} Bot</span><span class="ats-node-foot">${c.running} 执行中 · ${c.waiting} 待确认 · ${c.history} 历史</span></button>${toggle}</div>`;
  }
  // The frameless round speech bubble beside the Coordinator's and each Team Leader's name; Executors have none (agent-console::US-006/AC-01).
  const chatButton = (agentId) => `<button class="ats-chat-launch" type="button" data-chat="${esc(agentId)}" aria-label="与 ${esc(name(agentId))} 私聊" aria-pressed="${mode === "chat" && chatAgent === agentId && !$("ats-drawer").hidden}">${icon("chat")}</button>`;
  // An Executor: its profile, its Assignment, status and ID; no bot identity and no chat entry (agent-console::US-003/AC-04).
  function executorCard(a) {
    const id = `exec:${a.id}`;
    return `<div class="ats-card ${tone(a.teamId)}" data-card="${esc(id)}" data-active="${selected === id}"><div class="ats-card-head"><button class="ats-name" type="button" data-open="${esc(id)}" aria-label="查看${esc(a.executor)}的记录"><strong>${esc(a.executor)}</strong></button></div><button class="ats-node-button" type="button" data-open="${esc(id)}" aria-pressed="${selected === id}"><span class="ats-role">能力档 · ${esc(a.profile)}</span><span class="ats-task-caption">${esc(a.title)}</span><span class="ats-node-foot">${badge(a.status)}<span>${esc(a.label)}</span></span></button></div>`;
  }
  function frame(teamId, group, left) {
    const r = group.r, own = r.assignments.filter((a) => a.teamId === teamId).length, cross = r.assignments.length - own, id = `req:${r.id}`;
    const caption = r.lead === teamId ? `本队 ${own} 项分工${cross ? ` · 跨队 ${cross} 项` : ""}` : `跨队分工 · 应 ${name(r.lead)} 请求`;
    return `<div class="ats-position ats-req-frame" data-anchor="${esc(`${teamId}:${r.id}`)}" ${box(left, 372, group.width)}><button class="ats-req-label" type="button" data-open="${esc(id)}" aria-pressed="${selected === id}" aria-label="查看事务 ${esc(r.label)} ${esc(r.title)}"><span class="ats-req-title">${esc(r.label)} ${esc(r.title)}</span><small>${esc(caption)}</small></button><div class="ats-req-members">${group.list.map((a) => `<div class="ats-req-slot">${executorCard(a)}</div>`).join("")}</div></div>`;
  }
  // Node positions travel as data attributes and are applied through the CSSOM: the console's CSP allows no inline style attribute.
  const box = (left, top, width) => `data-left="${left}" data-top="${top}" data-width="${width}"`;
  function place() {
    const surface = $("ats-surface");
    if (!surface) return;
    surface.style.width = `${canvasWidth}px`;
    surface.style.height = `${CANVAS_H}px`;
    for (const element of surface.querySelectorAll("[data-left]")) {
      element.style.left = `${element.dataset.left}px`;
      element.style.top = `${element.dataset.top}px`;
      element.style.width = `${element.dataset.width}px`;
    }
  }
  function stores() {
    const sam = esc(name(coordinator()));
    return `<div class="ats-storage-row"><div class="ats-storage-label">本群的资料<small>群业务记忆仅 ${sam} 读取 · 负责人与执行者只看交办</small></div><div class="ats-stores"><button class="ats-store" type="button" data-open="store:group-memory:${esc(scope)}">群业务记忆<small>仅 ${sam} 读取</small></button><button class="ats-store" type="button" data-open="store:agent-memory:${esc(scope)}">负责人与执行者记忆<small>执行者按能力档共享</small></button><button class="ats-store" type="button" data-open="store:team-store:${esc(scope)}">执行记录与交付文件</button><button class="ats-store" type="button" data-open="store:group-schedule:${esc(scope)}">任务与提醒</button></div></div>`;
  }
  function tree() {
    const branches = scopeTeams().map((team) => {
      const all = frames(team.id), groups = collapsed.has(team.id) ? [] : all;
      for (const group of groups) group.width = group.list.length * CARD_W + (group.list.length - 1) * CARD_GAP + FRAME_PAD * 2 + 2;
      const inner = groups.reduce((sum, group) => sum + group.width, 0) + Math.max(0, groups.length - 1) * FRAME_GAP;
      return { team, groups, active: all.length, inner, width: Math.max(260, inner) };
    });
    const natural = branches.reduce((sum, branch) => sum + branch.width, 0) + Math.max(0, branches.length - 1) * BRANCH_GAP + 40;
    canvasWidth = Math.max(1120, natural);
    let x = (canvasWidth - natural) / 2 + 20;
    const nodes = branches.map((branch) => {
      const center = x + branch.width / 2;
      let left = center - branch.inner / 2;
      const framed = branch.groups.map((group) => { const html = frame(branch.team.id, group, left); left += group.width + FRAME_GAP; return html; }).join("");
      const note = branch.groups.length ? "" : `<div class="ats-branch-note" ${box(center - 110, 398, 220)}>${branch.active ? `已收起 ${branch.active} 项活动事务<br>点负责人卡片展开` : "暂无活动事务<br>收到事务后按分工创建临时执行者"}<br>已结束事务可在关联记录中查看</div>`;
      x += branch.width + BRANCH_GAP;
      return `<div class="ats-position" ${box(center - 120, 190, 240)} data-anchor="${esc(branch.team.id)}">${leaderCard(branch.team, branch.active)}</div>${framed}${note}`;
    }).join("");
    return `<div class="ats-stage" id="ats-stage"><div class="ats-surface" id="ats-surface"><svg class="ats-lines" aria-hidden="true"></svg><div class="ats-position" ${box(canvasWidth / 2 - 100, 18, 200)} data-anchor="coordinator">${coordinatorCard()}</div>${nodes}${stores()}</div></div>`;
  }
  // 2px connectors in the colour of the role that dispatches: the Coordinator to each Team Leader, each Team Leader to its frames.
  function draw() {
    const surface = $("ats-surface");
    if (!surface) return;
    const svg = surface.querySelector("svg"), base = surface.getBoundingClientRect(), s = base.width / canvasWidth;
    const pairs = scopeTeams().flatMap((team) => [["coordinator", team.id, coordinator()], ...(collapsed.has(team.id) ? [] : frames(team.id).map((g) => [team.id, `${team.id}:${g.r.id}`, team.id]))]);
    const keys = new Set(pairs.map(([, , by]) => toneKey(by)));
    const anchor = (key) => [...surface.querySelectorAll("[data-anchor]")].find((element) => element.dataset.anchor === key);
    svg.innerHTML = `<defs>${[...keys].map((key) => `<marker id="ats-arrow-${key}" class="ats-arrow-${key}" viewBox="0 0 5 5" refX="5" refY="2.5" markerWidth="5" markerHeight="5" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L5 2.5 L0 5"/></marker>`).join("")}</defs>`
      + pairs.map(([from, to, by]) => {
        const a = anchor(from)?.getBoundingClientRect(), b = anchor(to)?.getBoundingClientRect();
        if (!a || !b) return "";
        const x1 = (a.left + a.width / 2 - base.left) / s, y1 = (a.bottom - base.top) / s, x2 = (b.left + b.width / 2 - base.left) / s, y2 = (b.top - base.top) / s, mid = (y1 + y2) / 2;
        return `<path class="ats-edge ats-edge-${toneKey(by)}" d="M${x1} ${y1} V${mid} H${x2} V${y2}" marker-end="url(#ats-arrow-${toneKey(by)})"/>`;
      }).join("");
  }
  function applyScale() {
    const stage = $("ats-stage"), surface = $("ats-surface");
    if (!stage) return;
    stage.style.width = `${canvasWidth * scale}px`;
    stage.style.height = `${CANVAS_H * scale}px`;
    surface.style.transform = `scale(${scale})`;
    $("ats-scale").textContent = `${Math.round(scale * 100)}%`;
  }
  // Fit-to-window shrinks the tree only so far that small nodes stay readable.
  function fit() {
    if (!fitMode) return;
    const box = $("ats-scroll");
    if (!box) return;
    scale = Math.max(0.72, Math.min(1, (box.clientWidth - 28) / canvasWidth, (box.clientHeight - 28) / CANVAS_H));
    applyScale();
  }
  function render() {
    $("ats-entry-bar").innerHTML = view.groups.length ? `<span class="ats-entry-label">消息入口</span>${view.groups.map((group) => `<button class="ats-chip" type="button" data-scope="${esc(group.chatId)}" aria-pressed="${group.chatId === scope}">${esc(group.name)} · 群协作</button>`).join("")}` : "";
    $("ats-all").textContent = `全部记录 · ${view.requests.length}`;
    if (!view.dispatch || !scope) {
      $("ats-view").innerHTML = '<section class="ats-group"><div class="ats-empty-scope">尚未配置派单群。在团队管理中选择派单群并重启服务后，这里显示团队与事务。</div></section>';
      return;
    }
    $("ats-view").innerHTML = `<section class="ats-group" id="ats-group"><div class="ats-group-head"><span>${esc(groupName(scope))} · 团队关系</span><div class="ats-legend"><span><i></i>协调分派</span><span><i class="ats-req-swatch"></i>同一事务的分工</span><span>仅显示活动执行者</span></div></div><div class="ats-scroll" id="ats-scroll" tabindex="0" aria-label="团队关系画布，可滚动查看">${tree()}</div><div class="ats-footer"><span class="ats-footer-hint">负责人常驻 · 执行者按分工创建 · 结束后保留记录</span><div class="ats-footer-actions"><button class="acv2-button" type="button" data-zoom="out">缩小</button><span class="ats-footer-output" id="ats-scale">100%</span><button class="acv2-button" type="button" data-zoom="in">放大</button><button class="acv2-button" type="button" data-zoom="fit">适应窗口</button></div></div></section>`;
    place();
    window.requestAnimationFrame(() => { draw(); if (fitMode) fit(); else applyScale(); });
    responsive();
  }

  // ── The drawer ──
  const storeOf = (id) => { const match = /^store:([a-z-]+):(.*)$/.exec(id ?? ""); return match ? { kind: match[1], chatId: match[2] } : null; };
  function records(id) {
    if (id === null) return view.requests;
    if (PRIVATE.has(id)) return [];
    if (id.startsWith("team:")) return inScope().filter((request) => involves(request, id.slice(5)));
    if (id.startsWith("exec:")) { const hit = findAssignment(id.slice(5)); return hit ? [hit.request] : []; }
    if (id.startsWith("req:")) { const request = findRequest(id.slice(4)); return request ? [request] : []; }
    const store = storeOf(id);
    if (store) return view.requests.filter((request) => request.chatId === store.chatId);
    if (id.startsWith("group:")) return view.requests.filter((request) => request.chatId === id.slice(6));
    return inScope();
  }
  const STORE_TITLE = { "group-memory": "群业务记忆", "agent-memory": "负责人与执行者记忆", "team-store": "执行记录与交付文件", "group-schedule": "任务与提醒" };
  function title(id) {
    if (id === null) return "全部处理记录";
    if (id === "coordinator") return name(coordinator());
    if (id.startsWith("team:")) return name(id.slice(5));
    if (id.startsWith("exec:")) return findAssignment(id.slice(5))?.a.executor ?? id;
    if (id.startsWith("req:")) { const r = findRequest(id.slice(4)); return r ? `${r.label} ${r.title}` : id; }
    if (id.startsWith("group:")) return groupName(id.slice(6));
    const store = storeOf(id);
    if (store) return STORE_TITLE[store.kind] ?? id;
    return { penny: "Penny", "penny-store": "独立财务存储", personal: "个人助手", "personal-store": "私人记忆与会话", "private-chats": "负责人私聊记录" }[id] ?? id;
  }
  function chatOf(id) {
    if (id === null || PRIVATE.has(id)) return null;
    if (id.startsWith("exec:")) return findAssignment(id.slice(5))?.request.chatId ?? scope;
    if (id.startsWith("req:")) return findRequest(id.slice(4))?.chatId ?? scope;
    if (id.startsWith("group:")) return id.slice(6);
    return storeOf(id)?.chatId ?? scope;
  }

  function rows(list) {
    return list.map((r) => `<article class="acv2-record" data-request="${esc(r.id)}"><button class="acv2-record-button" type="button" data-job="${esc(r.id)}" aria-expanded="${expandedRequest === r.id}"><span class="acv4-record-top"><span class="acv2-record-title">${esc(r.title)}</span><span class="acv4-record-action">${expandedRequest === r.id ? "收起详情" : "展开详情"}</span></span><span class="acv2-record-meta"><span class="acv2-agent ${tone(r.lead)}">${esc(name(r.lead))} · ${r.assignments.length} 项分工</span>${badge(r.status)}<span class="acv2-record-delivery">${esc(DELIVERY[r.delivery] ?? r.delivery)}</span><span class="acv2-record-time">${esc(stamp(r.receivedAt))}</span></span></button>${expandedRequest === r.id ? detail(r) : ""}</article>`).join("");
  }
  // An expanded record, in order: result, path, Assignments, group posts, original message and storage links (agent-console::US-004/AC-04).
  function detail(r) {
    const cross = r.crossTeams;
    const ended = r.assignments.length > 0 && !r.assignments.some((a) => active(a.status) || a.status === "queued");
    const result = resultText(r);
    const sam = esc(name(coordinator()));
    const path = `群任务 · ${esc(groupName(r.chatId))}<br>分派路径：${sam} → ${esc(name(r.lead))}（主责）${cross.map((teamId) => `<br>跨队：${sam} → ${esc(name(teamId))} · 应 ${esc(name(r.lead))} 请求`).join("")}${r.parts.filter((part) => part.teamId === null).map((part) => `<br>未承接：${esc(part.title)} · 没有团队承接`).join("")}<br>汇报：${[r.lead, ...cross].map((teamId) => esc(name(teamId))).join("、")} · 原群${ended ? "<br>全部执行者已结束，执行记录保留。" : ""}`;
    const assignments = r.assignments.length ? `<div class="acv2-detail-label">分工 · ${r.assignments.length} 项</div><ul class="ats-asg-list">${r.assignments.map((a) => `<li class="ats-asg"><div class="ats-asg-top"><button class="ats-asg-name ${tone(a.teamId)}" type="button" data-open="${esc(`exec:${a.id}`)}">${esc(a.executor)}</button>${badge(a.status)}</div><div class="ats-asg-meta">${esc(name(a.teamId))} 负责 · 能力档：${esc(a.profile)}${a.crossTeam ? " · 跨队" : ""}</div>${a.brief ? `<p class="ats-asg-brief">交办：${esc(a.brief)}</p>` : ""}<p>${esc(a.title)}${a.result ? `：${esc(a.result)}` : ""}${active(a.status) || a.status === "queued" || a.status === "blocked" ? "" : " 执行者已结束，记录保留。"}</p></li>`).join("")}</ul>` : "";
    const posts = `<details class="acv2-process" data-posts="${esc(r.id)}"${openPosts.has(r.id) ? " open" : ""}><summary>群内汇报 · ${r.posts.length} 条</summary><ol class="acv2-timeline">${r.posts.map((post) => `<li class="acv2-step"><time>${post.acceptedAt ? esc(clock(post.acceptedAt)) : ""}</time><div><span class="ats-report-who ${tone(post.agentId)}">${esc(name(post.agentId))}${KIND[post.kind] ? ` · ${KIND[post.kind]}` : ""}</span><p class="ats-report-text">${esc(post.text)} · ${esc(DELIVERY[post.state] ?? post.state)}</p></div></li>`).join("")}</ol></details>`;
    const source = [r.requester === "owner" ? "本人" : "群成员", groupName(r.chatId), SOURCE[r.message.source]].filter(Boolean).map(esc).join(" / ");
    const message = `${r.message.text}${r.message.attachments.length ? `\n附件：${r.message.attachments.join("、")}` : ""}`;
    // The owner's own request: a chat action for each involved leader, opening its conversation with this request selected (US-006/AC-03).
    const leaders = r.requester === "owner" ? [r.lead, ...cross].filter(chatable) : [];
    const chatActions = leaders.length ? `<div class="ats-chat-actions">${leaders.map((teamId) => `<button class="acv2-button" type="button" data-chat="${esc(teamId)}" data-chat-request="${esc(r.id)}">与 ${esc(name(teamId))} 私聊讨论</button>`).join("")}</div>` : "";
    return `<div class="acv2-record-detail"><h3 class="acv4-detail-title">${esc(r.title)}</h3><div class="acv2-result${WARN.has(r.status) ? " acv2-warning" : ""}">${esc(result)}</div><div class="ats-path-line">${path}</div>${assignments}${posts}<div class="acv2-detail-label">原始信息 · ${source}</div><blockquote class="acv2-message">${esc(message)}</blockquote>${chatActions}<div class="acv2-detail-label">对应存储</div><div class="acv2-related"><button type="button" data-open="store:group-memory:${esc(r.chatId)}">群业务记忆 · 仅 ${sam}</button><button type="button" data-open="store:agent-memory:${esc(r.chatId)}">负责人与执行者记忆</button><button type="button" data-open="store:team-store:${esc(r.chatId)}">执行记录与交付文件</button></div></div>`;
  }
  const searchText = (r) => `${r.title} ${r.message.text} ${r.result ?? ""} ${r.assignments.map((a) => `${a.executor} ${a.title}`).join(" ")} ${name(r.lead)} ${r.id}`.toLowerCase();
  function renderRows() {
    const metadata = PRIVATE.has(selected), query = $("ats-search").value.trim().toLowerCase(), status = $("ats-status").value, delivery = $("ats-delivery").value;
    $("ats-filters").classList.toggle("acv2-hidden", metadata);
    const deliveryKey = (r) => r.delivery === "queued" ? "sending" : r.delivery;
    const list = records(selected).filter((r) => (status === "all" || r.status === status) && (delivery === "all" || deliveryKey(r) === delivery) && searchText(r).includes(query));
    $("ats-count").textContent = metadata ? "私人范围" : `${list.length} 条`;
    $("ats-records").innerHTML = selected === "private-chats"
      ? `<div class="acv2-empty"><strong>负责人私聊分别保存</strong><p>从 ${esc(name(coordinator()))} 或负责人名字旁的聊天按钮进入。</p></div>`
      : metadata
      ? `<div class="acv2-empty"><strong>${selected.startsWith("penny") ? "账务内容保持私密" : "私人会话独立保存"}</strong><p>${selected.startsWith("penny") ? "仅显示状态与存储位置。请到 Penny 私聊查看账务。" : "普通私聊的会话与记忆不在工作台显示。"}</p></div>`
      : list.length ? rows(list) : '<div class="acv2-empty"><strong>暂无关联记录</strong><p>事务开始后会显示在这里，结束后也会保留。</p></div>';
  }

  // The relationships and storage tab: what the node is, how it is reached, its stores and related nodes (agent-console::US-005).
  const STORE_INFO = {
    "group-memory": (sam) => [`本群的业务事实与群内发言，只有 ${sam} 读取。负责人和执行者只看交办，不读取本群记忆；私人聊天和 Penny 账本不进入该范围。`, "memory/accounts/<本群作用域>/memory.sqlite"],
    "agent-memory": () => ["每位负责人在本群有自己的记忆；同一能力档创建的执行者在本群共享一份记忆，后续执行者可以召回。总协调看不到这些记忆，负责人也看不到执行者记忆。", "memory/accounts/<负责人作用域>/ · 按负责人隔离\nmemory/accounts/<能力档作用域>/ · 按能力档共享"],
    "team-store": () => ["每件事务保留主责负责人、各项分工的临时执行者、过程与结果；执行者结束后仍可查阅。", "agent-dispatch.sqlite / agent-sessions.sqlite / model-runtimes/"],
    "group-schedule": () => ["群定时任务与提醒按来源群隔离，授权成员共同管理；结果由负责人发回原群。", "scheduled-tasks.sqlite / workflow-targets.sqlite / workflow-file-artifacts/"],
  };
  // A dispatch group's memory, read-only (agent-console::US-005/AC-04): every entry by section, then every dated event.
  const CATEGORY = { preferences: "偏好", projects: "项目", decisions: "决定", constraints: "约束" };
  const PLAN = { pending: "计划·待落实", occurred: "计划·已发生", cancelled: "计划·已取消", unfulfilled: "计划·未落实" };
  const DAYTIME = { morning: "上午", afternoon: "下午", evening: "晚上" };
  const eventLabel = (event) => event.kind === "planned" ? PLAN[event.plan] ?? "计划" : event.retracted ? "已发生·已撤回" : event.fulfillsPlan ? "已发生·完成计划" : "已发生";
  const eventTime = (event) => event.kind !== "planned" ? "" : DAYTIME[event.time] ?? event.time ?? "未指定具体时间";
  const monthDay = (ms) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(ms)}`; };
  function memoryBody(memory) {
    if (!memory?.readable) return '<p class="ats-memory-note ats-memory-error" role="alert">暂时读不到本群记忆，请稍后重新打开。</p>';
    if (!memory.entries.length && !memory.events.length) return '<p class="ats-memory-note">本群还没有整理出的记忆。</p>';
    const sections = Object.entries(CATEGORY).map(([key, label]) => {
      const items = memory.entries.filter((entry) => entry.category === key);
      return items.length ? `<h4>${label}</h4><ul>${items.map((entry) => `<li>${esc(entry.value)}</li>`).join("")}</ul>` : "";
    }).join("");
    const events = memory.events.length ? `<h4>事件</h4><ul>${memory.events.map((event) => `<li>${esc([event.date, eventLabel(event), eventTime(event), event.summary].filter(Boolean).join(" · "))}</li>`).join("")}</ul>` : "";
    return `<p class="ats-memory-meta">记忆 ${memory.entries.length} 条 · 事件 ${memory.events.length} 个${memory.updatedAt ? ` · 最近整理 ${esc(monthDay(memory.updatedAt))}` : ""}</p><div class="ats-memory">${sections}${events}</div>`;
  }
  async function loadMemory(id, chatId) {
    let memory = null;
    try {
      const response = await fetch(`/api/overview/memory?group=${encodeURIComponent(chatId)}`);
      if (response.status === 401) { location.reload(); return; }
      if (response.ok) memory = await response.json();
    } catch { /* shown as unreadable */ }
    const body = $("ats-memory-body");
    if (selected === id && body) body.innerHTML = memoryBody(memory);
  }
  const PENNY_STATE = () => !view.penny.configured ? "未配置" : view.penny.ready ? "就绪" : "未就绪";
  function relation(id) {
    const sam = name(coordinator()), root = view.storageRoot;
    const related = (buttons) => buttons.length ? `<div class="acv2-related">${buttons.map(([target, label]) => `<button type="button" data-open="${esc(target)}">${esc(label)}</button>`).join("")}</div>` : "";
    if (id === null) return `<p class="ats-drawer-summary">本人的工作空间记录按来源群分开保存，每件事务保留主责负责人、各项分工的临时执行者和结果；Penny 账务不纳入此处。</p>${related(view.groups.map((group) => [`group:${group.chatId}`, group.name]))}`;
    const chatId = chatOf(id), group = chatId ? groupName(chatId) : "";
    // Sam's and each Team Leader's tab also lead to the store of the owner's private conversations with them (agent-console::US-005/AC-02).
    const privateStore = chatable(agentOf(id)) ? [["private-chats", "负责人私聊记录"]] : [];
    const groupStores = chatId ? related([[`store:group-memory:${chatId}`, `群业务记忆 · 仅 ${sam}`], [`store:agent-memory:${chatId}`, "负责人与执行者记忆"], [`store:team-store:${chatId}`, "执行记录"], ...privateStore]) : "";
    let summary, path, store, links = [];
    const groupStore = storeOf(id);
    if (groupStore) { [summary, store] = STORE_INFO[groupStore.kind](sam); path = `${group} → ${sam} → 团队负责人 → 临时执行者`; }
    else if (id === "penny") { summary = `Penny 保持独立私聊与财务存储，只显示状态：${PENNY_STATE()}。`; store = "penny/ledger.sqlite / journal.sqlite / media/"; path = "本人 → Penny Bot → Penny"; }
    else if (id === "penny-store") { summary = "仅展示位置和隔离关系，不展示交易数量、金额、账务正文或截图。"; store = "penny/ledger.sqlite / journal.sqlite / media/"; path = "本人 → Penny Bot → Penny"; }
    else if (id === "personal") { summary = "本人普通问答、文件与提醒。"; store = "memory/accounts/<私人作用域>/ / codex-service.json"; path = "本人普通私聊 → 个人助手"; }
    else if (id === "personal-store") { summary = "私人偏好与会话不进入群业务记忆或财务存储。"; store = "memory/accounts/<私人作用域>/ / codex-service.json"; path = "本人普通私聊 → 个人助手"; }
    else if (id === "private-chats") { summary = `与 ${sam} 和各负责人的对话分别保存；私聊正文不进入群记录、群记忆或普通私聊的记忆。`; store = "private-conversations.sqlite"; path = "本人 → 负责人私聊"; }
    else if (id === "coordinator") { summary = `职责：${view.coordinator?.responsibility ?? ""}。只负责总协调：把事务交给合适的负责人，跨团队的需要由 ${sam} 指派并在群里通报。读取群业务记忆和负责人汇报，看不到执行者的内容。`; store = "agent-dispatch.sqlite / memory/accounts/<本群作用域>/memory.sqlite"; path = `${group} → ${sam}`; }
    else if (id.startsWith("group:")) { summary = `${sam} 接收群消息并交给负责人。负责人把事务拆成分工，每项分工按能力档创建一名临时执行者，并统一向原群汇报；需要其他团队时由 ${sam} 指派并在群里通报。`; store = "agent-dispatch.sqlite"; path = `${group} → ${sam}`; }
    else if (id.startsWith("team:")) {
      const teamId = id.slice(5), team = view.teams.find((item) => item.id === teamId);
      summary = `职责：${team?.responsibility ?? ""}。只协调、拆分与汇报：把事务拆成分工，每项交给按能力档创建的临时执行者。只看 ${sam} 的交办和自己的记忆，不读取群业务记忆。`;
      store = "agent-dispatch.sqlite / agent-sessions.sqlite / model-runtimes/"; path = `${group} → ${sam} → ${name(teamId)} → 活动临时执行者`;
      links = inScope().flatMap((r) => r.assignments.filter((a) => a.teamId === teamId && active(a.status))).map((a) => [`exec:${a.id}`, a.executor]);
    } else if (id.startsWith("exec:")) {
      const hit = findAssignment(id.slice(5));
      if (hit) {
        const { request: r, a } = hit;
        summary = `由 ${name(a.teamId)} 按能力档「${a.profile}」为「${a.title}」创建${a.crossTeam ? `，属于 ${sam} 应 ${name(r.lead)} 请求指派的跨队分工` : ""}。${active(a.status) ? "分工仍在进行。" : "分工已结束，执行记录保留。"}只看负责人的交办和本能力档的共享记忆；不开放私聊，由负责人沟通与汇报。`;
        path = `${group} → ${sam} → ${name(a.teamId)}${a.crossTeam ? "（跨队）" : ""} → ${a.executor}`;
        links = [[`req:${r.id}`, `${r.label} ${r.title}`]];
      }
      store = "agent-dispatch.sqlite / agent-sessions.sqlite / model-runtimes/";
    } else if (id.startsWith("req:")) {
      const r = findRequest(id.slice(4));
      if (r) {
        const cross = r.crossTeams;
        summary = `${name(r.lead)} 主责，共 ${r.assignments.length} 项分工${cross.length ? `，其中 ${cross.map(name).join("、")} 的分工由 ${sam} 应 ${name(r.lead)} 请求指派` : ""}。每项分工由一名临时执行者完成。`;
        path = `${group} → ${sam} → ${name(r.lead)}${cross.length ? ` · 跨队 ${cross.map(name).join("、")}` : ""} → ${r.assignments.length} 项分工`;
        links = r.assignments.map((a) => [`exec:${a.id}`, a.executor]);
      }
      store = "agent-dispatch.sqlite / agent-sessions.sqlite";
    }
    const isolated = PRIVATE.has(id);
    const memory = groupStore?.kind === "group-memory" ? `<div class="acv-tip-row ats-memory-head"><h3 class="ats-relation-title">当前内容</h3>${tip(`只读：这是 ${sam} 处理本群事务时读取的记忆，包括启用团队之前整理的内容。\n· 事件按日期列出全部，不限时间范围。\n· 控制台不修改、不删除这份记忆。`)}</div><div id="ats-memory-body"></div>` : "";
    return `<p class="ats-drawer-summary">${esc(summary ?? "")}</p><h3 class="ats-relation-title">${isolated ? "私聊与身份" : "所属关系与消息身份"}</h3><div class="ats-path-line">${esc(path ?? "")}</div>${related(links)}<h3 class="ats-relation-title">对应存储</h3><code class="acv2-path">${esc(`${root}/`)}<br>${esc(store ?? "").replace(/\n/g, "<br>")}</code>${isolated ? "" : groupStores}${memory}`;
  }

  function setTab(next, focus = false) {
    tab = next;
    for (const key of ["records", "storage"]) {
      const on = tab === key, button = $(`ats-tab-${key}`);
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
      $(`ats-panel-${key}`).hidden = !on;
    }
    if (focus) $(`ats-tab-${tab}`).focus();
  }
  function updateSelection() {
    const open = !$("ats-drawer").hidden;
    for (const item of document.querySelectorAll(".acv-side .acv-s-item[data-open]")) item.setAttribute("aria-pressed", String(open && item.dataset.open === selected));
    for (const card of document.querySelectorAll(".ats-card")) card.dataset.active = String(open && card.dataset.card === selected);
    for (const button of document.querySelectorAll(".ats-node-button[data-open],.ats-req-label[data-open]")) button.setAttribute("aria-pressed", String(open && button.dataset.open === selected));
    for (const button of document.querySelectorAll(".ats-chat-launch")) button.setAttribute("aria-pressed", String(open && mode === "chat" && button.dataset.chat === chatAgent));
  }
  // On phones the drawer fills the workspace and the content underneath is inert (agent-console::US-002/AC-05).
  function responsive() { $("ats-view").inert = innerWidth < 720 && !$("ats-drawer").hidden; }
  function show(id) {
    selected = id;
    const chatId = chatOf(id);
    $("ats-drawer-title").textContent = title(id);
    $("ats-drawer-kind").textContent = id === null ? "本人工作空间 · 群任务" : PRIVATE.has(id) ? "私人区域 · 仅本人可见" : `${chatId ? groupName(chatId) : ""} · 团队协作`;
    $("ats-scope-label").textContent = id?.startsWith("team:") ? "团队事务 · 包含历史" : id?.startsWith("exec:") ? "该执行者所在事务" : id?.startsWith("req:") ? "事务记录" : "关联记录";
    $("ats-back").hidden = trail.length === 0;
    $("ats-mode-button").hidden = !chatable(agentOf(id));
    $("ats-panel-storage").innerHTML = relation(id);
    const store = storeOf(id);
    if (store?.kind === "group-memory") void loadMemory(id, store.chatId);
    renderRows();
    updateSelection();
  }
  /** Opens a node; `related` keeps the node shown now on the trail, so that 返回 goes back to it (agent-console::US-005/AC-01). */
  function open(id, trigger, related = false) {
    if (related && !$("ats-drawer").hidden) trail.push({ id: selected, tab, expanded: expandedRequest });
    else { trail = []; if (trigger) lastTrigger = trigger; }
    expandedRequest = id?.startsWith("req:") ? id.slice(4) : null;
    $("ats-search").value = ""; $("ats-status").value = "all"; $("ats-delivery").value = "all";
    setMode("records");
    $("ats-drawer").hidden = false;
    if (!related) setTab("records");
    show(id);
    responsive();
    window.requestAnimationFrame(fit);
    if (innerWidth < 720) $("ats-close").focus();
  }
  function back() {
    const previous = trail.pop();
    if (!previous) return;
    expandedRequest = previous.expanded;
    setTab(previous.tab);
    show(previous.id);
  }
  function close() {
    if ($("ats-drawer").hidden) return;
    $("ats-drawer").hidden = true;
    selected = undefined; expandedRequest = null; trail = [];
    updateSelection();
    responsive();
    window.requestAnimationFrame(fit);
    if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus({ preventScroll: true });
  }

  // ── Private conversations (agent-console::US-006) ──
  const chatState = (agentId) => {
    // `awaiting`: a record's chat action selected `requestId`, which stays selected until a view read after it shows whether the
    // conversation can select it. `error` is a refused send's reason, `loadError` that the conversation could not be read.
    if (!chats.has(agentId)) chats.set(agentId, { draft: "", requestId: "", awaiting: false, view: null, error: "", loadError: "", loaded: "" });
    return chats.get(agentId);
  };
  function setMode(next) {
    mode = next;
    const chat = mode === "chat";
    $("ats-record-tabs").hidden = chat; $("ats-drawer-scroll").hidden = chat; $("ats-record-foot").hidden = chat; $("ats-chat-pane").hidden = !chat;
    $("ats-mode-button").textContent = chat ? "查看记录" : "私聊";
  }
  /** Opens the conversation with `agentId` in the drawer; a record's chat action selects its request (US-006/AC-03). */
  function openChat(agentId, requestId, trigger) {
    if (!chatable(agentId)) return;
    if (trigger) lastTrigger = trigger;
    const state = chatState(agentId);
    if (requestId) { state.requestId = requestId; state.awaiting = true; }
    trail = []; expandedRequest = null; selected = nodeOf(agentId); chatAgent = agentId;
    setMode("chat");
    $("ats-drawer").hidden = false;
    $("ats-drawer-title").textContent = `与 ${name(agentId)} 私聊`;
    $("ats-drawer-kind").textContent = "本人私聊 · 仅本人可见";
    $("ats-back").hidden = true;
    $("ats-mode-button").hidden = false;
    renderChat();
    void loadChat(agentId);
    updateSelection();
    responsive();
    window.requestAnimationFrame(fit);
    if (innerWidth < 720) $("ats-close").focus();
  }
  async function loadChat(agentId) {
    const state = chatState(agentId);
    try {
      const response = await fetch(`/api/private-chats/${encodeURIComponent(agentId)}`);
      if (response.status === 401) { location.reload(); return; }
      if (!response.ok) throw new Error(String(response.status));
      const text = await response.text();
      if (text === state.loaded && !state.awaiting && !state.loadError) return;
      // A read that succeeds settles a preselected request and clears a failed read's notice.
      state.loaded = text; state.view = JSON.parse(text); state.awaiting = false; state.loadError = "";
    } catch {
      if (state.view) return;
      state.loadError = "暂时读不到这段私聊，请稍后再试。";
    }
    if (mode === "chat" && chatAgent === agentId && !$("ats-drawer").hidden) renderChatLog();
  }
  // The requests this conversation can select, as the service lists them, with what the overview shows of each.
  const chatRequests = (state) => (state.view?.requests ?? []).map(findRequest).filter(Boolean);
  function chatContext(state) {
    const options = chatRequests(state);
    if (state.requestId && !options.some((r) => r.id === state.requestId)) {
      // Until the conversation's view is read, a request a record's chat action selected stays offered and selected.
      const preselected = state.awaiting ? findRequest(state.requestId) : null;
      if (preselected) options.push(preselected); else state.requestId = "";
    }
    const r = state.requestId ? findRequest(state.requestId) : null;
    return `<label>关联事务<select id="ats-chat-task" aria-label="关联本人发起的事务"><option value="">新的私聊</option>${options.map((x) => `<option value="${esc(x.id)}"${x.id === state.requestId ? " selected" : ""}>群 · ${esc(x.title)} · ${esc(STATUS[x.status]?.[0] ?? x.status)}</option>`).join("")}</select></label><p>${r ? `来源：${esc(groupName(r.chatId))} · 发起人：本人` : "可直接讨论，或在上方选择本人发起的事务；私聊内容不进入群记录。"}</p>`;
  }
  function chatLog(state) {
    const who = esc(name(chatAgent)), r = state.requestId ? findRequest(state.requestId) : null;
    const messages = (state.view?.messages ?? []).map((m) => {
      const bubble = m.role === "owner"
        ? `<div class="ats-chat-message ats-chat-self"><div class="ats-chat-speaker">你</div><div class="ats-chat-bubble">${esc(m.text)}</div></div>`
        : `<div class="ats-chat-message"><div class="ats-chat-speaker">${who}</div><div class="ats-chat-bubble ats-md">${markdown(m.text)}</div></div>`;
      // An unanswered message says why, inline (D6).
      const after = m.state === "pending" ? `<p class="ats-chat-wait">${who}正在回复…</p>`
        : m.state === "failed" ? `<p class="ats-chat-notice">${who}这次没有回复：${esc(m.reason ?? "运行出错")}。可以重新发送。</p>`
          : m.state === "interrupted" ? '<p class="ats-chat-notice">服务中断，没有回复。可以重新发送。</p>' : "";
      return bubble + after;
    }).join("");
    const preview = r ? `<div class="ats-chat-preview">${esc(STATUS[r.status]?.[0] ?? r.status)} · ${r.assignments.length} 项分工<br>${esc(resultText(r))}${r.status === "completed" ? "<br>全部执行者已结束，历史记录保留。" : ""}</div>` : "";
    const error = state.error || state.loadError ? `<p class="ats-chat-notice" role="alert">${esc(state.error || state.loadError)}</p>` : "";
    return `${messages}${preview}${error}${r ? "" : '<p class="ats-chat-empty">告诉我你想完成什么，或在上方选择已有事务继续讨论。</p>'}`;
  }
  const canSend = (state) => Boolean(state.draft.trim()) && !state.view?.pending;
  /** Draws the whole conversation: on opening it, after a send and when the selected request changes. */
  function renderChat() {
    const state = chatState(chatAgent), who = esc(name(chatAgent));
    $("ats-chat-pane").innerHTML = `<div class="ats-chat-context" id="ats-chat-context">${chatContext(state)}</div><div class="ats-chat-log" id="ats-chat-log" aria-live="polite">${chatLog(state)}</div><form class="ats-chat-compose" id="ats-chat-form"><textarea id="ats-chat-input" rows="2" aria-label="给 ${who} 的私聊消息" placeholder="与 ${who} 讨论具体事务…">${esc(state.draft)}</textarea><div class="ats-chat-compose-foot"><small>Enter 发送 · Shift + Enter 换行</small><button class="acv2-button acv2-primary" id="ats-chat-send" type="submit"${canSend(state) ? "" : " disabled"}>发送</button></div></form>`;
    $("ats-chat-log").scrollTop = $("ats-chat-log").scrollHeight;
  }
  /** Follows the service without touching the draft being typed: the log, the selector when its options change, and 发送. */
  function renderChatLog() {
    const state = chatState(chatAgent), log = $("ats-chat-log");
    if (!log) return;
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    const select = $("ats-chat-task"), options = ["", ...chatRequests(state).map((r) => r.id)].join("\n");
    if (select && [...select.options].map((option) => option.value).join("\n") !== options) $("ats-chat-context").innerHTML = chatContext(state);
    log.innerHTML = chatLog(state);
    if (atEnd) log.scrollTop = log.scrollHeight;
    $("ats-chat-send").disabled = !canSend(state);
  }
  async function sendChat() {
    const agentId = chatAgent, state = chatState(agentId), text = state.draft.trim();
    if (!canSend(state)) return;
    $("ats-chat-send").disabled = true;
    try {
      const response = await fetch(`/api/private-chats/${encodeURIComponent(agentId)}/messages`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, requestId: state.requestId || null }) });
      if (response.status === 401) { location.reload(); return; }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { state.error = body.error ?? "发送失败，请稍后再试。"; }
      else { state.view = body; state.loaded = ""; state.draft = ""; state.error = ""; }
    } catch {
      state.error = "发送失败，请稍后再试。";
    }
    if (mode === "chat" && chatAgent === agentId && !$("ats-drawer").hidden) { renderChat(); $("ats-chat-input").focus({ preventScroll: true }); }
  }
  document.addEventListener("input", (event) => {
    if (event.target.id !== "ats-chat-input") return;
    const state = chatState(chatAgent);
    state.draft = event.target.value;
    $("ats-chat-send").disabled = !canSend(state);
  });
  document.addEventListener("change", (event) => {
    if (event.target.id !== "ats-chat-task") return;
    chatState(chatAgent).requestId = event.target.value;
    $("ats-chat-context").innerHTML = chatContext(chatState(chatAgent));
    renderChatLog();
  });
  document.addEventListener("submit", (event) => {
    if (event.target.id !== "ats-chat-form") return;
    event.preventDefault();
    void sendChat();
  });
  document.addEventListener("keydown", (event) => {
    if (event.target.id !== "ats-chat-input" || event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void sendChat();
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!view) return;
    const chip = target.closest("[data-scope]");
    if (chip) { scope = chip.dataset.scope; render(); return; }
    const toggle = target.closest("[data-toggle]");
    if (toggle) { const id = toggle.dataset.toggle; if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id); render(); return; }
    const zoom = target.closest("[data-zoom]");
    if (zoom) {
      if (zoom.dataset.zoom === "fit") { fitMode = true; fit(); }
      else { fitMode = false; scale = Math.max(0.5, Math.min(1.4, scale + (zoom.dataset.zoom === "in" ? 0.1 : -0.1))); applyScale(); }
      return;
    }
    const chat = target.closest("[data-chat]");
    if (chat) { openChat(chat.dataset.chat, chat.dataset.chatRequest ?? "", chat); return; }
    const opener = target.closest("[data-open]");
    if (opener) { open(opener.dataset.open, opener, Boolean(opener.closest("#ats-drawer"))); return; }
    const job = target.closest("[data-job]");
    if (job) { expandedRequest = expandedRequest === job.dataset.job ? null : job.dataset.job; renderRows(); return; }
    // A click on blank space outside the drawer closes it; controls and other nodes keep their own action (agent-console::US-002/AC-05).
    if (!$("ats-drawer").hidden && !target.closest("#ats-drawer,button,input,select,textarea,a,summary,[role='button']")) close();
  });
  $("ats-all").addEventListener("click", (event) => open(null, event.currentTarget));
  $("ats-close").addEventListener("click", close);
  $("ats-back").addEventListener("click", back);
  // The header switches between the agent's conversation and its records (agent-console::US-006/AC-01).
  $("ats-mode-button").addEventListener("click", (event) => {
    if (mode === "chat") open(nodeOf(chatAgent), event.currentTarget);
    else openChat(agentOf(selected), "", event.currentTarget);
  });
  for (const key of ["records", "storage"]) $(`ats-tab-${key}`).addEventListener("click", () => setTab(key));
  $("ats-record-tabs").addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    setTab(event.key === "Home" ? "records" : event.key === "End" ? "storage" : tab === "records" ? "storage" : "records", true);
  });
  for (const id of ["ats-search", "ats-status", "ats-delivery"]) $(id).addEventListener(id === "ats-search" ? "input" : "change", () => { expandedRequest = null; renderRows(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("ats-drawer").hidden) close(); });
  new window.ResizeObserver(() => { fit(); responsive(); }).observe($("ats-view"));
  // Opening or closing a record's group-post timeline is remembered (toggle events do not bubble, so this listens in the capture phase).
  document.addEventListener("toggle", (event) => {
    const posts = event.target.closest?.("[data-posts]");
    if (!posts) return;
    if (posts.open) openPosts.add(posts.dataset.posts); else openPosts.delete(posts.dataset.posts);
  }, true);
  void load();
  // Requests start and end in the service, and a revoked browser must lose the page; like the other console pages, it follows the service.
  setInterval(() => {
    if (document.hidden) return;
    void load();
    if (mode === "chat" && chatAgent && !$("ats-drawer").hidden) void loadChat(chatAgent);
  }, 2000);
})();
