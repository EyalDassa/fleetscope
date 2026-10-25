# @fleetscope/collector

The SDK that measures a browser session and ships the events to the Fleetscope API. It wraps a
Playwright `Page` so that every step becomes an `action` event, and it batches everything through one
in-order queue. The schemas come from `@fleetscope/schema`; nothing here defines an event shape.

```
createCollector ──> startSession ──> session.collectPage(page) ──> page.goto / click / ...
 (one per process     queues            wraps a Playwright page      one `action` event each,
  and engine)         session.started                                 plus issues, network, heap
                                        session.recordContainerSample()   <- the runner, from Docker
                                        session.endSession(status, reason) -> session.ended (always last)
```

## Use it

```ts
const collector = createCollector({ apiUrl, source: "real", agentId, provider, engine });
const session = collector.startSession({ scenario, region, engineVersion, startupMs, connectMs });
const page = await session.collectPage(playwrightPage);

await page.goto(url);                       // returns the HTTP status; throws CollectedError on failure
await page.fill(sel, "text");               // the text is never recorded (it may be a password)
await page.click(sel);                      // waits for the navigation it caused
await page.extract(sel);                    // text; { as: "count" } for a number (0 is not an error)
await page.wait(500) / page.wait(sel);      // a time, or until a selector is visible
await page.eval(() => 1 + 1);               // run script in the page
await page.screenshot();                    // an `action`; the image is not stored in M1

await session.endSession("success", null);  // or failed | blocked | timeout | crashed, with a reason
await collector.close();                    // flush, bounded; stats() is final when it returns
```

`CollectedPage` is a plain wrapper class, not a proxy. Anything not on it goes through `page.raw` and
is not measured.

## What is recorded

| Event | When | Notes |
|---|---|---|
| `session.started` | `startSession` | `startup_ms`: container created until the engine's endpoint answered. `connect_ms`: the client's connect; for a Playwright server **this includes launching the browser**. Compare engines on the sum |
| `action` | each `CollectedPage` method | `seq` from 0 in start order, `ts` = when the action **started**, `duration_ms`, `ok`, `error_code`. `target` is a selector or a hostname |
| `issue` | see below | environment problems only |
| `network.request` | 1 in 5 http(s) requests (configurable), starting with the first | `bytes` is `null` when the engine does not say |
| `resource.sample` `cdp` | every 2 s, and once at start and end | `js_heap_mb` only. If the engine has no CDP `Performance` domain: one sample with `null`, then silence. Never a crash |
| `resource.sample` `container` | `recordContainerSample`, called by the runner | `ts` is when Docker took the reading |
| `session.ended` | `endSession` | `duration_ms` runs from `startSession`, so it excludes startup and connect. A non-success ending always has a `reason` |

Honesty rules: what an engine cannot report is `null`, never a guess; all text is cut on code points
and repaired so a lone surrogate (half an emoji) can never reach ClickHouse, which refuses it.

## Error codes (`action.error_code`) and issues

| Code | Meaning | Also raises an `issue` |
|---|---|---|
| `timeout` | Playwright timeout on an element that exists, or a page that never settles | `timeout` |
| `selector_not_found` | the selector matched nothing before the timeout | none |
| `nav_error` | DNS / refused / TLS failure, or the page answered another HTTP 4xx | `nav_error` |
| `http_403` | a page the action loaded (a goto, or a click that navigated) answered 403 | `blocked` |
| `http_429` | ... answered 429 Too Many Requests (a site pushing back) | `blocked` |
| `http_5xx` | ... answered a server error | `nav_error` |
| `captcha` | the page has `[data-testid=captcha]` | `captcha` |
| `unsupported_api` | the page used a Web API the engine lacks: a `ReferenceError` / "X is not defined", or a `TypeError` that names a known API (see below) | `unsupported_api` |
| `unsupported_feature` | the **engine refused a Playwright/CDP feature** the action needs: `Protocol error (Domain.method): ... wasn't found` (JSON-RPC -32601), "not implemented", "not supported". The engine's limit, not the page's; the message says what was refused | none |
| `js_error` | `eval` threw something else | none |
| `browser_closed` | the page, context or browser closed or crashed during the action | `crash`, unless the runner called `session.beginShutdown()` first (it closed the browser itself) |
| `unknown` | anything else; the thrown error keeps the original as `cause` | none |

A 403 or a captcha throws `BlockedError`; the runner ends such a session `blocked`.

**Why did a session fail?** Every non-success session has a `reason`, and the action that failed has
an `error_code`. Together they answer the question. `issue` events are for problems with the site or
the engine (blocked, captcha, crash, timeout, navigation, unsupported API), so a session can fail
without an issue, for example when a selector is missing. Do not read only `issues` for failures.

**Missing Web API vs unsupported feature.** `unsupported_api` is about the *page*: its script used
`IntersectionObserver`, `crypto.subtle`, ... and the engine does not have it. TypeError-shaped ones
(`IntersectionObserver is not a constructor`, `Cannot read properties of undefined (reading
'digest')`) count only when they name an API from the fixed list in `src/errors.ts`
(`KNOWN_WEB_APIS`, plus the `crypto.subtle` method names), never by a broad "is not a function" rule.
`unsupported_feature` is about the *action*: a screenshot, viewport emulation or another CDP call the
engine does not implement. It is never filed as `unknown`.

## Delivery

One queue per collector, so events keep their order. `push` never touches the network: page actions
are never slowed by a slow API.

- Flush at 500 events or every 1 s; at most 1000 per request (the API limit).
- `400`/`413` and other 4xx: never retried; the events are dropped, counted and logged with the
  validation issues.
- `503`, `429`, `408`, other 5xx and network errors: retried with jittered exponential backoff
  (250 ms doubling to 10 s), honouring `Retry-After`, **for up to 10 minutes per batch**. That is
  long enough for an API restart and shorter than the API's 15-minute window for recognising repeated
  `event_id`s, so a late resend is still safe. Retries resend identical events.
- While a batch is stuck, newer events wait behind it, in order. If more than 100 000 pile up, samples
  and network events are dropped first; sessions, actions and issues are kept.
- `close(timeoutMs = 10 000)` aborts what is still pending at the deadline. When it returns,
  `stats()` is final: `{ pushed, sent, duplicates, dropped, pending: 0 }`. Treat `dropped > 0` as
  data loss (the runner exits 1).

## Tests

`pnpm --filter @fleetscope/collector test`: fake Playwright pages, a real HTTP server that
misbehaves, and a virtual clock for the long outages. `collector.http.test.ts` is QA's.
