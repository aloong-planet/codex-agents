// The console shell (agent-console::US-002), shared by every console page: the 212px sidebar with the identity and
// the page navigation, the narrow-screen menu bar and info tips. A page loads it before its own script and calls
// ConsoleShell.mount('<page id>'). The navigation lists only pages that exist; each new console page adds its entry
// to PAGES. The private sections and the 本机 section arrive with the team overview.
(() => {
  // Icon bodies from the owner-confirmed prototype (agent-link's Lucide-style 24px strokes).
  const ICONS = {
    plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  };
  const PAGES = [{ id: "mcp", label: "MCP 管理", icon: "plug", href: "/console/mcp" }];
  const APP_NAME = "Codex Weixin";

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
    app.classList.add("acv-shell");
    app.insertAdjacentHTML("afterbegin", `<aside class="acv-side" aria-label="导航"><div class="acv-side-top"><div class="acv-ident"><span class="acv-logo" aria-hidden="true">${esc(initials)}</span><div class="acv-ident-text"><b>Agent 工作台</b><span>${esc(APP_NAME)}</span></div></div><div class="acv-conn"><i></i>本机工作空间</div></div><nav class="acv-side-nav" aria-label="页面"><div class="acv-side-h">工作台</div>${nav}</nav></aside><div class="acv-side-scrim"></div>`);
    const head = app.querySelector(".acv2-header");
    if (head) head.insertAdjacentHTML("afterbegin", `<button class="acv-menu-btn" type="button" aria-label="打开导航">${icon("menu")}</button>`);
    app.addEventListener("click", (event) => {
      if (event.target.closest(".acv-menu-btn")) app.classList.add("acv-side-open");
      else if (event.target.closest(".acv-side-scrim")) app.classList.remove("acv-side-open");
    });
    for (const element of document.querySelectorAll("[data-console-tip]")) element.outerHTML = tip(element.dataset.consoleTip);
  }

  window.ConsoleShell = { mount, tip, icon, esc };
})();
