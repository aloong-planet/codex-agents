// Shared console shell for the Agent console prototypes, borrowed from the owner's agent-link web console:
// the left sidebar (identity, page navigation), the narrow-screen menu bar, and info tips.
// Pages load it before their own script and call AcvShell.mount('<page id>') first.
(() => {
  // Icon bodies copied from agent-link's sprite (Lucide-style 24px strokes); spark is the owner-chosen Skill icon.
  const ICONS = {
    network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
    idcard: '<path d="M13 19a4 4 0 00-8 0"/><path d="M16 10h2"/><path d="M16 14h2"/><circle cx="9" cy="12" r="3"/><rect x="2" y="5" width="20" height="14" rx="2"/>',
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  };
  const icon = (name) => `<svg class="acv-i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // The owner's private entries, shown in the sidebar on every page. On the team overview they act in place (switch the tree's
  // scope or open the drawer); on other pages they lead to the team overview, which owns those views.
  const PRIVATE = [
    { h: '私人任务', tip: '在负责人私聊中创建，结果默认仅本人可见。\n· 私人任务独立保存；群任务仍由负责人向原群汇报。', items: [
      { label: '我的私人任务', meta: '1 项进行中 · 结果仅私聊可见', attr: 'data-scope="private"', metaId: 'acv-private-count' },
      { label: '负责人私聊记录', attr: 'data-open="leader-chats"' },
      { label: '私人任务与执行记录', attr: 'data-open="private-store"' }] },
    { h: 'Penny · 本人私聊', tip: '仅显示状态与存储位置。\n· 账务正文和截图保留在本人私聊。', items: [
      { label: 'Penny', meta: '个人账 / 经营账 · 就绪', dot: true, attr: 'data-open="penny"' },
      { label: '独立财务存储', meta: '账本 · 私聊记录 · 附件', attr: 'data-open="penny-store"' }] },
    { h: '普通私聊', tip: '普通助手会话与负责人私聊分别保存。', items: [
      { label: '个人助手', meta: '普通问答 · 文件 · 提醒', attr: 'data-open="personal"' },
      { label: '私人记忆与会话', attr: 'data-open="personal-store"' }] },
  ];
  const NAV = [
    { id: 'team-structures', label: '团队总览', icon: 'network' },
    { id: 'team-management', label: '团队管理', icon: 'idcard' },
    { id: 'mcp-catalog', label: 'MCP 管理', icon: 'plug' },
    { id: 'skill-library', label: 'Skill 管理', icon: 'spark' },
  ];

  /** Tip trigger: lines separated by "\n"; a line starting with "· " is a bullet. The text travels in data-tip and is shown by the shared popover. */
  const tip = (text) => {
    const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
    return `<span class="acv-tip"><button class="acv-tip-btn" type="button" data-tip="${esc(lines.join('\n'))}" aria-label="说明：${esc(lines.map((l) => l.replace(/^· /, '')).join('；'))}">${icon('info')}</button></span>`;
  };

  // One popover for every tip, appended to body with position: fixed so no ancestor's overflow clips it. Its position is
  // computed from the trigger's measured rect when shown; scrolling (outside the popover) or resizing closes it.
  let pop = null, owner = null;
  const hide = () => { if (pop) pop.hidden = true; owner = null; };
  const show = (btn) => {
    if (!pop) { pop = document.createElement('div'); pop.className = 'acv-tip-pop'; pop.setAttribute('role', 'tooltip'); pop.hidden = true; document.body.appendChild(pop); }
    owner = btn;
    pop.innerHTML = btn.dataset.tip.split('\n').map((l) => l.startsWith('· ') ? `<div class="acv-tip-pt">${esc(l.slice(2))}</div>` : `<div>${esc(l)}</div>`).join('');
    pop.hidden = false;
    const r = btn.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight, gap = 6, edge = 8;
    const left = Math.max(edge, Math.min(r.left - 8, innerWidth - w - edge));
    const below = r.bottom + gap + h <= innerHeight - edge;
    pop.style.left = `${left}px`;
    pop.style.top = `${below ? r.bottom + gap : Math.max(edge, r.top - gap - h)}px`;
  };
  document.addEventListener('mouseover', (e) => { const b = e.target.closest?.('.acv-tip-btn'); if (b && b !== owner) show(b); });
  document.addEventListener('mouseout', (e) => { if (!owner) return; const to = e.relatedTarget; if (to && (owner.contains(to) || pop.contains(to))) return; if (e.target.closest?.('.acv-tip-btn') === owner || pop.contains(e.target)) hide(); });
  document.addEventListener('focusin', (e) => { const b = e.target.closest?.('.acv-tip-btn'); if (b) show(b); else if (owner) hide(); });
  document.addEventListener('scroll', (e) => { if (owner && !(pop && pop.contains(e.target))) hide(); }, true);
  addEventListener('resize', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && owner) hide(); });

  function mount(active) {
    const app = document.querySelector('.acv2-app');
    if (!app || app.querySelector('.acv-side')) return;
    const name = window.PROTOTYPE_APP?.name ?? 'Agent';
    const initials = name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    const nav = NAV.map((n) => n.id === active
      ? `<span class="acv-nav-item" aria-current="page">${icon(n.icon)}${n.label}</span>`
      : `<button class="acv-nav-item" type="button" data-goto="agent-console/${n.id}" data-goto-href="../agent-console/prototype-${n.id}.html">${icon(n.icon)}${n.label}</button>`).join('');
    app.classList.add('acv-shell');
    const goto = 'data-goto="agent-console/team-structures" data-goto-href="../agent-console/prototype-team-structures.html"';
    const priv = PRIVATE.map((sec) => `<div class="acv-side-sec"><div class="acv-side-h acv-tip-row">${sec.h}${tip(sec.tip)}</div>${sec.items.map((it) =>
      `<button class="acv-s-item" type="button" ${active === 'team-structures' ? it.attr : goto} aria-pressed="false"><span class="acv-s-title">${it.dot ? '<i class="acv-dot"></i>' : ''}${it.label}</span>${it.meta ? `<span class="acv-s-meta"${it.metaId ? ` id="${it.metaId}"` : ''}>${it.meta}</span>` : ''}</button>`).join('')}</div>`).join('');
    const foot = `<div class="acv-side-foot"><div class="acv-side-h acv-tip-row">本机${tip(AUTH_TIP)}</div><button class="acv-s-item" type="button" data-acv-login aria-pressed="false"><span class="acv-s-title">本机登录</span><span class="acv-s-meta" id="acv-login-meta"></span></button></div>`;
    app.insertAdjacentHTML('afterbegin', `<aside class="acv-side" aria-label="导航"><div class="acv-side-top"><div class="acv-ident"><span class="acv-logo" aria-hidden="true">${esc(initials)}</span><div class="acv-ident-text"><b>Agent 工作台</b><span>${esc(name)}</span></div></div><div class="acv-conn"><i></i>本机工作空间</div></div><nav class="acv-side-nav" aria-label="页面"><div class="acv-side-h">工作台</div>${nav}</nav><div class="acv-side-scroll" aria-label="私人区域 · 仅本人可见">${priv}</div>${foot}</aside><div class="acv-side-scrim"></div>`);
    const head = app.querySelector('.acv2-header');
    if (head) head.insertAdjacentHTML('afterbegin', `<button class="acv-menu-btn" type="button" aria-label="打开导航">${icon('menu')}</button>`);
    app.addEventListener('click', (e) => {
      if (e.target.closest('.acv-menu-btn')) app.classList.add('acv-side-open');
      else if (e.target.closest('.acv-side-scrim')) app.classList.remove('acv-side-open');
      else if (e.target.closest('[data-acv-login]')) { app.classList.remove('acv-side-open'); openLogin(); }
    });
    mountLogin(app);
    for (const el of document.querySelectorAll('[data-acv-tip]')) el.outerHTML = tip(el.dataset.acvTip);
  }

  // Browser authorization (local login). The drawer lists authorized browsers and revokes them; a browser without
  // authorization sees only the gate, which explains how to get a one-time login link. Mock data, page memory only.
  const AUTH_TIP = '浏览器经一次性登录链接授权后才能打开工作台，授权可在这里收回。\n· 配置变更、接入操作、浏览器授权与收回、被拒绝的 MCP 调用都追加写入本机审计文件，不记录密钥。\n· 工作台不提供审计页面，在本机终端查看。';
  const BROWSERS = [
    { id: 'b1', label: 'Chrome · 这台 Mac', granted: '11-02 21:14', used: '刚刚', current: true },
    { id: 'b2', label: 'Safari · 这台 Mac', granted: '10-28 09:30', used: '11-06 22:10' },
    { id: 'b3', label: 'Edge · 这台 Mac', granted: '09-15 18:02', used: '10-01 08:45' },
  ];
  let browsers = BROWSERS.map((b) => ({ ...b })), confirming = null, loginStatus = '', loginTrigger = null;
  const $ = (id) => document.getElementById(id);
  function mountLogin(app) {
    app.insertAdjacentHTML('beforeend', `<aside class="acv2-drawer acv-login-drawer" id="acv-login-drawer" aria-label="本机登录" hidden><div class="acv2-drawer-head"><div><div class="acv2-eyebrow">本机登录</div><h2>已授权的浏览器</h2></div><div class="acv2-drawer-actions"><button class="acv3-icon-close" id="acv-login-close" type="button" aria-label="关闭抽屉"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div></div><div class="acv2-drawer-scroll" id="acv-login-body"></div></aside><div class="acv2-mask acv-login-mask" id="acv-login-mask"></div>`);
    document.body.insertAdjacentHTML('beforeend', '<div class="acv-gate" id="acv-gate" hidden></div>');
    const drawer = $('acv-login-drawer');
    // Clicks inside the login drawer and its scrim stay here, so a page's own outside-click handling ignores them.
    for (const el of [drawer, $('acv-login-mask')]) el.addEventListener('click', (e) => { e.stopPropagation(); onLoginClick(e); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) { e.stopImmediatePropagation(); e.preventDefault(); closeLogin(); } }, true);
    document.addEventListener('click', (e) => { const b = e.target.closest?.('[data-acv-auth]'); if (b) setAuth(b.dataset.acvAuth); });
    renderLogin();
  }
  function renderLogin() {
    const meta = $('acv-login-meta');
    if (meta) meta.textContent = `${browsers.length} 个浏览器已授权`;
    const rows = browsers.map((b) => `<li><div><b>${esc(b.label)}</b>${b.current ? ' <span class="acv2-badge acv2-completed">当前浏览器</span>' : ''}<small>授权于 ${b.granted} · 最近使用 ${b.used}</small>${confirming === b.id ? `<div class="acf-inline-confirm">收回后，该浏览器打开的页面立即断开，需要重新运行登录命令才能再用。${b.current ? '<br><b>这是你正在使用的浏览器，收回后本页立即退出。</b>' : ''}<div class="acf-row-actions"><button class="acv2-button acf-danger-button" type="button" data-revoke-ok="${b.id}">确认收回</button><button class="acv2-button" type="button" data-revoke-cancel>取消</button></div></div>` : ''}</div>${confirming === b.id ? '' : `<button class="acv2-button" type="button" data-revoke="${b.id}">收回</button>`}</li>`).join('');
    $('acv-login-body').innerHTML = `<p class="acv2-intro">授权新浏览器：在这台电脑的终端运行工作台登录命令，把打印的一次性链接在该浏览器中打开。链接 2 分钟内有效、只能使用一次。</p>${loginStatus ? `<p class="acv-login-status" role="status">${esc(loginStatus)}</p>` : ''}<section class="acf-section"><div class="acv-tip-row"><h3>已授权的浏览器 · ${browsers.length}</h3>${tip('授权保存在本机，只存凭据摘要；重启服务后无需重新登录。\n· 有效期 400 天，每次打开页面自动续期。\n· 也可以在本机终端列出与收回授权。')}</div><ul class="acv5-list">${rows}</ul><div class="acf-row-actions">${confirming === 'all' ? `<div class="acf-inline-confirm">收回全部 ${browsers.length} 个浏览器的授权？包括正在使用的这个，本页会立即退出。<div class="acf-row-actions"><button class="acv2-button acf-danger-button" type="button" data-revoke-ok="all">确认全部收回</button><button class="acv2-button" type="button" data-revoke-cancel>取消</button></div></div>` : '<button class="acv2-button acf-danger-button" type="button" data-revoke="all">全部收回</button>'}</div></section><section class="acf-section"><div class="acv-tip-row"><h3>配置审计</h3>${tip('团队、群绑定、能力档、MCP、Skill 的变更，接入操作，浏览器授权与收回，以及被拒绝的 MCP 调用，都追加写入本机审计文件。\n· 只记录时间、操作方和改了什么，不记录密钥。\n· 工作台不提供审计页面，在本机终端查看。')}</div><p class="acf-section-note">写入本机审计文件 · 在终端查看</p></section>`;
  }
  function onLoginClick(e) {
    if (e.target.closest('#acv-login-mask') || e.target.closest('#acv-login-close')) { closeLogin(); return; }
    const r = e.target.closest('[data-revoke]');
    if (r) { confirming = r.dataset.revoke; loginStatus = ''; renderLogin(); return; }
    if (e.target.closest('[data-revoke-cancel]')) { confirming = null; renderLogin(); return; }
    const ok = e.target.closest('[data-revoke-ok]');
    if (!ok) return;
    const id = ok.dataset.revokeOk, hit = browsers.find((b) => b.id === id);
    confirming = null;
    if (id === 'all' || hit?.current) { browsers = []; setAuth('revoked'); return; }
    browsers = browsers.filter((b) => b.id !== id);
    loginStatus = `已收回「${hit.label}」的授权，它打开的页面已断开。`;
    renderLogin();
  }
  function openLogin() {
    loginTrigger = document.activeElement;
    confirming = null; loginStatus = ''; renderLogin();
    $('acv-login-drawer').hidden = false;
    document.querySelector('[data-acv-login]')?.setAttribute('aria-pressed', 'true');
    $('acv-login-close').focus();
  }
  function closeLogin() {
    const d = $('acv-login-drawer');
    if (!d || d.hidden) return;
    d.hidden = true;
    document.querySelector('[data-acv-login]')?.setAttribute('aria-pressed', 'false');
    if (loginTrigger && document.contains(loginTrigger)) loginTrigger.focus({ preventScroll: true });
  }
  // Demo state: ok (authorized), none (never authorized), expired (an expired or used link), revoked (after revoking this browser).
  function setAuth(state) {
    const app = document.querySelector('.acv2-app'), gate = $('acv-gate');
    if (state === 'ok') { browsers = BROWSERS.map((b) => ({ ...b })); loginStatus = ''; renderLogin(); }
    closeLogin();
    const locked = state !== 'ok';
    app.inert = locked;
    gate.hidden = !locked;
    for (const b of document.querySelectorAll('[data-acv-auth]')) b.setAttribute('aria-pressed', String(b.dataset.acvAuth === (state === 'revoked' ? 'none' : state)));
    if (!locked) return;
    const notice = state === 'expired' ? '这条登录链接已失效：超过 2 分钟或已经用过。请重新运行登录命令。' : state === 'revoked' ? '本浏览器的授权已收回，打开的页面已断开。' : '';
    gate.innerHTML = `<div class="acv-gate-card" role="dialog" aria-labelledby="acv-gate-title"><h1 id="acv-gate-title">需要本机授权</h1><p>工作台只对这台电脑上授权过的浏览器开放，未授权时不显示任何内容。</p>${notice ? `<p class="acv-gate-notice" role="alert">${notice}</p>` : ''}<ol><li>在这台电脑的终端运行工作台登录命令。</li><li>命令打印一条一次性登录链接，并用默认浏览器打开；也可以只打印，再复制到要授权的浏览器。</li><li>链接 2 分钟内有效，只能使用一次。打开后本浏览器即获授权，重启服务也无需重新登录。</li></ol></div>`;
  }

  window.AcvShell = { mount, tip, icon };
})();
