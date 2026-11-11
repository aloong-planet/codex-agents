import { describe, expect, it } from "vitest";
import { scheduleText, type Schedule } from "../src/scheduled-time.js";

describe("the text of a schedule", () => {
  it.each<[Schedule, string, string]>([
    [{ kind: "calendar", time: "17:00", weekdays: [5] }, "Asia/Shanghai", "每周五 17:00"],
    [{ kind: "calendar", time: "09:30", weekdays: [0, 1, 3] }, "Asia/Shanghai", "每周一、三、日 09:30"],
    [{ kind: "calendar", time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, "Asia/Shanghai", "每天 08:00"],
    [{ kind: "interval", everySeconds: 172_800, firstAt: "2026-10-30T00:00:00.000Z" }, "Asia/Shanghai", "每 2 天"],
    [{ kind: "interval", everySeconds: 3600, firstAt: "2026-10-30T00:00:00.000Z" }, "Asia/Shanghai", "每小时"],
    [{ kind: "interval", everySeconds: 7200, firstAt: "2026-10-30T00:00:00.000Z" }, "Asia/Shanghai", "每 2 小时"],
    [{ kind: "interval", everySeconds: 5400, firstAt: "2026-10-30T00:00:00.000Z" }, "Asia/Shanghai", "每 90 分钟"],
    [{ kind: "interval", everySeconds: 90, firstAt: "2026-10-30T00:00:00.000Z" }, "Asia/Shanghai", "每 90 秒"],
    [{ kind: "once", at: "2026-10-14T15:00:00+08:00" }, "Asia/Shanghai", "2026-10-14 15:00"],
    [{ kind: "once", at: "2026-10-14T15:00:00+08:00" }, "America/New_York", "2026-10-14 03:00"],
  ])("%j in %s reads %s", (schedule, timezone, text) => {
    expect(scheduleText(schedule, timezone)).toBe(text);
  });
});
