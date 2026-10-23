/**
 * The product catalog: 200 products generated from fixed word lists, so the same id always
 * gives the same product on every run and every machine (no randomness, no clock).
 */

const ADJECTIVES = [
  "Compact",
  "Deluxe",
  "Ultra",
  "Classic",
  "Smart",
  "Eco",
  "Pro",
  "Mini",
  "Rugged",
  "Portable",
] as const;

const NOUNS: ReadonlyArray<{ name: string; category: string; basePrice: number }> = [
  { name: "Widget", category: "Hardware", basePrice: 12 },
  { name: "Gadget", category: "Electronics", basePrice: 29 },
  { name: "Lamp", category: "Home", basePrice: 35 },
  { name: "Backpack", category: "Travel", basePrice: 58 },
  { name: "Keyboard", category: "Electronics", basePrice: 74 },
  { name: "Mouse", category: "Electronics", basePrice: 24 },
  { name: "Monitor", category: "Electronics", basePrice: 189 },
  { name: "Headphones", category: "Audio", basePrice: 96 },
  { name: "Kettle", category: "Kitchen", basePrice: 41 },
  { name: "Notebook", category: "Office", basePrice: 7 },
  { name: "Bottle", category: "Outdoors", basePrice: 16 },
  { name: "Charger", category: "Electronics", basePrice: 19 },
  { name: "Speaker", category: "Audio", basePrice: 63 },
  { name: "Camera", category: "Electronics", basePrice: 240 },
  { name: "Router", category: "Networking", basePrice: 88 },
  { name: "Chair", category: "Furniture", basePrice: 129 },
  { name: "Desk", category: "Furniture", basePrice: 210 },
  { name: "Mug", category: "Kitchen", basePrice: 9 },
  { name: "Watch", category: "Accessories", basePrice: 150 },
  { name: "Tripod", category: "Photography", basePrice: 45 },
];

export interface Product {
  /** "1" to "200". Used in the URL: /item/:id */
  id: string;
  sku: string;
  title: string;
  category: string;
  /** Price in cents, so totals add up without floating point surprises. */
  priceCents: number;
  description: string;
}

export const PRODUCT_COUNT = ADJECTIVES.length * NOUNS.length;

function buildProduct(index: number): Product {
  const noun = NOUNS[index % NOUNS.length];
  const adjective = ADJECTIVES[Math.floor(index / NOUNS.length)];
  if (!noun || !adjective) throw new Error(`product index out of range: ${index}`);
  const id = String(index + 1);
  const title = `${adjective} ${noun.name}`;
  // A small, fixed price change per adjective so products of one kind differ from each other.
  const priceCents = Math.round(noun.basePrice * (1 + (index % 7) * 0.05) * 100) - 1;
  return {
    id,
    sku: `FS-${id.padStart(4, "0")}`,
    title,
    category: noun.category,
    priceCents,
    description: `${title}: a ${adjective.toLowerCase()} ${noun.name.toLowerCase()} for everyday use. Category: ${noun.category}.`,
  };
}

export const PRODUCTS: readonly Product[] = Array.from({ length: PRODUCT_COUNT }, (_, i) =>
  buildProduct(i),
);

const BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));

export function getProduct(id: string): Product | undefined {
  return BY_ID.get(id);
}

/** Case-insensitive match on title or category. An empty query matches everything. */
export function searchProducts(query: string): Product[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...PRODUCTS];
  return PRODUCTS.filter(
    (p) => p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q),
  );
}

export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
