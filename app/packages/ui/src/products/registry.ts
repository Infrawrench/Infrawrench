/**
 * The products ("apps") Infrawrench is made of.
 *
 * The app is one deployment, but it is presented as several products that
 * each stand on their own: Home shows them as a grid, each has a page that
 * lists its tools. They are separate in how
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
import { PRODUCT_IDS, PRODUCT_NAMES, isProductId, type ProductId } from "@infrawrench/client-core";

export { PRODUCT_IDS, isProductId, type ProductId };

export interface ProductDef {
  id: ProductId;
  /** English name, used for the tab title; the translated one is in copy.ts. */
  name: string;
  /** Org tool keys, in the order the product page lists them. */
  tools: readonly string[];
}

export const PRODUCTS: readonly ProductDef[] = [
  {
    id: "infrastructure",
    name: PRODUCT_NAMES.infrastructure,
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
  },
  {
    id: "costs",
    name: PRODUCT_NAMES.costs,
    tools: [
      "costs",
      "cost-reports",
      "cost-canvases",
      "k8s-efficiency",
      "invoices",
      "price-catalog",
    ],
  },
  {
    id: "observability",
    name: PRODUCT_NAMES.observability,
    tools: ["logs", "metric-alerts", "probes", "slos", "query-monitors", "wallboard"],
  },
  {
    id: "incidents",
    name: PRODUCT_NAMES.incidents,
    tools: ["incidents", "status-pages", "runbooks", "calendar"],
  },
  {
    id: "security",
    name: PRODUCT_NAMES.security,
    tools: [
      "posture",
      "vulnerabilities",
      "compliance",
      "access-review",
      "jit-access",
      "expiring",
      "backups",
    ],
  },
  {
    id: "delivery",
    name: PRODUCT_NAMES.delivery,
    tools: ["deploy", "ci", "delivery", "environments", "environment-diff"],
  },
  {
    id: "automation",
    name: PRODUCT_NAMES.automation,
    tools: ["agents", "workflows"],
  },
];

/** The product that owns an org tool, by the tool's `key`. */
export function productForTool(toolKey: string): ProductId | undefined {
  return PRODUCTS.find((p) => p.tools.includes(toolKey))?.id;
}

/** The slice of a workspace tab target these helpers read. */
interface TabTargetLike {
  kind: string;
  productId?: string | undefined;
}

/**
 * The org tool a tab belongs to, by the tool's `key`, or undefined for a tab
 * that is not a tool (Home, a dashboard, an account, a resource, chat,
 * settings). Tool keys are the tab kinds, except Deploy.
 */
export function toolKeyForTabTarget(target: TabTargetLike | undefined): string | undefined {
  if (!target) return undefined;
  const key = target.kind === "deployments" ? "deploy" : target.kind;
  return productForTool(key) ? key : undefined;
}

/**
 * Whether the sidebar shows the provider accounts tree for this tab. The
 * tree is Infrastructure's: it shows on Infrastructure's page and tools and
 * on the accounts and resources opened from it. Dashboards keep it too,
 * because dragging a resource from the tree onto a dashboard is how it is
 * pinned. With no tab open there is nothing to be out of context for.
 */
export function showsInfrastructureSidebar(target: TabTargetLike | undefined): boolean {
  if (!target) return true;
  switch (target.kind) {
    case "account":
    case "resource":
    case "linux-app":
    case "dashboard":
      return true;
    case "home":
      return target.productId === "infrastructure";
    default:
      return productForTool(toolKeyForTabTarget(target) ?? "") === "infrastructure";
  }
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
