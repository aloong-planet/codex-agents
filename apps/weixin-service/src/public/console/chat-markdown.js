// Markdown for the Coordinator's and the Team Leaders' replies in a private conversation (agent-console::REQ-005/AC-01 to AC-03),
// as the owner-confirmed prototype renders it: headings, lists, emphasis, inline code, code blocks and tables. The whole text is
// escaped first, so raw HTML stays text and nothing the reply holds can add an element or an attribute. Only `http` and `https`
// links become links, opening in a new tab without access to this page; any other target stays text with its address in
// brackets. An image is never loaded: it shows its alternative text. A table sits in its own scroll region, so a wide or long one
// scrolls inside the message (REQ-005/AC-05). Everything else in the console stays plain text (REQ-005/AC-04).
// The page loads this file as a classic script and the unit tests import it as a module, so it publishes itself on globalThis.
(() => {
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** One line's inline formatting, on text already escaped. Code spans are set aside first, so nothing inside them is formatted. */
  function inline(text) {
    const codes = [];
    const marked = text.replace(/`([^`]+)`/g, (match, code) => { codes.push(code); return `\u0000${codes.length - 1}\u0000`; })
      .replace(/!\[([^\]]*)\]\(([^)\s]*)\)/g, (match, alt) => `<span class="ats-md-img">［图片：${alt || "无说明"}］</span>`)
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => /^https?:\/\//i.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : `${label}（${url}）`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
    return marked.replace(/\u0000(\d+)\u0000/g, (match, index) => `<code>${codes[Number(index)]}</code>`);
  }

  /** The reply as HTML for the message bubble: block by block, a line starting a new block ending a paragraph. */
  function render(text) {
    const lines = esc(text).split("\n"), row = /^\|.*\|\s*$/;
    const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
    let out = "", i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const code = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        i += 1;
        out += `<pre><code>${code.join("\n")}</code></pre>`;
        continue;
      }
      // Headings sit inside a message, so # to ### become h4 to h6.
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) { const level = heading[1].length + 3; out += `<h${level}>${inline(heading[2])}</h${level}>`; i += 1; continue; }
      if (row.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
        const head = cells(line), body = [];
        i += 2;
        while (i < lines.length && row.test(lines[i])) body.push(cells(lines[i++]));
        out += `<div class="ats-md-table" tabindex="0" role="region" aria-label="表格，可滚动"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead>`
          + `<tbody>${body.map((cellsOfRow) => `<tr>${cellsOfRow.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
        continue;
      }
      const list = /^\s*[-*]\s+/.test(line) ? "ul" : /^\s*\d+\.\s+/.test(line) ? "ol" : "";
      if (list) {
        const items = [], marker = list === "ul" ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
        while (i < lines.length && marker.test(lines[i])) items.push(lines[i++].replace(marker, ""));
        out += `<${list}>${items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list}>`;
        continue;
      }
      if (!line.trim()) { i += 1; continue; }
      const paragraph = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i])) paragraph.push(lines[i++]);
      out += `<p>${paragraph.map(inline).join("<br>")}</p>`;
    }
    return out;
  }

  globalThis.ConsoleMarkdown = { render };
})();
