# Fleetscope dashboard spec (DESIGN.md)

Status: Grafana spec derived from the design approved by Eyal on 2026-10-22; adjustments for Grafana by the design lead on 2026-10-24.

The UI is Grafana (ADR 0003). This spec is for the engineer who builds `infra/grafana/dashboards/*.json`: colours, units, thresholds, panel order and drill-down links. The earlier shadcn/Recharts spec is in git history, and `design/DECISIONS.md` and `design/proposals/` record how it was decided; where they disagree with this file, this file wins. Every panel uses the ClickHouse data source with UID `fleetscope-clickhouse`. Browsers, Usage and Insights (M3/M4) follow the same rules.

## 1. Principles that survive

1. **Verdict first.** Overview opens with the fleet verdict in one word, and Session detail opens with the session status and one sentence about what happened. Evidence sits beside the verdict, and the charts come after it.
2. **Every number drills down to sessions.** Every stat, table row and chart point has a Grafana **data link** to the sessions behind it (link patterns in 4.1). A panel whose values are links ends its title with `↗`, so the link is visible without hovering.
3. **Honest data.** A count with no events prints `0`. A ratio with no denominator prints `—`. A metric the engine can't provide (`null`) prints `Not available`: never drawn as 0, never interpolated. Simulated data is always labelled (`SIM` in session tables, the Simulated share stat, the Perfetto process name).
4. **Never colour alone.** A status is shown as a value mapping with glyph + word + colour. An engine is shown with its name (legend, tooltip) + line style + colour.

**One meaning per pattern.** Violet means blocked. Engine colours never mean a status, and status colours never mean an engine. A filled panel means a verdict: only the two verdict stats are filled.

## 2. Colours

Grafana's theme supplies every neutral (canvas, panels, text, grid). Hue is used only for status and engine, taken from the approved, measured palette.

| Engine (`engine`) | Dark (default) | Light | `custom.lineStyle` |
|---|---|---|---|
| `chromium` | `#56B4E9` | `#0072B2` | `{"fill":"solid"}` |
| `chrome-headless-shell` | `#E69F00` | `#B86E00` | `{"fill":"dash","dash":[10,10]}` |
| `lightpanda` | `#CC79A7` | `#B0457F` | `{"fill":"dot","dash":[0,10]}` |

| Status (SQL value) | Mapping text | Dark (default) | Light |
|---|---|---|---|
| `healthy` | `✓ Healthy` | `#6EE7A8` | `#0B6B39` |
| `degraded` | `▲ Degraded` | `#FFD95A` | `#6B4400` |
| `failed` | `✕ Failed` | `#FF7B7B` | `#B42318` |
| `blocked` | `⊘ Blocked` | `#D9CCFF` | `#3D2A9E` |
| `running` | `○ Running` | `#9AA9BB` | `#475569` |
| `interrupted` | `■ Interrupted` | `#7D8DA1` | `#5F6E82` |

Other colours (dark / light): gauge cells in tables use the approved neutral `--bar`, `#5B7491` / `#6B829E`. The field default colour for any series without an engine override is `#9AA9BB` / `#475569`. The annotations use the status colours: "Failed actions" is Failed, "Issues" is Degraded.

- **Engines:** Okabe-Ito hues; every engine-vs-engine pair has ΔE ≥ 11 under protanopia and deuteranopia (DECISIONS.md). Grafana draws every point as a circle, so the approved marker shapes are lost and the **line style** is the shape cue. Lightpanda is dotted because Grafana has no dash-dot preset (the values above are the editor's own Dash/Dots defaults). Engine series are always lines, because bars can't be dashed. Engine colours never colour text or cells, and engine names are written as in the API.
- **Statuses:** there are exactly six. `timeout` and `crashed` show as Failed, with the code in the Cause column. Running and Interrupted are not outcomes, so they get the approved greys (`fg-muted`, `fg-subtle`), and the glyph and word tell them apart. The glyphs are plain text characters, not emoji.
- **Dark is the default and the only theme we commit.** Grafana stores field colours as fixed hex, not theme tokens, so one JSON can't switch with the theme. Set the org default theme to Dark (Administration > Default preferences), locally and on Grafana Cloud. The Light column is a 1:1 find-and-replace map (no hex appears in both columns) if a light copy is ever needed. We don't use Grafana's named colours: they follow the theme, but they aren't our measured palette. The one exception is `text` as a threshold base.
- **Engine overrides:** every time series panel gets three "Fields with name matching regex" overrides: `/chromium/`, `/chrome-headless-shell/`, `/lightpanda/`. Each sets `color` = `{"mode":"fixed","fixedColor":"<hex>"}` and `custom.lineStyle`. The regexes are unanchored on purpose: neither name contains the other, and they still match whatever prefix the plugin adds to a series name. Set the field default colour to `#9AA9BB`, so nothing falls back to Grafana's classic palette, whose green would read as Healthy.
- **Status:** SQL returns the lowercase value, and the mapping below adds glyph, word and colour; copy it wherever a status appears. Tables use the cell type **Colored text**. The two verdict stats use the colour mode **Background solid**, which makes Grafana pick dark or white text for contrast, so they read in either theme.
- **Contrast** (lead estimate): Grafana's dark panel `#181B1F` is slightly lighter than our old `#111821`, which scales the measured ratios by about ×0.97. That gives status text ≥ 6.8:1, Interrupted 5.1:1, and engine lines 7.5 / 7.7 / 5.6:1. Light panels are white, the surface the Light column was measured on.

```json
"mappings": [{ "type": "value", "options": {
  "healthy":     { "index": 0, "text": "✓ Healthy",     "color": "#6EE7A8" },
  "degraded":    { "index": 1, "text": "▲ Degraded",    "color": "#FFD95A" },
  "failed":      { "index": 2, "text": "✕ Failed",      "color": "#FF7B7B" },
  "blocked":     { "index": 3, "text": "⊘ Blocked",     "color": "#D9CCFF" },
  "running":     { "index": 4, "text": "○ Running",     "color": "#9AA9BB" },
  "interrupted": { "index": 5, "text": "■ Interrupted", "color": "#7D8DA1" } } }]
```

## 3. Units, thresholds and definitions

| Metric | Grafana unit | Decimals | Prints |
|---|---|---|---|
| Counts | `locale` | 0 | `1,926` |
| Latency, durations, offsets | `ms` | unset (a fixed 2 prints `842.00 ms`) | `842 ms`, `1.84 s` |
| Success / error rate, simulated share | `percent` (SQL returns 0–100) | 1, share 0 | `91.6%`, `62%` |
| CPU of one session | `percent` (% of one core, can pass 100) | 0 | `62%` |
| CPU in use (fleet) | `suffix: cores` | 1 | `36.2 cores` |
| Memory, JS heap | `mbytes` | 0 (fleet total 1) | `210 MiB`, `4.2 GiB` |
| Network bytes | `bytes` | unset | `1.2 MiB` |
| Actions per minute | `suffix: /min` | 0 | `48 /min` |
| Estimated cost: range / one session | `currencyUSD` | 2 / 4 | `$8.73` / `$0.0004` |
| Timestamps in tables | `dateTimeAsLocalNoDateIfToday` | – | `14:25:03` |

- **Memory is in MiB.** The collector divides bytes by 1024², so use `mbytes` (it prints MiB and GiB), not `decmbytes`. Labelling these values "MB" would be about 5% off.
- **Cost is always labelled as an estimate.** Use the title "Estimated cost" and the column header "Est. cost", with this description: "Browser-hours × $0.10 per browser-hour (Browserbase's published price, from the `pricing` table). An estimate, not a bill."

**Thresholds**
- **Success rate** (KPI stat and the By engine Status column): base `#FF7B7B`, 90 → `#FFD95A`, 95 → `#6EE7A8`. So ≥ 95% is Healthy, 90 to < 95% is Degraded and < 90% is Failed (Eyal, 2026-10-22).
- **Error rate chart:** the same rule, mirrored. `thresholdsStyle: {"mode":"area"}`, transparent base, 5 → `#FFD95A`, 10 → `#FF7B7B`.
- **Failed actions** (Sessions) and **HTTP status** (Network): base `text`, then 1 or 400 → `#FF7B7B`.
- Nothing else has a target, so nothing else is threshold-coloured.

**Definitions.** The SQL that implements them lives in `packages/db/README.md`, and it must agree with this list.
- **Display status:** `running` = no `session.ended` yet. `interrupted` = `reason = 'interrupted'`. `healthy` = `success` with no failed action and no issue. `degraded` = `success` with a failed action (a retry) or any issue. `blocked` = `blocked`. `failed` = `failed`, `timeout` or `crashed`. The approved rule that an action slower than its p95 degrades a session is a stretch item.
- **Success rate** = (healthy + degraded) / ended sessions. Ended excludes running and interrupted sessions; blocked counts against the rate.
- **Error rate** = 100 − success rate, per `ended_at` bucket, computed from `sessions` rather than `fleet_minute` (which counts actions). That way interrupted sessions are excluded and the chart agrees with the verdict.
- **Fleet verdict** = the success rate over the range, through the thresholds. It is `no_data` when no session ended. The approved capacity rule is dropped, because there is no capacity data.
- **Failure cause** (sessions that didn't succeed, interrupted excluded): the first `issues.kind`, else the first failed action's `error_code`, else `status`. A From column says which one (`issue` / `action` / `status`).
- **Estimated cost** = browser-hours (startup + connect + session duration, because the browser is billed from the moment its container exists; a running session counts until now) × price.
- **Interrupted sessions** have their own count and status. They never enter the success rate, error rate, Recent failures or Top failure causes.
- **Honest SQL:** ratios as `if(den = 0, NULL, num / den)`; `-OrNull` aggregates (`maxOrNull`, `avgOrNull`, `quantileOrNull`) wherever a set can be empty; never `ifNull(metric, 0)` or `coalesce(metric, 0)`.

## 4. Dashboards

### 4.1 Shared settings

- **Navigation:** tag all three dashboards `fleetscope`. Add dashboard links by tag that keep the time range and the variables. Set `graphTooltip: 1` (shared crosshair) and timezone browser.
- **Time series:** line width 2, `spanNulls: false`, fill 0 (15 on session charts), points never (always, size 4, on session charts), legend as a list at the bottom, tooltip with all series sorted descending, min interval 1m.
- **Stats:** graph mode none (no sparklines), text mode value, KPI value size 22. Verdicts use auto size, so they are the largest text on the page. A string stat needs Value options > Fields set to its column, because "Numeric fields" hides strings.
- **Descriptions:** every panel has a one-sentence description with its definition from section 3. People see it under (i), and Grafana Assistant can read it.

| Variable | Type | Values | Default | Dashboards |
|---|---|---|---|---|
| `engine` | custom, multi, All | `chromium,chrome-headless-shell,lightpanda` | All | overview, sessions |
| `source` | custom, single, All | `real,sim` | All | overview, sessions |
| `status` | custom, multi, All | `Healthy : healthy`, … all six | All | sessions |
| `agent`, `scenario` | query, multi, All | distinct values from `sessions FINAL` within `$__timeFilter(started_at)` | All | sessions |
| `session` | textbox | a session id | empty | session |
| `api_url` | constant, hidden | API base URL (set by provisioning and `grafana:push`) | – | session |

In SQL, use the variables as `engine IN (${engine:singlequote})`. Links are relative, so they work both locally and on Grafana Cloud:
- **To Sessions:** `/d/fleetscope-sessions?${__url_time_range}&${engine:queryparam}&${source:queryparam}`, plus `&var-status=…` where the tables below say so.
- **To Session detail:** `/d/fleetscope-session?var-session=${__data.fields.session_id}&from=${__data.fields.from_ms}&to=${__data.fields.to_ms}`. Here `from_ms` = start − 5 s and `to_ms` = end (or now) + 5 s, both in epoch ms. Hide these two fields with the `custom.hidden` override. Don't use Organize fields: it removes them, and the link breaks.
- **To Perfetto:** `${api_url}/v1/sessions/${session}/perfetto`, in a new tab.

### 4.2 Overview (`fleetscope-overview`)

Range `now-1h`, refresh `30s`, variables `engine` and `source`. Panels are listed top to bottom, with sizes as w×h on the 24-column grid.

| # | Panel (type, size) | Shows | Drill-down |
|---|---|---|---|
| 1 | **Fleet verdict ↗** (Stat, 6×5) | The word, Background solid. `no_data` → "No ended sessions" in `#9AA9BB`. | Sessions, `var-status=failed&var-status=blocked` |
| 2 | **Outcomes ↗** (Bar gauge, horizontal, 12×5) | Counts in the fields `healthy`, `degraded`, `failed`, `blocked`. Display names are the mapping texts; colours are fixed per field. | Sessions, `var-status=${__field.name}` |
| 3 | **Simulated share ↗** (Stat, 6×5) | Sim sessions / all sessions in range, no colour. Mappings: 0 → "0% · all real", 100 → "100% · all simulated". | Sessions, `var-source=sim` |
| 4–11 | **KPI row** (8 stats, 3×4 each) | See the next table. | See the next table. |
| 12 | **Error rate by engine ↗** (Time series, 24×8) | Error rate (section 3). Min interval 5m, threshold areas at 5% and 10%, y min 0. | Sessions, `var-engine=${__field.labels.engine}`, failed + blocked |
| 13 | **Active sessions by engine ↗** (Time series, 12×7) | Sessions running in each bucket, from `sessions` at query time. | Sessions, that engine |
| 14 | **Actions per minute by engine ↗** (Time series, 12×7) | `fleet_minute` counts divided by the bucket length in minutes. | Sessions, that engine |
| 15 | **By engine ↗** (Table, 24×6) | Columns below. | Sessions, `var-engine=${__data.fields.engine}` |
| 16 | **Recent failures ↗** (Table, 14×9) | Below. | Session detail |
| 17 | **Top failure causes ↗** (Table, 10×9) | Below. | Two links, below |

| KPI | Value | Unit | Colour | Link `var-status` |
|---|---|---|---|---|
| Active now ↗ | Running sessions with a resource sample in the last 30 s. Ignores the time range (the description says so). | `locale` | none | `running`, `from=now-15m` |
| Sessions ↗ | Sessions started in range, any status. | `locale` | none | All |
| Success rate ↗ | As defined in section 3. Null → `—`. | `percent`, 1 | thresholds, colour mode Value | `failed` + `blocked` |
| p95 action latency ↗ | From `fleet_minute` over the range. | `ms` | none | All |
| CPU in use ↗ | Sum of the latest `cpu_pct` / 100 over active sessions. | `cores`, 1 | none | `running` |
| Memory in use ↗ | Sum of the latest `mem_mb` over active sessions. | `mbytes`, 1 | none | `running` |
| Estimated cost ↗ | As defined in section 3. | `currencyUSD`, 2 | none | All |
| Interrupted ↗ | Sessions in range with `reason = 'interrupted'`. | `locale` | none | `interrupted` |

- **By engine:** columns Engine · Version (latest `engine_version`, null → `not reported`) · Status (engine success rate through the thresholds, Colored text) · Active now · Sessions · Success rate · p95 latency · CPU (avg % of one core) · Memory (avg peak MiB) · Est. cost · Top cause (e.g. `unsupported_api ×48`). There is no totals row: the KPI row is the total, and a Grafana footer would average the rates.
- **Recent failures:** the last 15 sessions that ended in range without succeeding (interrupted excluded). Columns: Time · Status · Session · Engine · Scenario · Cause (`code: message`, truncated, full text on hover) · Source. The Status and Session cells link to Session detail. No value: "No failures in this range".
- **Top failure causes:** the top 10. Columns: Cause · From · Sessions (gauge cell, `#5B7491`) · Engines (e.g. `lightpanda 71, chromium 3`). Two data links, which Grafana shows as a menu: "Latest session with this cause" (through hidden `session_id`, `from_ms` and `to_ms` fields) and "Failed and blocked sessions in range". No value: "No failures in this range".
- **Chart links** carry the whole panel range, not the clicked minute. To open the sessions in one spike, drag across it to zoom, then click. Every chart's description says this.
- **Stretch (first to cut):** an annotation "`<engine> <version>` first seen", from `min(started_at)` per engine and version, in `#9AA9BB`.

### 4.3 Sessions (`fleetscope-sessions`)

Range `now-1h`, refresh `30s`, variables `engine`, `source`, `status`, `agent`, `scenario`. The dashboard has one panel, **Sessions ↗** (Table, 24×22):
- **Rows:** the latest 1,000 sessions started in range (the description says so), newest first. Pagination, column filters, a footer with the row count, and cell height `sm`.
- **Links and empty state:** the Status and Session cells link to Session detail. No value: "No sessions match these filters in this range". The per-row memory sparkline from PLAN section 7 is a stretch item.

| Column | Content | Format |
|---|---|---|
| Status | display status | Colored text + the status mapping |
| Session | `session_id` | data link |
| Started | `started_at` | `dateTimeAsLocalNoDateIfToday` |
| Engine, Version | `engine`, `engine_version` | Version null → `not reported` |
| Scenario, Agent | `scenario`, `agent_id` | text |
| Duration | `duration_ms` | `ms`; null → `running` |
| Time to browser | `startup_ms + connect_ms` | `ms` |
| Actions, Failed actions | counts | `locale`; Failed actions has the threshold from section 3 |
| Peak memory | `maxOrNull(mem_mb)` | `mbytes`, 0; null → `Not available` |
| Est. cost | as defined in section 3 | `currencyUSD`, 4 |
| Cause | failure cause, `code: message` | truncated, full text on hover |
| Source | `real` → `REAL`, `sim` → `SIM` | no colour |
| (hidden) | `from_ms`, `to_ms` | `custom.hidden` |

### 4.4 Session detail (`fleetscope-session`)

Variables `session` and `api_url`, refresh off.
- **Time range:** the Sessions link sets it to the session ± 5 s.
- **Filtering:** only the three charts use `$__timeFilter`. Every other panel filters on `session_id = '${session}'` alone, so the header works in any range.
- **Layout:** a left column 16 wide and a right column 8 wide. Issues is the always-visible side panel that Eyal approved.

| # | Panel (type, size, column) | Shows |
|---|---|---|
| 1 | **Status** (Stat, 4×4) | Display status, Background solid. No value: "Session not found. It may be older than 30 days, or the id is wrong." |
| 2 | **What happened** (string Stat, 12×4) | One sentence built in SQL. Examples: `Failed at 9.35 s: action #9 click button.checkout-submit, selector_timeout`, `Blocked at 3.10 s: captcha`, `Completed with 1 issue: unsupported_api`, `Completed, no issues`, `Interrupted by the runner (not counted as a failure)`, `Running`. |
| 3, 4 | **Engine**, **Source** (Stats, 4×4) | `lightpanda 0.2.9` and `REAL` / `SIM`, no colour |
| 5–12 | **Stat row** (8 stats, 3×3) | Duration · Actions (`10 ok · 1 failed`) · Time to browser · Peak CPU · Peak memory · Peak JS heap (null → `Not available`) · Requests · Est. cost (4 decimals) |
| 13 | **Actions** (Table, 16×10, left) | # · Start (offset, `ms`) · Action (`action_type`) · Target · Duration (gauge cell, `#5B7491`) · Result (`✓ ok`, or `✕ failed` in `#FF7B7B`) · Error code. Sorted by #. Panel link: "Open timeline in Perfetto ↗". |
| 14 | **Timeline** (Text, 8×3, right) | "Open timeline in Perfetto ↗" and the line: "Actions, network and issues with CPU, memory and JS heap on one time axis. Opens ui.perfetto.dev; the trace stays in your browser." |
| 15 | **Issues** (Table, 8×13, right) | Time (offset) · Kind · Message (wrapped). No value: "No issues in this session". |
| 16–18 | **CPU**, **Memory**, **JS heap** (Time series, 16×6 each, left) | Container `cpu_pct` and `mem_mb`; CDP `js_heap_mb` |
| 19 | **Ask Grafana Assistant** (Text, 8×10, right) | The prompts below |
| 20 | **Network** (Table, 24×8) | Time · Domain · Type · Status (null → `no response`, ≥ 400 in `#FF7B7B`) · Bytes (null → `not reported`) · Duration. The description says the requests are sampled. |

- **Charts:** the queries keep the `engine` label, so the engine overrides colour them, and points sit at the real sample times. No value on CPU and Memory: "No samples in this range. Open the session from the Sessions table so the range fits it." No value on JS heap: "No JS heap samples: the engine doesn't report it (stored as null), or the range doesn't cover the session."
- **Annotations** (dashboard level, so they show on all three charts) replace the approved failure line. "Failed actions" is `#FF7B7B`, with text like `#9 click button.checkout-submit: selector_timeout`. "Issues" is `#FFD95A`, with text `kind: message`: an issue is what makes a successful session Degraded.
- **Assistant prompts** (Markdown; Grafana fills in `${session}`). Note in the panel that Assistant is Grafana Cloud only.
  - "Why did session ${session} fail? Start from the What happened panel and the first failed action."
  - "Was the page waiting or working when it failed? Compare CPU with the Actions table."
  - "Is this an engine limitation (unsupported_api, metrics that are Not available) or a problem with the site?"
  - "Find other sessions in the last 24 hours with the same failure cause, and say which engines they ran on."

## 5. Perfetto timeline

`GET /v1/sessions/:id/trace` returns Chrome Trace Event JSON (`{"traceEvents": [...], "displayTimeUnit": "ms"}`). `GET /v1/sessions/:id/perfetto` opens ui.perfetto.dev and hands it the trace with `postMessage`. The trace is processed in the viewer's browser and is never uploaded.
- **Time base:** `ts` and `dur` are microseconds from `started_at`, so the axis runs from 0 to the session duration, like the offsets in Grafana.
- **Process:** a single process (`pid: 1`), named with an `M` `process_name` event: `<session_id> · <engine> <version> · <REAL|SIM> · <status word>`.
- **Tracks:** each track is a thread, named with `M` `thread_name` and ordered with `thread_sort_index`.

| Track | tid | Events | Slice name | args |
|---|---|---|---|---|
| actions | 1 | `X` | `<action_type> <target>` (target cut at 60 chars); failed: `✕ <action_type> <target>` | `seq`, `ok`, `duration_ms`, `error_code` |
| network | 2, then `network 2`, `network 3`… | `X` | `<resource_type> <domain>`; failed (status null or ≥ 400): `✕ <resource_type> <domain> <status or "no response">` | `status`, `bytes`, `duration_ms` |
| issues | 3 | `i`, `s: "t"` | `<kind>` | `message` |

| Counter track | Event (`ph: "C"`, `pid: 1`) | Source | Unit |
|---|---|---|---|
| CPU % | `{"name":"CPU","args":{"%":62}}` | container `cpu_pct` | % of one core |
| memory MB | `{"name":"memory","args":{"MB":210}}` | container `mem_mb` | MiB, as stored |
| JS heap MB | `{"name":"JS heap","args":{"MB":38}}` | cdp `js_heap_mb` | MiB |

- **Lanes:** slices on one thread must nest. Network requests overlap, so the API packs them greedily into lanes and adds a `network N` thread only when one is needed. Actions are sequential and use one lane.
- **Counter track names:** Perfetto builds them by joining the event name and the arg key. Check them in Perfetto once. If they differ, change the key, not the meaning.
- **Colours:** Perfetto colours each slice from a hash of its name, using its own palette, and a JSON trace can't set a slice's colour (don't rely on the legacy `cname` field). So our tokens don't apply, identical actions share a colour, and ok vs failed is carried by the `✕` prefix and the args, never by colour.
- **Nulls:** never emit a counter value for a null sample. A counter holds its last value until the next event, so Perfetto can't show a gap (Grafana's charts can). If every JS heap sample of a session is null, emit no JS heap track; instead, add an instant at 0 on the issues track: `note: JS heap not available (engine reports null)`.

## 6. Empty and error states

| Situation | Shows | How |
|---|---|---|
| Count with no events | `0` | `count()` |
| Ratio or percentile with no denominator | `—` | SQL NULL; special mappings Null → `—` and NaN → `—` (as a guard) |
| Metric the engine can't provide | `Not available` | special mapping Null → `Not available`; `spanNulls: false` |
| Panel with no rows | the panel's own No value text (given per panel above) | `fieldConfig.defaults.noValue`; never Grafana's bare "No data" |
| One query fails | Grafana's red corner icon and the error on that panel only | built in |
| ClickHouse unreachable | the error on every panel; the time picker, variables and links still work | built in |
| Sim-only filter | Simulated share reads "100% · all simulated", and every row says `SIM` | 4.2 |
| Unknown or empty `session` | "Session not found…" in Status; the other panels show their No value text | 4.4 |

## 7. Do and don't

| Do | Don't |
|---|---|
| `✕ Failed` from the mapping, with `timeout` in the Cause column | A `Timeout` status, or a coloured status cell with no word |
| Engine colours set by the three regex overrides, with field default `#9AA9BB` | Series left on Grafana's classic palette |
| `if(den = 0, NULL, …)`, `maxOrNull`, `spanNulls: false` | `ifNull(x, 0)`, `coalesce(x, 0)`, connecting nulls |
| "Estimated cost", with the price explained in the description | A bare `$` figure |
| A data link on the value or the row, plus `↗` in the title | Links that live only in the panel header menu |
| Interrupted sessions shown as their own count | Counting them as failed, or dropping them silently |
| Hex values from section 2 only | A new colour without updating this file |

## 8. What we gave up for Grafana, and what we got

**Gave up:**
- **Custom KPI cards:** deltas "vs prior 1 h", the real/sim split bar, the capacity track and the breach edge. A Grafana stat shows one value, so trends live in the time series.
- **The verdict banner's sentence and its "Review N failures" button:** now the verdict stat, Outcomes and Success rate, with the verdict linking to the failures.
- **⌘K** (Grafana's own search covers dashboards; sessions open from the Sessions table), and **SSE live updates and animation** (a 30 s auto-refresh instead).
- **The Recharts waterfall** (neutral, slow and failed bars, the selected-row strip, one cursor across all rows): now Perfetto, plus the Actions table with gauge cells and the failure annotations.
- **Visual details:** marker shapes and end markers, peak and spike labels, the shared legend, the hatch and source strip for sim, our type scale and monospace ids, automatic theme switching. **Capacity** goes too (the line and the verdict rule), because the schema has no capacity data.
- **"Explain this session"** is replaced by Grafana Assistant (Cloud only, and we don't control its answers). **PostHog** is gone.

**Got for free:** the time picker with state in the URL, variables, auto-refresh, the shared crosshair, annotations, Inspect > Data (the "View as table" alternative for every chart, with CSV export), per-panel error isolation, and alerting for later.

## 9. Checks

- **SQL:** CI already runs every panel's SQL against seeded data (ADR 0003).
- **Dashboard JSON:** add a check that parses `infra/grafana/dashboards/*.json` and asserts that every colour is a Dark hex from section 2 (or `text` / `transparent` as a threshold base), every panel uses UID `fleetscope-clickhouse`, every stat and table sets `noValue`, every time series has `spanNulls: false` and the three engine overrides, and no `rawSql` contains `ifNull(` or `coalesce(` with a `0` default.
- **QA:** open Overview and Session detail at 1440 and 1024 px in dark. Check that no panel shows the bare "No data", every `↗` panel opens a filtered Sessions view, a Sessions row opens Session detail with data in its charts, and Perfetto shows the tracks and counters from section 5.
