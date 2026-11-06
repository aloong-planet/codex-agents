import { Ajv } from "ajv";
import { MAX_WEIXIN_LOGICAL_CODE_POINTS } from "./weixin-text-segmenter.js";

const statuses = ["completed", "partial", "not_found", "needs_input", "blocked", "failed", "cancelled", "in_progress", "unknown"] as const;
export type MainBusinessResult = { subject: string; status: typeof statuses[number] };
export type MainReply = { message: string; results: MainBusinessResult[] };
export type StoredMainBusinessResult = {
  version: 1; source: "main_model"; inboundKey: string; results: MainBusinessResult[];
};

export const MAIN_REPLY_OUTPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["message", "results"],
  properties: {
    message: { type: "string", minLength: 1 },
    results: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["subject", "status"],
      properties: { subject: { type: "string", minLength: 1 }, status: { type: "string", enum: [...statuses] } },
    } },
  },
};

const validate = new Ajv({ strict: true }).compile<MainReply>(MAIN_REPLY_OUTPUT_SCHEMA);
// Reserve room for JSON escaping and the result envelope, separately from displayed text.
const MAX_REPLY_BYTES = MAX_WEIXIN_LOGICAL_CODE_POINTS * 8;
const failureCodes = ["main_reply_too_large", "main_reply_invalid_json", "main_reply_invalid_schema"] as const;
export type MainReplyFailureCode = typeof failureCodes[number];
export function parseMainReplyFailure(value: unknown): MainReplyFailureCode {
  if (typeof value !== "string" || !failureCodes.some((code) => code === value)) {
    throw new Error("main_reply_record_invalid");
  }
  return value as MainReplyFailureCode;
}
export class MainReplyProtocolError extends Error {
  constructor(readonly code: MainReplyFailureCode) { super(code); }
}

export function parseMainReply(text: string): MainReply {
  if (Buffer.byteLength(text, "utf8") > MAX_REPLY_BYTES) throw new MainReplyProtocolError("main_reply_too_large");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new MainReplyProtocolError("main_reply_invalid_json"); }
  if (!validate(value) || !value.message.trim() || value.results.some((item) => !item.subject.trim())) {
    throw new MainReplyProtocolError("main_reply_invalid_schema");
  }
  return { message: value.message, results: value.results.map((item) => ({ subject: item.subject, status: item.status })) };
}

export function parseStoredMainBusinessResult(value: unknown): StoredMainBusinessResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("main_reply_record_invalid");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 4 || item.version !== 1 || item.source !== "main_model" ||
      typeof item.inboundKey !== "string" || !/^[a-f0-9]{64}$/u.test(item.inboundKey)) {
    throw new Error("main_reply_record_invalid");
  }
  // Use a shortest valid message so validation cannot enlarge an accepted envelope.
  const parsed = parseMainReply(JSON.stringify({ message: "x", results: item.results }));
  return { version: 1, source: "main_model", inboundKey: item.inboundKey, results: parsed.results };
}

export const MAIN_REPLY_INSTRUCTIONS = [
  "最终答复只输出符合 outputSchema 的 JSON：message 是发给用户的自然中文正文，results 是本轮业务目标的结果数组；普通聊天使用空数组。",
  "每项 subject 是简短目标说明，不是 ID；一个目标的多次工具调用归为一项，独立目标可分别报告。",
  "results 只列用户本轮实际要求完成的目标，不得把用户明确排除或禁止的动作新增为目标。例如只要求提供代码和测试用例、明确不要运行时，交付代码和用例即可分别记 completed；测试尚未运行应在 message 中如实说明，不新增运行测试的失败项。若用户实际要求运行而未能运行，则该目标必须如实记为未完成，不能用代码审阅替代执行。",
  "status 类型：completed 已完成；partial 同一目标部分完成；not_found 未找到；needs_input 需要补充或选择；blocked 受权限、政策或前置条件阻止；failed 已知执行失败；cancelled 已取消或放弃；in_progress 仍在进行；unknown 实际结果无法确认。",
  "根据完整对话和真实执行证据自行选择类型，不把中间工具结果当作最终结论，不虚构完成。结果只是报告，不是执行命令或手机送达证明。",
].join("\n");
