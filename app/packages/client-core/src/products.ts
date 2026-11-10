/**
 * The products ("apps") the application is presented as, for code that runs
 * on the server as well as in the apps. The ids come from the plugin
 * contract, where a plugin's capabilities name the product they power; what
 * each product contains in the UI (its tools, its copy) is
 * `@infrawrench/ui`'s `products/registry.ts`.
 */
import { PRODUCT_IDS, type PreflightDeclaration, type ProductId } from "@infrawrench/plugin-base";

export { PRODUCT_IDS, type ProductId };

export function isProductId(value: unknown): value is ProductId {
  return typeof value === "string" && (PRODUCT_IDS as readonly string[]).includes(value);
}

/**
 * English names, for text written outside the translated UI: a tab title, a
 * refusal the chat agent or an MCP client reads. The translated names are
 * `@infrawrench/ui`'s `products/copy.ts`.
 */
export const PRODUCT_NAMES: Readonly<Record<ProductId, string>> = {
  infrastructure: "Infrastructure",
  costs: "Costs",
  observability: "Observability",
  incidents: "Incident response",
  security: "Security",
  delivery: "Delivery",
  automation: "Automation",
};

/**
 * Products an organization cannot turn off. Infrastructure is the inventory
 * every other product reads, and the place accounts are connected from. (A
 * single connection may still leave it out: one made for Costs alone syncs no
 * resources, see `accountSyncsResources`.)
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

/** The part of a plugin's preflight declaration the product helpers read. */
type ProductDeclaration = Pick<PreflightDeclaration, "capabilities"> | null | undefined;

/**
 * The products a plugin's connection can be made for: the distinct products
 * of its preflight capabilities, in the canonical order. Empty for a plugin
 * without preflight, which therefore offers no choice.
 */
export function productsOfferedBy(declaration: ProductDeclaration): ProductId[] {
  if (!declaration) return [];
  const offered = new Set(declaration.capabilities.map(capabilityProduct));
  return PRODUCT_IDS.filter((id) => offered.has(id));
}

/**
 * Whether connecting this plugin comes with a choice of products: only when
 * its capabilities power more than one.
 */
export function offersProductChoice(declaration: ProductDeclaration): boolean {
  return productsOfferedBy(declaration).length > 1;
}

/**
 * The capability ids a connection made for `products` needs, in declaration
 * order. `null` (every product) is every capability.
 */
export function capabilityIdsForProducts(
  declaration: ProductDeclaration,
  products: readonly ProductId[] | null | undefined,
): string[] {
  if (!declaration) return [];
  const wanted = products ? new Set(products) : null;
  return declaration.capabilities
    .filter((capability) => !wanted || wanted.has(capabilityProduct(capability)))
    .map((capability) => capability.id);
}

/**
 * What a form submits for the apps it has checked: `null` when the plugin
 * offers no choice or everything it offers is checked (so "everything" keeps
 * its one spelling), else the checked apps in the canonical order.
 */
export function productsToSubmit(
  declaration: ProductDeclaration,
  selected: readonly ProductId[],
): ProductId[] | null {
  const offered = productsOfferedBy(declaration);
  if (offered.length <= 1) return null;
  const chosen = offered.filter((id) => selected.includes(id));
  return chosen.length === 0 || chosen.length === offered.length ? null : chosen;
}

/**
 * Whether an account is connected for `product`. `null` is an account with no
 * choice recorded, which serves every product.
 */
export function accountServesProduct(
  products: readonly string[] | null | undefined,
  product: ProductId,
): boolean {
  return !products || products.includes(product);
}

/**
 * Whether an account's resources are synced. Every product but Costs reads
 * the inventory, so only a connection made for Costs alone goes without.
 */
export function accountSyncsResources(products: readonly string[] | null | undefined): boolean {
  return !products || products.some((id) => id !== "costs");
}

/** Why a submitted product choice was refused, or what to store for it. */
export type AccountProductsChoice =
  | { readonly ok: true; readonly products: ProductId[] | null }
  | { readonly ok: false; readonly error: string };

/**
 * Check a submitted product choice against what the plugin offers and turn it
 * into the stored value. `null` or `undefined` is every product. A list must
 * be an array of known product ids, not empty, and a subset of the plugin's
 * offer; the whole offer is stored as `null`, so "everything" has one
 * spelling and keeps meaning everything when the plugin gains a product.
 */
export function resolveAccountProducts(
  declaration: ProductDeclaration,
  submitted: unknown,
): AccountProductsChoice {
  if (submitted === null || submitted === undefined) return { ok: true, products: null };
  if (!Array.isArray(submitted)) return { ok: false, error: "products must be an array" };
  const unknown = submitted.filter((id) => !isProductId(id));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown products: ${unknown.map(String).join(", ")}` };
  }
  const chosen = normalizeProductIds(submitted);
  if (chosen.length === 0) return { ok: false, error: "products must name at least one app" };
  const offered = productsOfferedBy(declaration);
  if (offered.length === 0) {
    return { ok: false, error: "This plugin does not offer a choice of apps" };
  }
  const notOffered = chosen.filter((id) => !offered.includes(id));
  if (notOffered.length > 0) {
    return {
      ok: false,
      error: `This plugin does not offer: ${notOffered.join(", ")}. It offers: ${offered.join(", ")}`,
    };
  }
  return { ok: true, products: chosen.length === offered.length ? null : chosen };
}
