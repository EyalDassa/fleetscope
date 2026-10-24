// Expands the ClickHouse data source's `$__macros`, the way the plugin's backend does before it
// sends a query to ClickHouse. Source of truth (checked for plugin v4.23.2):
//   https://github.com/grafana/clickhouse-datasource/blob/v4.23.2/pkg/macros/macros.go
//   https://github.com/grafana/macropro (the engine: finds `$__name` and `$__name(args)`)
//
// What is implemented, with the expansion for a range 2024-01-01T00:00:00Z .. 01:00:00Z:
//   $__timeFilter(c)        c >= toDateTime(1704067200) AND c <= toDateTime(1704070800)
//   $__timeFilter_ms(c)     c >= fromUnixTimestamp64Milli(..) AND c <= fromUnixTimestamp64Milli(..)
//   $__dateFilter(c)        c >= toDate('2024-01-01') AND c <= toDate('2024-01-01')
//   $__dateTimeFilter(d,t)  (d filter) AND (t filter);  $__dt is the same
//   $__fromTime  $__toTime  toDateTime(<unix seconds>)
//   $__fromTime_ms  $__toTime_ms   fromUnixTimestamp64Milli(<unix ms>)
//   $__timeFrom([c])  $__timeTo([c])   toDateTime(..), or `c >= toDateTime(..)` / `c <= ..` with a column
//   $__timeInterval(c)      toStartOfInterval(toDateTime(c), INTERVAL <n> second)
//   $__timeInterval_ms(c)   toStartOfInterval(toDateTime64(c, 3), INTERVAL <n> millisecond)
//   $__timeGroup(c, 5m)     toStartOfInterval(toDateTime(c), INTERVAL 300 second)
//   $__interval_s           whole seconds of the panel interval (at least 1)
//   $__interval  $__interval_ms   the interval as "1m" / in milliseconds
//   $__fromGrafanaInterval(5m)    5 minute
// Not implemented, and reported as an error instead of being sent to ClickHouse unexpanded:
//   $__table, $__column and the statement macros ($__columns, $__rateColumns, $__perSecondColumns,
//   $__increaseColumns, $__lttb, $__adHocFilters). Write plain SQL in dashboards instead.
// `$__conditionalAll` is not a backend macro; it lives in the data source's frontend and is
// handled in interpolate.ts. Unknown `$__names` are left alone, like the plugin does.
import { findClosingParen, splitArgs, stripComments } from "./sql-text";

export interface MacroContext {
  from: Date;
  to: Date;
  /** The panel interval ($__interval) in milliseconds. */
  intervalMs: number;
}

export class MacroError extends Error {
  override name = "MacroError";
}

const UNSUPPORTED = new Set([
  "table",
  "column",
  "columns",
  "rateColumns",
  "perSecondColumns",
  "increaseColumns",
  "lttb",
  "adHocFilters",
]);

const unixSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);
const dateTime = (d: Date): string => `toDateTime(${unixSeconds(d)})`;
const dateTime64 = (d: Date): string => `fromUnixTimestamp64Milli(${d.getTime()})`;
const date = (d: Date): string => `toDate('${d.toISOString().slice(0, 10)}')`;

function needArgs(name: string, args: string[], count: number, usage: string): void {
  if (args.length !== count) {
    throw new MacroError(
      `$__${name} expects ${count} argument(s), got ${args.length}. Usage: ${usage}`,
    );
  }
}

/** Seconds of the interval, at least 1: the plugin never buckets finer than a second. */
function intervalSeconds(ctx: MacroContext): number {
  return Math.trunc(Math.max(ctx.intervalMs / 1000, 1));
}

/** The interval as Grafana writes it: the largest of h, m, s or ms that divides it exactly. */
export function formatInterval(ms: number): string {
  if (ms === 0) return "0s";
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

const GO_DURATION_UNITS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Go's time.ParseDuration, which is what the plugin uses for $__timeGroup. Returns milliseconds. */
function parseGoDuration(text: string): number | undefined {
  if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(text)) return undefined;
  let total = 0;
  for (const part of text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(part[1]) * (GO_DURATION_UNITS[part[2] as string] as number);
  }
  return total;
}

const GRAFANA_INTERVAL_UNITS: Record<string, string> = {
  ms: "millisecond",
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
  w: "week",
  M: "month",
  y: "year",
};

type Handler = (args: string[], ctx: MacroContext) => string;

function timeBoundary(name: string, op: string, t: Date, args: string[]): string {
  if (args.length === 0 || (args.length === 1 && args[0] === "")) return dateTime(t);
  if (args.length === 1) return `${args[0]} ${op} ${dateTime(t)}`;
  throw new MacroError(`$__${name} accepts at most 1 argument, got ${args.length}`);
}

const HANDLERS: Record<string, Handler> = {
  timeFilter(args, ctx) {
    needArgs("timeFilter", args, 1, "$__timeFilter(timeColumn)");
    const c = args[0];
    return `${c} >= ${dateTime(ctx.from)} AND ${c} <= ${dateTime(ctx.to)}`;
  },
  timeFilter_ms(args, ctx) {
    needArgs("timeFilter_ms", args, 1, "$__timeFilter_ms(timeColumn)");
    const c = args[0];
    return `${c} >= ${dateTime64(ctx.from)} AND ${c} <= ${dateTime64(ctx.to)}`;
  },
  dateFilter(args, ctx) {
    needArgs("dateFilter", args, 1, "$__dateFilter(dateColumn)");
    const c = args[0];
    return `${c} >= ${date(ctx.from)} AND ${c} <= ${date(ctx.to)}`;
  },
  dateTimeFilter(args, ctx) {
    needArgs("dateTimeFilter", args, 2, "$__dateTimeFilter(dateColumn, timeColumn)");
    const [d, t] = args;
    return (
      `(${d} >= ${date(ctx.from)} AND ${d} <= ${date(ctx.to)}) AND ` +
      `(${t} >= ${dateTime(ctx.from)} AND ${t} <= ${dateTime(ctx.to)})`
    );
  },
  fromTime: (_args, ctx) => dateTime(ctx.from),
  toTime: (_args, ctx) => dateTime(ctx.to),
  fromTime_ms: (_args, ctx) => dateTime64(ctx.from),
  toTime_ms: (_args, ctx) => dateTime64(ctx.to),
  timeFrom: (args, ctx) => timeBoundary("timeFrom", ">=", ctx.from, args),
  timeTo: (args, ctx) => timeBoundary("timeTo", "<=", ctx.to, args),
  timeInterval(args, ctx) {
    needArgs("timeInterval", args, 1, "$__timeInterval(timeColumn)");
    return `toStartOfInterval(toDateTime(${args[0]}), INTERVAL ${intervalSeconds(ctx)} second)`;
  },
  timeInterval_ms(args, ctx) {
    needArgs("timeInterval_ms", args, 1, "$__timeInterval_ms(timeColumn)");
    const ms = Math.trunc(Math.max(ctx.intervalMs, 1));
    return `toStartOfInterval(toDateTime64(${args[0]}, 3), INTERVAL ${ms} millisecond)`;
  },
  timeGroup(args) {
    needArgs("timeGroup", args, 2, "$__timeGroup(timeColumn, interval)");
    const period = (args[1] as string).replace(/^['"]|['"]$/g, "");
    const ms = parseGoDuration(period);
    if (ms === undefined) {
      throw new MacroError(
        `$__timeGroup: invalid interval "${period}" (use h, m, s or ms, like 5m or 1h30m)`,
      );
    }
    const seconds = Math.round(ms / 1000);
    if (seconds <= 0)
      throw new MacroError(`$__timeGroup: interval must be positive, got "${period}"`);
    return `toStartOfInterval(toDateTime(${(args[0] as string).trim()}), INTERVAL ${seconds} second)`;
  },
  interval_s: (_args, ctx) => String(intervalSeconds(ctx)),
  interval: (_args, ctx) => formatInterval(ctx.intervalMs),
  interval_ms: (_args, ctx) => String(Math.trunc(ctx.intervalMs)),
  fromGrafanaInterval(args) {
    needArgs("fromGrafanaInterval", args, 1, "$__fromGrafanaInterval(interval)");
    const text = (args[0] as string).replace(/^['"]|['"]$/g, "");
    const match = /^(\d+)(ms|s|m|h|d|w|M|y)$/.exec(text);
    const unit = match ? GRAFANA_INTERVAL_UNITS[match[2] as string] : undefined;
    if (!match || !unit || Number(match[1]) === 0) {
      throw new MacroError(
        `$__fromGrafanaInterval: expected <positive integer><unit> (ms, s, m, h, d, w, M, y), got "${text}"`,
      );
    }
    return `${Number(match[1])} ${unit}`;
  },
};
HANDLERS.dt = HANDLERS.dateTimeFilter as Handler;

/** Expands every `$__macro` in `sql`. Throws MacroError for bad arguments or unsupported macros. */
export function expandMacros(sql: string, ctx: MacroContext): string {
  return expandIn(stripComments(sql), ctx);
}

function expandIn(text: string, ctx: MacroContext): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("$__", i);
    if (start === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, start);
    const name = /^[A-Za-z0-9_]+/.exec(text.slice(start + 3))?.[0] ?? "";
    let end = start + 3 + name.length;

    const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
    if (UNSUPPORTED.has(name)) {
      throw new MacroError(
        `$__${name} is not supported by the dashboard check (and the dashboards should not use it): write plain SQL`,
      );
    }
    if (!handler) {
      // Unknown names stay as they are. The plugin leaves them too; ClickHouse will complain.
      out += text.slice(start, end);
      i = end;
      continue;
    }

    let args: string[] = [];
    if (text[end] === "(") {
      const close = findClosingParen(text, end);
      if (close === -1) throw new MacroError(`$__${name}( has no closing parenthesis`);
      args = splitArgs(text.slice(end + 1, close)).map((arg) => expandIn(arg, ctx));
      end = close + 1;
    }
    out += handler(args, ctx);
    i = end;
  }
  return out;
}
