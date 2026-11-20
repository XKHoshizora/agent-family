import type { ToolSpec } from "../../models/gateway.ts";

/** The clock (README "Agents and runs", Tools in a reply): where the site is, now. */
export const CURRENT_TIME = "current_time";

export const clockSpec: ToolSpec = {
  name: CURRENT_TIME,
  description: "看现在的日期、星期几和时间（按这个网站所在的时区）。不需要参数。",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

/** `now` where the site is (`timeZone`): `{date: "2026-11-20", weekday: "周五", time: "14:05", zone}`. */
export function currentTime(now: Date, timeZone: string): { date: string; weekday: string; time: string; zone: string } {
  const { date, time } = siteDateTime(now, timeZone);
  return { date, weekday: siteWeekday(now, timeZone), time, zone: timeZone };
}

/** `at` where the site is: its date (`YYYY-MM-DD`) and its time of day (`HH:mm`, 24 hours). */
export function siteDateTime(at: Date, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

/** `at`'s weekday where the site is, as Chinese writes it short: 周一 … 周日. */
export const siteWeekday = (at: Date, timeZone: string): string => new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "short" }).format(at);
