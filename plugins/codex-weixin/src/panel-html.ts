export const WEIXIN_PANEL_URI = "ui://codex-weixin/panel.html";

export const weixinPanelHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>微信直连助手</title>
  <style>
    :root { color-scheme: light dark; font-family: var(--font-sans, ui-sans-serif, system-ui); }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; color: var(--color-text-primary, #17372b); background: var(--color-background-primary, #fff); }
    main { max-width: 620px; margin: 0 auto; border: 1px solid var(--color-border-secondary, #cfe0d6); border-radius: 18px; padding: 18px; }
    h1 { margin: 0 0 4px; font-size: 21px; }
    .subtle { color: var(--color-text-secondary, #62776e); font-size: 13px; }
    .status { margin: 16px 0; padding: 12px; border-radius: 12px; background: var(--color-background-secondary, #f3f8f5); }
    .status strong { display: block; margin-bottom: 3px; }
    .grid { display: grid; gap: 12px; }
    .qr { display: none; text-align: center; padding: 8px; }
    .qr img { width: min(280px, 82vw); height: auto; background: #fff; padding: 10px; border-radius: 12px; }
    label { display: grid; gap: 6px; font-weight: 600; font-size: 14px; }
    label.inline { display: flex; align-items: flex-start; gap: 8px; font-weight: 500; }
    input, select, textarea, button { font: inherit; }
    input, select, textarea { width: 100%; border: 1px solid var(--color-border-primary, #aac5b5); border-radius: 10px; padding: 10px; background: var(--color-background-primary, #fff); color: inherit; }
    textarea { min-height: 76px; resize: vertical; }
    button { border: 0; border-radius: 10px; padding: 10px 14px; background: #10a45a; color: #fff; font-weight: 700; cursor: pointer; }
    button.secondary { background: var(--color-background-tertiary, #e9f1ec); color: var(--color-text-primary, #17372b); }
    button:disabled { opacity: .48; cursor: not-allowed; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .pair, .session, .send, .relay { display: none; padding-top: 12px; border-top: 1px solid var(--color-border-secondary, #dce8e0); }
    .permissions { padding-top: 12px; border-top: 1px solid var(--color-border-secondary, #dce8e0); }
    .mode-grid { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .mode { display: flex; gap: 7px; padding: 9px; border: 1px solid var(--color-border-primary, #aac5b5); border-radius: 10px; font-size: 12px; }
    .mode input, .root input { width: auto; margin-top: 2px; }
    .mode span, .mode small { display: block; }
    .mode small { margin-top: 3px; color: var(--color-text-secondary, #62776e); font-weight: 400; }
    .roots { display: grid; gap: 7px; }
    .root { display: flex; gap: 7px; font-weight: 500; }
    .root small { display: block; color: var(--color-text-secondary, #62776e); overflow-wrap: anywhere; }
    .feedback { min-height: 20px; margin-top: 10px; font-size: 13px; color: var(--color-text-success, #087f47); }
    .feedback.error { color: var(--color-text-danger, #bb2828); }
    details { margin-top: 12px; font-size: 13px; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <main>
    <h1>微信直连助手</h1>
    <div class="subtle">腾讯 iLink 真实通道 · 凭据与二维码不会进入模型上下文</div>
    <section class="status" aria-live="polite">
      <strong id="phase">正在连接本地服务</strong>
      <span id="notice">等待 Codex 宿主初始化面板……</span>
    </section>
    <div class="grid">
      <div class="actions">
        <button id="login">生成真实二维码</button>
        <button id="refresh" class="secondary">刷新状态</button>
      </div>
      <div id="qr" class="qr"><img id="qrImage" alt="微信登录二维码"><p class="subtle">请在手机微信中扫码，并按手机端提示确认。</p></div>
      <section id="pair" class="pair grid">
        <label>手机端显示的配对码<input id="pairCode" inputmode="numeric" autocomplete="one-time-code"></label>
        <button id="submitPair">提交配对码</button>
      </section>
      <section id="session" class="session grid">
        <label>直连账户<select id="account"></select></label>
        <label>最近入站目标<select id="target"></select></label>
        <label class="inline"><input id="inboundConfirmed" type="checkbox">我确认刚刚已从这个微信目标给 bot 发过消息</label>
        <div class="actions">
          <button id="confirm">确认会话与目标</button>
          <button id="discover" class="secondary">同步入站目标</button>
        </div>
      </section>
      <section id="send" class="send grid">
        <label>测试消息<textarea id="message">Codex Plugin 微信直连测试成功。</textarea></label>
        <label class="inline"><input id="sendConfirmed" type="checkbox">我确认将向上方选择的微信目标发送这条真实消息</label>
        <button id="sendButton" disabled>发送测试消息</button>
      </section>
      <section id="relay" class="relay grid">
        <strong>微信 → Codex 原生执行</strong>
        <div id="relayStatus" class="subtle">正在读取转发状态……</div>
        <div class="actions">
          <button id="relayEnable">启用当前目标</button>
          <button id="relayDisable" class="secondary">停用当前目标</button>
          <button id="openDesktop" class="secondary">在 Codex Desktop 中查看（实验）</button>
        </div>
        <p class="subtle">每个目标使用独立 Codex task。Desktop 查看仅请求打开原生任务，不会移交或接管；原生页面仍可能提示任务正在其他位置运行。</p>
      </section>
      <section id="permissions" class="permissions grid">
        <strong>Codex 本地权限</strong>
        <form id="permissionForm" class="grid">
          <div class="mode-grid">
            <label class="mode"><input type="radio" name="permissionMode" value="safe"><span><strong>安全只读</strong><small>仅读取所选目录</small></span></label>
            <label class="mode"><input type="radio" name="permissionMode" value="guarded_plus"><span><strong>增强受控</strong><small>修改前在本地确认</small></span></label>
            <label class="mode"><input type="radio" name="permissionMode" value="advanced_controlled"><span><strong>高级受控</strong><small>安全修改自动执行</small></span></label>
          </div>
          <div id="permissionRoots" class="roots"></div>
          <label class="inline"><input id="permissionConfirmed" type="checkbox">我确认网络仅用于只读检索，删除与高风险操作始终被阻止</label>
          <div id="permissionCapability" class="subtle">正在检查严格目录隔离能力……</div>
          <button id="permissionSubmit" type="submit" disabled>应用权限设置</button>
        </form>
      </section>
    </div>
    <div id="feedback" class="feedback" aria-live="polite"></div>
    <details><summary>高级信息与原始 ID</summary><div id="rawIds" class="subtle">尚未发现账户或目标。</div></details>
  </main>
  <script>
    (() => {
      const pending = new Map();
      let nextId = 1;
      let currentState = null;
      let permissionCandidates = [];
      let permissionRevision = -1;
      let permissionDirty = false;
      // The account and target the user chose and has not confirmed yet. State updates, such as the silent
      // poll, render it instead of the confirmed session, so 「确认会话与目标」 confirms what the user sees.
      let pendingSelection = null;
      const el = (id) => document.getElementById(id);
      const request = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      });
      const notify = (method, params = {}) => window.parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
      const resultText = (result) => Array.isArray(result?.content)
        ? result.content.filter((item) => item.type === "text").map((item) => item.text).join(" ")
        : "";
      const setFeedback = (text, isError = false) => {
        el("feedback").textContent = text;
        el("feedback").classList.toggle("error", isError);
      };
      const callTool = async (name, args = {}, options = {}) => {
        const silent = options.silent === true;
        if (!silent) setFeedback("处理中……");
        try {
          const result = await request("tools/call", { name, arguments: args });
          if (result.isError) throw new Error(resultText(result) || "操作失败");
          applyResult(result);
          if (!silent) setFeedback(resultText(result) || "操作已完成");
          return result;
        } catch (error) {
          setFeedback(error instanceof Error ? error.message : "操作失败", true);
          throw error;
        }
      };
      const labelFor = (item, fallbackKey) => item.label || item[fallbackKey] || "未命名";
      const renderOptions = (select, items, valueKey, selected) => {
        const existing = select.value;
        select.replaceChildren(...items.map((item) => {
          const option = document.createElement("option");
          option.value = item[valueKey];
          option.textContent = labelFor(item, valueKey);
          return option;
        }));
        const preferred = selected || existing;
        if (preferred && items.some((item) => item[valueKey] === preferred)) select.value = preferred;
      };
      const syncPermissionSubmit = () => {
        const permissions = currentState?.codex?.permissions;
        const mode = document.querySelector('input[name="permissionMode"]:checked');
        const roots = document.querySelectorAll('input[name="permissionRoot"]:checked');
        el("permissionSubmit").disabled = !permissions?.restrictedReadSupported || !mode || roots.length === 0 || !el("permissionConfirmed").checked;
      };
      const renderPermissions = (permissions) => {
        el("permissionCapability").textContent = permissions?.restrictedReadSupported
          ? "当前 Codex 支持严格目录隔离，可以应用设置。"
          : "当前 Codex 版本不支持严格目录隔离；三档权限暂不能启用。";
        if (!permissions) return;
        if (!permissionDirty || permissionRevision !== permissions.revision) {
          const selected = new Set((permissions.selectedRoots || []).map((root) => root.id));
          document.querySelectorAll('input[name="permissionMode"]').forEach((input) => {
            input.checked = permissions.onboardingCompleted && input.value === permissions.mode;
            input.disabled = !permissions.restrictedReadSupported;
          });
          el("permissionRoots").replaceChildren(...permissionCandidates.map((candidate) => {
            const label = document.createElement("label");
            label.className = "root";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.name = "permissionRoot";
            input.value = candidate.id;
            input.checked = selected.has(candidate.id);
            input.disabled = !permissions.restrictedReadSupported;
            input.addEventListener("change", () => { permissionDirty = true; syncPermissionSubmit(); });
            const text = document.createElement("span");
            const name = document.createElement("strong");
            name.textContent = candidate.displayName;
            const path = document.createElement("small");
            path.textContent = candidate.path;
            text.append(name, path);
            label.append(input, text);
            return label;
          }));
          el("permissionConfirmed").checked = false;
          permissionRevision = permissions.revision;
          permissionDirty = false;
        }
        syncPermissionSubmit();
      };
      const applyResult = (result) => {
        if (!result?.structuredContent) return;
        currentState = result.structuredContent;
        if (Array.isArray(result._meta?.permissionCandidates)) permissionCandidates = result._meta.permissionCandidates;
        const state = currentState;
        el("phase").textContent = state.phase || "未知状态";
        el("notice").textContent = state.notice || "";
        const qr = result._meta?.qrDataUrl;
        if (typeof qr === "string" && qr.startsWith("data:image/png;base64,")) {
          el("qrImage").src = qr;
          el("qr").style.display = "block";
        } else if (state.phase === "login_starting" || !["awaiting_scan", "scanned", "pair_code_required"].includes(state.phase)) {
          el("qrImage").removeAttribute("src");
          el("qr").style.display = "none";
        }
        el("pair").style.display = state.phase === "pair_code_required" ? "grid" : "none";
        const accounts = Array.isArray(state.accounts) ? state.accounts : [];
        const targets = Array.isArray(state.targets) ? state.targets : [];
        const renderSelection = (selection) => {
          renderOptions(el("account"), accounts, "accountId", selection.accountId);
          const shownAccountId = el("account").value;
          renderOptions(el("target"), targets.filter((item) => !shownAccountId || item.accountId === shownAccountId), "target", selection.target);
        };
        // Once the confirmed session is the user's choice, as after a confirm of it, the panel follows the service again.
        if (pendingSelection?.accountId === state.selectedAccountId && pendingSelection?.target === state.selectedTarget) pendingSelection = null;
        const accountBefore = el("account").value;
        const targetBefore = el("target").value;
        renderSelection(pendingSelection || { accountId: state.selectedAccountId, target: state.selectedTarget });
        if (pendingSelection?.target === "" && el("account").value === pendingSelection.accountId) {
          // The chosen account had no target yet: take the one it offers now, as choosing the account would.
          pendingSelection = { ...pendingSelection, target: el("target").value };
        }
        if (pendingSelection && (el("account").value !== pendingSelection.accountId || el("target").value !== pendingSelection.target)) {
          // The chosen option is gone: drop the choice and show the session the update gives.
          pendingSelection = null;
          renderSelection({ accountId: state.selectedAccountId, target: state.selectedTarget });
        }
        // A confirmation ticked for one target never carries over to a target the panel switched to by itself.
        if (el("account").value !== accountBefore || el("target").value !== targetBefore) invalidateSelection();
        const accountId = el("account").value;
        el("session").style.display = accounts.length ? "grid" : "none";
        const sendReady = ["ready", "sent", "send_error"].includes(state.phase)
          && el("account").value === state.selectedAccountId
          && el("target").value === state.selectedTarget;
        el("send").style.display = sendReady ? "grid" : "none";
        el("sendButton").disabled = !sendReady || !el("sendConfirmed").checked;
        const codex = state.codex;
        const selected = { accountId: el("account").value, target: el("target").value };
        const relayEnabled = Boolean(codex?.enabledTargets?.some((item) =>
          item.accountId === selected.accountId && item.target === selected.target));
        el("relay").style.display = selected.accountId && selected.target ? "grid" : "none";
        el("relayStatus").textContent = codex
          ? (relayEnabled ? "当前目标已启用 · " : "当前目标未启用 · ") + codex.notice
          : "Codex 转发服务不可用";
        el("relayEnable").disabled = !codex || relayEnabled;
        el("relayDisable").disabled = !codex || !relayEnabled;
        el("openDesktop").disabled = !codex || !relayEnabled;
        renderPermissions(codex?.permissions);
        const accountRaw = accountId ? "账户：" + accountId : "";
        const targetRaw = el("target").value ? "目标：" + el("target").value : "";
        el("rawIds").textContent = [accountRaw, targetRaw].filter(Boolean).join(" · ") || "尚未发现账户或目标。";
      };
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent || event.data?.jsonrpc !== "2.0") return;
        const message = event.data;
        if (message.id !== undefined && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message || "宿主调用失败"));
          else entry.resolve(message.result);
          return;
        }
        if (message.method === "ui/notifications/tool-result") applyResult(message.params);
      });
      el("login").addEventListener("click", () => void callTool("start_weixin_login"));
      el("refresh").addEventListener("click", () => void callTool("get_weixin_state"));
      el("submitPair").addEventListener("click", () => void callTool("submit_weixin_pair_code", { code: el("pairCode").value }));
      el("discover").addEventListener("click", () => void callTool("discover_weixin_targets"));
      const invalidateSelection = () => {
        el("inboundConfirmed").checked = false;
        el("sendConfirmed").checked = false;
        el("sendButton").disabled = true;
        el("send").style.display = "none";
        const accountRaw = el("account").value ? "账户：" + el("account").value : "";
        const targetRaw = el("target").value ? "目标：" + el("target").value : "";
        el("rawIds").textContent = [accountRaw, targetRaw].filter(Boolean).join(" · ") || "尚未发现账户或目标。";
      };
      const keepChoice = () => {
        pendingSelection = { accountId: el("account").value, target: el("target").value };
      };
      el("account").addEventListener("change", () => {
        const targets = Array.isArray(currentState?.targets) ? currentState.targets : [];
        renderOptions(el("target"), targets.filter((item) => item.accountId === el("account").value), "target", null);
        keepChoice();
        invalidateSelection();
      });
      el("target").addEventListener("change", () => {
        keepChoice();
        invalidateSelection();
      });
      el("sendConfirmed").addEventListener("change", () => {
        el("sendButton").disabled = !el("sendConfirmed").checked;
      });
      el("confirm").addEventListener("click", () => void callTool("confirm_weixin_session", {
        accountId: el("account").value,
        target: el("target").value,
        inboundConfirmed: el("inboundConfirmed").checked,
      }));
      el("sendButton").addEventListener("click", () => void callTool("send_weixin_test_message", {
        message: el("message").value,
        outboundConfirmed: el("sendConfirmed").checked,
      }));
      el("relayEnable").addEventListener("click", () => void callTool("enable_weixin_codex_relay", {
        accountId: el("account").value, target: el("target").value,
      }));
      el("relayDisable").addEventListener("click", () => void callTool("disable_weixin_codex_relay", {
        accountId: el("account").value, target: el("target").value,
      }));
      el("openDesktop").addEventListener("click", () => void callTool("open_weixin_codex_desktop_thread", {
        accountId: el("account").value, target: el("target").value,
      }));
      document.querySelectorAll('input[name="permissionMode"]').forEach((input) => input.addEventListener("change", () => {
        permissionDirty = true;
        syncPermissionSubmit();
      }));
      el("permissionConfirmed").addEventListener("change", () => {
        permissionDirty = true;
        syncPermissionSubmit();
      });
      el("permissionForm").addEventListener("submit", (event) => {
        event.preventDefault();
        const mode = document.querySelector('input[name="permissionMode"]:checked')?.value;
        const rootIds = [...document.querySelectorAll('input[name="permissionRoot"]:checked')].map((input) => input.value);
        void callTool("configure_weixin_codex_permissions", {
          mode, rootIds, confirmed: el("permissionConfirmed").checked,
        }).then(() => { permissionDirty = false; });
      });
      const connect = async () => {
        await request("ui/initialize", {
          appInfo: { name: "微信直连助手", version: "0.1.0" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        });
        notify("ui/notifications/initialized");
        await callTool("get_weixin_state");
        window.setInterval(() => void callTool("get_weixin_state", {}, { silent: true }).catch(() => {}), 2000);
      };
      void connect().catch((error) => setFeedback(error instanceof Error ? error.message : "无法连接 Codex 宿主", true));
    })();
  </script>
</body>
</html>`;
