export const MAX_WEIXIN_TEXT_CODE_POINTS = 1_500;
export const MAX_WEIXIN_SEGMENTS = 8;
export const MAX_WEIXIN_LOGICAL_CODE_POINTS =
  MAX_WEIXIN_TEXT_CODE_POINTS * MAX_WEIXIN_SEGMENTS;

const MULTI_SEGMENT_PREFIX_LENGTH = Array.from(`[${MAX_WEIXIN_SEGMENTS}/${MAX_WEIXIN_SEGMENTS}]\n`).length;
const MULTI_SEGMENT_CONTENT_LIMIT = MAX_WEIXIN_TEXT_CODE_POINTS - MULTI_SEGMENT_PREFIX_LENGTH;
const TRUNCATION_SUFFIX = "\n\n（内容过长，已截断）";

export type WeixinTextPlan = {
  segments: string[];
  truncated: boolean;
  originalLength: number;
};

function lastBoundary(points: string[], capacity: number): number {
  const minimum = Math.floor(capacity / 2);
  const upper = Math.min(points.length, capacity);

  for (let index = upper - 1; index >= minimum; index -= 1) {
    if (points[index] === "\n" && points[index - 1] === "\n") return index - 1;
  }
  for (let index = upper - 1; index >= minimum; index -= 1) {
    if (points[index] === "\n") return index;
  }
  for (let index = upper - 1; index >= minimum; index -= 1) {
    if (/[.!?。！？；;]/u.test(points[index] ?? "")) return index + 1;
  }
  for (let index = upper - 1; index >= minimum; index -= 1) {
    if (/\s/u.test(points[index] ?? "")) return index;
  }
  return upper;
}

function splitContent(points: string[]): string[] {
  const chunks: string[] = [];
  let remaining = points;

  while (remaining.length > MULTI_SEGMENT_CONTENT_LIMIT) {
    const boundary = lastBoundary(remaining, MULTI_SEGMENT_CONTENT_LIMIT);
    const chunk = remaining.slice(0, boundary).join("").trimEnd();
    if (!chunk) throw new Error("微信正文分段失败");
    chunks.push(chunk);
    remaining = remaining.slice(boundary);
    while (remaining[0] !== undefined && /\s/u.test(remaining[0])) remaining = remaining.slice(1);
  }

  const tail = remaining.join("").trimEnd();
  if (tail) chunks.push(tail);
  return chunks;
}

export function segmentWeixinText(text: string): WeixinTextPlan {
  const normalized = text.trim();
  if (!normalized) throw new Error("微信正文不能为空");

  const points = Array.from(normalized);
  const originalLength = points.length;
  if (originalLength <= MAX_WEIXIN_TEXT_CODE_POINTS) {
    return { segments: [normalized], truncated: false, originalLength };
  }

  const rawSegments = splitContent(points);
  const truncated = rawSegments.length > MAX_WEIXIN_SEGMENTS;
  const contents = rawSegments.slice(0, MAX_WEIXIN_SEGMENTS);

  if (truncated) {
    const suffixLength = Array.from(TRUNCATION_SUFFIX).length;
    const final = Array.from(contents[MAX_WEIXIN_SEGMENTS - 1] ?? "")
      .slice(0, MULTI_SEGMENT_CONTENT_LIMIT - suffixLength)
      .join("")
      .trimEnd();
    contents[MAX_WEIXIN_SEGMENTS - 1] = `${final}${TRUNCATION_SUFFIX}`;
  }

  const total = contents.length;
  const segments = contents.map((content, index) => `[${index + 1}/${total}]\n${content}`);
  if (segments.some((segment) => Array.from(segment).length > MAX_WEIXIN_TEXT_CODE_POINTS)) {
    throw new Error("微信正文分段超过 1500 字符");
  }

  return { segments, truncated, originalLength };
}
