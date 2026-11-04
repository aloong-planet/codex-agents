// Leaves room for ten article titles, sources and section headings in one message.
export const NEWS_BRIEF_MAX_CODE_POINTS = 80;

export class InvalidNewsBriefError extends Error {
  constructor() {
    super("Codex 新闻短摘要必须在字数限制内完整成句，不能使用省略号");
  }
}

export function parseNewsBrief(value: unknown): string {
  if (typeof value !== "string") throw new InvalidNewsBriefError();
  const text = value.trim();
  if (!/[\p{L}\p{N}]/u.test(text) || Array.from(text).length > NEWS_BRIEF_MAX_CODE_POINTS ||
    /…|\.{3,}|⋯/u.test(text) || /[\r\n]/u.test(text) ||
    !/[。！？.!?][”’」』"'）)]*$/u.test(text)
  ) throw new InvalidNewsBriefError();
  return text;
}
