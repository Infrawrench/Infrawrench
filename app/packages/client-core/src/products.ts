/**
 * The products ("apps") the application is presented as, for code that runs
 * on the server as well as in the apps. The ids come from the plugin
 * contract, where a plugin's capabilities name the product they power; what
 * each product contains in the UI (its tools, its copy) is
 * `@infrawrench/ui`'s `products/registry.ts`.
 */
import { PRODUCT_IDS, type ProductId } from "@infrawrench/plugin-base";

export { PRODUCT_IDS, type ProductId };

export function isProductId(value: unknown): value is ProductId {
  return typeof value === "string" && (PRODUCT_IDS as readonly string[]).includes(value);
}

/**
 * Products an organization cannot turn off and a connection cannot leave
 * out. Infrastructure is the inventory every other product reads, and the
 * place accounts are connected from.
 */
export const ALWAYS_ON_PRODUCTS: readonly ProductId[] = ["infrastructure"];

/** Products an organization's policy may turn off. */
export const SWITCHABLE_PRODUCTS: readonly ProductId[] = PRODUCT_IDS.filter(
  (id) => !ALWAYS_ON_PRODUCTS.includes(id),
);

/**
 * A stored or submitted list of product ids, cleaned up: unknown ids dropped
 * (an older client or a hand-edited row), duplicates removed, in the
 * canonical order so two equal sets compare equal.
 */
export function normalizeProductIds(input: unknown): ProductId[] {
  if (!Array.isArray(input)) return [];
  const given = new Set(input.filter(isProductId));
  return PRODUCT_IDS.filter((id) => given.has(id));
}

/** The products an organization's policy turns off: never an always-on one. */
export function normalizeDisabledProducts(input: unknown): ProductId[] {
  return normalizeProductIds(input).filter((id) => !ALWAYS_ON_PRODUCTS.includes(id));
}

/** Capability ids plugins use by convention, and the product each powers. */
const CONVENTIONAL_CAPABILITY_PRODUCTS: Readonly<Record<string, ProductId>> = {
  costs: "costs",
  commitments: "costs",
  credits: "costs",
  seats: "costs",
  "idle-findings": "costs",
  "ai-request-logs": "costs",
  metrics: "observability",
  logs: "observability",
  slos: "observability",
  synthetics: "observability",
};

/**
 * The product a plugin capability powers: what the plugin declared, else the
 * convention for its id, else Infrastructure (listing and managing
 * resources, which is what an undeclared capability almost always is).
 */
export function capabilityProduct(capability: {
  id: string;
  product?: ProductId | undefined;
}): ProductId {
  return capability.product ?? CONVENTIONAL_CAPABILITY_PRODUCTS[capability.id] ?? "infrastructure";
}
