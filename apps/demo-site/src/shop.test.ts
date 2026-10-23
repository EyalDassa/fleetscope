import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cookieFrom, count, get, login, makeApp, post, type TestApp } from "./testing";

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.app.close();
});

describe("health and home", () => {
  it("answers /healthz with 200", async () => {
    const res = await get(t.app, "/healthz");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("serves a public home page with links", async () => {
    const res = await get(t.app, "/");
    expect(res.statusCode).toBe(200);
    for (const path of ["/login", "/heavy", "/slow", "/flaky", "/botwall", "/js-heavy"]) {
      expect(res.body).toContain(`href="${path}"`);
    }
  });
});

describe("login", () => {
  it("renders the form with the contract's test ids", async () => {
    const res = await get(t.app, "/login");
    expect(res.statusCode).toBe(200);
    for (const id of ["login-user", "login-pass", "login-submit"]) {
      expect(res.body).toContain(`data-testid="${id}"`);
    }
    expect(res.body).not.toContain('data-testid="login-error"');
  });

  it("redirects pages behind login to /login when there is no cookie", async () => {
    for (const url of ["/dashboard", "/search?q=a", "/item/1", "/checkout", "/checkout/done"]) {
      const res = await get(t.app, url);
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe("/login");
    }
    const add = await post(t.app, "/cart/add", { id: "1" });
    expect(add.statusCode).toBe(302);
    expect(add.headers.location).toBe("/login");
  });

  it("rejects a cookie that was never issued", async () => {
    const res = await get(t.app, "/dashboard", "fs_session=made-up");
    expect(res.statusCode).toBe(302);
  });

  it("re-renders the form with an error for wrong credentials, and sets no cookie", async () => {
    for (const fields of [
      { user: "agent", pass: "wrong" },
      { user: "root", pass: "fleetscope" },
      { user: "", pass: "" },
    ]) {
      const res = await post(t.app, "/login", fields);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('data-testid="login-error"');
      expect(res.body).toContain('data-testid="login-submit"');
      expect(cookieFrom(res)).toBeUndefined();
    }
  });

  it("escapes what the visitor typed", async () => {
    const res = await post(t.app, "/login", { user: '"><script>alert(1)</script>', pass: "x" });
    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("signs in agent/fleetscope, sets an HttpOnly cookie and redirects to the dashboard", async () => {
    const res = await post(t.app, "/login", { user: "agent", pass: "fleetscope" });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe("/dashboard");
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");

    const dashboard = await get(t.app, "/dashboard", cookieFrom(res));
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('data-testid="dashboard-greeting"');
    expect(dashboard.body).toContain("Welcome back, agent");
    expect(dashboard.body).toContain('data-testid="search-input"');
  });

  it("gives every login its own session", async () => {
    const a = await login(t.app);
    const b = await login(t.app);
    expect(a).not.toBe(b);
  });

  it("signs out: the cookie stops working", async () => {
    const cookie = await login(t.app);
    const out = await post(t.app, "/logout", {}, cookie);
    expect(out.statusCode).toBe(303);
    expect(out.headers.location).toBe("/login");
    const res = await get(t.app, "/dashboard", cookie);
    expect(res.statusCode).toBe(302);
  });
});

describe("search", () => {
  it("lists result rows that link to /item/:id", async () => {
    const cookie = await login(t.app);
    const res = await get(t.app, "/search?q=lamp", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-testid="search-input"');
    expect(count(res.body, 'data-testid="search-result"')).toBe(10);
    const links = [...res.body.matchAll(/<a href="\/item\/(\d+)" data-testid="search-result"/g)];
    expect(links).toHaveLength(10);
    expect(res.body).toContain("Compact Lamp");
  });

  it("is deterministic: the same query gives the same page", async () => {
    const cookie = await login(t.app);
    const a = await get(t.app, "/search?q=mug", cookie);
    const b = await get(t.app, "/search?q=mug", cookie);
    expect(a.body).toBe(b.body);
  });

  it("shows the first 20 of the 200 products for an empty query, with paging", async () => {
    const cookie = await login(t.app);
    const first = await get(t.app, "/search", cookie);
    expect(count(first.body, 'data-testid="search-result"')).toBe(20);
    expect(first.body).toContain("Showing 1-20 of 200 products");
    expect(first.body).toContain('data-testid="search-next"');
    expect(first.body).not.toContain('data-testid="search-prev"');

    const last = await get(t.app, "/search?page=10", cookie);
    expect(last.body).toContain("Showing 181-200 of 200 products");
    expect(last.body).not.toContain('data-testid="search-next"');
    expect(last.body).toContain('data-testid="search-prev"');
  });

  it("says so when nothing matches, and escapes the query", async () => {
    const cookie = await login(t.app);
    const res = await get(t.app, `/search?q=${encodeURIComponent("<b>zzz</b>")}`, cookie);
    expect(count(res.body, 'data-testid="search-result"')).toBe(0);
    expect(res.body).toContain("No products match");
    expect(res.body).not.toContain("<b>zzz</b>");
  });
});

describe("item, cart and checkout", () => {
  it("shows the item with an add-to-cart form", async () => {
    const cookie = await login(t.app);
    const res = await get(t.app, "/item/3", cookie);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-testid="item-title">Compact Lamp');
    expect(res.body).toContain('data-testid="add-to-cart"');
    expect(res.body).toContain('method="post" action="/cart/add"');
  });

  it("answers 404 for an unknown item", async () => {
    const cookie = await login(t.app);
    for (const id of ["0", "201", "abc"]) {
      const res = await get(t.app, `/item/${id}`, cookie);
      expect(res.statusCode, id).toBe(404);
      expect(res.body).toContain('data-testid="not-found"');
    }
  });

  it("adds to the cart and redirects to /checkout, which lists it", async () => {
    const cookie = await login(t.app);
    const add = await post(t.app, "/cart/add", { id: "3" }, cookie);
    expect(add.statusCode).toBe(303);
    expect(add.headers.location).toBe("/checkout");
    const checkout = await get(t.app, "/checkout", cookie);
    expect(checkout.body).toContain('data-testid="cart-line"');
    expect(checkout.body).toContain("Compact Lamp");
    expect(checkout.body).toContain('data-testid="cart-count">1<');
  });

  it("keeps each visitor's cart separate", async () => {
    const a = await login(t.app);
    const b = await login(t.app);
    await post(t.app, "/cart/add", { id: "3" }, a);
    const res = await get(t.app, "/checkout", b);
    expect(res.body).toContain('data-testid="cart-empty"');
  });

  it("rejects an unknown product id", async () => {
    const cookie = await login(t.app);
    const res = await post(t.app, "/cart/add", { id: "9999" }, cookie);
    expect(res.statusCode).toBe(404);
  });

  it("renders the checkout form with the contract's test ids", async () => {
    const cookie = await login(t.app);
    const res = await get(t.app, "/checkout", cookie);
    for (const id of ["checkout-name", "checkout-email", "checkout-address", "checkout-submit"]) {
      expect(res.body).toContain(`data-testid="${id}"`);
    }
    expect(res.body).not.toContain('data-testid="checkout-error"');
  });

  it("validates on the server and keeps what was typed", async () => {
    const cookie = await login(t.app);
    const res = await post(
      t.app,
      "/checkout",
      { name: "Ada <b>", email: "not-an-email", address: "x" },
      cookie,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-testid="checkout-error"');
    expect(res.body).toContain("valid email address");
    expect(res.body).toContain("delivery address");
    expect(res.body).toContain('value="Ada &lt;b&gt;"');
    expect(res.body).not.toContain('data-testid="order-confirmation"');
  });

  it("takes a valid order, redirects to /checkout/done and shows an order id", async () => {
    const cookie = await login(t.app);
    await post(t.app, "/cart/add", { id: "3" }, cookie);
    const order = await post(
      t.app,
      "/checkout",
      { name: "Ada Lovelace", email: "ada@example.com", address: "12 Analytical Street" },
      cookie,
    );
    expect(order.statusCode).toBe(303);
    expect(order.headers.location).toBe("/checkout/done");

    const done = await get(t.app, "/checkout/done", cookie);
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('data-testid="order-confirmation"');
    expect(done.body).toMatch(/data-testid="order-id">FS-\d{6}</);
    expect(done.body).toContain("Ada Lovelace");

    // The cart is empty afterwards.
    const checkout = await get(t.app, "/checkout", cookie);
    expect(checkout.body).toContain('data-testid="cart-empty"');
  });

  it("gives each order a new id", async () => {
    const cookie = await login(t.app);
    const fields = { name: "Ada", email: "ada@example.com", address: "12 Analytical Street" };
    await post(t.app, "/checkout", fields, cookie);
    const first = (await get(t.app, "/checkout/done", cookie)).body.match(/FS-\d{6}/)?.[0];
    await post(t.app, "/checkout", fields, cookie);
    const second = (await get(t.app, "/checkout/done", cookie)).body.match(/FS-\d{6}/)?.[0];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("sends visitors without an order away from /checkout/done", async () => {
    const cookie = await login(t.app);
    const res = await get(t.app, "/checkout/done", cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/checkout");
  });
});
