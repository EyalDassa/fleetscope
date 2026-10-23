import { html, raw, type SafeHtml } from "./html";

const CSS = `
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1f2933;background:#f5f7fa}
  header{background:#243b53;color:#fff;padding:12px 24px;display:flex;gap:20px;align-items:center}
  header a{color:#fff;text-decoration:none}
  header .brand{font-weight:700;font-size:20px;margin-right:auto}
  header form{margin:0}
  main{max-width:860px;margin:24px auto;padding:0 24px}
  h1{font-size:26px;margin:0 0 16px}
  .card{background:#fff;border:1px solid #d9e2ec;border-radius:6px;padding:20px;margin-bottom:16px}
  label{display:block;margin:12px 0 4px;font-weight:600}
  input[type=text],input[type=password],textarea{width:100%;padding:8px;border:1px solid #9fb3c8;border-radius:4px;font:inherit}
  button,.button{display:inline-block;margin-top:16px;padding:8px 18px;border:0;border-radius:4px;background:#2680c2;color:#fff;font:inherit;cursor:pointer;text-decoration:none}
  button.link{margin:0;padding:0;background:none;color:#fff;text-decoration:underline}
  .error{background:#ffe3e3;border:1px solid #e12d39;color:#8a041a;padding:10px 14px;border-radius:4px;margin-bottom:12px}
  .hint{color:#627d98;font-size:14px}
  ul.results{list-style:none;margin:0;padding:0}
  ul.results li{margin:0 0 8px}
  ul.results a{display:flex;justify-content:space-between;background:#fff;border:1px solid #d9e2ec;border-radius:6px;padding:12px 16px;color:inherit;text-decoration:none}
  ul.results a:hover{border-color:#2680c2}
  .price{font-weight:600}
  .grid{display:flex;flex-wrap:wrap;gap:2px}
  .n{width:28px;height:18px;font-size:9px;background:#d9e2ec;text-align:center}
  .thumb{margin:2px}
`;

export interface LayoutOptions {
  title: string;
  body: SafeHtml;
  /** The signed-in user. Shows the navigation for logged-in pages. */
  user?: string | undefined;
  cartCount?: number | undefined;
  /** Extra markup for the end of <body>, e.g. an inline script. */
  scripts?: SafeHtml | undefined;
}

/** A full HTML document with the shop header. Plain on purpose: this is the target, not the product. */
export function layout({ title, body, user, cartCount = 0, scripts }: LayoutOptions): string {
  const nav = user
    ? html`<nav style="display:flex;gap:16px;align-items:center">
        <a href="/dashboard" data-testid="nav-dashboard">Dashboard</a>
        <a href="/search" data-testid="nav-search">Search</a>
        <a href="/checkout" data-testid="nav-cart">Cart (<span data-testid="cart-count">${cartCount}</span>)</a>
        <form method="post" action="/logout"><button class="link" type="submit" data-testid="logout">Sign out (${user})</button></form>
      </nav>`
    : html`<nav><a href="/login" data-testid="nav-login">Sign in</a></nav>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Fleetmart</title>
<style>${raw(CSS)}</style>
</head>
<body>
<header><a class="brand" href="/">Fleetmart</a>${nav}</header>
<main>${body}</main>
${scripts}
</body>
</html>`.value;
}
