export type Schedule = { kind: "once"; at: string }
  | { kind: "interval"; everySeconds: number; firstAt: string }
  | { kind: "calendar"; time: string; weekdays: number[] };

export function nextInstant(schedule: Schedule, after: number, timezone: string): string | null {
  if (schedule.kind === "once") return null;
  if (schedule.kind === "calendar") return calendarInstant(schedule, after, timezone, 1);
  const first = Date.parse(schedule.firstAt), period = schedule.everySeconds * 1000;
  return new Date(first + Math.max(0, Math.floor((after - first) / period) + 1) * period).toISOString();
}

export function latestInstant(schedule: Schedule, through: number, timezone: string): string {
  if (schedule.kind === "once") return schedule.at;
  if (schedule.kind === "calendar") return calendarInstant(schedule, through, timezone, -1);
  const first = Date.parse(schedule.firstAt), period = schedule.everySeconds * 1000;
  return new Date(first + Math.floor((through - first) / period) * period).toISOString();
}

function calendarInstant(schedule: Extract<Schedule, { kind: "calendar" }>, boundary: number, timezone: string, direction: 1 | -1): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, calendar: "iso8601", numberingSystem: "latn",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const local = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)!.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  };
  const day = 86_400_000;
  const localDay = Math.floor(local(boundary) / day) * day;
  const [hour, minute] = schedule.time.split(":").map(Number);
  // Iterate calendar dates, not elapsed days. Offsets on either side of a local date
  // enumerate both sides of a transition; round-trip matching excludes gaps, and
  // the earliest matching instant selects one occurrence during a fold.
  for (let delta = 0; delta <= 14; delta++) {
    const date = localDay + direction * delta * day;
    if (!schedule.weekdays.includes(new Date(date).getUTCDay())) continue;
    const wallTime = date + hour! * 3_600_000 + minute! * 60_000;
    const offsets = new Set<number>();
    for (let hours = -36; hours <= 36; hours += 6) {
      const sample = wallTime + hours * 3_600_000;
      offsets.add(local(sample) - sample);
    }
    const matches = [...offsets].map((offset) => wallTime - offset).filter((instant) => local(instant) === wallTime);
    if (!matches.length) continue;
    const instant = Math.min(...matches);
    if (direction === 1 ? instant > boundary : instant <= boundary) return new Date(instant).toISOString();
  }
  throw new Error("calendar_occurrence_unavailable");
}
