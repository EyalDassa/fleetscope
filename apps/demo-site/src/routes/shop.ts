/** The shop flow: login, dashboard, search, item, cart, checkout. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { formatPrice, getProduct, PRODUCTS, searchProducts } from "../catalog";
import { page } from "../chaos-gate";
import { html, type SafeHtml } from "../html";
import { layout } from "../layout";
import { formField, queryString, sessionIdFromRequest } from "../request";
import {
  clearedSessionCookie,
  DEMO_PASSWORD,
  DEMO_USER,
  type Session,
  type SessionStore,
  sessionCookie,
} from "../session";

const HTML = "text/html; charset=utf-8";
const PAGE_SIZE = 20;

export interface ShopDeps {
  sessions: SessionStore;
}

function cartTotal(session: Session): number {
  return session.cart.reduce((sum, id) => sum + (getProduct(id)?.priceCents ?? 0), 0);
}

interface CheckoutValues {
  name: string;
  email: string;
  address: string;
}

function validateCheckout({ name, email, address }: CheckoutValues): string[] {
  const problems: string[] = [];
  if (name.length < 2 || name.length > 80) problems.push("Please enter your full name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
    problems.push("Please enter a valid email address.");
  }
  if (address.length < 5 || address.length > 200) {
    problems.push("Please enter a delivery address (at least 5 characters).");
  }
  return problems;
}

export async function shopRoutes(app: FastifyInstance, { sessions }: ShopDeps): Promise<void> {
  /** Pages behind login send visitors without a valid session cookie to /login. */
  async function requireLogin(request: FastifyRequest, reply: FastifyReply) {
    const session = sessions.get(sessionIdFromRequest(request));
    if (!session) return reply.redirect("/login", 302);
    request.session = session;
  }
  const protectedPage = () => ({ ...page(), preHandler: requireLogin });

  /** Wraps a page body in the layout, with the signed-in navigation. */
  function render(request: FastifyRequest, title: string, body: SafeHtml): string {
    const session = request.session;
    return layout({ title, body, user: session?.user, cartCount: session?.cart.length ?? 0 });
  }

  // Forms are posted as application/x-www-form-urlencoded; the body becomes a URLSearchParams.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 64 * 1024 },
    (_request, body, done) => done(null, new URLSearchParams(body as string)),
  );
  app.decorateRequest("session", null);

  // ---- Login ----

  const loginForm = (username: string, error?: string) =>
    html`<div class="card">
      <h1>Sign in</h1>
      ${error ? html`<div class="error" role="alert" data-testid="login-error">${error}</div>` : ""}
      <form method="post" action="/login" novalidate>
        <label for="user">Username</label>
        <input type="text" id="user" name="user" value="${username}" autocomplete="username" data-testid="login-user">
        <label for="pass">Password</label>
        <input type="password" id="pass" name="pass" autocomplete="current-password" data-testid="login-pass">
        <button type="submit" data-testid="login-submit">Sign in</button>
      </form>
      <p class="hint">Demo account: ${DEMO_USER} / ${DEMO_PASSWORD}</p>
    </div>`;

  app.get("/login", page(), async (request, reply) => {
    return reply.type(HTML).send(render(request, "Sign in", loginForm("")));
  });

  app.post("/login", async (request, reply) => {
    const user = formField(request, "user").trim();
    const pass = formField(request, "pass");
    if (user !== DEMO_USER || pass !== DEMO_PASSWORD) {
      // 200, not 401: this is a form the user fills in again, not a failed API call.
      return reply
        .type(HTML)
        .send(render(request, "Sign in", loginForm(user, "Invalid username or password.")));
    }
    // A new session on every login, so an old cookie cannot be reused (session fixation).
    sessions.destroy(sessionIdFromRequest(request));
    const session = sessions.create(user);
    return reply.header("set-cookie", sessionCookie(session.id)).redirect("/dashboard", 303);
  });

  app.post("/logout", async (request, reply) => {
    sessions.destroy(sessionIdFromRequest(request));
    return reply.header("set-cookie", clearedSessionCookie()).redirect("/login", 303);
  });

  // ---- Dashboard and search ----

  const searchForm = (q: string) =>
    html`<form method="get" action="/search" role="search">
      <input type="text" name="q" value="${q}" placeholder="Search products" aria-label="Search products" data-testid="search-input">
      <button type="submit" data-testid="search-submit">Search</button>
    </form>`;

  app.get("/dashboard", protectedPage(), async (request, reply) => {
    const session = request.session as Session;
    const featured = PRODUCTS.filter((_, i) => i % 40 === 0);
    const body = html`<div class="card">
        <h1 data-testid="dashboard-greeting">Welcome back, ${session.user}</h1>
        <p>Find something for your fleet.</p>
        ${searchForm("")}
      </div>
      <div class="card">
        <h2>Featured</h2>
        <ul class="results">
          ${featured.map((p) => html`<li><a href="/item/${p.id}" data-testid="featured-item"><span>${p.title}</span><span class="price">${formatPrice(p.priceCents)}</span></a></li>`)}
        </ul>
      </div>`;
    return reply.type(HTML).send(render(request, "Dashboard", body));
  });

  app.get("/search", protectedPage(), async (request, reply) => {
    const q = queryString(request, "q").slice(0, 100);
    const pageNumber = Math.max(1, Number.parseInt(queryString(request, "page"), 10) || 1);
    const matches = searchProducts(q);
    const start = (pageNumber - 1) * PAGE_SIZE;
    const shown = matches.slice(start, start + PAGE_SIZE);
    const pageLink = (n: number, label: string, testid: string) =>
      html`<a class="button" href="/search?q=${encodeURIComponent(q)}&amp;page=${n}" data-testid="${testid}">${label}</a>`;
    const count =
      matches.length === 0
        ? `No products match "${q}".`
        : `Showing ${start + 1}-${start + shown.length} of ${matches.length} products`;
    const body = html`<div class="card">
        <h1>Search</h1>
        ${searchForm(q)}
      </div>
      <p data-testid="search-count">${count}</p>
      <ul class="results" data-testid="search-results">
        ${shown.map((p) => html`<li><a href="/item/${p.id}" data-testid="search-result" data-item-id="${p.id}"><span>${p.title} <span class="hint">${p.category}</span></span><span class="price">${formatPrice(p.priceCents)}</span></a></li>`)}
      </ul>
      <p>
        ${pageNumber > 1 ? pageLink(pageNumber - 1, "Previous", "search-prev") : ""}
        ${start + PAGE_SIZE < matches.length ? pageLink(pageNumber + 1, "Next", "search-next") : ""}
      </p>`;
    return reply.type(HTML).send(render(request, q ? `Search: ${q}` : "Search", body));
  });

  // ---- Item and cart ----

  function notFound(request: FastifyRequest, reply: FastifyReply, what: string) {
    const body = html`<div class="card" data-testid="not-found">
      <h1>Not found</h1>
      <p>${what}</p>
      <p><a href="/search">Back to search</a></p>
    </div>`;
    return reply
      .code(404)
      .type(HTML)
      .send(render(request, "Not found", body));
  }

  app.get("/item/:id", protectedPage(), async (request, reply) => {
    const { id } = request.params as { id: string };
    const product = getProduct(id);
    if (!product) return notFound(request, reply, "That product does not exist.");
    // Flaky chaos: the add-to-cart button is missing from the HTML, as if it failed to load.
    const showButton = !request.chaos?.flaky;
    const body = html`<div class="card">
      <p class="hint"><a href="/search">Back to search</a> / ${product.category} / ${product.sku}</p>
      <h1 data-testid="item-title">${product.title}</h1>
      <p data-testid="item-price" class="price">${formatPrice(product.priceCents)}</p>
      <p data-testid="item-description">${product.description}</p>
      ${
        showButton
          ? html`<form method="post" action="/cart/add">
              <input type="hidden" name="id" value="${product.id}">
              <button type="submit" data-testid="add-to-cart">Add to cart</button>
            </form>`
          : ""
      }
    </div>`;
    return reply.type(HTML).send(render(request, product.title, body));
  });

  app.post("/cart/add", { preHandler: requireLogin }, async (request, reply) => {
    const product = getProduct(formField(request, "id"));
    if (!product) return notFound(request, reply, "That product does not exist.");
    (request.session as Session).cart.push(product.id);
    return reply.redirect("/checkout", 303);
  });

  // ---- Checkout ----

  function checkoutPage(
    request: FastifyRequest,
    values: CheckoutValues,
    problems: string[],
  ): string {
    const session = request.session as Session;
    const lines = session.cart.flatMap((id) => {
      const product = getProduct(id);
      return product ? [product] : [];
    });
    // Flaky chaos: the submit button is missing from the HTML.
    const showSubmit = !request.chaos?.flaky;
    const cart =
      lines.length === 0
        ? html`<p data-testid="cart-empty">Your cart is empty.</p>`
        : html`<ul data-testid="cart-lines">
            ${lines.map((p) => html`<li data-testid="cart-line">${p.title} <span class="price">${formatPrice(p.priceCents)}</span></li>`)}
          </ul>
          <p>Total: <strong data-testid="cart-total">${formatPrice(cartTotal(session))}</strong></p>`;
    const errors =
      problems.length > 0
        ? html`<div class="error" role="alert" data-testid="checkout-error"><ul>${problems.map((p) => html`<li>${p}</li>`)}</ul></div>`
        : "";
    const body = html`<div class="card">
        <h1>Checkout</h1>
        ${cart}
      </div>
      <div class="card">
        <h2>Delivery details</h2>
        ${errors}
        <form method="post" action="/checkout" novalidate>
          <label for="name">Full name</label>
          <input type="text" id="name" name="name" value="${values.name}" autocomplete="name" data-testid="checkout-name">
          <label for="email">Email</label>
          <input type="text" id="email" name="email" value="${values.email}" autocomplete="email" data-testid="checkout-email">
          <label for="address">Address</label>
          <textarea id="address" name="address" rows="3" autocomplete="street-address" data-testid="checkout-address">${values.address}</textarea>
          ${showSubmit ? html`<button type="submit" data-testid="checkout-submit">Place order</button>` : ""}
        </form>
      </div>`;
    return render(request, "Checkout", body);
  }

  app.get("/checkout", protectedPage(), async (request, reply) => {
    const empty: CheckoutValues = { name: "", email: "", address: "" };
    return reply.type(HTML).send(checkoutPage(request, empty, []));
  });

  app.post("/checkout", { preHandler: requireLogin }, async (request, reply) => {
    const values: CheckoutValues = {
      name: formField(request, "name").trim(),
      email: formField(request, "email").trim(),
      address: formField(request, "address").trim(),
    };
    const problems = validateCheckout(values);
    if (problems.length > 0) {
      // 200, like the login form: the user corrects the form, nothing failed at the API level.
      return reply.type(HTML).send(checkoutPage(request, values, problems));
    }
    const session = request.session as Session;
    session.lastOrder = {
      id: sessions.nextOrderId(),
      name: values.name,
      itemCount: session.cart.length,
      totalCents: cartTotal(session),
    };
    session.cart = [];
    return reply.redirect("/checkout/done", 303);
  });

  app.get("/checkout/done", protectedPage(), async (request, reply) => {
    const order = (request.session as Session).lastOrder;
    if (!order) return reply.redirect("/checkout", 302);
    const body = html`<div class="card" data-testid="order-confirmation">
      <h1>Thank you, ${order.name}!</h1>
      <p>Your order <strong data-testid="order-id">${order.id}</strong> is confirmed.</p>
      <p>${order.itemCount} item(s), total ${formatPrice(order.totalCents)}.</p>
      <p><a href="/dashboard">Back to the dashboard</a></p>
    </div>`;
    return reply.type(HTML).send(render(request, "Order confirmed", body));
  });
}
