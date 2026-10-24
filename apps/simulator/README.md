# @fleetscope/simulator

Posts synthetic sessions to the Fleetscope API, always with `source: "sim"` (the dashboards show them
as SIM and never mix them into real numbers silently). Agent id `sim@<host>`, provider `local-docker`
(so the pricing join works).

```
pnpm sim run --sessions 500 [--duration 10m] [--seed N] [--engines chromium,lightpanda] [--stretch X]
pnpm sim live --rate 6            # sessions per minute, until Ctrl+C (for Grafana Cloud)
pnpm sim calibrate                # rewrite src/profile.json from the real sessions in ClickHouse
```

- `run` is a backfill: the timestamps are spread over the last `--duration` (default 10m, never in
  the future, always inside the API's 30 day window) and the batches (at most 1000 events, a session
  is never split) go out as fast as the API takes them. A 503 waits for `Retry-After`.
- `live` creates sessions at the given rate and sends each event when its time comes, so sessions are
  `running` for a few seconds and the Active sessions chart moves. Ctrl+C sends the sessions in
  flight and stops (a second Ctrl+C quits at once and leaves them `running`).
- `--stretch X` multiplies the session duration. Real sessions on the demo site last 1 to 5 s, which
  gives one or two 2 s container samples; `--stretch 10` shows memory rising page by page.
- `--seed` makes a run repeatable (same sessions, same ids; only the event ids differ). Without it
  the seed is printed.
- Every scenario runs on every engine (round-robin, shuffled per round).

## Where the numbers come from

`src/profile.json` is generated, not hand-written. `pnpm sim calibrate` reads the **real** sessions
(`source = 'real'`, interrupted and running ones left out) and stores, per engine and scenario, the
median and 95th percentile of: `startup_ms`, `connect_ms`, session duration, per-action latency by
type, container CPU, peak memory, network request duration and size; plus actions per session, the
request mix and the failure mix. The simulator samples these as log-normals. The file says when it
was made and from how many sessions.

An engine with fewer than 10 real sessions is **derived from Chromium's numbers with documented
priors** (`src/priors.ts`, marked `basis: "prior"` in the profile): they are assumptions, not
measurements. Run `pnpm sim calibrate` again after `pnpm fleet run --engines chromium,chrome-headless-shell,lightpanda`
and each engine switches to its own real numbers.

Known limits: real Chromium failures include the fleet runner's chaos mode, so they are not a web
failure rate; real sessions are too short to show how memory climbs, so memory starts at most 80% of
the way to the peak; the simulator raises the same `issue` per error code as the real collector
(a copy of `ISSUE_FOR_CODE`).
