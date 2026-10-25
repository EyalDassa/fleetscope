# ADR 0007: Real public sites next to the demo site

- Status: accepted (2026-10-25)

## Context

The demo site gives controlled, reproducible failures, but it can't show how the engines cope with real production pages. Eyal wants the fleet to also visit live sites, so that:
- the scripts keep working when a site changes;
- Grafana never mixes demo and real-site traffic.

## Options

1. **Practice sites made for scraping** (books.toscrape.com, saucedemo.com). Stable and welcoming, but not real production traffic. Eyal rejected them.
2. **Big consumer sites** (Google, Amazon, news). Their terms forbid bots, they show CAPTCHAs and cookie walls, and they change constantly. Rejected.
3. **Large public reference sites whose robots.txt allows `*`, read-only.** Chosen.

## Decision

- **Sites:** Wikipedia, MDN, GOV.UK, Hacker News, Python docs.
  - Excluded: Stack Overflow (robots.txt disallows everything) and GitHub (its terms restrict automated access).
- **Read-only journeys only.** Open a page, follow links, read. No login, no form that creates anything, no purchases.
  - Never solve a CAPTCHA, and never click a cookie or consent banner.
- **Robots.txt.** Only paths that the site's robots.txt allows for `*`, checked at the start of every run. The site's crawl-delay is kept between page loads within a session: GOV.UK 10 s, Hacker News 30 s.
- **No fingerprint changes.** Each engine visits with its own user agent, headers and defaults; the fleet measures the browsers as they are and never disguises them.
  - Trade-off: Wikimedia asks bots to send an identifying user agent, and we knowingly don't.
  - What keeps it polite instead: very low volume (about one public session per batch, rotating through five sites, so each site sees about one visit every few minutes) and pausing on push-back.
- **Push-back pauses the site.** A 403, 429 or CAPTCHA ends the session as `blocked` and pauses that site for an hour.
- **Kept apart in the data.** Every session carries `target` (`demo` | `public`) and `site`. `source` (`real` | `sim`) keeps its meaning. Every dashboard can filter on target and site.
- **Site changes are not blamed on the browser.** When a page loads but its landmark selector is missing, the error is `site_layout`. A daily canary (GitHub Actions, Chromium only, never a required check) opens an issue when a site's journey breaks.

### Implementation choices (2026-10-25)

- **Optional fields, default at storage.** `target` and `site` are optional in `session.started`; absent means `demo` / `demo-site`, applied at storage. Old events and the simulator therefore stay valid.
- **robots.txt:**
  - one that cannot be read (5xx or a network error) means the site is **skipped**, never visited blind;
  - a 4xx robots.txt means "allow all", per the robots standard;
  - it is re-read every 6 hours in `fleet traffic`.
- **No site available.** When every site is paused or skipped, public sessions fall back to the demo site, with one warning, so a batch still runs.
- **Error codes.** A 429 is recorded as its own code, `http_429`, not folded into `http_403`.
- **Pacing.** The crawl delay is kept per site across all sessions of one fleet process, with at most one session per site at a time. Pacing is per process: two fleet processes running at once can each visit a site. Only the pause file (`--state-file`) is shared between processes, so run one public-site process at a time (the live loop is that one).

## Adding a site: checklist

1. Its robots.txt allows `*` for the planned paths, and its terms don't forbid automated access.
2. The journey is read-only and needs no account.
3. The descriptor has a crawl-delay and landmark selectors (with a fallback each), plus a saved HTML fixture for the offline tests.
4. The canary covers it.

## Consequences

- **Real-world compatibility numbers** per engine, including Lightpanda on real JavaScript-heavy pages.
- **Upkeep.** Sites change, and the canary and `site_layout` make that visible rather than silent; fixing a descriptor is part of normal upkeep.
- **Public runs are less reproducible** than demo runs: the site's content and timing vary, even though the path choice is seeded.
- **A site may block the fleet.** Then it is paused and shows as `blocked`, and we decide whether to drop it.
