/**
 * get_payout_schedule: next Director round day (Sunday/Wednesday UTC) and the
 * next Builder weekly root (after the Sunday Director round). Pure: it never
 * gives an hour, because the exact time varies from round to round.
 */
import { makeEnvelope, makeReceipt } from "../kernel/numbers";

import { GITBOOK_BUILDER_URL, GITBOOK_DISTRIBUTION_URL, WEEKDAYS } from "./constants";

import type { ToolEnvelope } from "../types";

export const SCHEDULE_TTL_SECONDS = 3600;
const DIRECTOR_DAYS = [0, 3]; // Sunday, Wednesday (UTC)

export interface ScheduledDay {
  date: string;
  weekday: string;
  /** The next round day is today: it may already have landed. */
  isToday: boolean;
  daysAway: number;
}

export interface PayoutScheduleData {
  cadence: string;
  nextDirectorRound: ScheduledDay;
  followingDirectorRound: ScheduledDay;
  nextBuilderRoot: ScheduledDay & { note: string };
  exactTimeVaries: true;
  note: string;
}

function nextDay(now: Date, days: number[], fromOffset = 0): ScheduledDay {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let k = fromOffset; k < fromOffset + 8; k++) {
    const d = new Date(today + k * 86_400_000);
    if (days.includes(d.getUTCDay())) {
      return {
        date: d.toISOString().slice(0, 10),
        weekday: WEEKDAYS[d.getUTCDay()]!,
        isToday: k === 0,
        daysAway: k,
      };
    }
  }
  throw new Error("unreachable");
}

export function getPayoutSchedule(now: Date = new Date()): ToolEnvelope<PayoutScheduleData> {
  const t = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const next = nextDay(t, DIRECTOR_DAYS);
  const following = nextDay(t, DIRECTOR_DAYS, next.daysAway + 1);
  const builder = nextDay(t, [0]);
  const data: PayoutScheduleData = {
    cadence:
      "Director rounds on Sundays and Wednesdays (UTC); Builder weekly root after the Sunday Director round",
    nextDirectorRound: next,
    followingDirectorRound: following,
    nextBuilderRoot: {
      ...builder,
      note: "Published after the Sunday Director distribution; Builders then claim in the Terminal.",
    },
    exactTimeVaries: true,
    note: next.isToday
      ? `Today (${next.weekday}) is a round day; it may already have landed. The exact time varies.`
      : "The exact time of day varies from round to round.",
  };
  const readAt = t.toISOString();
  const dayNums = (d: ScheduledDay) => {
    const [y, m, dd] = d.date.split("-").map(Number) as [number, number, number];
    return [y, m, dd, d.daysAway];
  };
  const receipts = [
    makeReceipt({
      id: "r:schedule:cadence",
      kind: "docs",
      label: "Documented payout cadence",
      locator:
        "GitBook Distribution / Director Nodes: semi-weekly, Sunday and Wednesday (subject to adaptation); Builder weekly on Sunday",
      value:
        "Director: twice a week, Sundays and Wednesdays; Builder: weekly, after the Sunday Director round. The exact time varies.",
      numbers: [2, 104, 72, 96],
      read_at: readAt,
      url: GITBOOK_DISTRIBUTION_URL,
    }),
    makeReceipt({
      id: "r:schedule:next_director_round",
      kind: "calc",
      label: "Next Director round day",
      locator: "F17 cadence: next Sunday or Wednesday (UTC) from now",
      value: `${next.weekday} ${next.date}${next.isToday ? " (today; may already have landed)" : ""}, then ${following.weekday} ${following.date}. No fixed hour.`,
      numbers: [...dayNums(next), ...dayNums(following)],
      read_at: readAt,
      url: GITBOOK_DISTRIBUTION_URL,
    }),
    makeReceipt({
      id: "r:schedule:next_builder_root",
      kind: "calc",
      label: "Next Builder weekly root",
      locator: "F17 cadence: next Sunday (UTC), after the Director round",
      value: `${builder.weekday} ${builder.date}, after the Sunday Director round`,
      numbers: dayNums(builder),
      read_at: readAt,
      url: GITBOOK_BUILDER_URL,
    }),
  ];
  return makeEnvelope({
    data,
    source: "kernel",
    locator: "payout cadence (Sun/Wed UTC) from the given time",
    asOf: readAt,
    ttlSeconds: SCHEDULE_TTL_SECONDS,
    receipts,
  });
}
