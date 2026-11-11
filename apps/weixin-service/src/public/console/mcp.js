// MCP 管理 (docs/specs/mcp-catalog.md), drawn after the owner-confirmed MCP catalog prototype. The page shows what
// the service reports and sends the owner's changes; the service validates them, holds the connections and audits
// every change. Every value from the service or a server is inserted as text (agent-console::REQ-005/AC-04).
(() => {
  const { mount, tip, esc } = window.ConsoleShell;
  mount("mcp");

  const KEEP = "••••••";
  const REQ = '<span class="acv-fld-tag acv-req">必填</span>';
  const OPT = '<span class="acv-fld-tag acv-opt">选填</span>';
  const STATES = {
    connected: ["已连接", "acv2-badge acv2-completed"],
    connecting: ["连接中", "acv2-badge acv2-running"],
    disconnected: ["已断开", "acv2-badge acv2-waiting"],
    failed: ["连接失败", "acv2-badge acv2-failed"],
    disabled: ["已停用", "acv2-badge"],
  };
  const PARTS = { text: "说明", schema: "参数", hints: "注解", meta: "元数据" };
  const $ = (id) => document.getElementById(id);

  let servers = [];
  let selected = null;
  let mode = "server";
  let form = null;
  let note = { text: "", state: "clean" };
  let preview = null;
  let deleting = false;
  let previewTimer = null;
  /** The import drawer: the pasted text, the service's check of it, or the refusal of the document. */
  let importing = { text: "", entries: null, error: "" };
  /** What the drawer sections last showed; the 2-second refresh redraws them only when it changed. */
  let drawerKey = "";

  const chip = (state) => `<span class="${STATES[state][1]}">${STATES[state][0]}</span>`;
  const current = () => servers.find((server) => server.name === selected);
  const pad = (value) => String(value).padStart(2, "0");
  const dateTime = (iso) => { const d = new Date(iso); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const clock = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const where = (server) => (server.transport === "http" ? server.url : [server.command.split("/").pop(), ...server.args].join(" "));
  const KINDS = { stdio: "本机程序（stdio）", http: "网址（Streamable HTTP）" };

  async function api(path, payload) {
    const response = await fetch(path, payload === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    if (response.status === 401) { location.reload(); throw new Error("unauthorized"); }
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, body };
  }

  // ---- table ----
  function renderRows() {
    $("amc-count").textContent = `${servers.length} 个`;
    if (!servers.length) {
      $("amc-rows").innerHTML = '<tr><td colspan="5"><div class="acv2-empty"><strong>还没有 MCP 服务器。</strong><p>点「添加服务器」登记本机程序。</p></div></td></tr>';
      return;
    }
    $("amc-rows").innerHTML = servers.map((server) => {
      const { total, usable, pending } = server.counts;
      return `<tr aria-selected="${selected === server.name && mode === "server"}"><td><button class="acv5-name amc-mono" type="button" data-open="${esc(server.name)}">${esc(server.name)}</button></td>`
        + `<td>${server.transport === "http" ? "网址" : "本机程序"}<span class="amc-sub amc-mono" title="${esc(where(server))}">${esc(where(server))}</span></td>`
        + `<td>${chip(server.state)}${server.error && server.state !== "connected" ? `<span class="amc-sub" title="${esc(server.error)}">${esc(server.error)}</span>` : ""}${server.retryAt ? `<span class="amc-sub">将于 ${clock(server.retryAt)} 自动重试</span>` : ""}</td>`
        + `<td>${total ? `${total} 个${usable < total ? `（可用 ${usable} 个）` : ""}` : "—"}${pending ? `<span class="amc-sub"><span class="acv2-badge acv2-waiting">${pending} 个待复核</span></span>` : ""}</td>`
        + `<td>${server.attachedProfiles.length ? `${server.attachedProfiles.length} 个能力档` : "未绑定"}</td></tr>`;
    }).join("");
  }

  // ---- drawer sections ----
  function statusHtml(server) {
    const sandbox = server.sandbox;
    const rows = [
      ["状态", chip(server.state) + (server.state === "disconnected" ? "　下次调用时自动重新连接" : "")],
      ...(server.server ? [["服务器", `<span class="amc-mono">${esc(`${server.server.name} ${server.server.version}`)}</span>`]] : []),
      ...(server.protocol ? [["协议", `<span class="amc-mono">${esc(server.protocol)}</span>`]] : []),
      ...(server.oauth ? [["认证", `OAuth client_credentials · 客户端 <span class="amc-mono">${esc(server.oauth.clientId)}</span>${server.dpop ? " · DPoP" : ""}`]]
        : server.transport === "http" && Object.keys(server.headers).length ? [["认证", `请求头 <span class="amc-mono">${Object.keys(server.headers).map(esc).join("、")}</span>`]] : []),
      ...(sandbox ? [["沙箱", esc(`开（${sandbox.domains.length ? `放行 ${sandbox.domains.join("、")}` : "断网"}；${sandbox.read.length ? `可读 ${sandbox.read.join("、")}；` : ""}${sandbox.write.length ? `可写 ${sandbox.write.join("、")}` : "不可写其他目录"}）`)]] : []),
      ...(server.connectedAt && server.state === "connected" ? [["连接于", dateTime(server.connectedAt)]] : []),
      ...(server.error ? [["原因", esc(server.error)]] : []),
      ...(server.retryAt ? [["自动重试", `将于 ${clock(server.retryAt)} 自动重试（已连续失败 ${server.retries} 次；间隔每次翻倍，最长 10 分钟）`]] : []),
      ["工具注解", server.trusted ? "采信（已标为可信服务器）" : "不采信（未标为可信，一律按可能修改数据对待）"],
    ];
    return `<section class="acf-section"><div class="amc-head-row"><h3>连接状态</h3>${server.enabled ? '<button class="acv2-button" type="button" data-reconnect>重新连接</button>' : ""}</div><dl class="amc-kv">${rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join("")}</dl>${server.output ? `<details class="amc-out"><summary>程序输出（末尾）</summary><pre>${esc(server.output)}</pre></details>` : ""}</section>`;
  }

  function toolsHtml(server) {
    if (!server.tools.length) return "";
    const waiting = server.counts.pending;
    const enabled = server.tools.filter((tool) => tool.enabled).length;
    return `<section class="acf-section"><div class="amc-head-row"><div class="acv-tip-row"><h3>工具（共 ${server.tools.length} 个${enabled < server.tools.length ? `，启用 ${enabled} 个` : ""}）</h3>${tip(`勾选的工具提供给绑定了它的执行者；取消勾选即停用，下一次调用起生效，包括进行中的事务。\n· 新增的、定义有变化的工具暂停提供，核对说明和参数后点「确认」。\n· 服务器标为需人工确认的工具不提供。\n· 工具的名称为 mcp__${server.name}__工具名，确认卡片和审计里都这样写。`)}</div>${waiting > 1 ? `<button class="acv2-button" type="button" data-approve="*">全部确认（${waiting}）</button>` : ""}</div><div class="amc-tools">${server.tools.map((tool) => `<label class="amc-tool"><input type="checkbox" data-tool="${esc(tool.name)}" ${tool.enabled ? "checked" : ""}><span><b>${esc(tool.name)}</b>${tool.readOnly ? '<span class="acv2-badge acv2-completed">只读</span>' : ""}${tool.mayModify ? '<span class="acv2-badge acv2-waiting">可能修改数据</span>' : ""}${tool.needsUser ? '<span class="acv2-badge acv2-failed">需人工确认，不提供</span>' : ""}${tool.pending ? `<span class="acv2-badge acv2-waiting">${tool.pending === "new" ? "新增，待复核" : "定义有变化，待复核"}</span>` : ""}<small>${esc(tool.description)}</small>${tool.pending === "changed" ? `<small>变化的部分：${tool.changed.map((part) => PARTS[part]).join("、")}；原说明：${esc(tool.was)}</small>` : ""}</span>${tool.pending ? `<button class="acv2-button" type="button" data-approve="${esc(tool.name)}">确认</button>` : ""}</label>`).join("")}</div></section>`;
  }

  function usedHtml(server) {
    return `<section class="acf-section"><div class="acv-tip-row"><h3>绑定的能力档</h3>${tip("这些执行者能力档的执行者可以使用它的工具。\n· 要解除，请到团队管理解绑。")}</div>${server.attachedProfiles.length
      ? `<ul class="acv5-list">${server.attachedProfiles.map(({ teamId, leader, teamName, profile }) => `<li><span>${esc(leader)} · ${esc(teamName)}<small>能力档：${esc(profile)}</small></span><a class="acv2-button" href="/console/teams?team=${esc(encodeURIComponent(teamId))}">去团队管理解绑</a></li>`).join("")}</ul>`
      : '<p class="acf-section-note amc-flush">还没有能力档绑定它。在团队管理的执行者能力档里绑定，绑定时需要你确认。</p>'}</section>`;
  }

  function dangerHtml(server) {
    // A server that a profile attaches is not deleted (mcp-catalog::US-005/AC-01).
    if (server.attachedProfiles.length) {
      return `<section class="acf-section acf-danger"><h3>删除</h3><p class="acf-section-note">被 ${server.attachedProfiles.length} 个能力档绑定。先在团队管理解绑，才能删除。</p><button class="acv2-button acf-danger-button" type="button" disabled>删除服务器</button></section>`;
    }
    return `<section class="acf-section acf-danger"><h3>删除</h3>${deleting
      ? `<div class="acf-inline-confirm">删除「${esc(server.name)}」：断开连接，配置和已保存的凭证一并删除。<div class="acf-row-actions"><button class="acv2-button acf-danger-button" type="button" data-delete-confirm>确认删除</button><button class="acv2-button" type="button" data-delete-cancel>取消</button></div></div>`
      : '<p class="acf-section-note">没有能力档绑定它，可以删除。</p><button class="acv2-button acf-danger-button" type="button" data-delete>删除服务器</button>'}</section>`;
  }

  // Saved secret values arrive as ••••••, or empty for a value still to fill in; sending them back keeps them.
  const pairs = (values, separator) => Object.entries(values ?? {}).map(([name, value]) => `${name}${separator}${value}`).join("\n");

  function formFrom(server) {
    const blank = { name: "", transport: "stdio", command: "", args: "", cwd: "", env: "", sandbox: false, sbDomains: "", sbRead: "", sbWrite: "", url: "", headers: "", dpop: false, issuer: "", clientId: "", clientSecret: "", scope: "", timeout: "", trusted: false, enabled: true };
    if (!server) return blank;
    const common = { ...blank, name: server.name, transport: server.transport, timeout: server.timeout === 60 ? "" : String(server.timeout), trusted: server.trusted, enabled: server.enabled };
    if (server.transport === "http") {
      return { ...common, url: server.url, headers: pairs(server.headers, ": "), dpop: server.dpop, issuer: server.oauth?.issuer ?? "", clientId: server.oauth?.clientId ?? "", clientSecret: server.oauth ? KEEP : "", scope: server.oauth?.scope ?? "" };
    }
    return { ...common, command: server.command, args: server.args.join("\n"), cwd: server.cwd ?? "", env: pairs(server.env, "="), sandbox: Boolean(server.sandbox), sbDomains: (server.sandbox?.domains ?? []).join("\n"), sbRead: (server.sandbox?.read ?? []).join("\n"), sbWrite: (server.sandbox?.write ?? []).join("\n") };
  }

  const lines = (text) => text.split("\n").map((line) => line.trim()).filter(Boolean);

  /** One `name<separator>value` per line, as an object. */
  function valuesOf(text, separator, message, trim) {
    const values = {};
    for (const line of lines(text)) {
      const at = line.indexOf(separator);
      if (at < 1) throw new Error(message);
      values[line.slice(0, at).trim()] = trim ? line.slice(at + 1).trim() : line.slice(at + 1);
    }
    return values;
  }

  /** The draft as the API takes it: environment one NAME=value per line, headers one Name: value per line. */
  function payload() {
    const common = { name: form.name.trim(), transport: form.transport, timeout: form.timeout, trusted: form.trusted, enabled: form.enabled };
    if (form.transport === "http") {
      const oauth = form.issuer.trim() || form.clientId.trim() || form.scope.trim() || form.clientSecret
        ? { issuer: form.issuer, clientId: form.clientId, clientSecret: form.clientSecret, scope: form.scope }
        : null;
      return { ...common, url: form.url, headers: valuesOf(form.headers, ":", "请求头每行一个 名称: 值", true), oauth, dpop: form.dpop };
    }
    return {
      ...common,
      command: form.command,
      args: lines(form.args),
      cwd: form.cwd,
      env: valuesOf(form.env, "=", "环境变量每行一个 名称=值", false),
      sandbox: form.sandbox ? { domains: lines(form.sbDomains), read: lines(form.sbRead), write: lines(form.sbWrite) } : null,
    };
  }

  function grantHtml() {
    if (!preview?.needsConfirmation) return "";
    // A change to a server that profiles attach reaches running requests too (mcp-catalog::REQ-002).
    const attached = mode === "new" ? 0 : current()?.attachedProfiles.length ?? 0;
    return `<div class="acf-grant"><strong>确认登记</strong> ${form.transport === "http" ? "将连接" : "本机将运行"}：<code id="amc-launch">${esc(preview.launchLine)}</code>${attached
      ? `已绑定到 ${attached} 个能力档。确认后服务器重新连接，之后的每次调用都使用新的${form.transport === "http" ? "地址" : "命令"}，包括进行中的事务；定义有变化的工具会暂停提供，复核后再提供。`
      : "登记后还要在团队管理里绑定到能力档，执行者才能使用；绑定时会再次确认。"}</div>`;
  }

  function formHtml() {
    const isNew = mode === "new";
    const confirm = Boolean(preview?.needsConfirmation);
    const savebarText = note.text || (isNew ? "添加后即开始连接。" : "保存后重新连接；只改可信或停用工具时不重新连接。");
    const stdio = form.transport !== "http";
    return `<section class="acf-section"><div class="acv-tip-row"><h3>配置</h3>${tip(`环境变量、请求头和密钥的值只进不出。\n· 已保存的值显示为 ${KEEP}，不修改即沿用。\n· 错误信息和程序输出里出现时替换为 ***。`)}</div>`
      + `<div class="acf-fields"><label class="acf-field"><span class="acv-tip-row">名称${REQ}${tip("英文字母、数字、_ 和 -，1–32 个字符，创建后不可修改。\n· 工具的名称为 mcp__名称__工具名，确认卡片和审计里都这样写。")}</span><input class="acv2-input amc-mono" data-f="name" value="${esc(form.name)}" maxlength="32" placeholder="如：github" ${isNew ? "" : "disabled"}></label></div>`
      + `<div class="acf-field amc-gap"><span class="acv-tip-row">连接方式${REQ}</span><div class="amc-radios"><label><input type="radio" name="amc-transport" data-kind="stdio" ${stdio ? "checked" : ""}>${KINDS.stdio}</label><label><input type="radio" name="amc-transport" data-kind="http" ${stdio ? "" : "checked"}>${KINDS.http}</label></div></div>`
      + (stdio ? stdioFieldsHtml() : httpFieldsHtml())
      + `<div class="acf-fields amc-gap"><label class="acf-field"><span class="acv-tip-row">超时（秒）${OPT}${tip("单次调用的超时，1–600 秒；留空为 60 秒。")}</span><input class="acv2-input" type="number" min="1" max="600" data-f="timeout" value="${esc(form.timeout)}" placeholder="60"></label></div>`
      + `<div class="acf-checks amc-gap"><label class="acf-check"><input type="checkbox" data-f="trusted" ${form.trusted ? "checked" : ""}><span>可信<small>采信工具注解（只读、可能修改数据）</small></span></label><label class="acf-check"><input type="checkbox" data-f="enabled" ${form.enabled ? "checked" : ""}><span>启用<small>停用后断开连接，所有执行者从下一次调用起都不能使用其工具，包括进行中的事务；配置保留</small></span></label></div>`
      + `<div id="amc-grant">${grantHtml()}</div>`
      + `<div class="acf-savebar" data-state="${note.state}"><span id="amc-note">${esc(savebarText)}</span><button class="acv2-button acv2-primary" type="button" data-save>${isNew ? "确认并添加" : confirm ? "确认并保存" : "保存"}</button></div></section>`;
  }

  function stdioFieldsHtml() {
    return `<div class="acf-fields amc-gap"><label class="acf-field"><span class="acv-tip-row">命令${REQ}</span><input class="acv2-input amc-mono" data-f="command" value="${esc(form.command)}" placeholder="如：npx"></label><label class="acf-field"><span class="acv-tip-row">工作目录${OPT}</span><input class="acv2-input amc-mono" data-f="cwd" value="${esc(form.cwd)}" placeholder="留空为家目录"></label></div>`
      + `<label class="acf-field amc-gap"><span class="acv-tip-row">参数${OPT}${tip("每行一个参数。")}</span><textarea class="amc-pairs" data-f="args" placeholder="-y&#10;@modelcontextprotocol/server-github">${esc(form.args)}</textarea></label>`
      + `<label class="acf-field amc-gap"><span class="acv-tip-row">环境变量${OPT}${tip(`每行一个 名称=值。\n· 只给这里配置的变量和 PATH、HOME 等基础变量，拿不到模型 key。\n· 已保存的值显示为 ${KEEP}，不修改即沿用。`)}</span><textarea class="amc-pairs" data-f="env" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=…">${esc(form.env)}</textarea></label>`
      + `<label class="acf-check amc-gap"><input type="checkbox" data-f="sandbox" ${form.sandbox ? "checked" : ""}>在沙箱中运行（仅 macOS）${tip("经 sandbox-runtime 启动，每个服务器一个进程。\n· 网络只放行填写的域名，不填即断网；用 npx 启动的，需放行 registry.npmjs.org。\n· 读不到家目录和状态目录，填写的目录、工作目录和参数里写明的文件除外。\n· 只能写可读写的目录。\n· 每个服务器有自己的 npm 缓存，不读 ~/.npmrc；不提供 uv、pip 等其他工具的缓存。")}</label>`
      + (form.sandbox ? `<div class="acf-fields amc-gap-sm"><label class="acf-field">放行的域名<textarea class="amc-pairs" data-f="sbDomains" placeholder="registry.npmjs.org">${esc(form.sbDomains)}</textarea></label><label class="acf-field">可读的目录<textarea class="amc-pairs" data-f="sbRead" placeholder="/Users/me/reference">${esc(form.sbRead)}</textarea></label><label class="acf-field">可读写的目录<textarea class="amc-pairs" data-f="sbWrite" placeholder="/Users/me/agent-work">${esc(form.sbWrite)}</textarea></label></div>` : "");
  }

  function httpFieldsHtml() {
    return `<div class="acf-fields amc-gap"><label class="acf-field"><span class="acv-tip-row">网址${REQ}</span><input class="acv2-input amc-mono" data-f="url" value="${esc(form.url)}" placeholder="https://example.com/mcp"></label></div>`
      + `<label class="acf-field amc-gap"><span class="acv-tip-row">请求头${OPT}${tip(`每行一个 名称: 值。\n· 已保存的值显示为 ${KEEP}，不修改即沿用。`)}</span><textarea class="amc-pairs" data-f="headers" placeholder="X-Api-Key: …">${esc(form.headers)}</textarea></label>`
      + `<label class="acf-check amc-gap"><input type="checkbox" data-f="dpop" ${form.dpop ? "checked" : ""}>用 DPoP 出示令牌（RFC 9449）</label>`
      + `<div class="acf-fields amc-gap"><label class="acf-field"><span class="acv-tip-row">OAuth 授权服务器${OPT}${tip("用于无人值守的 client_credentials。\n· 密钥只发给这里填写的授权服务器。")}</span><input class="acv2-input amc-mono" data-f="issuer" value="${esc(form.issuer)}" placeholder="https://auth.example.com"></label><label class="acf-field">客户端 ID<input class="acv2-input amc-mono" data-f="clientId" value="${esc(form.clientId)}"></label><label class="acf-field">客户端密钥<input class="acv2-input amc-mono" type="password" data-f="clientSecret" value="${esc(form.clientSecret)}" placeholder="只进不出" autocomplete="off"></label><label class="acf-field">权限范围（可选）<input class="acv2-input amc-mono" data-f="scope" value="${esc(form.scope)}"></label></div>`;
  }

  // ---- import ----
  function importNote(entry) {
    if (!entry.ok) return entry.reason;
    return `${entry.transport === "http" ? "网址" : "本机程序"} · 默认不可信、未绑定${entry.fill.length ? `；需要填写：${entry.fill.join("、")}` : ""}${entry.enabled ? "" : "；导入后停用"}`;
  }

  function importLines(transport, label) {
    const listed = importing.entries.filter((entry) => entry.ok && entry.transport === transport);
    return listed.length ? `${label}：<code>${listed.map((entry) => esc(entry.line)).join("<br>")}</code>` : "";
  }

  /** The check result, the confirmation card and the action; redrawn alone so that the text keeps its focus. */
  function importOutHtml() {
    const entries = importing.entries;
    const importable = (entries ?? []).some((entry) => entry.ok);
    return (importing.error ? `<p class="amc-import-error">${esc(importing.error)}</p>` : "")
      + (entries ? `<ul class="amc-import-result">${entries.map((entry) => `<li>${entry.ok ? '<span class="acv2-badge acv2-completed">将导入</span>' : '<span class="acv2-badge">跳过</span>'} <span class="amc-mono">${esc(entry.name)}</span><small>${esc(importNote(entry))}</small></li>`).join("")}</ul>` : "")
      + (importable ? `<div class="acf-grant"><strong>确认登记</strong> ${importLines("stdio", "本机将运行")}${importLines("http", "将连接")}导入后默认不可信，还要在团队管理里绑定到能力档。</div>` : "")
      + `<div class="acf-row-actions">${importable ? '<button class="acv2-button acv2-primary" type="button" data-import-confirm>确认并导入</button>' : '<button class="acv2-button acv2-primary" type="button" data-import-check>检查</button>'}</div>`;
  }

  function importHtml() {
    return `<section class="acf-section"><div class="acv-tip-row"><h3>导入 JSON</h3>${tip('粘贴 Claude Desktop、Cursor 等使用的 {"mcpServers": {…}}，一次导入多个。\n· 导入的服务器默认不可信、不绑定任何能力档。\n· 已有同名的、SSE 传输的、名称不合法的跳过。')}</div>`
      + `<textarea class="amc-pairs amc-json" data-json placeholder='{"mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "…"}}}}'>${esc(importing.text)}</textarea>`
      + `<div id="amc-import-out">${importOutHtml()}</div></section>`;
  }

  function refreshImport() {
    const out = $("amc-import-out");
    if (out) out.innerHTML = importOutHtml();
  }

  async function checkDocument() {
    const { ok, body } = await api("/api/mcp/import/check", { text: importing.text });
    importing = ok ? { ...importing, entries: body.entries, error: "" } : { ...importing, entries: null, error: body.error ?? "请求失败" };
    refreshImport();
  }

  async function importDocument() {
    const confirmed = importing.entries.filter((entry) => entry.ok).map((entry) => ({ name: entry.name, line: entry.line }));
    const { ok, body } = await api("/api/mcp/import", { text: importing.text, confirmed });
    if (!ok) {
      importing = { ...importing, entries: null, error: body.error ?? "请求失败" };
      refreshImport();
      return;
    }
    await load();
    open(body.servers[0].name);
    note = { text: body.servers.length > 1 ? `已导入 ${body.servers.length} 个，正在连接。` : "已导入，正在连接。", state: "saved" };
    renderForm();
  }

  function renderServerSections() {
    const server = current();
    if (!server) return;
    const key = JSON.stringify([server, deleting]);
    if (key === drawerKey) return;
    drawerKey = key;
    const outputOpen = Boolean($("amc-status").querySelector("details")?.open);
    $("amc-kind").textContent = [KINDS[server.transport], STATES[server.state][0], server.counts.total ? `${server.counts.total} 个工具${server.counts.usable < server.counts.total ? `，可用 ${server.counts.usable} 个` : ""}` : ""].filter(Boolean).join(" · ");
    $("amc-title").textContent = server.name;
    $("amc-status").innerHTML = statusHtml(server);
    const output = $("amc-status").querySelector("details");
    if (output && outputOpen) output.open = true;
    $("amc-tools").innerHTML = toolsHtml(server);
    $("amc-used").innerHTML = usedHtml(server);
    $("amc-danger").innerHTML = dangerHtml(server);
  }

  function renderForm() {
    $("amc-form").innerHTML = mode === "import" ? importHtml() : formHtml();
  }

  function render() {
    renderRows();
    const drawer = $("amc-drawer");
    if (selected === null) { drawer.hidden = true; return; }
    drawer.hidden = false;
    if (mode === "new" || mode === "import") {
      $("amc-kind").textContent = mode === "new" ? "添加后即开始连接" : "粘贴 mcpServers 配置，一次导入多个";
      $("amc-title").textContent = mode === "new" ? "添加 MCP 服务器" : "导入 MCP 服务器";
      for (const id of ["amc-status", "amc-tools", "amc-used", "amc-danger"]) $(id).innerHTML = "";
    } else {
      renderServerSections();
    }
    renderForm();
  }

  function open(name, nextMode = "server") {
    selected = name;
    mode = nextMode;
    deleting = false;
    note = { text: "", state: "clean" };
    form = formFrom(nextMode === "server" ? servers.find((server) => server.name === name) : null);
    preview = null;
    importing = { text: "", entries: null, error: "" };
    drawerKey = "";
    render();
    if (nextMode === "new") void updatePreview();
  }

  function close() {
    selected = null;
    render();
  }

  // ---- confirmation card ----
  /** Asks the service for the exact line it will run; the card shows only what the service returned. */
  async function updatePreview() {
    let draft;
    try { draft = payload(); } catch (error) { setNote(error.message, "dirty"); return undefined; }
    if (!(draft.transport === "http" ? draft.url : draft.command).trim()) { preview = mode === "new" ? { launchLine: "（尚未填写）", needsConfirmation: true, empty: true } : null; refreshGrant(); return preview; }
    const { ok, body } = await api("/api/mcp/preview", { server: draft, ...(mode === "server" ? { existing: selected } : {}) });
    if (!ok) { setNote(body.error ?? "请求失败", "dirty"); return undefined; }
    preview = body;
    refreshGrant();
    return preview;
  }

  function refreshGrant() {
    const grant = $("amc-grant");
    if (grant) grant.innerHTML = grantHtml();
    const save = document.querySelector("[data-save]");
    if (save) save.textContent = mode === "new" ? "确认并添加" : preview?.needsConfirmation ? "确认并保存" : "保存";
  }

  function setNote(text, state) {
    note = { text, state };
    const bar = document.querySelector(".acf-savebar");
    if (bar) bar.dataset.state = state;
    const span = $("amc-note");
    if (span) span.textContent = text || (mode === "new" ? "添加后即开始连接。" : "保存后重新连接；只改可信或停用工具时不重新连接。");
  }

  async function save() {
    const shown = preview?.needsConfirmation && !preview.empty ? preview.launchLine : undefined;
    const fresh = await updatePreview();
    if (!fresh) return;
    if (fresh.needsConfirmation && fresh.launchLine !== shown) {
      setNote("将要运行的命令已更新，请核对确认卡片后再保存。", "dirty");
      return;
    }
    const draft = payload();
    const { ok, body } = mode === "new"
      ? await api("/api/mcp/servers", { server: draft, confirmed: shown })
      : await api(`/api/mcp/servers/${encodeURIComponent(selected)}`, { server: draft, ...(shown ? { confirmed: shown } : {}) });
    if (!ok) { setNote(body.error ?? "请求失败", "dirty"); return; }
    await load();
    const added = mode === "new";
    open(body.server.name);
    note = { text: added ? "已添加，正在连接。" : "已保存：新事务使用新配置。", state: "saved" };
    renderForm();
  }

  // ---- data ----
  async function load() {
    const { ok, body } = await api("/api/mcp/servers");
    if (!ok) return;
    servers = body.servers;
    renderRows();
    if (selected !== null && mode === "server") {
      if (!current()) close();
      else renderServerSections();
    }
  }

  async function act(path, payloadValue = {}) {
    const { ok, body } = await api(path, payloadValue);
    if (!ok) { setNote(body.error ?? "请求失败", "dirty"); return; }
    await load();
  }

  // ---- events ----
  document.addEventListener("click", (event) => {
    const target = event.target;
    const openButton = target.closest("[data-open]");
    if (openButton) { open(openButton.dataset.open); return; }
    if (target.closest("#amc-new")) { open("", "new"); return; }
    if (target.closest("#amc-import")) { open("", "import"); return; }
    if (target.closest("[data-import-check]")) { void checkDocument(); return; }
    if (target.closest("[data-import-confirm]")) { void importDocument(); return; }
    if (target.closest("#amc-close")) { close(); return; }
    const approve = target.closest("[data-approve]");
    if (approve) { event.preventDefault(); void act(`/api/mcp/servers/${encodeURIComponent(selected)}/approve`, approve.dataset.approve === "*" ? {} : { tools: [approve.dataset.approve] }); return; }
    if (target.closest("[data-reconnect]")) { void act(`/api/mcp/servers/${encodeURIComponent(selected)}/reconnect`); return; }
    if (target.closest("[data-save]")) { void save(); return; }
    if (target.closest("[data-delete]")) { deleting = true; renderServerSections(); return; }
    if (target.closest("[data-delete-cancel]")) { deleting = false; renderServerSections(); return; }
    if (target.closest("[data-delete-confirm]")) {
      void api(`/api/mcp/servers/${encodeURIComponent(selected)}/delete`, {}).then(({ ok, body }) => {
        // A refusal leaves the server as it is; the drawer then shows what the service reports of it now.
        if (!ok) { deleting = false; setNote(body.error ?? "请求失败", "dirty"); void load(); return; }
        close();
        void load();
      });
      return;
    }
    if (!$("amc-drawer").hidden && !target.closest("#amc-drawer,button,input,select,textarea,label,a,.acv-tip-pop")) close();
  });

  document.addEventListener("change", (event) => {
    const tool = event.target.dataset.tool;
    if (tool) { void act(`/api/mcp/servers/${encodeURIComponent(selected)}/tools`, { tool, enabled: event.target.checked }); return; }
    const kind = event.target.dataset.kind;
    if (kind) { form.transport = kind; preview = null; setNote("", "clean"); renderForm(); void updatePreview(); return; }
    const field = event.target.dataset.f;
    if (field && event.target.type === "checkbox") { form[field] = event.target.checked; setNote("", "clean"); renderForm(); }
  });

  document.addEventListener("input", (event) => {
    if (event.target.matches("[data-json]")) { importing = { text: event.target.value, entries: null, error: "" }; refreshImport(); return; }
    const field = event.target.dataset.f;
    if (!field || event.target.type === "checkbox") return;
    form[field] = event.target.value;
    if (note.state !== "clean") setNote("", "clean");
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void updatePreview(), 150);
  });

  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && selected !== null) close(); });

  void load();
  // Connection states, retries and tool reviews change in the service; the page follows them.
  setInterval(() => { if (!document.hidden) void load(); }, 2000);
})();
