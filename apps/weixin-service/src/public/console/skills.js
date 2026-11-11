// Skill 管理 (docs/specs/skill-library.md), drawn after the owner-confirmed skill library prototype. The page shows what
// the service reports, and sends a folder path and what the owner confirmed of it: it never sends skill content, and the
// service copies only from the folder (skill-library::REQ-001). Every value from the service or a folder is inserted as
// text (agent-console::REQ-005/AC-04). The table is not refreshed on a timer: comparing each skill with its source folder
// reads the whole folder, so the page asks when it opens, after a change, and on 「重新检查」.
(() => {
  const { mount, tip, esc } = window.ConsoleShell;
  mount("skills");

  const REQ = '<span class="acv-fld-tag acv-req">必填</span>';
  const $ = (id) => document.getElementById(id);

  let skills = [];
  /** What the drawer shows: nothing, the import ("new"), or the skill with this ID. */
  let selected = null;
  /** The import drawer: the typed path, what reading it found, or why the read or the import was refused. */
  let importing = { folder: "", preview: null, error: null };
  /** The details drawer: the re-import card, the delete confirmation, the note after a re-import, and a refusal of either. */
  let detail = { reimport: false, deleting: false, done: "", error: null, deleteError: null };
  let busy = false;

  const current = () => skills.find((skill) => skill.id === selected);
  const pad = (value) => String(value).padStart(2, "0");
  const dateTime = (iso) => { const d = new Date(iso); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  async function api(path, payload) {
    const response = await fetch(path, payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (response.status === 401) { location.reload(); throw new Error("unauthorized"); }
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
  }
  /** One request at a time: a second click while the service reads or copies a folder does nothing. */
  async function once(action) {
    if (busy) return;
    busy = true;
    try { await action(); } finally { busy = false; }
  }
  /** A refusal as the page shows it: the service's sentence, or for symbolic links the list of them. */
  const refusalOf = (body) => (body.refusal?.kind === "links" ? { links: body.refusal.links } : { text: body.error ?? "请求失败" });

  // ---- table ----
  const STATES = {
    same: () => '<span class="acv2-badge acv2-completed">与来源一致</span>',
    changed: (state) => `<span class="acv2-badge acv2-waiting">${state.files.length} 个文件已变化</span>`,
    missing: () => '<span class="acv2-badge acv2-waiting">找不到来源文件夹</span>',
    unreadable: () => '<span class="acv2-badge acv2-waiting">读不了来源文件夹</span>',
  };

  function renderRows() {
    $("asl-count").textContent = `${skills.length} 个`;
    if (!skills.length) {
      $("asl-rows").innerHTML = '<tr><td colspan="6"><div class="acv2-empty"><strong>还没有 skill。</strong><p>点「从文件夹导入」导入本机的 skill 文件夹。</p></div></td></tr>';
      return;
    }
    $("asl-rows").innerHTML = skills.map((skill) => `<tr aria-selected="${selected === skill.id}"><td><button class="acv5-name" type="button" data-open="${esc(skill.id)}">${esc(skill.name)}<small>${esc(skill.description)}</small></button></td>`
      + `<td><code class="asl-code" title="${esc(skill.source)}">${esc(skill.source)}</code></td>`
      + `<td>${skill.files.length} 个${skill.files.some((file) => file.script) ? " · 含脚本" : ""}</td><td>${dateTime(skill.importedAt)}</td>`
      + `<td>${STATES[skill.state.state](skill.state)}</td><td>${skill.usedBy.length ? `${skill.usedBy.length} 个能力档` : "未使用"}</td></tr>`).join("");
  }

  // ---- drawer sections ----
  const filesHtml = (files) => `<ul class="acv5-list">${files.map((file) => `<li><code>${esc(file.path)}</code>${file.script ? '<span class="acv2-badge">脚本</span>' : ""}</li>`).join("")}</ul>`;

  function errorHtml(error) {
    if (!error) return "";
    if (error.links) return `<div class="asl-error" role="alert">这个文件夹里有 ${error.links.length} 个符号链接，无法导入：<code class="asl-code asl-wrap">${error.links.map(esc).join("<br>")}</code>符号链接可能指向文件夹以外的文件。请换成实际文件后重新读取。</div>`;
    return `<div class="asl-error" role="alert">${esc(error.text)}</div>`;
  }

  /** What reading the folder found: the refusal, or the files to copy with the confirmation card. */
  function importOutHtml() {
    const preview = importing.preview;
    if (importing.error) return errorHtml(importing.error);
    if (!preview) return "";
    const scripts = preview.files.filter((file) => file.script).length;
    return `<section class="acf-section asl-preview"><h3>${esc(preview.name)}</h3><p class="asl-desc">${esc(preview.description)}</p>`
      + `<div class="acf-sub">将导入 ${preview.files.length} 个文件<small>${scripts ? `其中 ${scripts} 个是脚本文件` : ""}</small></div>${filesHtml(preview.files)}`
      + '<div class="acf-grant"><strong>确认导入</strong> 这些文件会复制进本系统的 Skill 库；之后修改来源文件夹，要重新导入才会生效。</div>'
      + '<div class="acf-row-actions"><button class="acv2-button acv2-primary" type="button" data-import-confirm>确认导入</button></div></section>';
  }

  function importHtml() {
    return `<section class="acf-section"><div class="acv-tip-row"><h3>来源文件夹</h3>${tip("选择 skill 的根目录，里面需要有 SKILL.md。\n· 文件会复制进本系统的 Skill 库；导入后内容不能在页面上修改。\n· 不限制文件数量和大小，二进制文件照常复制；含符号链接的文件夹不能导入。")}</div>`
      + `<div class="acf-fields"><label class="acf-field"><span class="acv-tip-row">文件夹路径${REQ}</span><input class="acv2-input" data-folder value="${esc(importing.folder)}" placeholder="~/agent-skills/…"></label></div>`
      + `<div class="acf-row-actions"><button class="acv2-button" type="button" data-read ${importing.folder.trim() ? "" : "disabled"}>读取文件夹</button></div><div id="asl-import-out">${importOutHtml()}</div></section>`;
  }

  /** The skill against its source folder now, with 「重新导入」 and its confirmation card when files differ. */
  function compareHtml(skill) {
    const state = skill.state;
    let body;
    if (state.state === "missing") {
      body = `<p class="acf-section-note">找不到来源文件夹 ${esc(skill.source)}，可能已移动或删除，暂时无法重新导入。已导入的副本照常可用，能力档不受影响；把文件夹放回原处后重新检查。</p><button class="acv2-button" type="button" data-recheck>重新检查</button>`;
    } else if (state.state === "unreadable") {
      body = `<p class="acf-section-note">读不了来源文件夹 ${esc(skill.source)}，暂时无法重新导入。已导入的副本照常可用，能力档不受影响；恢复读取权限后重新检查。</p><button class="acv2-button" type="button" data-recheck>重新检查</button>`;
    } else if (state.state === "changed" && detail.reimport) {
      // A file only the source has, or only the copy has, is marked; the others differ in content.
      const marks = { added: "（新增）", removed: "（已删除）", changed: "" };
      body = `<div class="acf-grant"><strong>确认重新导入</strong> 将用来源文件夹里的新内容替换这 ${state.files.length} 个文件：<code>${state.files.map((file) => `${esc(file.path)}${marks[file.change]}`).join("<br>")}</code>`
        + `${skill.usedBy.length ? `使用它的 ${skill.usedBy.length} 个能力档，新事务使用新内容；进行中的事务保持原内容。` : ""}`
        + '<div class="acf-row-actions"><button class="acv2-button acv2-primary" type="button" data-reimport-confirm>确认重新导入</button><button class="acv2-button" type="button" data-reimport-cancel>取消</button></div></div>';
    } else if (state.state === "changed") {
      body = `<p class="acf-section-note">来源文件夹里有 ${state.files.length} 个文件与导入时不同。</p><button class="acv2-button acv2-primary" type="button" data-reimport>重新导入</button>`;
    } else {
      body = `<p class="acf-section-note">${esc(detail.done || "与来源文件夹一致。")}</p><button class="acv2-button" type="button" data-recheck>重新检查</button>`;
    }
    return `<section class="acf-section"><h3>与来源文件夹比较</h3>${body}${errorHtml(detail.error)}</section>`;
  }

  function detailHtml(skill) {
    const source = `<section class="acf-section"><div class="acv-tip-row"><h3>来源</h3>${tip("说明来自 SKILL.md。\n· 内容在来源文件夹里修改后重新导入；页面不能编辑内容。")}</div><p class="asl-desc">${esc(skill.description)}</p>`
      + `<div class="acf-sub">来源文件夹</div><code class="asl-code asl-wrap">${esc(skill.source)}</code>`
      + `<div class="acf-sub">已导入 ${skill.files.length} 个文件<small>导入于 ${dateTime(skill.importedAt)}</small></div>${filesHtml(skill.files)}</section>`;
    const usage = `<section class="acf-section"><div class="acv-tip-row"><h3>使用情况</h3>${tip("这些执行者能力档选了它。\n· 要停用，请到团队管理取消勾选。")}</div>${skill.usedBy.length
      ? `<ul class="acv5-list">${skill.usedBy.map((use) => `<li><span>${esc(use.leader)} · ${esc(use.teamName)}<small>能力档：${esc(use.profile)}</small></span><a class="acv2-button" href="/console/teams?team=${encodeURIComponent(use.teamId)}">去团队管理解绑</a></li>`).join("")}</ul>`
      : '<p class="acf-section-note asl-flush">还没有能力档使用它。</p>'}</section>`;
    const danger = `<section class="acf-section acf-danger"><h3>删除</h3>${skill.usedBy.length
      ? `<p class="acf-section-note">被 ${skill.usedBy.length} 个能力档使用。先在团队管理解绑，才能删除。</p><button class="acv2-button acf-danger-button" type="button" disabled>删除 skill</button>`
      : detail.deleting
        ? `<div class="acf-inline-confirm">从 Skill 库删除「${esc(skill.name)}」；来源文件夹不受影响。<div class="acf-row-actions"><button class="acv2-button acf-danger-button" type="button" data-delete-confirm>确认删除</button><button class="acv2-button" type="button" data-delete-cancel>取消</button></div></div>`
        : '<p class="acf-section-note">没有能力档使用它，可以删除。来源文件夹不受影响。</p><button class="acv2-button acf-danger-button" type="button" data-delete>删除 skill</button>'}${errorHtml(detail.deleteError)}</section>`;
    return source + compareHtml(skill) + usage + danger;
  }

  function render() {
    renderRows();
    const drawer = $("asl-drawer");
    const skill = current();
    if (selected === null || (selected !== "new" && !skill)) { selected = null; drawer.hidden = true; return; }
    drawer.hidden = false;
    $("asl-kind").textContent = selected === "new" ? "从文件夹导入" : "Skill";
    $("asl-title").textContent = selected === "new" ? "导入 skill" : skill.name;
    $("asl-body").innerHTML = selected === "new" ? importHtml() : detailHtml(skill);
  }

  function open(id) {
    selected = id;
    detail = { reimport: false, deleting: false, done: "", error: null, deleteError: null };
    if (id === "new") importing = { folder: "", preview: null, error: null };
    render();
    if (id === "new") document.querySelector("[data-folder]")?.focus();
  }

  function close() {
    selected = null;
    render();
  }

  // ---- actions ----
  async function load() {
    const { ok, body } = await api("/api/skills");
    if (!ok) return;
    skills = body.skills;
    render();
  }

  async function readFolder() {
    const { ok, body } = await api("/api/skills/read", { folder: importing.folder });
    importing = ok ? { ...importing, preview: body.preview, error: null } : { ...importing, preview: null, error: refusalOf(body) };
    const out = $("asl-import-out");
    if (out) out.innerHTML = importOutHtml();
  }

  /** Imports exactly what the confirmation card listed: the service refuses a folder that changed since it was read. */
  async function importFolder() {
    const { ok, body } = await api("/api/skills/import", { folder: importing.folder, confirmed: importing.preview.fingerprint });
    if (!ok) {
      importing = { ...importing, preview: null, error: refusalOf(body) };
      const out = $("asl-import-out");
      if (out) out.innerHTML = importOutHtml();
      return;
    }
    skills = body.skills;
    open(body.id);
  }

  async function reimport() {
    const skill = current();
    const { ok, body } = await api(`/api/skills/${encodeURIComponent(skill.id)}/reimport`, { confirmed: skill.state.fingerprint });
    if (!ok) {
      // What was compared no longer holds: the card closes, and the page shows the source as it is now.
      detail = { ...detail, reimport: false, error: refusalOf(body) };
      await load();
      return;
    }
    skills = body.skills;
    detail = { ...detail, reimport: false, error: null, done: "已重新导入，与来源文件夹一致。" };
    render();
  }

  async function remove() {
    const { ok, body } = await api(`/api/skills/${encodeURIComponent(selected)}/delete`, {});
    if (!ok) {
      detail = { ...detail, deleting: false, deleteError: refusalOf(body) };
      await load();
      return;
    }
    skills = body.skills;
    close();
  }

  // ---- events ----
  document.addEventListener("click", (event) => {
    const target = event.target;
    const openButton = target.closest("[data-open]");
    if (openButton) { open(openButton.dataset.open); return; }
    if (target.closest("#asl-new")) { open("new"); return; }
    if (target.closest("#asl-close")) { close(); return; }
    if (target.closest("[data-read]")) { void once(readFolder); return; }
    if (target.closest("[data-import-confirm]")) { void once(importFolder); return; }
    if (target.closest("[data-reimport]")) { detail = { ...detail, reimport: true, error: null }; render(); return; }
    if (target.closest("[data-reimport-cancel]")) { detail = { ...detail, reimport: false }; render(); return; }
    if (target.closest("[data-reimport-confirm]")) { void once(reimport); return; }
    if (target.closest("[data-recheck]")) { detail = { ...detail, done: "", error: null }; void once(load); return; }
    if (target.closest("[data-delete]")) { detail = { ...detail, deleting: true, deleteError: null }; render(); return; }
    if (target.closest("[data-delete-cancel]")) { detail = { ...detail, deleting: false }; render(); return; }
    if (target.closest("[data-delete-confirm]")) { void once(remove); return; }
    if (!$("asl-drawer").hidden && !target.closest("#asl-drawer,button,input,select,textarea,label,a,.acv-tip-pop")) close();
  });

  // A changed path is a folder not read yet: what the last read showed goes, and nothing can be confirmed until it is read.
  document.addEventListener("input", (event) => {
    if (!event.target.matches("[data-folder]")) return;
    importing = { folder: event.target.value, preview: null, error: null };
    document.querySelector("[data-read]").disabled = !importing.folder.trim();
    $("asl-import-out").innerHTML = "";
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && selected !== null) close();
    else if (event.key === "Enter" && event.target.matches?.("[data-folder]") && importing.folder.trim()) void once(readFolder);
  });

  void load();
})();
