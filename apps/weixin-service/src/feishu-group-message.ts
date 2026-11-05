type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;

/** Addressing comes only from platform identity metadata; discussion text grants no authority. */
export function feishuGroupMessage(type: string, content: string, mentions: unknown, botOpenId: string): {
  addressed: boolean; content: string; observation: string;
} {
  if (content.length > 64 * 1024) throw new Error("feishu_message_invalid");
  const data = object(JSON.parse(content));
  if (!data || (mentions !== undefined && !Array.isArray(mentions))) throw new Error("feishu_mentions_invalid");
  const metadata = (mentions ?? []) as unknown[];
  if (metadata.length > 100) throw new Error("feishu_mentions_invalid");
  const replacements = new Map<string, string>();
  let addressed = false;
  for (const value of metadata) {
    const mention = object(value);
    const id = object(mention?.id)?.open_id;
    if (!mention || typeof mention.key !== "string" || !mention.key || mention.key.length > 200 ||
        typeof id !== "string" || typeof mention.name !== "string" || mention.name.length > 200 || replacements.has(mention.key)) throw new Error("feishu_mentions_invalid");
    const own = id === botOpenId;
    addressed ||= own;
    replacements.set(mention.key, own ? "" : `@${mention.name}`);
  }
  const keys = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const replace = (text: string) => keys.length
    ? text.replace(new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), (key) => replacements.get(key)!)
    : text;
  let observation = "";
  if (type === "text") {
    if (typeof data.text !== "string") throw new Error("feishu_message_invalid");
    data.text = replace(data.text).trim();
    observation = data.text as string;
  } else if (type === "post") {
    if (typeof data.title !== "string" || !Array.isArray(data.content)) throw new Error("feishu_message_invalid");
    const paragraphs = [data.title];
    data.content = data.content.map((paragraph: unknown) => {
      if (!Array.isArray(paragraph)) throw new Error("feishu_message_invalid");
      const retained: RecordValue[] = [];
      const text: string[] = [];
      for (const value of paragraph) {
        const node = object(value);
        if (!node) throw new Error("feishu_message_invalid");
        if (node.tag === "at") {
          const id = node.open_id ?? node.user_id;
          if (metadata.length === 0 && id === botOpenId) addressed = true;
          const replacement = typeof id === "string" ? replacements.get(id) : undefined;
          if (id === botOpenId || replacement === "") continue;
          if (replacement !== undefined) node.user_name = replacement.slice(1);
          text.push(replacement ?? `@${typeof node.user_name === "string" ? node.user_name : String(id ?? "")}`);
        } else if (typeof node.text === "string") {
          node.text = replace(node.text);
          text.push(node.text as string);
        } else if (node.tag === "img") text.push("[图片]");
        retained.push(node);
      }
      paragraphs.push(text.join(""));
      return retained;
    });
    observation = paragraphs.filter(Boolean).join("\n").trim();
  } else {
    observation = `[${type}]`;
  }
  if (Array.from(observation).length > 8000) throw new Error("feishu_message_invalid");
  return { addressed, content: JSON.stringify(data), observation };
}
