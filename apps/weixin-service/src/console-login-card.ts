/**
 * The only page an unauthorized browser sees (agent-console::US-001/AC-04). It is self-contained: no script,
 * no external style, and it shows no service data. Copy and styling follow the confirmed console prototype's
 * login gate; step 1 also names the actual login command.
 */
export type LoginCardNotice = "expired" | "revoked";

const NOTICES: Record<LoginCardNotice, string> = {
  expired: "这条登录链接已失效：超过 2 分钟或已经用过。请重新运行登录命令。",
  revoked: "本浏览器的授权已收回，打开的页面已断开。",
};

export const LOGIN_COMMAND = "pnpm --filter @aloong-planet/codex-weixin-service console login";

export const LOGIN_CARD_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

const STYLE = `
:root{--console-bg:#fbfbf9;--console-ink:#1a201d;--console-line:#e2e5df;--console-muted:#5f6963;--console-paper:#fff;--console-warning:#94580a;--console-warning-soft:#fcf1dc;--console-shadow:0 1px 2px rgba(20,30,25,.05),0 10px 28px rgba(20,30,25,.08);--console-sans:system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;--console-mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--console-bg)}
.console-gate{min-height:100vh;display:grid;place-items:center;padding:16px;color:var(--console-ink);font:13px/1.6 var(--console-sans)}
.console-gate-card{width:min(460px,100%);padding:22px 24px;border:1px solid var(--console-line);border-radius:14px;background:var(--console-paper);box-shadow:var(--console-shadow)}
.console-gate-card h1{margin:0 0 8px;font-size:19px;font-weight:680}
.console-gate-card p{margin:0 0 10px;color:var(--console-muted)}
.console-gate-card .console-gate-notice{padding:8px 10px;border-radius:9px;background:var(--console-warning-soft);color:var(--console-warning)}
.console-gate-card ol{margin:6px 0 0;padding-left:20px;line-height:1.8}
.console-gate-card code{font-family:var(--console-mono);font-size:12px;overflow-wrap:anywhere}
`;

export function renderLoginCard(notice?: LoginCardNotice): string {
  const noticeHtml = notice ? `<p class="console-gate-notice" role="alert">${NOTICES[notice]}</p>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>需要本机授权</title>
<style>${STYLE}</style>
</head>
<body>
<main class="console-gate">
<section class="console-gate-card" aria-labelledby="console-gate-title">
<h1 id="console-gate-title">需要本机授权</h1>
<p>工作台只对这台电脑上授权过的浏览器开放，未授权时不显示任何内容。</p>
${noticeHtml}
<ol>
<li>在这台电脑的终端运行工作台登录命令：<code>${LOGIN_COMMAND}</code></li>
<li>命令打印一条一次性登录链接，并用默认浏览器打开；也可以只打印，再复制到要授权的浏览器。</li>
<li>链接 2 分钟内有效，只能使用一次。打开后本浏览器即获授权，重启服务也无需重新登录。</li>
</ol>
</section>
</main>
</body>
</html>
`;
}
