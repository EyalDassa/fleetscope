import { z } from "zod";

/**
 * The session timeline as a Chrome Trace Event Format file, which https://ui.perfetto.dev opens
 * (`GET /v1/sessions/:id/trace`). Only the few event kinds we use are described here; the layout
 * (tracks, names, units) is specified in design/DESIGN.md section 5.
 *
 * Units: `ts` and `dur` are MICROSECONDS from the start of the session. Everything is in one
 * process (`pid` 1); each track is a thread.
 */

export const TRACE_PROCESS_ID = 1;

/** Track ids. Extra lanes for overlapping slices get their own ids (see the API's `build-trace`). */
export const TRACE_TID = {
  actions: 1,
  network: 2,
  issues: 3,
  session: 4,
} as const;

const traceArgs = z.record(z.string(), z.unknown());

/** A complete slice: an action or a network request. */
export const TraceSliceEvent = z.object({
  ph: z.literal("X"),
  name: z.string().min(1),
  cat: z.string(),
  pid: z.int(),
  tid: z.int(),
  ts: z.int(),
  dur: z.int().nonnegative(),
  args: traceArgs,
});

/** An instant on a thread: an issue, or a session marker. */
export const TraceInstantEvent = z.object({
  ph: z.literal("i"),
  name: z.string().min(1),
  cat: z.string(),
  pid: z.int(),
  tid: z.int(),
  ts: z.int(),
  s: z.enum(["t", "p", "g"]),
  args: traceArgs,
});

/**
 * One value of a counter track. Perfetto names the track `<name> <arg key>`, so
 * `{"name": "CPU", "args": {"%": 62}}` becomes the track "CPU %". Exactly one argument.
 */
export const TraceCounterEvent = z.object({
  ph: z.literal("C"),
  name: z.string().min(1),
  pid: z.int(),
  tid: z.int(),
  ts: z.int(),
  args: z
    .record(z.string(), z.number().finite())
    .refine((args) => Object.keys(args).length === 1, { error: "a counter has exactly one value" }),
});

/** Names for the process and its threads, and the order of the tracks. */
export const TraceMetadataEvent = z.object({
  ph: z.literal("M"),
  name: z.enum(["process_name", "process_sort_index", "thread_name", "thread_sort_index"]),
  pid: z.int(),
  tid: z.int(),
  args: traceArgs,
});

export const TraceEvent = z.discriminatedUnion("ph", [
  TraceSliceEvent,
  TraceInstantEvent,
  TraceCounterEvent,
  TraceMetadataEvent,
]);
export type TraceEvent = z.infer<typeof TraceEvent>;

/** Body of `GET /v1/sessions/:id/trace`. */
export const ChromeTrace = z.object({
  traceEvents: z.array(TraceEvent),
  displayTimeUnit: z.literal("ms"),
  /** Facts about the session (id, engine, status, start time, ...), shown by Perfetto's info page. */
  metadata: z.record(z.string(), z.unknown()),
});
export type ChromeTrace = z.infer<typeof ChromeTrace>;
