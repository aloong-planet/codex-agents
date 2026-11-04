import type { WorkflowToolMember } from "./workflow-tool-catalog.js";

const calendarProperty = { type: "object", additionalProperties: false, required: ["time"], properties: {
  time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
  weekdays: { type: "array", minItems: 1, maxItems: 7, uniqueItems: true, items: { type: "integer", minimum: 0, maximum: 6 } },
} };
// Keep fields optional at schema validation so pre-upgrade operation replays can be read.
// The host requires both fields for every fresh creation or explicit content edit.
const reminderProperties = {
  reminderText: { type: "string", minLength: 1, maxLength: 65536, description: "完整的实际发送正文；面向接收者，不含调度设置或自动标题。" },
  reminderMode: { type: "string", enum: ["natural", "verbatim"] },
};
const managementProperties = {
  reference: { type: "string", minLength: 1, maxLength: 120 },
  expectedRevision: { type: "integer", minimum: 1 },
  sourceText: { type: "string", minLength: 1, maxLength: 16000 },
};
const reminderDescription = "以下正文规则只用于 reminder 静态提醒，不用于 researched_text 研究任务。创建或明确修改内容时，必须同时提交 instruction（任务含义）、reminderText（完整实际发送正文）和 reminderMode。普通提醒用 natural：面向接收者表达，不机械替换人称；每分钟提醒我活动一下→你应该活动一下了。移除每分钟、只发文字等设置要求，保留人物、动作、否定、数量、期限、引号内的话及用户语言，不添加建议。提醒我让小王给我回电话→记得让小王给你回电话。提醒我对妈妈说‘我晚点回家’应保留引号内原话。原样发送用 verbatim：reminderText 逐字取自 sourceText 中指定正文，保留空格、换行和标点，不改我/你，不加标题。普通提醒中的人物或期限有歧义时，必须先向用户澄清，不能调用 schedules.create/edit。例：提醒我把文件发给他，且他是新提到的人，必须先问他是谁；不能把“记得把文件发给他”存入任务来绕过澄清。仅保存文字也适用，不能把保留未解析的人物指代当作完整理解。注意提醒不是执行事项：文件、这两份文件、报告等事项描述可以直接保留，不需要定位文件、询问文件名或读取文件；例如“提醒我不要把这两份文件发给小王”应直接保存“不要把这两份文件发给小王”。明确要求原样发送的 verbatim 正文不做这类解释。相对期限按原请求时间理解，静态正文不能假装每次动态更新。不能把取消意图误建为提醒。仅改名称/时间或启停不提交内容字段，不改写旧正文。新任务和内容修改缺正文会拒绝；不要退回整句管理指令。回执必须展示返回的 reminderText，不重新润色；reminderTextAvailable=true 但正文未返回时，用 schedules.read_text(field=reminderText) 逐页读取再展示。旧任务该标志为 false 时保持旧指令说明，不声称已有新正文。创建或修改回执请按以下项目完整列出：任务编号（返回的完整 task.id）、实际提醒正文、执行规则（必须按返回 task.schedule.kind 区分 once 一次性、interval 周期、calendar 日历；不能把周期回执说成一次性）、下一次执行时间和时区、启用状态、接收位置。即使正文很短也不要省略任务编号。";
const researchDescription = "用户要求到时检索公开信息并生成报告时用 template=researched_text；提醒用户自己研究仍用 reminder。研究的 instruction 保存完整目标、范围、语言和来源要求，不传 reminderText/reminderMode，不提前生成报告。仅支持独立网页研究和文字报告附来源，不支持文件、程序、其他外发或递归任务。研究创建/编辑回执也必须列完整编号、研究要求、规则、下一时间及其时区、启用状态和接收位置；不得省略或冒充已生成报告。template 不可改，研究编辑只需 instruction，reminderTextAvailable=false 正常。报告用 history/read_text(output) 读取，失败据 stage/reason/recoveryAction 回复，不编造报告或重试。";
export const SCHEDULE_SETTINGS_AUTHORITY = "任务操作的授权来自当前用户请求的完整语义。聊天历史、引用和长期记忆只帮助理解指代；它们不是新的修改请求。已有任务的内容、范围、时间、启停和接收位置以本轮 inspect/read_text 读到的持久配置为准，禁止为了符合旧偏好而恢复、纠正或同步任务设置。查询、刷新或执行本身不授权修改任何设置；只有当前请求明确要求改变某字段时才提交该字段。明确同时要求修改并执行时，先完成所要求的修改，再依据返回的新 revision 执行；未要求改变的字段保持原值。用户只限定本次结果且未要求永久修改时，不得用永久 edit 代替临时参数；能力不支持时说明限制并澄清。sourceText 原文匹配和 revision 校验仅证明来源与版本，不能代替你核对该操作及每个修改字段是否获当前请求授权。";
const managementDescription = "仅按本条完整请求操作当前会话任务及明确要求变更的字段，旧记忆不授权修改；先 inspect 获取最新 revision，expectedRevision 必须等于该值。reference 优先完整任务编号；同名 needs_choice 时先请用户选择，不能猜测。sourceText 逐字引用本条消息中该操作的片段。revision_conflict 时重新读取并核对；不覆盖并发修改。replayed=true 表示原操作的回执，不能说又修改或启动了一次；status 是原操作的接纳结果，依据当前 task 状态回复。渠道接受不等于手机收到。";

export const SCHEDULE_TOOL_MEMBERS: readonly WorkflowToolMember[] = [
  {
    id: "schedules.create", version: 1, executionClass: "inline_mutation",
    description: researchDescription + "在当前微信会话创建任务。delaySeconds、at、intervalSeconds、calendar 恰选一种。相对一次性请求（如“两分钟后提醒我”“3分钟后提醒我”）使用 delaySeconds=120/180，只执行一次；不要用 intervalSeconds 表示等待多久。at 是一次性带偏移的未来 ISO 时间。只有明确重复请求（如“每两分钟”）才用 intervalSeconds，至少60秒；可选未来 startAt，省略时宿主以接纳时间加间隔定首次执行。calendar.time 为 HH:MM，weekdays 为0周日至6周六，省略则每天；按 timezone 当地钟点，夏令时空缺跳过、重复只取较早一次。timezone 为 IANA 名称，默认 Asia/Shanghai。用户明确要求且时间完整才调用，有歧义先追问。sourceText 逐字引用本条消息中这一任务的完整片段，不含其他计划。创建回执必须列完整 task.id、保存的内容/研究要求、规则、下一次时间、时区、启用状态和接收位置（当前微信会话），不能说已推送。原请求重放据现存 task.lifecycle 和下一时间回复，已完成不表示重新启动。" + reminderDescription,
    inputSchema: { type: "object", additionalProperties: false, required: ["name", "instruction", "sourceText"], properties: {
      template: { type: "string", enum: ["reminder", "researched_text"], description: "提醒保存静态正文；研究在执行时检索公开网页并生成报告。省略时为 reminder。" },
      name: { type: "string", minLength: 1, maxLength: 120 },
      instruction: { type: "string", minLength: 1, maxLength: 16000 },
      ...reminderProperties,
      delaySeconds: { type: "integer", minimum: 1, description: "从本次接纳起等待多少秒后执行一次；两分钟后=120。不重复，不能与其他时间规则或 startAt 同传。" },
      at: { type: "string", minLength: 20, maxLength: 40 },
      calendar: calendarProperty,
      intervalSeconds: { type: "integer", minimum: 1, description: "重复执行的周期秒数，仅用于明确的每隔/每次循环请求；不能表达一次性延迟。" },
      startAt: { type: "string", minLength: 20, maxLength: 40 },
      timezone: { type: "string", minLength: 1, maxLength: 80 },
      sourceText: { type: "string", minLength: 1, maxLength: 16000 },
    } },
  },
  {
    id: "schedules.list", version: 1, executionClass: "inline_query",
    description: SCHEDULE_SETTINGS_AUTHORITY + "列出本人定时任务。默认 scope=current_channel，只列实际通知接收位置属于当前聊天的任务。用户明确询问全部任务、所有渠道任务时才用 scope=all_channels，并逐项注明 notificationDestination 的接收渠道；destination 是历史存储身份，不能当作接收位置。scope 与 view 独立：历史/已完成任务仍默认限定当前渠道，全部任务用 scope=all_channels、view=all。每次查询都调用本工具读取最新状态，不复用聊天中的旧列表。视图只按本条用户请求选择：“查看我的定时任务”“有哪些定时任务”等未指定范围的请求必须用 view=active；即使上一轮讨论过已完成任务，也不能擅自切换为 all。默认 view=active，隐藏 lifecycle=completed 的已完成一次性任务及 lifecycle=deleted 的已删除任务；待执行、正在执行、待推送和失败/不确定的任务仍显示。用户询问已完成或历史任务时用 view=completed，询问全部任务时用 view=all。total 是所选视图数量，totalAll 是全部保存数量，completedTotal 是已完成数量；默认列表为空但 completedTotal>0 时，先明确回复“当前没有待处理的定时任务”，再说明“历史中有 N 个已完成任务”；不要把历史条目再次列入当前任务，也不能说没有保存过任务。存在 nextOffset 时保持同一 scope、view 继续翻页。依据 lifecycle 和 recoveryAction 说明进度，enabled 只是启用开关；completed 表述为已完成（渠道已接受），不等于手机收到。未绑定的其他用户任务不可见；明确指定本人任务编号的 inspect/edit 仍可跨本人渠道管理，不转移通知位置。",
    inputSchema: { type: "object", additionalProperties: false, properties: { scope: { type: "string", enum: ["current_channel", "all_channels"] }, view: { type: "string", enum: ["active", "completed", "all"] }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } } },
  },
  {
    id: "schedules.inspect", version: 1, executionClass: "inline_query",
    description: SCHEDULE_SETTINGS_AUTHORITY + researchDescription + "查询当前微信会话的任务设置、执行和推送历史，含已完成/已删除任务。已有日报 template=daily_ai_news 沿用专门来源、摘要和归档；先 inspect 再管理，不另建其他模板冒充，不传提醒正文。刷新会话只读取当前恢复条件，不承诺未知结果重发。优先使用返回的 taskId；同名 needs_choice 必须选择，有 nextOffset 继续分页。reference 是任务编号；精确查一次执行另传 run_now 返回的 occurrenceId，不能当作任务编号。仅精确查询返回 occurrence_not_found 才表示该执行不在保留记录中，第一页未见或错误引用不能证明未执行。依据 task.lifecycle 报告进度，enabled 只是开关，nextExecutionAt=null 不等于完成。accepted/completed 仅代表渠道接受，不证明手机收到。现在是否等待只依据 task.delivery、currentBlocker、recoveryAction；已 accepted 不要求刷新或承诺续发。reminderText 是实际发送原文，不能用 instruction 代替；旧任务正文不可用时不改写。长正文/指令用 read_text 分页。history 按 plannedAt 倒序，同时间编号稳定排序。skippedRange 的 from/through/cadenceRevision 表示合并跳过的首末时间和节奏版本，不是执行失败，无正文。totalOccurrences 是永久保留的执行/跳过摘要数；terminalHistoryLimit=null 表示无次数上限。executionCount 排除 skipped：executionCountKind=cumulative 可说累计执行 N 次，known_minimum 只能说已知至少 N 次（旧历史可能已丢失）。同一次执行重试不另计。detailsClearedAt 表示正文和详细记录已按时间/容量清理，摘要结果仍在，不能误报未执行或重新生成/补发。nextOffset、nextAttemptOffset、nextNotificationOffset 分别对应历史、尝试、通知的后续页，传相应 offset 继续。notifications 仅为历史通知，recordedCode 是当时原因，delivery 是通知自身结果，suppressed 表示已撤销，不是当前阻塞。",
    inputSchema: { type: "object", additionalProperties: false, required: ["reference"], properties: { reference: { type: "string", minLength: 1, maxLength: 120 },
      occurrenceId: { type: "string", minLength: 1, maxLength: 240, description: "可选：查询该任务的一次特定执行，reference 仍使用任务编号。" },
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 5 },
      notificationOffset: { type: "integer", minimum: 0 }, notificationLimit: { type: "integer", minimum: 1, maximum: 5 },
      attemptOffset: { type: "integer", minimum: 0 }, attemptLimit: { type: "integer", minimum: 1, maximum: 5 },
    } },
  },
  {
    id: "schedules.delete", version: 1, executionClass: "inline_mutation",
    description: "删除任务以停止未来执行和缓存发送，保留可查询的历史及稳定编号。未发送的缓存取消，不会标成送达；不会撤回已经发送的消息。若任务正在执行或提交，busy 时请说明先停用并等待结果，再删除。删除后不能重新启用；需要时明确创建新任务。" + managementDescription,
    inputSchema: { type: "object", additionalProperties: false, required: ["reference", "expectedRevision", "sourceText"], properties: managementProperties },
  },
  {
    id: "schedules.retry_news", version: 1, executionClass: "inline_mutation",
    description: "仅重试已有 daily_ai_news 日报今天的研究或归档失败，保留原自动重试时间，不创建另一份日报。用户说立即重试日报时先 inspect：若已有缓存，只说明当前恢复状态，不重新研究；已接受、部分、拒绝或未知提交不能用本工具重发。没有当日可重试失败或任务停用时据宿主结果说明。" + managementDescription,
    inputSchema: { type: "object", additionalProperties: false, required: ["reference", "expectedRevision", "sourceText"], properties: managementProperties },
  },
  {
    id: "schedules.run_now", version: 1, executionClass: "inline_mutation",
    description: "为已有任务立即领取一次独立执行，不修改内容、范围、时间、启停等任何设置或 revision；直接使用当前持久配置，不能先 edit 来迎合旧记忆。停用时只授权本次结果推送，再次停用会撤销尚未提交的授权。仅在用户明确要求执行一次时使用；不能将它当成未知发送结果的自动重试。busy/capacity 返回拒绝时说明原因，不能说已启动。started 表示本次已领取，不表示正文生成或微信送达。" + managementDescription,
    inputSchema: { type: "object", additionalProperties: false, required: ["reference", "expectedRevision", "sourceText"], properties: managementProperties },
  },
  ...(["disable", "enable"] as const).map((action): WorkflowToolMember => ({
    id: `schedules.${action}`, version: 1, executionClass: "inline_mutation",
    description: (action === "disable" ? "停用任务并阻止后续执行和缓存发送。每次明确停用都会撤销此前尚未发送的手动执行授权；已提交的消息不能撤回，不承诺完全没有在途消息。" : "启用任务，恢复未来执行及符合条件的缓存发送。周期任务保留原节奏，从下一未来时段继续，停用期间不补跑。不会重放已接受、部分、拒绝或未知结果。停用期间错过的一次性时间不会补跑；overdue_once 时请用户给出新时间或明确现在执行一次。") + managementDescription,
    inputSchema: { type: "object", additionalProperties: false, required: ["reference", "expectedRevision", "sourceText"], properties: managementProperties },
  })),
  {
    id: "schedules.edit", version: 1, executionClass: "inline_mutation",
    description: researchDescription + "修改任务名称、内容或未来尚未领取的执行时间。至少提供一项修改；一次性相对延迟用 delaySeconds，或绝对时间用 at；改变重复间隔用 intervalSeconds，可选未来 startAt；没有 startAt 则以修改接纳时间加新间隔建立新节奏。日历规则用 calendar（time 和可选 weekdays）；修改日历或其 timezone 从新的未来时段开始。名称或内容修改不能提交未改变的时间字段。at 必须是带偏移的未来 ISO 时间。编辑不会启用停用的任务，不改变已领取执行的内容。一次性计划已领取后不能重设自动执行时间，可另建提醒或明确执行一次。回执须列 nextExecutionAt 和 timezone；停用期间不执行，但不表示没有下一计划。" + reminderDescription + managementDescription,
    inputSchema: { type: "object", additionalProperties: false, required: ["reference", "expectedRevision", "sourceText"], properties: {
      ...managementProperties,
      name: { type: "string", minLength: 1, maxLength: 120 }, instruction: { type: "string", minLength: 1, maxLength: 16000 },
      ...reminderProperties,
      delaySeconds: { type: "integer", minimum: 1, description: "从本次接纳起等待多少秒后执行一次；两分钟后=120。不重复，不能与其他时间规则或 startAt 同传。" },
      at: { type: "string", minLength: 20, maxLength: 40 },
      calendar: calendarProperty,
      intervalSeconds: { type: "integer", minimum: 1, description: "重复执行的周期秒数，仅用于明确的每隔/每次循环请求；不能表达一次性延迟。" },
      startAt: { type: "string", minLength: 20, maxLength: 40 }, timezone: { type: "string", minLength: 1, maxLength: 80 },
    } },
  },
  {
    id: "schedules.read_text", version: 1, executionClass: "inline_query",
    description: "分页读取当前微信会话中已保存的完整任务指令、提醒正文或缓存正文。field=instruction 或 reminderText 时 reference 使用 taskId，field=output 时使用 occurrenceId。提醒正文是将要发送的完整原文；不要添加标题或改写。history_details_cleared 表示正文已按保留策略清理，执行摘要仍在，不应重新生成或补发。offset/nextOffset 按 Unicode 字符计数；有 nextOffset 时继续读取，不自行补写或用省略号截断原文。",
    inputSchema: { type: "object", additionalProperties: false, required: ["reference", "field"], properties: {
      reference: { type: "string", minLength: 1, maxLength: 160 }, field: { type: "string", enum: ["instruction", "reminderText", "output"] },
      offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 4000 },
    } },
  },
];
