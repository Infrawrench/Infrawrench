/**
 * The products ("apps") Infrawrench is made of.
 *
 * The app is one deployment, but it is presented as several products that
 * each stand on their own: Home shows them as a grid, each has a page saying
 * what it offers, and its tools open from there. They are separate in how
 * they read, not in what they can reach: every product works on the same
 * accounts and resources, and dashboards and chat sit across all of them.
 *
 * This file is data only (no React, no translation) so the tab store can
 * read a product's name for a tab title. The translated copy is in
 * `copy.ts`, keyed by the ids here.
 *
 * `tools` are the `key`s of the org tools each platform builds (web
 * `lib/org-tools.tsx`, desktop `lib/org-tools.tsx`). A tool a platform does
 * not offer (cloud-only tools in desktop local mode, CI before it is rolled
 * out) is simply absent from that platform's list and is left out of the
 * product; a tool no product claims shows under "More tools" on Home, so a
 * new tile is never unreachable while it waits for a home here.
 */
export const PRODUCT_IDS = [
  "infrastructure",
  "costs",
  "observability",
  "incidents",
  "security",
  "delivery",
  "automation",
] as const;

export type ProductId = (typeof PRODUCT_IDS)[number];

export interface ProductDef {
  id: ProductId;
  /** English name, used for the tab title; the translated one is in copy.ts. */
  name: string;
  /** Org tool keys, in the order the product page lists them. */
  tools: readonly string[];
  /** Products this one exchanges data with, in display order. */
  worksWith: readonly ProductId[];
}

export const PRODUCTS: readonly ProductDef[] = [
  {
    id: "infrastructure",
    name: "Infrastructure",
    tools: [
      "graph",
      "services",
      "changes",
      "iac",
      "resource-reports",
      "dns",
      "quotas",
      "ssh-fanout",
    ],
    worksWith: ["costs", "security", "delivery"],
  },
  {
    id: "costs",
    name: "Costs",
    tools: [
      "costs",
      "cost-reports",
      "cost-canvases",
      "k8s-efficiency",
      "invoices",
      "price-catalog",
    ],
    worksWith: ["infrastructure", "delivery", "observability"],
  },
  {
    id: "observability",
    name: "Observability",
    tools: ["logs", "metric-alerts", "probes", "slos", "query-monitors", "wallboard"],
    worksWith: ["incidents", "infrastructure", "delivery"],
  },
  {
    id: "incidents",
    name: "Incident response",
    tools: ["incidents", "status-pages", "runbooks", "calendar"],
    worksWith: ["observability", "delivery", "automation"],
  },
  {
    id: "security",
    name: "Security",
    tools: [
      "posture",
      "vulnerabilities",
      "compliance",
      "access-review",
      "jit-access",
      "expiring",
      "backups",
    ],
    worksWith: ["infrastructure", "incidents", "observability"],
  },
  {
    id: "delivery",
    name: "Delivery",
    tools: ["deploy", "ci", "delivery", "environments", "environment-diff"],
    worksWith: ["infrastructure", "costs", "observability"],
  },
  {
    id: "automation",
    name: "Automation",
    tools: ["agents", "workflows"],
    worksWith: ["delivery", "costs", "incidents"],
  },
];

export function isProductId(value: unknown): value is ProductId {
  return typeof value === "string" && (PRODUCT_IDS as readonly string[]).includes(value);
}

export function findProduct(id: string | undefined): ProductDef | undefined {
  return id ? PRODUCTS.find((p) => p.id === id) : undefined;
}

/**
 * Splits a platform's tool list into the products that claim each tool.
 * Returns the tools per product, in the product's own order, plus the tools
 * no product claims.
 */
export function groupToolsByProduct<T extends { key: string }>(
  tools: readonly T[],
): { byProduct: Record<ProductId, T[]>; unclaimed: T[] } {
  const byKey = new Map(tools.map((tool) => [tool.key, tool]));
  const claimed = new Set<string>();
  const byProduct = {} as Record<ProductId, T[]>;
  for (const product of PRODUCTS) {
    const mine: T[] = [];
    for (const key of product.tools) {
      const tool = byKey.get(key);
      if (!tool) continue;
      mine.push(tool);
      claimed.add(key);
    }
    byProduct[product.id] = mine;
  }
  return { byProduct, unclaimed: tools.filter((tool) => !claimed.has(tool.key)) };
}
