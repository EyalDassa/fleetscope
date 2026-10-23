# @fleetscope/demo-site

The target that the Fleetscope browser fleet is pointed at: a small, plain web shop ("Fleetmart")
with pages that misbehave on purpose. It is not the dashboard, so `design/DESIGN.md` does not apply.
It holds no real data: products are generated, sessions and carts live in memory.

Fastify, server-rendered HTML (no client framework), TypeScript, pino logs.

## Run it

```bash
pnpm --filter @fleetscope/demo-site dev      # tsx watch, http://localhost:3100
pnpm --filter @fleetscope/demo-site build    # esbuild bundle -> dist/server.js
pnpm --filter @fleetscope/demo-site start    # run the bundle
pnpm --filter @fleetscope/demo-site test     # vitest (fastify.inject, no network)
```

| Variable | Default | Meaning |
|---|---|---|
| `DEMO_SITE_PORT` | `3100` | Listen port |
| `DEMO_SITE_HOST` | `0.0.0.0` | Listen address. All interfaces on purpose: browser containers reach the site through `host.docker.internal`, which on Linux CI resolves to the Docker bridge address, so a loopback-only listener would be unreachable |
| `LOG_LEVEL` | `info` | pino level (`/healthz` is never logged) |

From a browser container, the base URL is `http://host.docker.internal:3100`.

### Secure context gotcha (`crypto.subtle`)

`/js-heavy` calls `crypto.subtle.digest`, which browsers only expose on a secure context (HTTPS or
`localhost`). Over `http://host.docker.internal:3100` Chromium has no `crypto.subtle`, so that probe
fails with a real `TypeError` on every Chromium-based engine, which says nothing about the engine.
Verified workaround for Chromium and chrome-headless-shell: browse to `http://demo.localhost:3100`
and start the browser with `--host-resolver-rules="MAP demo.localhost host.docker.internal"`.
`*.localhost` origins count as secure, and the rule sends the traffic to the host.
(`--unsafely-treat-insecure-origin-as-secure` also works, but only on full Chromium with
`--headless=new`, not on the headless shell.)

## Login and session

The only account is `agent` / `fleetscope`. A successful login sets an HttpOnly cookie `fs_session`
(server-side session, in memory, capped at 5000 sessions). Pages behind login redirect to `/login`
(302) when the cookie is missing or unknown. Nothing else is redirected.

Behind login: `/dashboard`, `/search`, `/item/:id`, `/cart/add`, `/checkout`, `/checkout/done`.
Public: `/`, `/login`, `/healthz`, `/img/:n.svg`, `/admin/chaos`, and every chaos page below.

Form posts answer with 303 redirects. A form with bad input is shown again with **status 200**
(like a typical server-rendered form), not 4xx, so deliberate bad input does not look like a
network failure in the fleet's data.

## Routes and test ids

Elements are found with `data-testid`. Every id below is unique on its page unless it says "one per
row".

| Route | What it is | Test ids |
|---|---|---|
| `GET /` | Home with links to everything | `home-login`, `home-heavy`, `home-slow`, `home-flaky`, `home-botwall`, `home-js-heavy` |
| `GET /login` | Login form | `login-user`, `login-pass`, `login-submit`; `login-error` after a failed attempt |
| `POST /login` | Fields `user`, `pass` (urlencoded). Success: sets cookie, 303 to `/dashboard`. Failure: form again (200) with `login-error` | |
| `POST /logout` | Ends the session, 303 to `/login` | `logout` (the button in the header) |
| `GET /dashboard` | Greeting, search box, featured products | `dashboard-greeting` ("Welcome back, agent"), `search-input`, `search-submit`, `featured-item` (one per product) |
| `GET /search?q=&page=` | Search over the 200 products, 20 per page | `search-input`, `search-submit`, `search-count`, `search-results` (the list), `search-result` (one per row), `search-next`, `search-prev` |
| `GET /item/:id` | Product page, `id` is 1 to 200 (404 otherwise, `not-found`) | `item-title`, `item-price`, `item-description`, `add-to-cart` |
| `POST /cart/add` | Field `id`. Adds one unit, 303 to `/checkout` | |
| `GET /checkout` | Cart summary and the order form. Works with an empty cart too | `checkout-name`, `checkout-email`, `checkout-address`, `checkout-submit`, `checkout-error`, `cart-lines`, `cart-line`, `cart-total`, `cart-empty` |
| `POST /checkout` | Fields `name`, `email`, `address`. Success: 303 to `/checkout/done`. Failure: form again (200) with `checkout-error` | |
| `GET /checkout/done` | Confirmation of the latest order (redirects to `/checkout` if there is none) | `order-confirmation` (whole box), `order-id` (`FS-000001`, `FS-000002`, ...) |
| `GET /healthz` | `200 {"status":"ok"}` | |

Notes for scenario authors:

- `search-result` is the row itself, and it is the `<a href="/item/:id">` (with `data-item-id`).
  `locator('[data-testid=search-result]').first().click()` follows the link in every engine, and
  `getAttribute('href')` works on it.
- Layout (logged-in pages only): `nav-dashboard`, `nav-search`, `nav-cart`, `cart-count` (units in
  the cart), `logout`. Logged out: `nav-login`.
- Checkout validation, on the server only (the inputs have no `required` or `type=email`, so the
  browser never blocks the submit): name 2 to 80 characters, email `x@y.z`, address 5 to 200
  characters. `checkout-error` lists every problem; the typed values stay in the fields.
- The catalog is deterministic: 10 adjectives x 20 nouns, e.g. id 1 is "Compact Widget", id 3
  "Compact Lamp" ($38.49). Searching `lamp` gives 10 rows, `audio` 20 (the category is searched too).

## Chaos pages

All are public and all answer to the global chaos settings and the query overrides below.

| Route | Params | Behaviour | Test ids |
|---|---|---|---|
| `GET /heavy` | `nodes` (default 5000, max 50000), `images` (default 50, max 500) | `nodes` small `<div class="n">` cells (in sections of 100) and `images` `<img src="/img/N.svg">` with distinct URLs, so every image is its own request | `heavy-summary` (`data-nodes`, `data-images`), `heavy-images`, `heavy-grid` |
| `GET /img/:n.svg` | `n` is 0 to 999999 | A small generated SVG (about 400 bytes), the same for the same `n`. `Cache-Control: no-store`. Never delayed or failed by chaos | |
| `GET /slow` | `ms` (default 2000, max 30000) | Responds after `ms` milliseconds | `slow-result` (`data-waited-ms`) |
| `GET /flaky` | `rate` (default 0.3) | With that probability the button is left out of the page | `flaky-button` (clicking writes "Clicked" into `flaky-result`), `flaky-result` |
| `GET /botwall` | `rate` (default 0.2), `step` (cosmetic, default 1) | With that probability the page is a bot wall: HTTP **403** (`botwall-blocked`) or a **200** page with a fake CAPTCHA (`captcha`), roughly half each. Otherwise a normal page that links on to `/botwall?...&step=N+1` | `botwall-ok`, `botwall-next`, `botwall-home`; on the wall: `botwall-blocked` or `captcha` |
| `GET /js-heavy` | none | Inline script using `IntersectionObserver`, `ResizeObserver`, `crypto.subtle.digest`, a Web Worker from a blob URL and `requestIdleCallback`. It does **not** check whether they exist: a missing API throws a real `ReferenceError` or `TypeError` | `js-result` |

### `/js-heavy` result

`js-result` is empty while running. When all five probes are finished it gets
`data-status="done"`, `data-failed="<number of failed probes>"` and JSON text like:

```json
{"intersectionObserver":{"ok":true,"detail":"1 entry, isIntersecting=true"},
 "resizeObserver":{"ok":true,"detail":"1 entry, width=200"},
 "cryptoSubtleDigest":{"ok":false,"error":"TypeError: Cannot read properties of undefined (reading 'digest')"},
 "webWorker":{"ok":true,"detail":"worker answered 42"},
 "requestIdleCallback":{"ok":true,"detail":"didTimeout=false"}}
```

Each probe runs in its own try/catch only so that one missing API does not hide the others. The
original error object is then **thrown again, uncaught**, from a timer, so the engine reports one
page error per failing API (what a Playwright `pageerror` listener sees). A probe that never
finishes is recorded as `"timeout after 3000ms"` and not thrown. Wait for the result with
`[data-testid=js-result][data-status=done]`.

## Global chaos

Four knobs, each in effect for **every page** (GET requests to everything except `/healthz`,
`/admin/*` and `/img/*`; form posts are never affected):

| Setting | Range | Effect on a page |
|---|---|---|
| `latencyMs` | 0 to 30000 | Waits this long before answering |
| `errorRate` | 0 to 1 | With this probability the page is a **500** (`server-error`) |
| `botwallRate` | 0 to 1 | With this probability the page is replaced by a bot wall: 403 (`botwall-blocked`) or a 200 CAPTCHA page (`captcha`), half each |
| `flakyRate` | 0 to 1 | With this probability the page's main action is missing from the HTML: `add-to-cart` on `/item/:id`, `checkout-submit` on `/checkout`, `flaky-button` on `/flaky` |

The checks run in this order: latency, then error, then bot wall, then flaky.

### Admin API

| Request | Effect |
|---|---|
| `GET /admin/chaos` | Returns the current settings, e.g. `{"latencyMs":0,"flakyRate":0,"botwallRate":0,"errorRate":0}` |
| `POST /admin/chaos` | JSON body with any of the four fields. Fields you leave out keep their value. Returns the new settings. Unknown fields or out-of-range values: **400** and nothing changes |
| `DELETE /admin/chaos` | Resets all four to 0 |

The settings are in memory: a restart resets them. There is no authentication; the site holds no
real data, but do not expose it to the internet.

```bash
curl -X POST localhost:3100/admin/chaos -H 'content-type: application/json' \
     -d '{"latencyMs":500,"errorRate":0.1}'
curl -X DELETE localhost:3100/admin/chaos
```

### Query parameters (per request)

Any page accepts these and they **override** the global settings for that request:
`latencyMs`, `errorRate`, `botwallRate`, `flakyRate`, plus `seed`. The dedicated pages also have a
short name for their own knob: `/slow?ms=`, `/flaky?rate=`, `/botwall?rate=` (if both the short and
the long name are given, the short one wins).

For each knob the order is: **query parameter, then a non-zero global setting, then the page's own
default** (`/slow` 2000 ms, `/flaky` 0.3, `/botwall` 0.2, every other page 0). So with all
settings at 0, `/flaky` is flaky and `/login` is not, and `/flaky?rate=0` is never flaky.

- Values are clamped (rates to 0..1, latency to 0..30000) and ignored when they are not numbers.
- `?seed=N` (a whole number) makes the random choices of that request deterministic: the same seed
  with the same settings always gives the same outcome. The choices are drawn in a fixed order
  (error, bot wall, bot wall kind, flaky) whatever the rates are. Without `seed` the choices are
  random.

## Code map

| File | What it holds |
|---|---|
| `src/chaos.ts` | Pure chaos logic: settings, query resolution, seeded random, the dice (`decide`) |
| `src/chaos-gate.ts` | Fastify hook that applies it to pages, plus `/admin/chaos` |
| `src/routes/shop.ts` | Login, dashboard, search, item, cart, checkout |
| `src/routes/chaos-pages.ts` | `/`, `/heavy`, `/img`, `/slow`, `/flaky`, `/botwall`, `/js-heavy` |
| `src/js-probe.ts` | The inline script of `/js-heavy` |
| `src/catalog.ts`, `src/session.ts`, `src/html.ts`, `src/layout.ts` | Products, sessions, escaping template helper, page shell |
