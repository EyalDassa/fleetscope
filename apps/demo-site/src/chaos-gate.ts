/**
 * Fastify glue for the chaos logic: a hook that runs before every page route, and the
 * /admin/chaos routes that change the global settings.
 *
 * A route opts in with `config: { chaos: {...} }` (see `page()`). Health checks, images and the
 * admin routes do not, so they always answer promptly. Only GET requests are affected: form
 * posts (login, add to cart, checkout) behave the same whatever the chaos settings are.
 *
 * The admin routes only accept callers on loopback (see loopback.ts).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type ChaosRoute,
  type ChaosSettings,
  type ChaosStore,
  chaosPatchSchema,
  decide,
  parseSeed,
  resolveSettings,
  seededRandom,
} from "./chaos";
import { html } from "./html";
import { layout } from "./layout";
import { requireLoopback } from "./loopback";

/** What the hook decided for this request, for the route handler to use. */
export interface ChaosOutcome {
  settings: ChaosSettings;
  /** Leave out the page's main action element (add-to-cart, checkout-submit, flaky-button). */
  flaky: boolean;
}

declare module "fastify" {
  interface FastifyContextConfig {
    chaos?: ChaosRoute;
  }
  interface FastifyRequest {
    chaos: ChaosOutcome | null;
  }
}

/** Route options that put a route behind the chaos hook. Call it once per route. */
export function page(route: ChaosRoute = {}): { config: { chaos: ChaosRoute } } {
  return { config: { chaos: route } };
}

export interface ChaosGateDeps {
  store: ChaosStore;
  /** Waits for `ms`. Tests replace it so they do not really wait. */
  sleep: (ms: number) => Promise<void>;
  /** The random source when the request has no ?seed. */
  random: () => number;
}

const HTML = "text/html; charset=utf-8";

function serverErrorPage(): string {
  return layout({
    title: "Server error",
    body: html`<div class="card" data-testid="server-error">
      <h1>500 Internal Server Error</h1>
      <p>Something went wrong on our side. Please try again in a moment.</p>
    </div>`,
  });
}

function forbiddenPage(): string {
  return layout({
    title: "Access denied",
    body: html`<div class="card" data-testid="botwall-blocked">
      <h1>403 Forbidden</h1>
      <p>Access denied. Automated traffic from your network has been blocked.</p>
      <p class="hint">Reference: bw-7f3a9c</p>
    </div>`,
  });
}

function captchaPage(): string {
  return layout({
    title: "Verify you are human",
    body: html`<div class="card" data-testid="captcha">
      <h1>Verify you are human</h1>
      <p>We have detected unusual traffic. Select all squares with traffic lights.</p>
      <div style="display:grid;grid-template-columns:repeat(3,64px);gap:4px;margin:12px 0">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => html`<div style="height:64px;background:#bcccdc" data-square="${n}"></div>`)}
      </div>
      <button type="button" data-testid="captcha-verify">Verify</button>
    </div>`,
  });
}

export async function registerChaosGate(app: FastifyInstance, deps: ChaosGateDeps): Promise<void> {
  app.decorateRequest("chaos", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const route = request.routeOptions?.config?.chaos;
    if (!route || request.method !== "GET") return;

    const query = (request.query ?? {}) as Record<string, unknown>;
    const settings = resolveSettings(query, deps.store.get(), route);
    const seed = parseSeed(query.seed);
    const decision = decide(settings, seed === undefined ? deps.random : seededRandom(seed));

    if (settings.latencyMs > 0) await deps.sleep(settings.latencyMs);

    if (decision.error) {
      return reply.code(500).type(HTML).send(serverErrorPage());
    }
    if (decision.botwall === "forbidden") {
      return reply.code(403).type(HTML).send(forbiddenPage());
    }
    if (decision.botwall === "captcha") {
      return reply.code(200).type(HTML).send(captchaPage());
    }
    request.chaos = { settings, flaky: decision.flaky };
  });

  // The admin routes live in their own plugin so that the loopback check is a hook of the plugin
  // itself: every route registered inside it is protected, whatever URL form reaches it. Add new
  // admin routes here, not on `app`.
  await app.register(async (admin) => {
    admin.addHook("onRequest", requireLoopback);

    // The global settings: POST merges the given fields, GET reads, DELETE resets to all zeros.
    admin.get("/admin/chaos", async () => deps.store.get());

    admin.post("/admin/chaos", async (request, reply) => {
      const parsed = chaosPatchSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid chaos settings",
          issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      return deps.store.patch(parsed.data);
    });

    admin.delete("/admin/chaos", async () => deps.store.reset());
  });
}
