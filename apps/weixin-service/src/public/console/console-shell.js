// The console shell (agent-console::US-002), shared by every console page: the 212px sidebar with the identity, the page
// navigation, the owner's private entries and the 「本机」 section with the 本机登录 drawer (agent-console::US-001/AC-03), the
// narrow-screen menu bar and info tips. A page loads it before its own script and calls ConsoleShell.mount('<page id>'). The
// navigation lists only pages that exist; each new console page adds its entry to PAGES.
(() => {
  // The console's icons: path bodies from the owner-confirmed prototype (agent-link's Lucide-style 24px strokes), drawn as inline
  // SVG in currentColor. Never an emoji or a character: their glyphs come from whatever font renders them, so their size,
  // baseline and colour do not match the text beside them.
  const ICONS = {
    network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
    idcard: '<path d="M13 19a4 4 0 00-8 0"/><path d="M16 10h2"/><path d="M16 14h2"/><circle cx="9" cy="12" r="3"/><rect x="2" y="5" width="20" height="14" rx="2"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
    // The owner-chosen icon of Skill 管理 (agent-console::CON-003).
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    // Lucide MessageCircle: the round speech bubble of the chat button beside the Coordinator and each Team Leader (agent-console::US-006/AC-01).
    chat: '<path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719"/>',
  };
  const PAGES = [
    { id: "overview", label: "团队总览", icon: "network", href: "/console" },
    { id: "teams", label: "团队管理", icon: "idcard", href: "/console/teams" },
    { id: "mcp", label: "MCP 管理", icon: "plug", href: "/console/mcp" },
    { id: "skills", label: "Skill 管理", icon: "spark", href: "/console/skills" },
  ];
  const APP_NAME = "Codex Weixin";
  // The owner's private entries, on every page. On the team overview they open that page's drawer in place; on other pages they
  // lead to the team overview, which owns those views (agent-console::US-002/AC-02). The 私人任务 section arrives with private requests.
  const PRIVATE = [
    { h: "Penny · 本人私聊", tip: "仅显示状态与存储位置。\n· 账务正文和截图保留在本人私聊。", items: [
      { label: "Penny", open: "penny", penny: true },
      { label: "独立财务存储", meta: "账本 · 私聊记录 · 附件", open: "penny-store" }] },
    { h: "普通私聊", tip: "普通助手会话与负责人私聊分别保存。", items: [
      { label: "个人助手", meta: "普通问答 · 文件 · 提醒", open: "personal" },
      { label: "私人记忆与会话", open: "personal-store" }] },
  ];
  const AUTH_TIP = "浏览器经一次性登录链接授权后才能打开工作台，授权可在这里收回。\n· 配置变更、接入操作、浏览器授权与收回、被拒绝的 MCP 调用都追加写入本机审计文件，不记录密钥。\n· 工作台不提供审计页面，在本机终端查看。";
  const PENNY_STATE = (penny) => !penny ? "" : !penny.configured ? "未配置" : penny.ready ? "就绪" : "未就绪";

  const icon = (name) => `<svg class="acv-i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** A tip trigger: lines separated by "\n"; a line starting with "· " is a bullet. The shared popover shows it. */
  const tip = (text) => {
    const lines = String(text).split("\n").map((line) => line.trim()).filter(Boolean);
    return `<span class="acv-tip"><button class="acv-tip-btn" type="button" data-tip="${esc(lines.join("\n"))}" aria-label="说明：${esc(lines.map((line) => line.replace(/^· /, "")).join("；"))}">${icon("info")}</button></span>`;
  };

  // One popover for every tip, appended to body with position: fixed so that no ancestor's overflow clips it. It is
  // placed from the trigger's measured rect; scrolling outside it, resizing or Escape closes it.
  let pop = null;
  let owner = null;
  const hide = () => {
    if (pop) pop.hidden = true;
    owner = null;
  };
  const show = (button) => {
    if (!pop) {
      pop = document.createElement("div");
      pop.className = "acv-tip-pop";
      pop.setAttribute("role", "tooltip");
      pop.hidden = true;
      document.body.appendChild(pop);
    }
    owner = button;
    pop.replaceChildren(...button.dataset.tip.split("\n").map((line) => {
      const row = document.createElement("div");
      if (line.startsWith("· ")) row.className = "acv-tip-pt";
      row.textContent = line.startsWith("· ") ? line.slice(2) : line;
      return row;
    }));
    pop.hidden = false;
    const rect = button.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const gap = 6;
    const edge = 8;
    const below = rect.bottom + gap + height <= innerHeight - edge;
    pop.style.left = `${Math.max(edge, Math.min(rect.left - 8, innerWidth - width - edge))}px`;
    pop.style.top = `${below ? rect.bottom + gap : Math.max(edge, rect.top - gap - height)}px`;
  };
  document.addEventListener("mouseover", (event) => {
    const button = event.target.closest?.(".acv-tip-btn");
    if (button && button !== owner) show(button);
  });
  document.addEventListener("mouseout", (event) => {
    if (!owner) return;
    const to = event.relatedTarget;
    if (to && (owner.contains(to) || pop.contains(to))) return;
    if (event.target.closest?.(".acv-tip-btn") === owner || pop.contains(event.target)) hide();
  });
  document.addEventListener("focusin", (event) => {
    const button = event.target.closest?.(".acv-tip-btn");
    if (button) show(button);
    else if (owner) hide();
  });
  document.addEventListener("scroll", (event) => {
    if (owner && !(pop && pop.contains(event.target))) hide();
  }, true);
  addEventListener("resize", hide);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && owner) hide();
  });

  function mount(active) {
    const app = document.querySelector(".acv2-app");
    if (!app || app.querySelector(".acv-side")) return;
    const initials = APP_NAME.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase();
    const nav = PAGES.map((page) => page.id === active
      ? `<span class="acv-nav-item" aria-current="page">${icon(page.icon)}${esc(page.label)}</span>`
      : `<a class="acv-nav-item" href="${esc(page.href)}">${icon(page.icon)}${esc(page.label)}</a>`).join("");
    const entry = (item) => {
      const body = `<span class="acv-s-title">${item.penny ? '<i class="acv-dot"></i>' : ""}${esc(item.label)}</span>${item.penny ? '<span class="acv-s-meta" id="acv-penny-meta">个人账 / 经营账</span>' : item.meta ? `<span class="acv-s-meta">${esc(item.meta)}</span>` : ""}`;
      return active === "overview" ? `<button class="acv-s-item" type="button" data-open="${item.open}" aria-pressed="false">${body}</button>` : `<a class="acv-s-item" href="/console">${body}</a>`;
    };
    const priv = PRIVATE.map((section) => `<div class="acv-side-sec"><div class="acv-side-h acv-tip-row">${esc(section.h)}${tip(section.tip)}</div>${section.items.map(entry).join("")}</div>`).join("");
    const foot = `<div class="acv-side-foot"><div class="acv-side-h acv-tip-row">本机${tip(AUTH_TIP)}</div><button class="acv-s-item" type="button" data-acv-login aria-pressed="false"><span class="acv-s-title">本机登录</span><span class="acv-s-meta" id="acv-login-meta"></span></button></div>`;
    app.classList.add("acv-shell");
    app.insertAdjacentHTML("afterbegin", `<aside class="acv-side" aria-label="导航"><div class="acv-side-top"><div class="acv-ident"><span class="acv-logo" aria-hidden="true">${esc(initials)}</span><div class="acv-ident-text"><b>Agent 工作台</b><span>${esc(APP_NAME)}</span></div></div><div class="acv-conn"><i></i>本机工作空间</div></div><nav class="acv-side-nav" aria-label="页面"><div class="acv-side-h">工作台</div>${nav}</nav><div class="acv-side-scroll" aria-label="私人区域 · 仅本人可见">${priv}</div>${foot}</aside><div class="acv-side-scrim"></div>`);
    const head = app.querySelector(".acv2-header");
    if (head) head.insertAdjacentHTML("afterbegin", `<button class="acv-menu-btn" type="button" aria-label="打开导航">${icon("menu")}</button>`);
    app.addEventListener("click", (event) => {
      if (event.target.closest(".acv-menu-btn")) app.classList.add("acv-side-open");
      else if (event.target.closest(".acv-side-scrim")) app.classList.remove("acv-side-open");
      else if (event.target.closest("[data-acv-login]")) { app.classList.remove("acv-side-open"); void openLogin(); }
      else if (event.target.closest(".acv-side [data-open]")) app.classList.remove("acv-side-open");
    });
    mountLogin(app);
    void refreshSidebar();
    for (const element of document.querySelectorAll("[data-console-tip]")) element.outerHTML = tip(element.dataset.consoleTip);
  }

  // A refused request means this browser lost its authorization: reloading shows the login card (agent-console::US-001/AC-04).
  async function api(path, payload) {
    const response = await fetch(path, payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (response.status === 401) { location.reload(); throw new Error("unauthorized"); }
    return { ok: response.ok, body: await response.json().catch(() => ({})) };
  }

  async function refreshSidebar() {
    const { ok, body } = await api("/api/console/sidebar").catch(() => ({ ok: false, body: {} }));
    if (!ok) return;
    const login = document.getElementById("acv-login-meta"), penny = document.getElementById("acv-penny-meta");
    if (login) login.textContent = `${body.browsers} 个浏览器已授权`;
    if (penny) penny.textContent = `个人账 / 经营账 · ${PENNY_STATE(body.penny)}`;
  }

  // The 本机登录 drawer: the authorized browsers with 收回 and 全部收回, each confirmed inline (agent-console::US-001/AC-03).
  let browsers = [], confirming = null, status = null, trigger = null;
  const $ = (id) => document.getElementById(id);
  function mountLogin(app) {
    app.insertAdjacentHTML("beforeend", `<aside class="acv2-drawer acv-login-drawer" id="acv-login-drawer" aria-label="本机登录" hidden><div class="acv2-drawer-head"><div><div class="acv2-eyebrow">本机登录</div><h2>已授权的浏览器</h2></div><div class="acv2-drawer-actions"><button class="acv3-icon-close" id="acv-login-close" type="button" aria-label="关闭抽屉"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div></div><div class="acv2-drawer-scroll" id="acv-login-body"></div></aside><div class="acv2-mask acv-login-mask" id="acv-login-mask"></div>`);
    const drawer = $("acv-login-drawer");
    // Clicks inside the drawer and its scrim stay here, so a page's own outside-click handling ignores them.
    for (const element of [drawer, $("acv-login-mask")]) element.addEventListener("click", (event) => { event.stopPropagation(); void onLoginClick(event); });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !drawer.hidden) { event.stopImmediatePropagation(); event.preventDefault(); closeLogin(); }
    }, true);
  }
  const time = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? "" : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  };
  function renderLogin() {
    const meta = $("acv-login-meta");
    if (meta) meta.textContent = `${browsers.length} 个浏览器已授权`;
    const rows = browsers.map((browser) => `<li><div><b>${esc(browser.label)}</b>${browser.current ? ' <span class="acv2-badge acv2-completed">当前浏览器</span>' : ""}<small>授权于 ${esc(time(browser.authorizedAt))} · 最近使用 ${esc(time(browser.lastUsedAt))}</small>${confirming === browser.id ? `<div class="acf-inline-confirm">收回后，该浏览器打开的页面立即断开，需要重新运行登录命令才能再用。${browser.current ? "<br><b>这是你正在使用的浏览器，收回后本页立即退出。</b>" : ""}<div class="acf-row-actions"><button class="acv2-button acf-danger-button" type="button" data-revoke-ok="${esc(browser.id)}">确认收回</button><button class="acv2-button" type="button" data-revoke-cancel>取消</button></div></div>` : ""}</div>${confirming === browser.id ? "" : `<button class="acv2-button" type="button" data-revoke="${esc(browser.id)}">收回</button>`}</li>`).join("");
    const all = confirming === "all"
      ? `<div class="acf-inline-confirm">收回全部 ${browsers.length} 个浏览器的授权？包括正在使用的这个，本页会立即退出。<div class="acf-row-actions"><button class="acv2-button acf-danger-button" type="button" data-revoke-ok="all">确认全部收回</button><button class="acv2-button" type="button" data-revoke-cancel>取消</button></div></div>`
      : '<button class="acv2-button acf-danger-button" type="button" data-revoke="all">全部收回</button>';
    $("acv-login-body").innerHTML = `<p class="acv2-intro">授权新浏览器：在这台电脑的终端运行工作台登录命令，把打印的一次性链接在该浏览器中打开。链接 2 分钟内有效、只能使用一次。</p>${status ? `<p class="acv-login-status${status.error ? " acv-login-error" : ""}" role="${status.error ? "alert" : "status"}">${esc(status.text)}</p>` : ""}<section class="acf-section"><div class="acv-tip-row"><h3>已授权的浏览器 · ${browsers.length}</h3>${tip("授权保存在本机，只存凭据摘要；重启服务后无需重新登录。\n· 有效期 400 天，每次打开页面自动续期。\n· 也可以在本机终端列出与收回授权。")}</div><ul class="acv5-list">${rows}</ul><div class="acf-row-actions">${all}</div></section><section class="acf-section"><div class="acv-tip-row"><h3>配置审计</h3>${tip("团队、群绑定、能力档、MCP、Skill 的变更，接入操作，浏览器授权与收回，以及被拒绝的 MCP 调用，都追加写入本机审计文件。\n· 只记录时间、操作方和改了什么，不记录密钥。\n· 工作台不提供审计页面，在本机终端查看。")}</div><p class="acf-section-note">写入本机审计文件 · 在终端查看</p></section>`;
  }
  async function loadBrowsers() {
    const { ok, body } = await api("/api/console/browsers");
    if (ok) browsers = body.browsers;
    else status = { error: true, text: "暂时读不到已授权的浏览器，请稍后重新打开。" };
  }
  async function onLoginClick(event) {
    const target = event.target;
    if (target.closest("#acv-login-mask") || target.closest("#acv-login-close")) { closeLogin(); return; }
    const revoke = target.closest("[data-revoke]");
    if (revoke) { confirming = revoke.dataset.revoke; status = null; renderLogin(); return; }
    if (target.closest("[data-revoke-cancel]")) { confirming = null; renderLogin(); return; }
    const confirmed = target.closest("[data-revoke-ok]");
    if (!confirmed) return;
    const id = confirmed.dataset.revokeOk, revoked = browsers.find((browser) => browser.id === id);
    confirming = null;
    // Revoking this browser closes this page's connection: reloading turns the page into the login card with the revoked notice.
    if (id === "all" || revoked?.current) {
      await api("/api/console/browsers/revoke", { target: id }).catch(() => undefined);
      location.reload();
      return;
    }
    const { ok, body } = await api("/api/console/browsers/revoke", { target: id });
    status = ok ? { text: `已收回「${revoked?.label ?? id}」的授权，它打开的页面已断开。${body.auditFailed ? "审计记录写入失败，请在终端检查状态目录。" : ""}`, error: Boolean(body.auditFailed) }
      : { error: true, text: body.error ?? "收回失败，请重试。" };
    await loadBrowsers();
    renderLogin();
  }
  async function openLogin() {
    trigger = document.activeElement;
    confirming = null; status = null;
    await loadBrowsers();
    renderLogin();
    $("acv-login-drawer").hidden = false;
    document.querySelector("[data-acv-login]")?.setAttribute("aria-pressed", "true");
    $("acv-login-close").focus();
  }
  function closeLogin() {
    const drawer = $("acv-login-drawer");
    if (!drawer || drawer.hidden) return;
    drawer.hidden = true;
    document.querySelector("[data-acv-login]")?.setAttribute("aria-pressed", "false");
    if (trigger && document.contains(trigger)) trigger.focus({ preventScroll: true });
  }

  window.ConsoleShell = { mount, tip, icon, esc };
})();
