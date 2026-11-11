// How a private reply from the Coordinator or a Team Leader renders (agent-console::REQ-005/AC-01 to AC-03), as the page's own
// script decides it: src/public/console/chat-markdown.js, a classic script that publishes itself on globalThis and is imported
// here for that effect. Expected markup follows the spec and the owner-confirmed prototype. That the page puts this markup in
// the reply's bubble, that a link opens a new tab and that a long table scrolls inside the bubble on a phone is covered by
// e2e/agent-console.spec.ts.
import { describe, expect, it } from "vitest";
import "../src/public/console/chat-markdown.js";

const { render } = (globalThis as unknown as { ConsoleMarkdown: { render(text: string): string } }).ConsoleMarkdown;

describe("a private reply's Markdown", () => {
  it("renders headings, lists, emphasis, inline code, code blocks and paragraphs", () => {
    expect(render("# 计划\n## 步骤\n### 备注")).toBe("<h4>计划</h4><h5>步骤</h5><h6>备注</h6>");
    expect(render("- 写文案\n- 拍主图\n\n1. 上架\n2. 复盘")).toBe("<ul><li>写文案</li><li>拍主图</li></ul><ol><li>上架</li><li>复盘</li></ol>");
    expect(render("**已完成** 一半，*剩下* 用 `npm test` 核对\n第二行")).toBe("<p><strong>已完成</strong> 一半，<em>剩下</em> 用 <code>npm test</code> 核对<br>第二行</p>");
    // Nothing inside a code block or a code span is formatted.
    expect(render("```\n**原样** [链接](https://example.com)\n```")).toBe("<pre><code>**原样** [链接](https://example.com)</code></pre>");
    expect(render("`**原样**`")).toBe("<p><code>**原样**</code></p>");
  });

  it("puts a table in its own scroll region", () => {
    expect(render("| 商品 | 价格 |\n| --- | ---: |\n| D | 99 |\n| E | **120** |")).toBe(
      '<div class="ats-md-table" tabindex="0" role="region" aria-label="表格，可滚动"><table><thead><tr><th>商品</th><th>价格</th></tr></thead>'
      + "<tbody><tr><td>D</td><td>99</td></tr><tr><td>E</td><td><strong>120</strong></td></tr></tbody></table></div>");
  });

  it.each([["https://example.com/a?b=1&c=2", "https://example.com/a?b=1&amp;c=2"], ["HTTP://EXAMPLE.COM", "HTTP://EXAMPLE.COM"]])(
    "makes the http(s) link %s clickable in a new tab without access to the page", (url, href) => {
      expect(render(`看[官网](${url})`)).toBe(`<p>看<a href="${href}" target="_blank" rel="noopener noreferrer">官网</a></p>`);
    });

  it.each([["javascript:alert(1)", "点我（javascript:alert(1）)"], ["file:///etc/passwd", "点我（file:///etc/passwd）"], ["/console/teams", "点我（/console/teams）"],
    ["mailto:owner@example.com", "点我（mailto:owner@example.com）"]])("shows the %s link as text", (url, text) => {
    const html = render(`[点我](${url})`);
    expect(html).toBe(`<p>${text}</p>`);
    expect(html).not.toContain("<a");
  });

  it("shows an image's alternative text and never loads it", () => {
    expect(render("![商品主图](https://example.com/d.png) ![](https://example.com/e.png)")).toBe(
      '<p><span class="ats-md-img">［图片：商品主图］</span> <span class="ats-md-img">［图片：无说明］</span></p>');
  });

  it("shows raw HTML as text, so a reply adds no element or attribute", () => {
    const html = render('<img src=x onerror="alert(1)"><script>alert(2)</script>\n[x](https://a.example/"onmouseover="alert(3))');
    expect(html).toBe("<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;<br>"
      + '<a href="https://a.example/&quot;onmouseover=&quot;alert(3" target="_blank" rel="noopener noreferrer">x</a>)</p>');
    expect(html).not.toMatch(/<(img|script)/u);
  });
});
