import { describe, expect, it } from "vitest";
import { formatPrice, getProduct, PRODUCT_COUNT, PRODUCTS, searchProducts } from "./catalog";
import { escapeHtml, html, raw } from "./html";

describe("catalog", () => {
  it("has 200 products with unique ids and titles", () => {
    expect(PRODUCT_COUNT).toBe(200);
    expect(PRODUCTS).toHaveLength(200);
    expect(new Set(PRODUCTS.map((p) => p.id)).size).toBe(200);
    expect(new Set(PRODUCTS.map((p) => p.title)).size).toBe(200);
  });

  it("is deterministic: fixed ids map to fixed products", () => {
    expect(getProduct("1")).toMatchObject({ title: "Compact Widget", sku: "FS-0001" });
    expect(getProduct("3")).toMatchObject({ title: "Compact Lamp", priceCents: 3849 });
    expect(getProduct("200")).toMatchObject({ title: "Portable Tripod" });
    expect(getProduct("0")).toBeUndefined();
    expect(getProduct("201")).toBeUndefined();
  });

  it("searches title and category, ignoring case and spaces around the query", () => {
    expect(searchProducts("LAMP")).toHaveLength(10);
    expect(searchProducts("  lamp ")).toHaveLength(10);
    expect(searchProducts("audio")).toHaveLength(20);
    expect(searchProducts("")).toHaveLength(200);
    expect(searchProducts("no such thing")).toHaveLength(0);
  });

  it("formats prices", () => {
    expect(formatPrice(3849)).toBe("$38.49");
    expect(formatPrice(5)).toBe("$0.05");
  });
});

describe("html helper", () => {
  it("escapes interpolated values", () => {
    expect(html`<p>${"<script>"}</p>`.value).toBe("<p>&lt;script&gt;</p>");
    expect(escapeHtml(`a&b"c'd`)).toBe("a&amp;b&quot;c&#39;d");
  });

  it("keeps trusted markup, joins arrays and drops empty values", () => {
    const item = (n: number) => html`<li>${n}</li>`;
    expect(html`<ul>${[1, 2].map(item)}</ul>`.value).toBe("<ul><li>1</li><li>2</li></ul>");
    expect(html`${raw("<b>x</b>")}${null}${undefined}${false}`.value).toBe("<b>x</b>");
  });
});
