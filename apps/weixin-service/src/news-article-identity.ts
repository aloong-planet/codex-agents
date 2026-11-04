import crypto from "node:crypto";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "igshid",
  "vero_conv",
  "vero_id",
]);

export function canonicalizeArticleUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("新闻文章 URL 无效");
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  const kept = [...url.searchParams.entries()]
    .filter(([name]) => {
      const lower = name.toLowerCase();
      return !lower.startsWith("utm_") && !TRACKING_PARAMETERS.has(lower);
    })
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName.localeCompare(rightName) || leftValue.localeCompare(rightValue));
  url.search = "";
  for (const [name, value] of kept) url.searchParams.append(name, value);
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}${url.search}`;
}

export function articleKey(input: string): string {
  return crypto.createHash("sha256").update(canonicalizeArticleUrl(input)).digest("hex");
}
