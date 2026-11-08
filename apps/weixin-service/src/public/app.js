const phaseLabels = {
  disconnected: "尚未连接",
  configured: "发现已配置账户",
  login_starting: "正在请求二维码",
  awaiting_scan: "等待扫码",
  scanned: "已扫码，等待确认",
  pair_code_required: "需要配对码",
  connected: "已连接",
  account_stale: "账户凭据已失效",
  login_error: "连接未完成",
  ready: "可以测试发送",
  sending: "正在发送",
  sent: "渠道已接受",
  send_error: "发送失败或状态未知",
};

const codexStatusLabels = {
  disabled: "未启用",
  starting: "正在启动专用服务",
  idle: "已就绪，等待新消息",
  thinking: "Codex 正在回复",
  sending: "正在发回微信",
  error: "需要处理",
};

const runPhaseLabels = {
  queued: "排队中",
  typing: "正在输入",
  thinking: "Codex 思考中",
  tool: "工具执行中",
  sending: "正在发回微信",
  completed: "已完成",
  failed: "失败",
  interrupted: "服务重启时已中断",
};

const toolStatusLabels = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  blocked: "被阻止",
  unknown: "状态未知",
};

const runTimingStageLabels = {
  inbound: "入站接收",
  queue: "本地排队",
  typing_start: "启动正在输入",
  acknowledgement: "发送处理回执",
  agent: "Codex 总计",
  typing_stop: "关闭正在输入",
  outbound: "发送最终回复",
};

const agentTimingStageLabels = {
  app_server_prepare: "App Server 接受任务",
  first_model_wait: "首次模型事件等待",
  model_reasoning: "模型推理",
  tool_execution: "工具执行",
  tool_result_wait: "工具结果处理等待",
  final_generation: "最终回复生成",
};

const runTimingOutcomeLabels = {
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  unknown: "结果未知",
  unavailable: "不可用",
  interrupted: "已中断",
};

const runtimeExpandedLanes = new Map();
const runtimeProblemOutcomes = new Set(["failed", "unknown", "unavailable", "interrupted"]);

function runtimeLaneOutcome(run, laneId) {
  const timings = Array.isArray(run?.timings) ? run.timings : [];
  const stages = laneId === "typing"
    ? ["typing_start", "typing_stop"]
    : laneId === "agent" ? ["agent"] : ["outbound"];
  const outcomes = timings.filter((timing) => stages.includes(timing.stage)).map((timing) => timing.outcome);
  if (laneId === "typing" && run?.typingDiagnostics) {
    if (run.typingDiagnostics.getConfig) outcomes.push(run.typingDiagnostics.getConfig.outcome);
    if (run.typingDiagnostics.sendStart) outcomes.push(run.typingDiagnostics.sendStart.outcome);
    const typingStarted = run.typingDiagnostics.sendStart?.outcome === "completed";
    const typingStopped = timings.some((timing) => timing.stage === "typing_stop");
    if (typingStarted && !typingStopped) outcomes.push(run?.completedAt ? "unknown" : undefined);
  }
  if (laneId === "agent") outcomes.push(...(run?.agentTimings || []).map((timing) => timing.outcome));
  if (laneId === "outbound" && run?.outboundDiagnostics) {
    outcomes.push(
      run.outboundDiagnostics.prepare?.outcome,
      run.outboundDiagnostics.sendMessage?.outcome,
      run.outboundDiagnostics.responseRead?.outcome,
      run.outboundDiagnostics.stateSave?.outcome,
    );
  }
  const problem = outcomes.find((outcome) => runtimeProblemOutcomes.has(outcome));
  if (problem) return problem;
  return outcomes.some((outcome) => outcome === undefined) ? undefined : "completed";
}

function runtimeDurationTone(durationMs) {
  if (durationMs < 10_000) return "success";
  if (durationMs <= 30_000) return "warning";
  return "danger";
}
globalThis.runtimeDurationTone = runtimeDurationTone;

function buildRuntimeConcurrencyTimeline(run, now = Date.now()) {
  const timings = Array.isArray(run?.timings) ? run.timings : [];
  const effectiveNow = Number.isFinite(run?.completedAt) ? run.completedAt : now;
  const timingFor = (stage) => {
    const timing = timings.find((item) => item?.stage === stage);
    if (!timing || !Number.isFinite(timing.startedAt)) return null;
    const completedAt = Number.isFinite(timing.completedAt) ? timing.completedAt : effectiveNow;
    if (completedAt < timing.startedAt) return null;
    return { stage, startedAt: timing.startedAt, completedAt, outcome: timing.outcome };
  };
  const typingStart = timingFor("typing_start");
  const agent = timingFor("agent");
  const typingStop = timingFor("typing_stop");
  const outbound = timingFor("outbound");
  const typingSegments = [];
  if (typingStart) {
    typingSegments.push({ id: "typing-start", ...typingStart });
    if (run?.typingDiagnostics?.sendStart?.outcome === "completed") {
      const activeCompletedAt = typingStop?.startedAt ?? effectiveNow;
      if (activeCompletedAt >= typingStart.completedAt) {
        typingSegments.push({
          id: "typing-active",
          startedAt: typingStart.completedAt,
          completedAt: activeCompletedAt,
        });
      }
    }
  }
  if (typingStop) typingSegments.push({ id: "typing-stop", ...typingStop });
  const serialStages = ["inbound", "queue", "acknowledgement"]
    .map((stage) => timingFor(stage))
    .filter(Boolean);
  const lanes = [
    { id: "typing", label: "微信正在输入", segments: typingSegments },
    { id: "agent", label: "Codex", segments: agent ? [{ id: "agent", ...agent }] : [] },
    { id: "outbound", label: "微信最终回复", segments: outbound ? [{ id: "outbound", ...outbound }] : [] },
  ].filter((lane) => lane.segments.length).map((lane) => ({
    ...lane,
    durationMs: lane.segments.reduce(
      (total, segment) => total + segment.completedAt - segment.startedAt,
      0,
    ),
    outcome: runtimeLaneOutcome(run, lane.id),
  }));
  const segments = [...serialStages, ...lanes.flatMap((lane) => lane.segments)];
  const startAt = segments.length ? Math.min(...segments.map((segment) => segment.startedAt)) : null;
  const completedAt = segments.length ? Math.max(...segments.map((segment) => segment.completedAt)) : null;
  const typingStopOutboundOverlapMs = typingStop && outbound
    ? Math.max(0, Math.min(typingStop.completedAt, outbound.completedAt) - Math.max(typingStop.startedAt, outbound.startedAt))
    : 0;
  const canRender = startAt !== null && completedAt !== null && lanes.length >= 2;
  const defaultExpandedLaneId = canRender && lanes.some((lane) => lane.id === "agent") ? "agent" : "";
  return {
    startAt,
    completedAt,
    canRender,
    defaultExpandedLaneId,
    serialStages,
    lanes,
    typingStopOutboundOverlapMs,
  };
}
globalThis.buildRuntimeConcurrencyTimeline = buildRuntimeConcurrencyTimeline;

const memoryStatusLabels = {
  disabled: "已停用（文件保留）",
  idle: "等待新对话",
  collecting: "正在累计近期对话",
  pending: "等待后台整理",
  curating: "Curator 正在整理",
  needs_clarification: "需要补充说明",
  failed: "最近一次整理失败",
};

const memoryAttemptStageLabels = {
  snapshot: "读取记忆快照",
  resolve_policy: "解析写入策略",
  curate: "Curator 整理",
};

const memoryAttemptOutcomeLabels = {
  committed: "已提交",
  noop: "无需修改",
  needs_clarification: "需要补充说明",
  failed: "失败",
};

const appTabs = [
  { name: "connection", tabId: "connection-app-tab", panelId: "connection-app-tabpanel" },
  { name: "chat", tabId: "chat-app-tab", panelId: "chat-app-tabpanel" },
  { name: "workflows", tabId: "workflows-app-tab", panelId: "workflows-app-tabpanel" },
  { name: "memory", tabId: "memory-app-tab", panelId: "memory-app-tabpanel" },
  { name: "news", tabId: "news-app-tab", panelId: "news-app-tabpanel" },
  { name: "permissions", tabId: "permissions-app-tab", panelId: "permissions-app-tabpanel" },
];
let selectedAppTab = "connection";
const appTabScrollPositions = new Map();
let selectedMemoryTab = "memory";
let selectedWorkflowRunRef = null;
let workflowFilter = "all";
let latestWorkflowState = { runs: [] };
let latestModelState = null;
let lastRenderedModelKey = "";

function syncModelInputs(resetSelection = false) {
  const models = latestModelState?.catalog?.models || [];
  const mode = $("codex-model-mode").value;
  const currentPinned = $("codex-pinned-model").value;
  $("codex-pinned-model-label").hidden = mode !== "pinned";
  $("codex-pinned-model").replaceChildren(...models.map((model) => {
    const option = document.createElement("option");
    option.value = model.model;
    option.textContent = `${model.displayName} (${model.model})${model.upgrade ? " · 建议升级" : ""}`;
    return option;
  }));
  const trackModels = { fast: "gpt-5.6-luna", balanced: "gpt-5.6-terra", quality: "gpt-5.6-sol" };
  const selected = resetSelection && latestModelState?.selection?.mode === "pinned"
    ? latestModelState.selection.model
    : currentPinned || latestModelState?.selection?.model;
  if (selected && models.some((model) => model.model === selected)) $("codex-pinned-model").value = selected;
  const modelId = mode === "pinned" ? $("codex-pinned-model").value : trackModels[mode];
  const model = models.find((candidate) => candidate.model === modelId);
  const previousEffort = resetSelection ? latestModelState?.selection?.effort : $("codex-model-effort").value;
  $("codex-model-effort").replaceChildren(...(model?.supportedReasoningEfforts || []).map((effort) => {
    const option = document.createElement("option"); option.value = effort; option.textContent = effort; return option;
  }));
  if (previousEffort && model?.supportedReasoningEfforts.includes(previousEffort)) $("codex-model-effort").value = previousEffort;
  else if (model) $("codex-model-effort").value = mode === "fast" && model.supportedReasoningEfforts.includes("low") ? "low" : model.defaultReasoningEffort;
}

const newsStatusLabels = {
  disabled: "未启用",
  idle: "等待下次运行",
  researching: "正在检索",
  ready: "预览已就绪",
  sending: "正在发送",
  accepted: "渠道已接受",
  pending_inbound: "等待入站后补发",
  context_refresh_required: "需要微信入站刷新",
  auth_relogin_required: "需要重新绑定微信",
  rejected: "微信渠道已拒绝",
  unknown: "发送结果未知",
  failed: "本次失败",
};

const newsFailureStageLabels = {
  research: "新闻研究",
  archive: "Vault 归档",
  configuration: "发送配置",
};

const newsFailureNoticeLabels = {
  accepted: "失败通知已被渠道接受",
  pending_inbound: "失败通知等待入站后补发",
  context_refresh_required: "失败通知等待微信入站刷新",
  unknown: "失败通知发送结果未知",
  failed: "失败通知未送达",
};

const newsFailureCodeLabels = {
  codex_usage_limit: "Codex 使用额度已耗尽，等待额度恢复",
  codex_rate_limit: "Codex 请求频率受限，等待限流解除",
  codex_process: "Codex 进程失败",
  research_timeout: "研究超时",
  network_unavailable: "新闻源网络不可用",
  insufficient_search: "未完成真实网页搜索",
  invalid_result: "研究结果校验失败",
  hacker_news: "Hacker News 获取失败",
  research_unknown: "未知研究错误",
  archive_unavailable: "Vault 暂不可用",
  target_changed: "发送目标已变化",
};

const $ = (id) => document.getElementById(id);
let lastLabelSelection = "";
let lastAppliedAutoSelection = "";
let lastPermissionRevision = -1;
let permissionDirty = false;
let currentPermissions = null;
let lastMediaExportRevision = -1;
let mediaExportDirty = false;
let lastWorkflowModulePermissionSignature = "";
let workflowModulePermissionDirty = false;
const workflowModulePermissionFeedback = new Map();
let memoryFeedbackScope = "";
let memoryActionPending = false;

function shortId(value) {
  if (!value) return "—";
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function displayName(item, fallback) {
  return item?.label || shortId(fallback);
}

function shortEmbeddingModel(model) {
  if (model.includes("Qwen3-Embedding-0.6B")) return "Qwen3-Embedding-0.6B";
  if (model.includes("paraphrase-multilingual-MiniLM")) return "MiniLM-L12-v2";
  return model;
}

function formatTime(value) {
  if (!value) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatElapsed(value) {
  if (value === null || value === undefined) return "—";
  const hours = value / (60 * 60 * 1000);
  return `${hours.toFixed(hours % 1 === 0 ? 0 : 1)} 小时`;
}

function renderWorkflowModulePermissions(state) {
  const container = $("workflow-module-permission-list");
  if (!state) {
    container.textContent = "工作流模块权限不可用。";
    return;
  }
  const signature = state.modules.map((module) => `${module.moduleId}:${module.revision}:${module.saved}`).join("|");
  if (workflowModulePermissionDirty && signature === lastWorkflowModulePermissionSignature) return;
  container.replaceChildren(...state.modules.map((module) => {
    const card = document.createElement("article");
    card.className = "workflow-module-permission-card";
    card.dataset.workflowModuleId = module.moduleId;

    const header = document.createElement("header");
    const identity = document.createElement("div");
    const heading = document.createElement("h4");
    heading.textContent = module.name;
    const description = document.createElement("p");
    description.textContent = module.description;
    identity.append(heading, description);
    const status = document.createElement("span");
    status.className = "workflow-module-permission-status";
    status.dataset.saved = String(module.saved);
    status.textContent = module.saved ? "已配置" : "待保存";
    header.append(identity, status);

    const form = document.createElement("form");
    form.className = "workflow-module-permission-form";
    form.dataset.moduleId = module.moduleId;
    form.dataset.revision = String(module.revision);
    const labels = document.createElement("div");
    labels.className = "workflow-module-scope-labels";
    labels.innerHTML = "<span>资源范围</span><span>读取</span><span>写入</span>";
    form.append(labels);
    for (const scope of module.scopes) {
      const row = document.createElement("div");
      row.className = "workflow-module-scope";
      row.dataset.scopeId = scope.scopeId;
      const scopeIdentity = document.createElement("div");
      const scopeLabel = document.createElement("strong");
      scopeLabel.textContent = scope.label;
      const scopePath = document.createElement("small");
      scopePath.textContent = scope.directory;
      scopeIdentity.append(scopeLabel, scopePath);
      const readLabel = document.createElement("label");
      const read = document.createElement("input");
      read.type = "checkbox";
      read.name = "workflow-module-read";
      read.checked = scope.read;
      read.setAttribute("aria-label", `读取 ${scope.label}`);
      readLabel.append(read);
      const writeLabel = document.createElement("label");
      const write = document.createElement("input");
      write.type = "checkbox";
      write.name = "workflow-module-write";
      write.checked = scope.write;
      write.setAttribute("aria-label", `写入 ${scope.label}`);
      writeLabel.append(write);
      for (const input of [read, write]) input.addEventListener("change", () => { workflowModulePermissionDirty = true; });
      row.append(scopeIdentity, readLabel, writeLabel);
      form.append(row);
    }
    const footer = document.createElement("footer");
    const feedback = document.createElement("p");
    feedback.className = "feedback";
    feedback.setAttribute("role", "status");
    feedback.textContent = workflowModulePermissionFeedback.get(module.moduleId) || "";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "secondary";
    submit.textContent = "保存更改";
    footer.append(feedback, submit);
    form.append(footer);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const scopes = [...form.querySelectorAll(".workflow-module-scope")].map((scopeRow) => ({
        scopeId: scopeRow.dataset.scopeId,
        read: scopeRow.querySelector('input[name="workflow-module-read"]').checked,
        write: scopeRow.querySelector('input[name="workflow-module-write"]').checked,
      }));
      run(async () => {
        const next = await api("/api/workflows/module-permissions/configure", {
          moduleId: module.moduleId,
          expectedRevision: Number(form.dataset.revision),
          confirmed: true,
          scopes,
        });
        workflowModulePermissionFeedback.set(
          module.moduleId,
          `${module.name}权限已保存，从下一次工作流运行开始生效。`,
        );
        workflowModulePermissionDirty = false;
        return next;
      });
    });
    card.append(header, form);
    return card;
  }));
  lastWorkflowModulePermissionSignature = signature;
  workflowModulePermissionDirty = false;
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} 秒`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes} 分 ${seconds} 秒`;
}

const workflowStatusLabels = {
  accepted: "已接收",
  planning: "正在规划",
  ready: "等待执行",
  running: "运行中",
  needs_input: "需要输入",
  waiting_external: "等待外部条件",
  succeeded: "已完成",
  failed: "失败",
  blocked: "已阻塞",
  outcome_unknown: "结果未知",
  cancelled: "已取消",
  pending: "等待执行",
  rejected: "已拒绝",
  unknown: "结果未知",
  skipped: "已跳过",
};

const workflowSourceLabels = {
  weixin: "微信",
  scheduler: "定时任务",
  fixture: "系统",
};

const workflowAttentionStatuses = new Set([
  "needs_input",
  "waiting_external",
  "failed",
  "blocked",
  "outcome_unknown",
]);

const workflowActiveStatuses = new Set(["accepted", "planning", "ready", "running"]);

function workflowElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderWorkflowState(workflows) {
  latestWorkflowState = workflows ?? { runs: [] };
  const runs = Array.isArray(latestWorkflowState.runs) ? latestWorkflowState.runs : [];
  const today = new Date();
  const isToday = (value) => {
    const date = new Date(value);
    return date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate();
  };
  $("workflow-active-count").textContent = String(runs.filter((run) => workflowActiveStatuses.has(run.status)).length);
  $("workflow-attention-count").textContent = String(runs.filter((run) => workflowAttentionStatuses.has(run.status)).length);
  $("workflow-completed-count").textContent = String(runs.filter((run) => run.status === "succeeded" && isToday(run.updatedAt)).length);

  const visibleRuns = workflowFilter === "attention"
    ? runs.filter((run) => workflowAttentionStatuses.has(run.status))
    : runs;
  if (!visibleRuns.some((run) => run.runRef === selectedWorkflowRunRef)) {
    selectedWorkflowRunRef = visibleRuns[0]?.runRef ?? null;
  }
  const list = $("workflow-run-list");
  list.replaceChildren();
  if (visibleRuns.length === 0) {
    list.append(workflowElement("p", "workflow-empty", workflowFilter === "attention" ? "当前没有需要关注的运行。" : "尚无工作流运行。"));
  } else {
    for (const run of visibleRuns) {
      const button = workflowElement("button", "workflow-run-item");
      button.type = "button";
      button.dataset.status = run.status;
      button.dataset.selected = String(run.runRef === selectedWorkflowRunRef);
      button.setAttribute("aria-pressed", String(run.runRef === selectedWorkflowRunRef));
      const heading = workflowElement("span", "workflow-run-item-heading");
      heading.append(
        workflowElement("strong", "", `${run.workflowId}${run.workflowVersion ? ` · v${run.workflowVersion}` : ""}`),
        workflowElement("span", "workflow-status", workflowStatusLabels[run.status] ?? run.status),
      );
      button.append(
        heading,
        workflowElement("span", "workflow-run-meta", `${workflowSourceLabels[run.source] ?? run.source} · ${formatTime(run.updatedAt)} · ${run.runRef}`),
      );
      button.addEventListener("click", () => {
        selectedWorkflowRunRef = run.runRef;
        renderWorkflowState(latestWorkflowState);
      });
      list.append(button);
    }
  }

  const selected = visibleRuns.find((run) => run.runRef === selectedWorkflowRunRef);
  renderWorkflowDetail(selected);
}

function renderWorkflowDetail(run) {
  const detail = $("workflow-run-detail");
  detail.replaceChildren();
  if (!run) {
    detail.append(workflowElement("p", "workflow-empty", "选择左侧运行以查看步骤与副作用状态。"));
    return;
  }
  const heading = workflowElement("div", "workflow-detail-heading");
  heading.append(
    workflowElement("h3", "", `${run.workflowId}${run.workflowVersion ? ` · v${run.workflowVersion}` : ""}`),
    workflowElement("span", "workflow-status", workflowStatusLabels[run.status] ?? run.status),
  );
  detail.append(
    heading,
    workflowElement("p", "workflow-run-meta", `${workflowSourceLabels[run.source] ?? run.source}触发 · ${formatTime(run.occurredAt)} · 总耗时 ${formatDuration(Math.max(0, run.updatedAt - run.createdAt))} · ${run.runRef}`),
  );
  if (run.errorCode) detail.append(workflowElement("p", "workflow-error-code", `错误：${run.errorCode}`));

  const stepsTitle = workflowElement("h4", "", "执行步骤");
  const steps = workflowElement("ol", "workflow-step-list");
  if (run.steps.length === 0) {
    steps.append(workflowElement("li", "workflow-empty", "尚未生成执行计划。"));
  } else {
    for (const step of run.steps) {
      const item = workflowElement("li", "workflow-step");
      item.dataset.status = step.status;
      item.append(
        workflowElement("strong", "", step.stepId),
        workflowElement("span", "workflow-step-capability", step.capabilityId),
        workflowElement("span", "workflow-step-status", `${workflowStatusLabels[step.status] ?? step.status}${step.attemptCount > 1 ? ` · ${step.attemptCount} 次尝试` : ""}`),
      );
      if (step.dependsOn.length > 0) item.append(workflowElement("small", "", `依赖：${step.dependsOn.join("、")}`));
      steps.append(item);
    }
  }
  detail.append(stepsTitle, steps);

  const effectsTitle = workflowElement("h4", "", "副作用记录");
  const effects = workflowElement("ul", "workflow-effect-list");
  if (run.effects.length === 0) {
    effects.append(workflowElement("li", "workflow-empty", "没有外部副作用。"));
  } else {
    for (const effect of run.effects) {
      const item = workflowElement("li", "workflow-effect");
      item.dataset.state = effect.state;
      item.append(
        workflowElement("strong", "", effect.stepId),
        workflowElement("span", "", effect.state === "accepted" ? "渠道已接受" : effect.state === "rejected" ? "已拒绝" : effect.state === "unknown" ? "结果未知" : "等待确认"),
      );
      if (effect.errorCode) item.append(workflowElement("small", "", effect.errorCode));
      effects.append(item);
    }
  }
  detail.append(effectsTitle, effects);
}

const contextExperimentLabels = {
  inactive: "尚未启动实验",
  scheduled: "实验进行中，等待下一次探针",
  probing: "正在提交真实探针",
  expired: "Context 已在真实发送中被拒绝",
  valid_through_cutoff: "至少 48 小时仍可被渠道接受",
  invalidated_by_inbound: "本轮被新的微信入站打断",
  auth_stale: "Bot 凭据失效，无法得出 context 结论",
  rejected: "iLink 明确拒绝，原因未能归为 context 失效",
  unknown: "发送结果未知，实验已停止",
  unavailable: "账户或目标不可用，实验已停止",
};

// A revoked authorization answers 401; reloading replaces this page with the login card and its notice.
function reloadWhenUnauthorized(response) {
  if (response.status !== 401) return false;
  document.location.reload();
  return true;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (reloadWhenUnauthorized(response)) return new Promise(() => {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function render(next) {
  renderWorkflowState(next.workflows);
  renderWorkflowModulePermissions(next.workflowModulePermissions);
  $("phase").textContent = phaseLabels[next.phase] || next.phase;
  $("notice").textContent = next.notice;
  $("status-dot").dataset.phase = next.phase;
  $("qr-wrap").hidden = !next.qrDataUrl;
  if (next.qrDataUrl) $("qr-image").src = next.qrDataUrl;
  $("pair-form").hidden = next.phase !== "pair_code_required";
  $("login-button").disabled = ["login_starting", "awaiting_scan", "scanned", "pair_code_required", "sending"].includes(next.phase);
  const selectedAccountIsStale = next.accounts.some(
    (account) =>
      account.accountId === next.selectedAccountId && account.credentialStatus === "stale",
  );
  $("send-button").disabled =
    selectedAccountIsStale ||
    next.phase === "account_stale" ||
    !["ready", "sent", "send_error"].includes(next.phase);

  const binding = next.autoBinding;
  const bindingFeedback = $("auto-binding-feedback");
  bindingFeedback.dataset.kind = "";
  if (binding?.status === "awaiting_inbound") {
    bindingFeedback.textContent = "监听已启动：请从刚连接的微信给 bot 发一条文本消息。";
    bindingFeedback.dataset.kind = "pending";
  } else if (binding?.status === "sending") {
    bindingFeedback.textContent = "已收到首条消息并自动绑定，正在回复问候……";
    bindingFeedback.dataset.kind = "pending";
  } else if (binding?.status === "accepted") {
    bindingFeedback.textContent = "已自动绑定；问候已被渠道接受，请在微信端确认是否收到。";
  } else if (binding?.status === "failed") {
    bindingFeedback.textContent = "已自动绑定，但问候发送失败或结果未知；没有自动重试。";
    bindingFeedback.dataset.kind = "error";
  } else {
    bindingFeedback.textContent = "重新绑定并扫码后，这里会自动等待第一条微信消息。";
  }

  const sendFeedback = $("send-feedback");
  sendFeedback.dataset.kind = "";
  if (next.phase === "sending") {
    sendFeedback.textContent = "正在向腾讯 iLink 提交发送请求……";
    sendFeedback.dataset.kind = "pending";
  } else if (next.phase === "sent") {
    sendFeedback.textContent = "渠道已接受发送请求，请在微信端确认是否收到。";
  } else if (next.phase === "send_error") {
    sendFeedback.textContent =
      "发送失败或状态未知；请先从微信重新发一条消息刷新上下文，再由你主动重试。没有自动重试。";
    sendFeedback.dataset.kind = "error";
  } else if (next.phase === "account_stale") {
    sendFeedback.textContent = next.notice.includes("渠道已接受本次发送")
      ? "渠道已接受本次发送，但账户凭据随后失效；请在微信端确认本次是否收到。"
      : "账户凭据已失效或暂停，当前无法发送。";
    sendFeedback.dataset.kind = "error";
  } else {
    sendFeedback.textContent = "";
  }

  const account = $("account");
  const serverSelection = next.selectedAccountId && next.selectedTarget
    ? `${next.selectedAccountId}\n${next.selectedTarget}`
    : "";
  const applyServerSelection = Boolean(
    serverSelection && serverSelection !== lastAppliedAutoSelection,
  );
  const selected = applyServerSelection ? next.selectedAccountId : account.value;
  account.replaceChildren(
    ...next.accounts.map((item) => {
      const option = document.createElement("option");
      option.value = item.accountId;
      option.textContent = `${displayName(item, item.accountId)}${item.credentialStatus === "stale" ? "（凭据失效）" : ""}`;
      return option;
    }),
  );
  if (next.accounts.some((item) => item.accountId === selected)) account.value = selected;

  const discovered = $("discovered-target");
  const selectedCandidate = applyServerSelection ? serverSelection : discovered.value;
  discovered.replaceChildren(
    Object.assign(document.createElement("option"), {
      value: "",
      textContent: "请先发送入站消息并重新查找",
    }),
    ...next.targets.map((item) => {
      const option = document.createElement("option");
      option.value = `${item.accountId}\n${item.target}`;
      const targetName = displayName(item, item.target);
      const accountItem = next.accounts.find((account) => account.accountId === item.accountId);
      option.textContent = `${targetName}（${displayName(accountItem, item.accountId)}）`;
      return option;
    }),
  );
  if (
    selectedCandidate &&
    [...discovered.options].some((option) => option.value === selectedCandidate)
  ) {
    discovered.value = selectedCandidate;
  } else if (next.targets.length === 1) {
    const onlyTarget = next.targets[0];
    discovered.value = `${onlyTarget.accountId}\n${onlyTarget.target}`;
  }
  if (applyServerSelection) lastAppliedAutoSelection = serverSelection;

  const selectedAccountId = account.value;
  const selectedTargetValue = discovered.value;
  const [, selectedTargetId = ""] = selectedTargetValue.split("\n");
  const selectedAccount = next.accounts.find((item) => item.accountId === selectedAccountId);
  const selectedTarget = next.targets.find(
    (item) => item.accountId === selectedAccountId && item.target === selectedTargetId,
  );
  $("target").value = selectedTarget ? displayName(selectedTarget, selectedTarget.target) : "";
  $("target").dataset.targetId = selectedTarget?.target || "";
  $("raw-account-id").textContent = selectedAccountId || "—";
  $("raw-target-id").textContent = selectedTargetId || "—";
  $("target-health").textContent = selectedTarget
    ? `最近入站：${formatTime(selectedTarget.lastInboundAt)} · 上下文更新：${formatTime(selectedTarget.contextUpdatedAt)} · 最近渠道接受发送：${formatTime(selectedTarget.lastSendAcceptedAt)}`
    : "请选择一个已同步的入站目标。context token 没有公开的固定有效期。";

  const experiment = next.contextTokenExperiment;
  $("context-experiment-status").textContent = experiment
    ? contextExperimentLabels[experiment.status] || experiment.status
    : "实验服务不可用";
  $("context-experiment-status").dataset.state = experiment?.status || "inactive";
  $("context-experiment-baseline").textContent = experiment?.baselineContextUpdatedAt
    ? formatTime(experiment.baselineContextUpdatedAt)
    : "—";
  const validityMs = experiment?.expiredAfterMs ?? experiment?.latestAcceptedElapsedMs ?? null;
  $("context-experiment-validity").textContent = experiment?.status === "expired"
    ? `首次拒绝：${formatElapsed(validityMs)}`
    : validityMs === null ? "尚未完成首测" : `至少 ${formatElapsed(validityMs)}`;
  $("context-experiment-next").textContent = experiment?.nextProbeAt
    ? formatTime(experiment.nextProbeAt)
    : "—";
  $("context-experiment-count").textContent = experiment
    ? `接受 ${experiment.acceptedProbes} / 尝试 ${experiment.attemptedProbes}`
    : "0 / 0";
  const providerCodes = [
    experiment?.providerRet !== undefined ? `ret=${experiment.providerRet}` : "",
    experiment?.providerErrcode !== undefined ? `errcode=${experiment.providerErrcode}` : "",
  ].filter(Boolean).join(" · ");
  $("context-experiment-detail").textContent = experiment
    ? `${experiment.wakeLockAvailable ? "空闲防睡眠已启动" : "空闲防睡眠未启动"}${providerCodes ? ` · ${providerCodes}` : ""} · 不保存或展示 context token。`
    : "不保存或展示 context token。";

  const labelSelection = `${selectedAccountId}\n${selectedTargetId}`;
  if (labelSelection !== lastLabelSelection) {
    $("account-label").value = selectedAccount?.label || "";
    $("target-label").value = selectedTarget?.label || "";
    lastLabelSelection = labelSelection;
  }

  const codex = next.codex;
  const accountModelState = codex?.models?.accounts?.find((item) => item.accountId === selectedAccountId);
  latestModelState = accountModelState ? { ...accountModelState, catalog: codex.models.catalog } : null;
  const modelRenderKey = `${selectedAccountId}:${latestModelState?.revision ?? -1}:${latestModelState?.catalog?.fetchedAt ?? -1}`;
  if (latestModelState && modelRenderKey !== lastRenderedModelKey) {
    $("codex-model-mode").value = latestModelState.selection.mode === "pinned" ? "pinned" : latestModelState.selection.track;
    syncModelInputs(true);
    lastRenderedModelKey = modelRenderKey;
  }
  const resolvedModel = latestModelState?.resolved;
  const modelSummary = $("codex-model-summary");
  if (resolvedModel?.available) {
    const effectiveModel = document.createElement("span");
    effectiveModel.className = "codex-effective-model";
    effectiveModel.textContent = resolvedModel.model;
    modelSummary.replaceChildren(
      document.createTextNode("当前生效："),
      effectiveModel,
      document.createTextNode(` · ${resolvedModel.effort} · ${resolvedModel.source === "track" ? "自动档位" : "固定模型"}${resolvedModel.degraded ? " · effort 已按目录默认值降级" : ""} · 配置版本 ${resolvedModel.configRevision} · 目录 ${latestModelState.catalog.fetchedAt ? formatTime(latestModelState.catalog.fetchedAt) : "内置基线"}`),
    );
  } else {
    modelSummary.textContent = latestModelState
      ? `当前配置不可用：${resolvedModel?.reason || "未知原因"}`
      : "回复模型配置不可用。";
  }
  $("codex-model-save").disabled = !selectedAccountId || !resolvedModel;
  $("codex-model-refresh").disabled = !codex;
  const codexTargetEnabled = Boolean(codex?.enabledTargets.some(
    (item) => item.accountId === selectedAccountId && item.target === selectedTargetId,
  ));
  $("codex-summary").textContent = codex
    ? `${codexStatusLabels[codex.status] || codex.status} · ${codex.notice}`
    : "独立 Codex 服务不可用。";
  $("codex-enable-button").disabled =
    !codex || !selectedTarget || codexTargetEnabled || ["starting", "thinking", "sending"].includes(codex.status);
  $("codex-disable-button").disabled = !codex || !selectedTarget || !codexTargetEnabled;
  const runContainer = $("codex-runs");
  const visibleRuns = codex?.runs.filter((run) =>
    !selectedTargetId || (run.accountId === selectedAccountId && run.target === selectedTargetId),
  ) || [];
  const visibleRunKeys = new Set();
  runContainer.replaceChildren(...visibleRuns.map((run) => {
    const runKey = `${run.accountId}\n${run.target}\n${run.runId || run.startedAt}`;
    visibleRunKeys.add(runKey);
    const card = document.createElement("article");
    card.className = "runtime-card";
    card.dataset.phase = run.phase;
    const title = document.createElement("strong");
    const targetItem = next.targets.find((item) => item.accountId === run.accountId && item.target === run.target);
    title.textContent = `${displayName(targetItem, run.target)} · ${runPhaseLabels[run.phase] || run.phase}`;
    const meta = document.createElement("small");
    meta.className = "runtime-meta";
    const totalDuration = run.totalDurationMs ?? (run.timings?.[0] ? Date.now() - run.timings[0].startedAt : null);
    meta.append(document.createTextNode(`更新 ${formatTime(run.updatedAt)}`));
    if (run.model) {
      const model = document.createElement("span");
      model.className = "runtime-model";
      model.textContent = `${run.model}/${run.reasoningEffort}`;
      meta.append(document.createTextNode(" · "), model);
    }
    if (totalDuration !== null) {
      const durationLabel = document.createElement("span");
      durationLabel.className = "runtime-duration-label";
      durationLabel.textContent = `${run.completedAt ? "总耗时" : "已运行"} `;
      const duration = document.createElement("span");
      duration.className = "runtime-duration";
      duration.dataset.tone = runtimeDurationTone(totalDuration);
      duration.textContent = formatDuration(totalDuration);
      meta.append(document.createTextNode(" · "), durationLabel, duration);
    }
    if (run.queueDepth) meta.append(document.createTextNode(` · 排队 ${run.queueDepth} 条`));
    if (run.activeTool) meta.append(document.createTextNode(` · ${run.activeTool}`));
    const concurrencyModel = buildRuntimeConcurrencyTimeline(run);
    const concurrency = document.createElement("section");
    concurrency.className = "runtime-concurrency";
    concurrency.setAttribute("aria-label", "并行时间轴");
    concurrency.hidden = !concurrencyModel.canRender;
    const laneDetails = new Map();
    if (!concurrency.hidden) {
      const legend = document.createElement("small");
      legend.className = "runtime-concurrency-legend";
      legend.textContent = "时间条按真实起止位置对齐，点击阶段查看明细。";
      const duration = Math.max(1, concurrencyModel.completedAt - concurrencyModel.startAt);
      const lanes = document.createElement("div");
      lanes.className = "runtime-concurrency-lanes";
      const populateTimelineRow = (row, label, segments, durationMs, outcome) => {
        const laneLabel = document.createElement("strong");
        laneLabel.textContent = label;
        const track = document.createElement("div");
        track.className = "runtime-concurrency-track";
        for (const segment of segments) {
          const bar = document.createElement("span");
          bar.className = "runtime-concurrency-segment";
          bar.dataset.segment = segment.id || segment.stage;
          bar.style.left = `${((segment.startedAt - concurrencyModel.startAt) / duration) * 100}%`;
          bar.style.width = `${((segment.completedAt - segment.startedAt) / duration) * 100}%`;
          bar.title = `${label} · ${formatDuration(segment.completedAt - segment.startedAt)}`;
          track.append(bar);
        }
        const laneDuration = document.createElement("span");
        laneDuration.className = "runtime-concurrency-duration";
        laneDuration.textContent = formatDuration(durationMs);
        const laneOutcome = document.createElement("small");
        laneOutcome.className = "runtime-concurrency-outcome";
        laneOutcome.textContent = outcome ? runTimingOutcomeLabels[outcome] || outcome : "进行中";
        row.append(laneLabel, track, laneDuration, laneOutcome);
      };
      for (const timing of concurrencyModel.serialStages) {
        const stage = document.createElement("div");
        stage.className = "runtime-concurrency-row runtime-concurrency-serial-stage";
        stage.dataset.stage = timing.stage;
        populateTimelineRow(
          stage,
          runTimingStageLabels[timing.stage] || timing.stage,
          [{ ...timing, id: timing.stage }],
          timing.completedAt - timing.startedAt,
          timing.outcome,
        );
        lanes.append(stage);
      }
      const expandedLaneId = runtimeExpandedLanes.has(runKey)
        ? runtimeExpandedLanes.get(runKey)
        : concurrencyModel.defaultExpandedLaneId;
      for (const lane of concurrencyModel.lanes) {
        const laneElement = document.createElement("details");
        laneElement.className = "runtime-concurrency-lane";
        laneElement.dataset.lane = lane.id;
        laneElement.open = expandedLaneId === lane.id;
        const summary = document.createElement("summary");
        summary.className = "runtime-concurrency-row";
        populateTimelineRow(summary, lane.label, lane.segments, lane.durationMs, lane.outcome);
        const details = document.createElement("ol");
        details.className = "runtime-lane-details";
        laneDetails.set(lane.id, details);
        laneElement.append(summary, details);
        summary.addEventListener("click", (event) => {
          event.preventDefault();
          const shouldOpen = !laneElement.open;
          for (const sibling of lanes.querySelectorAll(".runtime-concurrency-lane")) {
            sibling.open = shouldOpen && sibling === laneElement;
          }
          runtimeExpandedLanes.set(runKey, shouldOpen ? lane.id : "");
        });
        lanes.append(laneElement);
      }
      concurrency.append(legend, lanes);
    }
    const timings = document.createElement("ol");
    timings.className = "runtime-timings";
    const timingItems = new Map();
    for (const timing of run.timings || []) {
      const item = document.createElement("li");
      const label = document.createElement("strong");
      label.textContent = runTimingStageLabels[timing.stage] || timing.stage;
      const duration = document.createElement("span");
      duration.textContent = formatDuration(timing.durationMs ?? (Date.now() - timing.startedAt));
      const outcome = document.createElement("small");
      outcome.textContent = timing.outcome ? runTimingOutcomeLabels[timing.outcome] || timing.outcome : "进行中";
      item.append(label, duration, outcome);
      timingItems.set(timing.stage, { item, label, timing });
      if (timing.stage === "typing_start" && run.typingDiagnostics) {
        const diagnostics = document.createElement("ol");
        diagnostics.className = "runtime-typing-diagnostics";
        const appendDiagnostic = (name, value, result) => {
          const diagnostic = document.createElement("li");
          const diagnosticName = document.createElement("strong");
          diagnosticName.textContent = name;
          const diagnosticValue = document.createElement("span");
          diagnosticValue.textContent = value;
          const diagnosticOutcome = document.createElement("small");
          diagnosticOutcome.textContent = result;
          diagnostic.append(diagnosticName, diagnosticValue, diagnosticOutcome);
          diagnostics.append(diagnostic);
        };
        appendDiagnostic(
          "ticket 缓存",
          run.typingDiagnostics.ticketCache === "hit" ? "命中" : "未命中",
          "脱敏状态",
        );
        for (const [name, step] of [
          ["getconfig", run.typingDiagnostics.getConfig],
          ["sendtyping", run.typingDiagnostics.sendStart],
        ]) {
          appendDiagnostic(
            name,
            formatDuration(step.durationMs),
            runTimingOutcomeLabels[step.outcome] || step.outcome,
          );
        }
        item.append(diagnostics);
      }
      if (timing.stage === "outbound" && run.outboundDiagnostics) {
        const diagnostics = document.createElement("ol");
        diagnostics.className = "runtime-outbound-diagnostics";
        const appendDiagnostic = (name, value, result) => {
          const diagnostic = document.createElement("li");
          const diagnosticName = document.createElement("strong");
          diagnosticName.textContent = name;
          const diagnosticValue = document.createElement("span");
          diagnosticValue.textContent = value;
          const diagnosticOutcome = document.createElement("small");
          diagnosticOutcome.textContent = result;
          diagnostic.append(diagnosticName, diagnosticValue, diagnosticOutcome);
          diagnostics.append(diagnostic);
        };
        for (const [name, step] of [
          ["准备正文", run.outboundDiagnostics.prepare],
          ["sendmessage", run.outboundDiagnostics.sendMessage],
          ["读取响应", run.outboundDiagnostics.responseRead],
          ["保存发送状态", run.outboundDiagnostics.stateSave],
        ]) {
          appendDiagnostic(
            name,
            formatDuration(step.durationMs),
            runTimingOutcomeLabels[step.outcome] || step.outcome,
          );
        }
        appendDiagnostic("请求", `${run.outboundDiagnostics.requestCount} 次`, "脱敏计数");
        item.append(diagnostics);
      }
      if (timing.stage === "agent") {
        const agentTimings = document.createElement("ol");
        agentTimings.className = "runtime-agent-timings";
        let toolNumber = 0;
        for (const agentTiming of run.agentTimings || []) {
          const agentItem = document.createElement("li");
          const agentLabel = document.createElement("strong");
          if (agentTiming.stage === "tool_execution") {
            toolNumber += 1;
            agentLabel.textContent = `工具 ${toolNumber} · ${agentTiming.label || agentTimingStageLabels.tool_execution}`;
          } else {
            agentLabel.textContent = agentTimingStageLabels[agentTiming.stage] || agentTiming.stage;
          }
          const agentDuration = document.createElement("span");
          agentDuration.textContent = formatDuration(agentTiming.durationMs ?? (Date.now() - agentTiming.startedAt));
          const agentOutcome = document.createElement("small");
          agentOutcome.textContent = agentTiming.outcome
            ? runTimingOutcomeLabels[agentTiming.outcome] || agentTiming.outcome
            : "进行中";
          agentItem.append(agentLabel, agentDuration, agentOutcome);
          agentTimings.append(agentItem);
        }
        if (!(run.agentTimings || []).length) {
          const empty = document.createElement("li");
          empty.className = "runtime-agent-timings-empty";
          empty.textContent = "旧运行记录暂无 Codex 内部分段耗时。";
          agentTimings.append(empty);
        }
        if (run.agentTimingsTruncated) {
          const truncated = document.createElement("li");
          truncated.className = "runtime-agent-timings-empty";
          truncated.textContent = "内部阶段过多，仅显示前 50 条。";
          agentTimings.append(truncated);
        }
        item.append(agentTimings);
      }
      timings.append(item);
    }
    if (!(run.timings || []).length) {
      const item = document.createElement("li");
      item.className = "runtime-timings-empty";
      item.textContent = "旧运行记录暂无分段耗时。";
      timings.append(item);
    }
    if (!concurrency.hidden) {
      const typingDetails = laneDetails.get("typing");
      const typingStartEntry = timingItems.get("typing_start");
      const typingStopEntry = timingItems.get("typing_stop");
      if (typingDetails && typingStartEntry) {
        typingStartEntry.label.textContent = "启动";
        typingDetails.append(typingStartEntry.item);
        const activeSegment = concurrencyModel.lanes
          .find((lane) => lane.id === "typing")
          ?.segments.find((segment) => segment.id === "typing-active");
        const active = document.createElement("li");
        const activeLabel = document.createElement("strong");
        activeLabel.textContent = "状态持续";
        const activeDuration = document.createElement("span");
        activeDuration.textContent = activeSegment
          ? formatDuration(activeSegment.completedAt - activeSegment.startedAt)
          : "未启动";
        const activeOutcome = document.createElement("small");
        activeOutcome.textContent = activeSegment ? "已完成" : "不可用";
        active.append(activeLabel, activeDuration, activeOutcome);
        typingDetails.append(active);
      }
      if (typingDetails && typingStopEntry) {
        typingStopEntry.label.textContent = "关闭";
        typingDetails.append(typingStopEntry.item);
      }
      const agentDetails = laneDetails.get("agent");
      const agentEntry = timingItems.get("agent");
      if (agentDetails && agentEntry) agentDetails.append(agentEntry.item);
      const outboundDetails = laneDetails.get("outbound");
      const outboundEntry = timingItems.get("outbound");
      if (outboundDetails && outboundEntry) outboundDetails.append(outboundEntry.item);
    }
    const steps = document.createElement("ul");
    steps.className = "runtime-steps";
    for (const step of run.recentSteps.slice(-6)) {
      const item = document.createElement("li");
      item.textContent = `${step.label} · ${toolStatusLabels[step.status] || step.status}`;
      steps.append(item);
    }
    card.append(title, meta);
    card.append(concurrency.hidden ? timings : concurrency, steps);
    return card;
  }));
  for (const key of runtimeExpandedLanes.keys()) {
    if (!visibleRunKeys.has(key)) runtimeExpandedLanes.delete(key);
  }
  if (!visibleRuns.length) runContainer.textContent = "当前目标尚无运行记录。";
  const permissions = codex?.permissions;
  currentPermissions = permissions || null;
  $("vault-summary").textContent = permissions
    ? `权限模式：${permissions.mode} · ${permissions.onboardingCompleted ? "已配置" : "等待首次设置"}`
    : "本地执行：不可用";
  $("permission-capability").textContent = permissions?.capability.restrictedReadSupported
    ? "当前 Codex 支持严格目录隔离，可以继续完成首次设置。"
    : "当前 Codex 版本不支持严格目录隔离；三档权限暂不能启用。";
  if (permissions && (!permissionDirty || lastPermissionRevision !== permissions.revision)) {
    const selectedRootIds = new Set(permissions.selectedRoots.map((root) => root.id));
    document.querySelectorAll('input[name="permission-mode"]').forEach((input) => {
      input.checked = permissions.onboardingCompleted && input.value === permissions.mode;
      input.disabled = !permissions.capability.restrictedReadSupported;
    });
    $("permission-roots").replaceChildren(...permissions.candidates.map((candidate) => {
      const label = document.createElement("label");
      label.className = "permission-root";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "permission-root";
      input.value = candidate.id;
      input.checked = selectedRootIds.has(candidate.id);
      input.disabled = !permissions.capability.restrictedReadSupported;
      input.addEventListener("change", () => {
        permissionDirty = true;
        syncPermissionSubmit();
      });
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = candidate.displayName;
      const path = document.createElement("small");
      path.textContent = candidate.path;
      text.append(name, path);
      label.append(input, text);
      return label;
    }));
    $("permission-confirmed").checked = false;
    lastPermissionRevision = permissions.revision;
    permissionDirty = false;
  }
  syncPermissionSubmit();
  const mediaExports = next.mediaExports;
  if (mediaExports && (!mediaExportDirty || lastMediaExportRevision !== mediaExports.revision)) {
    const statusLabels = { available: "可用", missing: "目录不存在", blocked: "被 macOS 阻止", changed: "目录已变化，请重新授权" };
    $("media-export-roots").replaceChildren(...mediaExports.roots.map((root) => {
      const label = document.createElement("label");
      label.className = "permission-root";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "media-export-root";
      input.value = root.id;
      input.checked = root.enabled;
      input.disabled = root.status !== "available";
      input.addEventListener("change", () => {
        mediaExportDirty = true;
        $("media-export-submit").disabled = !$("media-export-confirmed").checked;
      });
      const text = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = root.displayName;
      const status = document.createElement("small");
      status.textContent = statusLabels[root.status] || root.status;
      text.append(name, status);
      label.append(input, text);
      return label;
    }));
    $("media-export-confirmed").checked = false;
    $("media-export-submit").disabled = true;
    lastMediaExportRevision = mediaExports.revision;
    mediaExportDirty = false;
  }
  const memoryAccount = codex?.memory?.accounts.find(
    (item) => item.accountId === selectedAccountId,
  );
  const memoryScope = `${selectedAccountId}\n${selectedTargetId}`;
  if (memoryFeedbackScope && memoryFeedbackScope !== memoryScope) setMemoryFeedback("");
  memoryFeedbackScope = memoryScope;
  $("memory-current-account").textContent = selectedAccountId
    ? displayName(selectedAccount, selectedAccountId)
    : "尚未选择";
  $("memory-current-target").textContent = selectedTargetId
    ? displayName(selectedTarget, selectedTargetId)
    : "尚未选择";
  const memoryAvailable = Boolean(codex?.memory?.available);
  const memoryMutation = memoryAccount?.lastMutation
    ? ` · 最近提交 +${memoryAccount.lastMutation.added} / ~${memoryAccount.lastMutation.updated} / -${memoryAccount.lastMutation.removed}`
    : "";
  const memoryRetry = memoryAccount?.nextAttemptAt
    ? ` · 下次重试 ${new Date(memoryAccount.nextAttemptAt).toLocaleString()}`
    : "";
  const memoryClarification = memoryAccount?.clarificationReason === "target_ambiguous"
    ? " · 找到多个可能目标，请在微信中说明对应的提醒序号或具体事项"
    : memoryAccount?.clarificationReason === "target_missing"
      ? " · 未找到对应旧记忆；如需新建，请明确说“记住……”"
      : memoryAccount?.clarificationReason === "outcome_ambiguous"
        ? " · 无法确认该计划是已完成、未落实还是取消，请在微信中补充说明"
      : "";
  $("memory-summary").textContent = !memoryAvailable
    ? "账户记忆功能不可用。"
    : memoryAccount
      ? `${memoryStatusLabels[memoryAccount.status] || memoryAccount.status} · 已记录 ${memoryAccount.entryCount} 条 · 待整理 ${memoryAccount.pendingCount} 批 · 每个完成的对话回合自动整理${memoryMutation}${memoryRetry}${memoryClarification}${memoryAccount.lastError ? ` · ${memoryAccount.lastError}` : ""}`
      : "当前账户尚未启用长期记忆。";
  const embedding = memoryAccount?.embedding;
  const embeddingStateLabels = {
    idle: "尚未构建",
    building: "正在后台迁移",
    active: "已生效",
    failed: "迁移失败，继续使用原索引",
  };
  const embeddingErrorLabels = {
    memory_embedding_build_failed: "模型加载或索引构建失败；当前索引保持可用",
    memory_embedding_dimensions_invalid: "模型输出维度无效；当前索引保持可用",
    memory_embedding_result_missing: "模型输出不完整；当前索引保持可用",
    memory_embedding_coverage_incomplete: "构建期间记忆发生变化，系统会重新维护索引",
  };
  $("memory-embedding-summary").textContent = !memoryAvailable
    ? "语义索引不可用。"
    : !embedding
      ? "尚未读取到语义索引状态。"
      : `语义索引：${embeddingStateLabels[embedding.state] || embedding.state}`
        + `${embedding.activeModel ? ` · 当前 ${shortEmbeddingModel(embedding.activeModel)}` : ""}`
        + `${embedding.candidateModel ? ` · 候选 ${shortEmbeddingModel(embedding.candidateModel)}` : ""}`
        + `${embedding.rollbackModel ? ` · 可回滚 ${shortEmbeddingModel(embedding.rollbackModel)}` : ""}`
        + ` · ${embedding.indexedEntries}/${embedding.totalEntries} 条 · 代次 ${embedding.generation}`
        + `${embedding.lastError ? ` · ${embeddingErrorLabels[embedding.lastError] || "迁移暂时失败；当前索引保持可用"}` : ""}`;
  const memoryAttempts = memoryAccount?.recentAttempts || [];
  $("memory-diagnostics").textContent = memoryAttempts.length > 0
    ? memoryAttempts.map((attempt) => {
        const fields = [
          `${formatTime(attempt.finishedAt)} · 本任务第 ${attempt.attempt} 次`,
          memoryAttemptStageLabels[attempt.stage] || attempt.stage,
          memoryAttemptOutcomeLabels[attempt.outcome] || attempt.outcome,
          `耗时 ${attempt.durationMs} ms`,
        ];
        if (attempt.errorMessage) fields.push(attempt.errorMessage);
        if (attempt.retryScheduledAt) fields.push(`计划重试 ${formatTime(attempt.retryScheduledAt)}`);
        return fields.join(" · ");
      }).join("\n")
    : "暂无尝试诊断。新产生的整理任务会在这里记录阶段、耗时、结果和安全错误码。";
  $("memory-content").textContent = memoryAccount?.memory || "当前账户尚未启用长期记忆。";
  $("events-summary").textContent = memoryAccount
    ? `默认窗口：过去 30 天至未来 7 天 · 显示 ${memoryAccount.displayedEventCount ?? 0}/${memoryAccount.eventCount ?? 0} 条 · 计划提醒目标${memoryAccount.planFollowUp?.targetConfirmed ? "已确认" : "未确认"} · 当前到期 ${memoryAccount.planFollowUp?.dueCount ?? 0} 条${memoryAccount.planFollowUp?.unknownCount ? ` · ${memoryAccount.planFollowUp.unknownCount} 条发送结果未知，已停止自动重试` : ""}`
    : "默认显示过去 30 天和未来 7 天的事件。";
  $("events-content").textContent = memoryAccount?.events || "当前时间窗口内没有事件。";
  const memoryEnabled = Boolean(memoryAccount?.enabled);
  const reminderTargetSelected = Boolean(
    selectedTargetId && memoryAccount?.planFollowUp?.reminderTarget === selectedTargetId,
  );
  const accountStatus = $("memory-account-status");
  accountStatus.textContent = !selectedAccountId
    ? "未选择"
    : !memoryAvailable
      ? "不可用"
      : memoryEnabled
        ? "已启用"
        : "已停用";
  accountStatus.dataset.state = !selectedAccountId || !memoryAvailable
    ? "unselected"
    : memoryEnabled
      ? "enabled"
      : "disabled";
  const targetStatus = $("memory-target-status");
  targetStatus.textContent = !selectedTargetId
    ? "未选择"
    : reminderTargetSelected
      ? "已设置"
      : "未设置";
  targetStatus.dataset.state = !selectedTargetId
    ? "unselected"
    : reminderTargetSelected
      ? "configured"
      : "unconfigured";
  $("memory-enable-button").textContent = memoryEnabled ? "记忆已启用" : "为当前账户启用记忆";
  $("memory-disable-button").textContent = memoryEnabled ? "停用当前账户记忆" : "记忆已停用";
  $("memory-reminder-target-button").textContent = reminderTargetSelected
    ? "当前目标已设为提醒接收人"
    : "将当前目标设置为计划提醒接收人";
  $("memory-enable-button").disabled = memoryActionPending || !memoryAvailable || !selectedAccountId || memoryEnabled;
  $("memory-disable-button").disabled = memoryActionPending || !memoryAvailable || !memoryEnabled;
  $("memory-reminder-target-button").disabled = memoryActionPending || !memoryAvailable || !memoryEnabled || !selectedTarget || reminderTargetSelected;
  const transcript = $("codex-transcript");
  transcript.replaceChildren(
    ...(codex?.transcript.slice(-20).map((entry) => {
      const bubble = document.createElement("article");
      bubble.className = "message";
      bubble.dataset.role = entry.role;
      const targetItem = next.targets.find(
        (item) => item.accountId === entry.accountId && item.target === entry.target,
      );
      const text = document.createElement("p");
      text.textContent = entry.text;
      const meta = document.createElement("small");
      meta.textContent = `${entry.role === "user" ? displayName(targetItem, entry.target) : "Codex"} · ${formatTime(entry.createdAt)} · ${entry.status}`;
      bubble.append(text, meta);
      return bubble;
    }) || []),
  );

  const dailyNews = next.dailyNews;
  const alertStatuses = new Set(["context_refresh_required", "auth_relogin_required", "rejected", "unknown"]);
  const noticeNeedsAttention = new Set(["context_refresh_required", "unknown", "failed"]);
  const newsNeedsAttention = Boolean(dailyNews?.lastRun && (
    alertStatuses.has(dailyNews.lastRun.status) ||
    noticeNeedsAttention.has(dailyNews.lastRun.failureNoticeStatus)
  ));
  $("news-alert-badge").hidden = !newsNeedsAttention;
  $("global-alert").hidden = !newsNeedsAttention;
  if (newsNeedsAttention) {
    const code = dailyNews.lastRun.providerRet ?? dailyNews.lastRun.providerErrcode;
    const label = dailyNews.lastRun.status === "failed" && dailyNews.lastRun.failureNoticeStatus
      ? `${newsStatusLabels[dailyNews.lastRun.status] || dailyNews.lastRun.status}，且${newsFailureNoticeLabels[dailyNews.lastRun.failureNoticeStatus] || dailyNews.lastRun.failureNoticeStatus}`
      : newsStatusLabels[dailyNews.lastRun.status] || dailyNews.lastRun.status;
    $("global-alert").textContent = `${label}${code !== undefined ? `（iLink ${code}）` : ""}。请在“每日新闻”查看处理方式。`;
  }
  const newsTargetEnabled = Boolean(
    dailyNews?.enabledTarget?.accountId === selectedAccountId &&
    dailyNews?.enabledTarget?.target === selectedTargetId,
  );
  const nextRun = dailyNews?.nextRunAt ? formatTime(dailyNews.nextRunAt) : "未安排";
  const retryDetails = dailyNews?.lastRun?.status === "failed"
    ? [
        dailyNews.lastRun.attempt ? `第 ${dailyNews.lastRun.attempt} 次尝试` : "",
        newsFailureStageLabels[dailyNews.lastRun.failureStage] || "",
        newsFailureCodeLabels[dailyNews.lastRun.failureCode] || "",
        dailyNews.lastRun.nextRetryAt ? `后台重试：${formatTime(dailyNews.lastRun.nextRetryAt)}` : "今日不再重试",
        newsFailureNoticeLabels[dailyNews.lastRun.failureNoticeStatus] || "",
      ].filter(Boolean).join(" · ")
    : "";
  const recoveredFailureDetails = dailyNews?.lastRun?.status !== "failed" && dailyNews?.lastRun?.lastFailure
    ? [
        `曾在第 ${dailyNews.lastRun.lastFailure.attempt} 次失败`,
        newsFailureStageLabels[dailyNews.lastRun.lastFailure.stage] || "",
        newsFailureCodeLabels[dailyNews.lastRun.lastFailure.code] || "",
        "后续已恢复",
      ].filter(Boolean).join(" · ")
    : "";
  const lastRun = dailyNews?.lastRun
    ? `${dailyNews.lastRun.runKey} · ${newsStatusLabels[dailyNews.lastRun.status] || dailyNews.lastRun.status}${retryDetails ? ` · ${retryDetails}` : ""}${recoveredFailureDetails ? ` · ${recoveredFailureDetails}` : ""}`
    : "尚无运行记录";
  const archive = dailyNews?.archive
    ? ` · Vault：${dailyNews.archive.summaryPath}，正文 ${dailyNews.archive.archivedCount}/${dailyNews.archive.totalCount}${dailyNews.archive.hackerNewsTopPath ? `，HN 热门归档：${dailyNews.archive.hackerNewsTopPath}` : ""}`
    : "";
  $("news-summary").textContent = dailyNews
    ? `${newsStatusLabels[dailyNews.status] || dailyNews.status} · 下次：${nextRun} · 最近：${lastRun}${archive} · ${dailyNews.notice}`
    : "每日 AI 新闻服务不可用。";
  $("news-preview").textContent = dailyNews?.previewMessage || "尚未生成预览。";
  $("news-preview-button").disabled = !dailyNews || dailyNews.status === "researching" || dailyNews.status === "sending";
  $("news-send-button").disabled = !dailyNews?.previewMessage || !selectedTarget || dailyNews.status === "sending";
  $("news-enable-button").disabled = !dailyNews || !selectedTarget || newsTargetEnabled || dailyNews.status === "researching" || dailyNews.status === "sending";
  $("news-disable-button").disabled = !dailyNews?.enabledTarget || dailyNews.status === "sending";
}

function syncPermissionSubmit() {
  const supported = Boolean(currentPermissionState()?.capability.restrictedReadSupported);
  const mode = document.querySelector('input[name="permission-mode"]:checked');
  const roots = document.querySelectorAll('input[name="permission-root"]:checked');
  $("permission-submit").disabled = !supported || !mode || roots.length === 0 || !$("permission-confirmed").checked;
}

function currentPermissionState() {
  return currentPermissions;
}

async function run(action) {
  $("error").textContent = "";
  try {
    render(await action());
  } catch (error) {
    $("error").textContent = error instanceof Error ? error.message : "请求失败";
    await refresh();
  }
}

function setMemoryFeedback(message, kind = "") {
  const feedback = $("memory-feedback");
  feedback.textContent = message;
  feedback.dataset.kind = kind;
}

async function runMemoryAction(pendingMessage, successMessage, action) {
  const actionScope = memoryFeedbackScope;
  $("error").textContent = "";
  memoryActionPending = true;
  setMemoryFeedback(pendingMessage, "pending");
  for (const id of ["memory-enable-button", "memory-disable-button", "memory-reminder-target-button"]) {
    $(id).disabled = true;
  }
  try {
    const next = await action();
    memoryActionPending = false;
    render(next);
    if (memoryFeedbackScope === actionScope) setMemoryFeedback(successMessage);
  } catch (error) {
    memoryActionPending = false;
    const message = error instanceof Error ? error.message : "请求失败";
    await refresh();
    if (memoryFeedbackScope === actionScope) {
      $("error").textContent = message;
      setMemoryFeedback(`操作失败：${message}`, "error");
    }
  }
}

async function refresh() {
  const response = await fetch("/api/state", { cache: "no-store" });
  if (reloadWhenUnauthorized(response)) return;
  render(await response.json());
}

$("login-button").addEventListener("click", () => run(() => api("/api/login/start")));
$("discover-button").addEventListener("click", () => run(() => api("/api/session/discover")));
$("discovered-target").addEventListener("change", (event) => {
  const [accountId, target] = event.currentTarget.value.split("\n");
  if (!accountId || !target) return;
  $("account").value = accountId;
  lastLabelSelection = "";
  refresh();
});
$("account").addEventListener("change", () => {
  lastLabelSelection = "";
  refresh();
});
$("save-labels-button").addEventListener("click", () => {
  const [candidateAccountId, candidateTarget] = $("discovered-target").value.split("\n");
  const accountId = candidateAccountId || $("account").value;
  run(() =>
    api("/api/labels", {
      accountId,
      accountLabel: $("account-label").value,
      ...(candidateTarget
        ? { target: candidateTarget, targetLabel: $("target-label").value }
        : {}),
    }),
  );
});
$("pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => api("/api/login/code", { code: $("pair-code").value }));
});
$("send-form").addEventListener("submit", (event) => {
  event.preventDefault();
  run(() => api("/api/send", { message: $("message").value }));
});
$("codex-enable-button").addEventListener("click", () => {
  const [accountId, target] = $("discovered-target").value.split("\n");
  run(async () => {
    const next = await api("/api/codex/enable", { accountId, target });
    $("codex-feedback").textContent = "已启用独立 Codex 服务。请从微信发送一条新的文本消息。";
    return next;
  });
});
$("codex-disable-button").addEventListener("click", () => {
  const [accountId, target] = $("discovered-target").value.split("\n");
  run(async () => {
    const next = await api("/api/codex/disable", { accountId, target });
    $("codex-feedback").textContent = "已停用当前目标的 Codex 自动回复。";
    return next;
  });
});
$("codex-model-mode").addEventListener("change", () => syncModelInputs(false));
$("codex-pinned-model").addEventListener("change", () => syncModelInputs(false));
$("codex-model-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const mode = $("codex-model-mode").value;
  run(async () => {
    const next = await api("/api/codex/model/configure", {
      accountId: $("account").value,
      mode: mode === "pinned" ? "pinned" : "track",
      ...(mode === "pinned" ? { model: $("codex-pinned-model").value } : { track: mode }),
      effort: $("codex-model-effort").value,
    });
    $("codex-model-feedback").textContent = "已保存，将从下一条新微信消息开始生效。";
    return next;
  });
});
$("codex-model-refresh").addEventListener("click", () => {
  run(async () => {
    const next = await api("/api/codex/model/refresh", {});
    $("codex-model-feedback").textContent = "模型列表已刷新。";
    return next;
  });
});
$("memory-enable-button").addEventListener("click", () => {
  const accountId = $("account").value;
  void runMemoryAction(
    "正在为当前账户启用记忆……",
    "已为当前账户启用记忆。",
    () => api("/api/codex/memory/enable", { accountId }),
  );
});
$("memory-disable-button").addEventListener("click", () => {
  const accountId = $("account").value;
  void runMemoryAction(
    "正在停用当前账户记忆……",
    "已停用当前账户记忆。",
    () => api("/api/codex/memory/disable", { accountId }),
  );
});
$("memory-reminder-target-button").addEventListener("click", () => {
  const [accountId, target] = $("discovered-target").value.split("\n");
  void runMemoryAction(
    "正在设置计划提醒接收人……",
    "已将当前目标设置为计划提醒接收人。",
    () => api("/api/codex/memory/notification-target", { accountId, target }),
  );
});
for (const tab of [$("memory-tab"), $("events-tab")]) {
  tab.addEventListener("click", () => selectMemoryTab(tab.id === "events-tab" ? "events" : "memory"));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    selectMemoryTab(event.key === "ArrowRight" || event.key === "End" ? "events" : "memory", true);
  });
}

for (const [index, item] of appTabs.entries()) {
  const tab = $(item.tabId);
  tab.addEventListener("click", () => selectAppTab(item.name));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const destination = event.key === "Home"
      ? 0
      : event.key === "End"
        ? appTabs.length - 1
        : event.key === "ArrowRight"
          ? (index + 1) % appTabs.length
          : (index - 1 + appTabs.length) % appTabs.length;
    selectAppTab(appTabs[destination].name, true);
  });
}

for (const [id, filter] of [["workflow-filter-all", "all"], ["workflow-filter-attention", "attention"]]) {
  $(id).addEventListener("click", () => {
    workflowFilter = filter;
    $("workflow-filter-all").setAttribute("aria-pressed", String(filter === "all"));
    $("workflow-filter-attention").setAttribute("aria-pressed", String(filter === "attention"));
    renderWorkflowState(latestWorkflowState);
  });
}

function selectAppTab(name, focus = false) {
  const content = $("app-tab-content");
  appTabScrollPositions.set(selectedAppTab, content.scrollTop);
  selectedAppTab = name;
  for (const item of appTabs) {
    const selected = item.name === selectedAppTab;
    $(item.tabId).setAttribute("aria-selected", String(selected));
    $(item.tabId).tabIndex = selected ? 0 : -1;
    $(item.panelId).hidden = !selected;
  }
  content.scrollTop = appTabScrollPositions.get(selectedAppTab) ?? 0;
  if (focus) $(appTabs.find((item) => item.name === selectedAppTab).tabId).focus();
}

function selectMemoryTab(name, focus = false) {
  selectedMemoryTab = name;
  const eventsSelected = selectedMemoryTab === "events";
  $("memory-tab").setAttribute("aria-selected", String(!eventsSelected));
  $("events-tab").setAttribute("aria-selected", String(eventsSelected));
  $("memory-tab").tabIndex = eventsSelected ? -1 : 0;
  $("events-tab").tabIndex = eventsSelected ? 0 : -1;
  $("memory-tabpanel").hidden = eventsSelected;
  $("events-tabpanel").hidden = !eventsSelected;
  if (focus) $(eventsSelected ? "events-tab" : "memory-tab").focus();
}
document.querySelectorAll('input[name="permission-mode"]').forEach((input) => {
  input.addEventListener("change", () => {
    permissionDirty = true;
    syncPermissionSubmit();
  });
});
$("permission-confirmed").addEventListener("change", () => {
  permissionDirty = true;
  syncPermissionSubmit();
});
$("permission-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const mode = document.querySelector('input[name="permission-mode"]:checked')?.value;
  const rootIds = [...document.querySelectorAll('input[name="permission-root"]:checked')]
    .map((input) => input.value);
  run(async () => {
    const next = await api("/api/codex/permissions/configure", {
      mode,
      rootIds,
      confirmed: $("permission-confirmed").checked,
    });
    permissionDirty = false;
    $("permission-feedback").textContent = "权限设置已保存，将从下一条微信消息开始生效。";
    return next;
  });
});
$("media-export-confirmed").addEventListener("change", () => {
  mediaExportDirty = true;
  $("media-export-submit").disabled = !$("media-export-confirmed").checked;
});
$("media-export-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const rootIds = [...document.querySelectorAll('input[name="media-export-root"]:checked')]
    .map((input) => input.value);
  run(async () => {
    const next = await api("/api/media-exports/configure", {
      rootIds,
      confirmed: $("media-export-confirmed").checked,
    });
    mediaExportDirty = false;
    $("media-export-feedback").textContent = rootIds.length
      ? "微信图片外发目录已保存，从下一条微信消息开始生效。"
      : "微信图片外发目录已全部撤销。";
    return next;
  });
});
$("news-preview-button").addEventListener("click", () => {
  run(async () => {
    const next = await api("/api/news/preview", {});
    $("news-feedback").textContent = "今日预览已生成，尚未发送微信。";
    return next;
  });
});
$("news-send-button").addEventListener("click", () => {
  const [accountId, target] = $("discovered-target").value.split("\n");
  run(async () => {
    const next = await api("/api/news/send-preview", { accountId, target });
    $("news-feedback").textContent = "渠道已接受日报预览，请在微信端确认是否收到。";
    return next;
  });
});
$("news-enable-button").addEventListener("click", () => {
  const [accountId, target] = $("discovered-target").value.split("\n");
  run(async () => {
    const next = await api("/api/news/enable", { accountId, target });
    $("news-feedback").textContent = "已启用 AI 新闻日报，按已保存的执行规则运行；可在微信中查看或修改设置。";
    return next;
  });
});
$("news-disable-button").addEventListener("click", () => {
  run(async () => {
    const next = await api("/api/news/disable", {});
    $("news-feedback").textContent = "已停用每日 AI 新闻。";
    return next;
  });
});

refresh();
setInterval(refresh, 1500);
