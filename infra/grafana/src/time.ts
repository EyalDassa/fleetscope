// Resolves a dashboard's time range ("now-1h" .. "now") and the panel interval the way Grafana does,
// close enough for the check: the point is to give macros realistic values, not to match Grafana to
// the millisecond.
export interface TimeRange {
  from: Date;
  to: Date;
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/** First instant of the unit that contains `t` (UTC, weeks start on Monday). */
function startOf(t: Date, unit: string): Date {
  const d = new Date(t.getTime());
  switch (unit) {
    case "s":
      d.setUTCMilliseconds(0);
      break;
    case "m":
      d.setUTCSeconds(0, 0);
      break;
    case "h":
      d.setUTCMinutes(0, 0, 0);
      break;
    case "d":
      d.setUTCHours(0, 0, 0, 0);
      break;
    case "w":
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      break;
    case "M":
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      break;
    case "y":
      d.setUTCMonth(0, 1);
      d.setUTCHours(0, 0, 0, 0);
      break;
    default:
      throw new Error(`unknown time unit "${unit}"`);
  }
  return d;
}

function addUnits(t: Date, amount: number, unit: string): Date {
  if (unit === "M" || unit === "y") {
    const d = new Date(t.getTime());
    if (unit === "M") d.setUTCMonth(d.getUTCMonth() + amount);
    else d.setUTCFullYear(d.getUTCFullYear() + amount);
    return d;
  }
  return new Date(t.getTime() + amount * (UNIT_MS[unit] as number));
}

/** Parses "now", "now-6h", "now-1d/d", "now/w" or an absolute epoch-ms / ISO value. */
export function parseTimeExpression(expr: string, now: Date, roundUp: boolean): Date {
  const text = expr.trim();
  if (/^\d{10,}$/.test(text)) return new Date(Number(text));
  if (!text.startsWith("now")) {
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) throw new Error(`cannot read the time "${expr}"`);
    return parsed;
  }
  const match = /^now((?:[+-]\d+[smhdwMy])*)(?:\/([smhdwMy]))?$/.exec(text);
  if (!match) throw new Error(`cannot read the time "${expr}"`);
  let t = now;
  for (const step of (match[1] ?? "").matchAll(/([+-])(\d+)([smhdwMy])/g)) {
    const sign = step[1] === "-" ? -1 : 1;
    t = addUnits(t, sign * Number(step[2]), step[3] as string);
  }
  const round = match[2];
  if (round) {
    t = roundUp ? new Date(addUnits(startOf(t, round), 1, round).getTime() - 1) : startOf(t, round);
  }
  return t;
}

export function resolveTimeRange(
  time: { from?: string; to?: string } | undefined,
  now: Date,
): TimeRange {
  return {
    from: parseTimeExpression(time?.from ?? "now-6h", now, false),
    to: parseTimeExpression(time?.to ?? "now", now, true),
  };
}

// Grafana snaps the raw interval (range / max data points) up to one of these.
const NICE_INTERVALS_MS = [
  1000, 2000, 5000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000,
  1_200_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
  604_800_000, 2_592_000_000, 31_536_000_000,
];

/** Parses "30s", "1m", "2h" ... into milliseconds. Returns undefined for anything else. */
export function parseIntervalMs(text: string | undefined): number | undefined {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec((text ?? "").trim());
  if (!match) return undefined;
  const unit = match[2] as string;
  return Number(match[1]) * (unit === "ms" ? 1 : (UNIT_MS[unit] as number));
}

/** The $__interval of a panel: range / maxDataPoints, at least the min interval, snapped to a nice value. */
export function panelIntervalMs(
  range: TimeRange,
  maxDataPoints = 1000,
  minIntervalMs = 1000,
): number {
  const raw = Math.max((range.to.getTime() - range.from.getTime()) / maxDataPoints, minIntervalMs);
  return (
    NICE_INTERVALS_MS.find((candidate) => candidate >= raw) ?? (NICE_INTERVALS_MS.at(-1) as number)
  );
}
