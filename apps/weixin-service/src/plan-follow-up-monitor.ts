import type { AccountMemoryStore } from "./account-memory-store.js";
import type { SendTextResult } from "./channel-contract.js";
import type { NotificationDestination, OwnerNotificationRoute } from "./notification-channel.js";

export type PlanTimePrecision = "date" | "morning" | "afternoon" | "evening" | "exact";

export type DuePlanReminder = {
  id: string;
  summary: string;
  localDate: string;
  timePrecision: PlanTimePrecision;
  localTime?: string;
  reminderCount: number;
  scheduledAt?: number;
  notificationDestination?: NotificationDestination;
};

export type PlanReminderSegment = {
  message: string;
  planIds: string[];
};

type PlanFollowUpMonitorOptions = {
  store: AccountMemoryStore;
  sender(input: NotificationDestination & { message: string; operationId: string }): Promise<SendTextResult>;
  notificationRoute?: OwnerNotificationRoute;
  onError?: (error: unknown) => void;
  now?: () => number;
  pollIntervalMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout> | number;
  clearTimer?: (timer: ReturnType<typeof setTimeout> | number) => void;
};

export class PlanFollowUpMonitor {
  private closed = false;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | number | undefined;
  private accountIds: (() => string[]) | undefined;

  constructor(private readonly options: PlanFollowUpMonitorOptions) {}

  start(accountIds: () => string[]): void {
    if (this.closed || this.accountIds) return;
    this.accountIds = accountIds;
    void this.runNow(accountIds()).catch((error) => this.options.onError?.(error)).finally(() => this.arm());
  }

  async runNow(accountIds: string[]): Promise<void> {
    if (this.closed) return;
    if (this.running) return this.running;
    const run = this.scan([...new Set(accountIds)]).finally(() => {
      if (this.running === run) this.running = undefined;
    });
    this.running = run;
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) {
      (this.options.clearTimer ?? clearTimeout)(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  private arm(): void {
    if (this.closed || !this.accountIds || this.timer !== undefined) return;
    const setTimer = this.options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    this.timer = setTimer(() => {
      this.timer = undefined;
      if (!this.accountIds) return;
      void this.runNow(this.accountIds()).catch((error) => this.options.onError?.(error)).finally(() => this.arm());
    }, this.options.pollIntervalMs ?? 60_000);
  }

  private async scan(accountIds: string[]): Promise<void> {
    for (const accountId of accountIds) {
      if (this.closed) return;
      const route = this.options.notificationRoute;
      if (route && !route.ownsMemoryScope(accountId)) continue;
      this.options.store.recoverInterruptedReminderAttempts(accountId, this.options.now?.() ?? Date.now());
      if (route?.capturesCreationDestination) {
        this.options.store.migratePlanNotificationDestinations(accountId, () => {
          const destination = route.legacyMemoryDestination(accountId);
          if (!destination) throw new Error("memory_plan_origin_unbound");
          return destination;
        });
      }
      const target = this.options.store.notificationTarget(accountId);
      const legacyDelivery = target ? route?.memoryDestination(accountId, target) ?? (route ? undefined : { accountId, target }) : undefined;
      if (!route?.capturesCreationDestination && !legacyDelivery) continue;
      const now = this.options.now?.() ?? Date.now();
      const plans = this.options.store.duePlanReminders(accountId, now);
      const groups = new Map<string, { delivery: NotificationDestination; target: string; plans: DuePlanReminder[] }>();
      for (const plan of plans) {
        const delivery = route?.capturesCreationDestination ? plan.notificationDestination
          : legacyDelivery;
        if (!delivery || (route && !route.isSelected(delivery))) continue;
        if (route) {
          const allowed = route.captureMemory(accountId, delivery.target);
          if (!allowed || allowed.accountId !== delivery.accountId || (allowed.channel ?? "weixin") !== (delivery.channel ?? "weixin")) continue;
        }
        const key = JSON.stringify([delivery.channel ?? "weixin", delivery.accountId, delivery.target]);
        const group = groups.get(key) ?? { delivery, target: route?.capturesCreationDestination ? delivery.target : target!, plans: [] };
        group.plans.push(plan); groups.set(key, group);
      }
      for (const { delivery, target: batchTarget, plans: groupedPlans } of groups.values()) {
        const segments = renderPlanReminderSegments(groupedPlans);
        const batch = this.options.store.createReminderBatch(accountId, batchTarget, segments, now, route ? delivery : undefined);
        for (const [segmentIndex, segment] of segments.entries()) {
          this.options.store.markReminderSegmentSending(accountId, batch.id, segmentIndex, now);
          let outcome: "accepted" | "failed" | "unknown" = "unknown";
          try {
            const result = await this.options.sender({ ...delivery, message: segment.message, operationId: `${batch.id}:${segmentIndex}` });
            outcome = result.ok ? "accepted" : result.reason === "unknown" ? "unknown" : "failed";
          } catch {
            outcome = "unknown";
          }
          this.options.store.finishReminderSegment(accountId, batch.id, segmentIndex, outcome, this.options.now?.() ?? Date.now());
          if (outcome !== "accepted") break;
        }
      }
    }
  }
}

const OPENING = "提醒你一下，下面这些计划已经到时间了。你可以告诉我完成情况，或者重新安排时间。";
const REPLY_GUIDANCE = [
  "直接告诉我结果就可以，比如：",
  "“1 已完成；2 没有完成；3 改到周五晚上”",
  "也可以按你习惯的方式回复。",
].join("\n");
const FINAL_GUIDANCE = "标记为“最后一次”的计划，如果这次没有回复，我就先不再提醒了，会保留为“结果未确认”。以后想起来再告诉我也可以。";

export function renderPlanReminderSegments(
  plans: DuePlanReminder[],
  maximumCodePoints = 1_500,
): PlanReminderSegment[] {
  if (!Number.isInteger(maximumCodePoints) || maximumCodePoints < 200) {
    throw new Error("plan_reminder_limit_invalid");
  }
  if (plans.length === 0) return [];

  const items = plans.map((plan, index) => ({
    plan,
    line: renderPlanLine(plan, index + 1),
  }));
  const conservativeOverhead = codePoints(OPENING) + codePoints(REPLY_GUIDANCE)
    + codePoints(FINAL_GUIDANCE) + 40;
  const itemBudget = Math.max(40, maximumCodePoints - conservativeOverhead);
  const chunks: typeof items[] = [];
  let current: typeof items = [];
  let currentLength = 0;
  for (const item of items) {
    const line = truncateLine(item.line, itemBudget);
    const normalized = { ...item, line };
    const addition = codePoints(line) + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentLength + addition > itemBudget) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(normalized);
    currentLength += codePoints(line) + (current.length > 1 ? 1 : 0);
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((chunk, segmentIndex) => {
    const lines: string[] = [];
    if (chunks.length > 1) lines.push(`计划确认 ${segmentIndex + 1}/${chunks.length}`, "");
    if (segmentIndex === 0) lines.push(OPENING, "");
    lines.push(...chunk.map((item) => item.line));
    if (segmentIndex === chunks.length - 1) {
      lines.push("", REPLY_GUIDANCE);
      if (plans.some((plan) => plan.reminderCount === 2)) lines.push("", FINAL_GUIDANCE);
    }
    const message = lines.join("\n");
    if (codePoints(message) > maximumCodePoints) throw new Error("plan_reminder_item_too_long");
    return { message, planIds: chunk.map((item) => item.plan.id) };
  });
}

function renderPlanLine(plan: DuePlanReminder, ordinal: number): string {
  const reminderLabel = plan.reminderCount === 2
    ? "最后一次"
    : `第 ${Math.max(1, plan.reminderCount + 1)} 次`;
  const time = renderPlanTime(plan);
  const summary = normalizeSummary(plan.summary);
  return `${ordinal}. [${reminderLabel}] 你计划在 ${time}${summary}`;
}

function renderPlanTime(plan: DuePlanReminder): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(plan.localDate);
  if (!match) throw new Error("plan_reminder_date_invalid");
  const date = `${Number(match[2])} 月 ${Number(match[3])} 日`;
  if (plan.timePrecision === "morning") return `${date}上午`;
  if (plan.timePrecision === "afternoon") return `${date}下午`;
  if (plan.timePrecision === "evening") return `${date}晚上`;
  if (plan.timePrecision === "exact") {
    if (!/^\d{2}:\d{2}$/u.test(plan.localTime ?? "")) throw new Error("plan_reminder_time_invalid");
    return `${date} ${plan.localTime} `;
  }
  return date;
}

function normalizeSummary(value: string): string {
  const trimmed = value.trim()
    .replace(/^(?:计划|准备)(?:在)?/u, "")
    .replace(/^(?:今天|明天|后天|今晚|明晚|早上|上午|中午|下午|晚上)\s*/u, "");
  const content = trimmed || "处理这项计划";
  return /[。！？!?]$/u.test(content) ? content : `${content}。`;
}

function truncateLine(value: string, maximum: number): string {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return `${characters.slice(0, Math.max(1, maximum - 2)).join("")}……`;
}

function codePoints(value: string): number {
  return Array.from(value).length;
}
