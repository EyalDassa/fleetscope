# ADR 0005: Route sessions by scenario when an engine lacks a needed feature

- Status: accepted (2026-10-24)

## Context

Real cloud data showed Lightpanda failing every `heavy-page-crawl` session with `webWorker: timeout after 3000ms`. That one scenario pulled its success rate to about 56%; without it, it was about 84%, on par with Chromium (88%).

We checked that the failure is the engine's, not our probe's. `tools/worker-probe.mjs` starts an image and tries three kinds of Web Worker: from a script URL, from a `blob:` URL (what `/js-heavy` uses) and from a `data:` URL.

| Image | `typeof Worker` | Script URL | blob: | data: |
|---|---|---|---|---|
| `lightpanda/browser:1.0.2` | function | timeout | timeout | timeout |
| `lightpanda/browser:nightly` (1.1.0-nightly.11062, 2026-10-24) | function | timeout | timeout | timeout |
| `chromedp/headless-shell:156.0.8078.48` | function | ok | ok | ok |

Lightpanda has a `Worker` constructor but never runs a worker.

## Options

1. **Make the number look better**: skip the worker probe on Lightpanda, or count the session as a success. Rejected: it fakes data, which CLAUDE.md forbids.
2. **Leave it.** The comparison stays honest, but a fleet that sends Worker pages to Lightpanda fails them forever.
3. **Route by scenario** (chosen). Before a session starts, if the engine it was assigned lacks a capability the scenario needs, run it on the lightest capable engine instead, and record that it was routed.
4. **Retry on fallback**: run the session on Lightpanda, and if it fails with a missing feature, run it again elsewhere. It costs a failed session every time and makes the success rate harder to read. Deferred; option 3 avoids the doomed attempt.

## Decision

- **Capabilities are a static, evidence-backed table.**
  - Each scenario declares what it needs (`SCENARIO_NEEDS`, e.g. `heavy-page-crawl: ["webWorker"]`).
  - Each engine declares what it lacks (`lacks` in `ENGINE_SPECS`; Lightpanda: `["webWorker"]`).
  - An entry is added only with a reproducible probe, and removed only when `tools/worker-probe.mjs` (or a successor) passes on the new pinned image.
- **`--routing fixed|by-scenario`** on `fleet run` and `fleet traffic`.
  - `fixed` stays the default: fair assignment, every scenario on every engine, so the Browsers dashboard keeps measuring the gap.
  - `by-scenario` moves a session to the first capable engine among the run's engines, lightest first: lightpanda, then chrome-headless-shell, then chromium. If none is capable, the session runs as assigned and fails honestly.
- **Recorded, never hidden.** `session.started.routed_from` (and `sessions.routed_from`) names the engine first chosen. A routed session counts under the engine that actually ran it, and the dashboards show how many sessions were routed.
- **Live traffic** routes, but every 10th batch runs `fixed` as a canary, so the cloud data still measures the gap and shows when a Lightpanda release closes it.

## Consequences

- With routing on, Lightpanda's success rate reflects only the scenarios it is given (about 84%), and the fleet's overall rate rises to the level of the demo site's deliberate chaos (botwall, flaky button).
- Per-engine success rates under `by-scenario` answer "how does this engine do on the work it is routed?", not "how does it do on everything?". The compatibility matrix, fed by `fixed` runs and the canary, answers the second question.
- The table can go stale. A newer Lightpanda might support workers, and we would keep routing around it until someone reruns the probe. The canary batches surface that in the dashboards.
- Learning capabilities from data (for example from `unsupported_*` and timeout patterns per scenario × engine) would be an Insights feature (M4), not a hand-kept table.
