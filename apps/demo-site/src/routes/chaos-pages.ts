/** The public pages built to misbehave: heavy, slow, flaky, botwall, js-heavy, plus the images. */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { intParam, MAX_LATENCY_MS } from "../chaos";
import { page } from "../chaos-gate";
import { html, raw, type SafeHtml } from "../html";
import { JS_PROBE_SCRIPT } from "../js-probe";
import { layout } from "../layout";

const HTML = "text/html; charset=utf-8";

export const HEAVY_DEFAULTS = { nodes: 5000, images: 50 };
export const HEAVY_MAX = { nodes: 50_000, images: 500 };
/** The /img/:n.svg route accepts any n up to this; it is a generator, not a fixed set of files. */
const MAX_IMAGE_NUMBER = 999_999;

/** A small deterministic SVG: the same n always gives the same picture. About 400 bytes. */
export function svgImage(n: number): string {
  const hue = (n * 47) % 360;
  const accent = (hue + 140) % 360;
  const shape =
    n % 3 === 0
      ? `<circle cx="48" cy="48" r="30" fill="hsl(${accent} 70% 45%)"/>`
      : n % 3 === 1
        ? `<rect x="18" y="18" width="60" height="60" rx="8" fill="hsl(${accent} 70% 45%)"/>`
        : `<polygon points="48,14 82,80 14,80" fill="hsl(${accent} 70% 45%)"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<rect width="96" height="96" fill="hsl(${hue} 60% 88%)"/>` +
    shape +
    `<text x="48" y="56" font-family="sans-serif" font-size="22" font-weight="700" text-anchor="middle" fill="#fff">${n}</text>` +
    `</svg>`
  );
}

/** The query string of a request, for building links that keep the chaos parameters. */
function rawQuery(request: FastifyRequest, ...names: string[]): string {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const params = new URLSearchParams();
  for (const name of names) {
    const value = query[name];
    if (typeof value === "string") params.set(name, value);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export async function chaosPageRoutes(app: FastifyInstance): Promise<void> {
  // ---- Home: a public page that links to everything, handy for crawl scenarios ----

  app.get("/", page(), async (_request, reply) => {
    const body = html`<div class="card">
      <h1>Fleetmart</h1>
      <p>A small demo shop for Fleetscope. It holds no real data.</p>
      <ul>
        <li><a href="/login" data-testid="home-login">Sign in</a> (agent / fleetscope)</li>
        <li><a href="/heavy" data-testid="home-heavy">Heavy page</a></li>
        <li><a href="/slow" data-testid="home-slow">Slow page</a></li>
        <li><a href="/flaky" data-testid="home-flaky">Flaky page</a></li>
        <li><a href="/botwall" data-testid="home-botwall">Members area</a></li>
        <li><a href="/js-heavy" data-testid="home-js-heavy">Interactive widgets</a></li>
      </ul>
    </div>`;
    return reply.type(HTML).send(layout({ title: "Home", body }));
  });

  // ---- /heavy: a big DOM and many image requests ----

  app.get("/heavy", page(), async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const nodes = intParam(query.nodes, {
      min: 0,
      max: HEAVY_MAX.nodes,
      fallback: HEAVY_DEFAULTS.nodes,
    });
    const images = intParam(query.images, {
      min: 0,
      max: HEAVY_MAX.images,
      fallback: HEAVY_DEFAULTS.images,
    });

    // Built as one string: 50,000 small tagged-template calls would be needlessly slow.
    const cells: string[] = [];
    for (let i = 0; i < nodes; i++) {
      if (i % 100 === 0) cells.push(i === 0 ? "<section>" : "</section><section>");
      cells.push(`<div class="n">${i + 1}</div>`);
    }
    if (nodes > 0) cells.push("</section>");

    const thumbs: string[] = [];
    for (let i = 1; i <= images; i++) {
      thumbs.push(
        `<img class="thumb" src="/img/${i}.svg" width="48" height="48" alt="Image ${i}">`,
      );
    }

    const body = html`<div class="card">
        <h1>Heavy page</h1>
        <p data-testid="heavy-summary" data-nodes="${nodes}" data-images="${images}">${nodes} nodes, ${images} images</p>
      </div>
      <div class="card" data-testid="heavy-images">${raw(thumbs.join(""))}</div>
      <div class="card grid" data-testid="heavy-grid">${raw(cells.join(""))}</div>`;
    return reply.type(HTML).send(layout({ title: "Heavy page", body }));
  });

  // Small generated SVGs, so the heavy page produces many separate network requests.
  // Not behind the chaos hook: images always answer immediately.
  app.get("/img/:file", async (request, reply) => {
    const { file } = request.params as { file: string };
    const match = /^(\d{1,6})\.svg$/.exec(file);
    const n = match?.[1] === undefined ? Number.NaN : Number(match[1]);
    if (!Number.isInteger(n) || n < 0 || n > MAX_IMAGE_NUMBER) {
      return reply.code(404).type("text/plain").send("not found");
    }
    return reply.header("cache-control", "no-store").type("image/svg+xml").send(svgImage(n));
  });

  // ---- /slow: ?ms= is the page's name for latencyMs (default 2000, capped at 30 s) ----

  app.get(
    "/slow",
    page({ defaults: { latencyMs: 2000 }, aliases: { latencyMs: "ms" } }),
    async (request, reply) => {
      const waited = request.chaos?.settings.latencyMs ?? 0;
      const body = html`<div class="card">
        <h1>Slow page</h1>
        <p data-testid="slow-result" data-waited-ms="${waited}">This page took ${waited} ms to load.</p>
        <p class="hint">Longest possible wait: ${MAX_LATENCY_MS / 1000} s.</p>
        <p><a href="/">Home</a></p>
      </div>`;
      return reply.type(HTML).send(layout({ title: "Slow page", body }));
    },
  );

  // ---- /flaky: ?rate= is the page's name for flakyRate (default 0.3) ----

  app.get(
    "/flaky",
    page({ defaults: { flakyRate: 0.3 }, aliases: { flakyRate: "rate" } }),
    async (request, reply) => {
      const missing = request.chaos?.flaky ?? false;
      // The button only writes into the page; nothing here depends on an engine feature.
      const button = html`<button type="button" data-testid="flaky-button"
          onclick="document.querySelector('[data-testid=flaky-result]').textContent = 'Clicked'">Click me</button>`;
      const body = html`<div class="card">
        <h1>Flaky page</h1>
        <p>Sometimes the button below does not show up.</p>
        ${missing ? "" : button}
        <p data-testid="flaky-result"></p>
        <p><a href="/">Home</a></p>
      </div>`;
      return reply.type(HTML).send(layout({ title: "Flaky page", body }));
    },
  );

  // ---- /botwall: ?rate= is the page's name for botwallRate (default 0.2) ----
  // When the wall does not fire, the page links on to the next step, so a crawler meets the
  // wall again and again. The 403 and the CAPTCHA come from the chaos hook.

  app.get(
    "/botwall",
    page({ defaults: { botwallRate: 0.2 }, aliases: { botwallRate: "rate" } }),
    async (request, reply) => {
      const step = intParam((request.query as Record<string, unknown>).step, {
        min: 1,
        max: 1_000_000,
        fallback: 1,
      });
      const keep = rawQuery(request, "rate", "botwallRate", "seed");
      const sep = keep ? "&" : "?";
      const body = html`<div class="card">
        <h1>Members area</h1>
        <p data-testid="botwall-ok">You made it through (step ${step}).</p>
        <ul>
          <li><a href="/botwall${keep}${sep}step=${step + 1}" data-testid="botwall-next">Next page</a></li>
          <li><a href="/" data-testid="botwall-home">Home</a></li>
        </ul>
      </div>`;
      return reply.type(HTML).send(layout({ title: "Members area", body }));
    },
  );

  // ---- /js-heavy: Web APIs that some engines lack ----

  app.get("/js-heavy", page(), async (_request, reply) => {
    const probes = [
      "intersectionObserver",
      "resizeObserver",
      "cryptoSubtleDigest",
      "webWorker",
      "requestIdleCallback",
    ];
    const body: SafeHtml = html`<div class="card">
      <h1>Interactive widgets</h1>
      <div id="probe-target" style="width:200px;height:40px;background:#d9e2ec">probe target</div>
      <ul>${probes.map((name) => html`<li data-probe="${name}">${name}: running</li>`)}</ul>
      <pre data-testid="js-result" data-status="running" style="white-space:pre-wrap"></pre>
    </div>`;
    return reply.type(HTML).send(
      layout({
        title: "Interactive widgets",
        body,
        scripts: html`<script>${raw(JS_PROBE_SCRIPT)}</script>`,
      }),
    );
  });
}
