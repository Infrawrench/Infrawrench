import { describe, expect, it } from "vitest";
import {
  accountServesProduct,
  accountSyncsResources,
  capabilityIdsForProducts,
  capabilityProduct,
  offersProductChoice,
  productsOfferedBy,
  productsToSubmit,
  resolveAccountProducts,
} from "../products";

const cap = (id: string, product?: "security" | "costs" | "observability") => ({
  id,
  label: id,
  requiredPermissions: [],
  ...(product ? { product } : {}),
});

/** A cloud with inventory, metrics, a bill and a scanner. */
const cloud = {
  capabilities: [
    cap("resources"),
    cap("metrics"),
    cap("costs"),
    cap("idle-findings"),
    cap("scanner", "security"),
  ],
};

describe("capabilityProduct", () => {
  it("prefers what the plugin declared over the convention", () => {
    expect(capabilityProduct({ id: "costs", product: "security" })).toBe("security");
  });

  it("falls back to the convention, then to infrastructure", () => {
    expect(capabilityProduct({ id: "seats" })).toBe("costs");
    expect(capabilityProduct({ id: "logs" })).toBe("observability");
    expect(capabilityProduct({ id: "buckets" })).toBe("infrastructure");
  });
});

describe("productsOfferedBy", () => {
  it("lists the distinct products in the canonical order", () => {
    expect(productsOfferedBy(cloud)).toEqual([
      "infrastructure",
      "costs",
      "observability",
      "security",
    ]);
  });

  it("offers nothing without a preflight declaration", () => {
    expect(productsOfferedBy(null)).toEqual([]);
    expect(productsOfferedBy(undefined)).toEqual([]);
    expect(offersProductChoice(null)).toBe(false);
  });

  it("offers no choice when every capability powers one product", () => {
    const single = { capabilities: [cap("resources"), cap("buckets")] };
    expect(productsOfferedBy(single)).toEqual(["infrastructure"]);
    expect(offersProductChoice(single)).toBe(false);
    expect(offersProductChoice(cloud)).toBe(true);
  });
});

describe("capabilityIdsForProducts", () => {
  it("keeps the capabilities of the chosen products, in declaration order", () => {
    expect(capabilityIdsForProducts(cloud, ["costs"])).toEqual(["costs", "idle-findings"]);
    expect(capabilityIdsForProducts(cloud, ["security", "infrastructure"])).toEqual([
      "resources",
      "scanner",
    ]);
  });

  it("reads null as every product", () => {
    expect(capabilityIdsForProducts(cloud, null)).toEqual([
      "resources",
      "metrics",
      "costs",
      "idle-findings",
      "scanner",
    ]);
  });

  it("is empty for an empty choice and for no declaration", () => {
    expect(capabilityIdsForProducts(cloud, [])).toEqual([]);
    expect(capabilityIdsForProducts(null, ["costs"])).toEqual([]);
  });
});

describe("accountServesProduct and accountSyncsResources", () => {
  it("treats null as every product", () => {
    expect(accountServesProduct(null, "costs")).toBe(true);
    expect(accountServesProduct(undefined, "security")).toBe(true);
    expect(accountSyncsResources(null)).toBe(true);
  });

  it("serves only the listed products", () => {
    expect(accountServesProduct(["costs"], "costs")).toBe(true);
    expect(accountServesProduct(["costs"], "security")).toBe(false);
  });

  it("skips the resource sync only for a costs-only connection", () => {
    expect(accountSyncsResources(["costs"])).toBe(false);
    expect(accountSyncsResources(["costs", "security"])).toBe(true);
    expect(accountSyncsResources(["observability"])).toBe(true);
  });
});

describe("resolveAccountProducts", () => {
  it("stores null for no choice", () => {
    expect(resolveAccountProducts(cloud, undefined)).toEqual({ ok: true, products: null });
    expect(resolveAccountProducts(cloud, null)).toEqual({ ok: true, products: null });
    expect(resolveAccountProducts(null, null)).toEqual({ ok: true, products: null });
  });

  it("stores a subset in the canonical order, without duplicates", () => {
    expect(resolveAccountProducts(cloud, ["security", "costs", "costs"])).toEqual({
      ok: true,
      products: ["costs", "security"],
    });
  });

  it("stores null when the choice is everything the plugin offers", () => {
    expect(
      resolveAccountProducts(cloud, ["security", "observability", "costs", "infrastructure"]),
    ).toEqual({ ok: true, products: null });
  });

  it("refuses an empty list", () => {
    expect(resolveAccountProducts(cloud, [])).toMatchObject({ ok: false });
  });

  it("refuses something that is not a list", () => {
    expect(resolveAccountProducts(cloud, "costs")).toMatchObject({ ok: false });
  });

  it("refuses an unknown id rather than dropping it", () => {
    const result = resolveAccountProducts(cloud, ["costs", "billing"]);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain("billing");
  });

  it("refuses a product the plugin does not offer", () => {
    const result = resolveAccountProducts(cloud, ["delivery"]);
    expect(result.ok ? "" : result.error).toContain("delivery");
  });

  it("refuses any list for a plugin without preflight", () => {
    expect(resolveAccountProducts(null, ["costs"])).toMatchObject({ ok: false });
  });
});

// What the add-account form does with its checkboxes: the selection decides
// both the capabilities the policy template asks for and what is saved.
describe("a form's selection", () => {
  it("starts with everything checked, which asks for every capability and saves null", () => {
    const selected = productsOfferedBy(cloud);
    expect(capabilityIdsForProducts(cloud, selected)).toEqual(cloud.capabilities.map((c) => c.id));
    expect(productsToSubmit(cloud, selected)).toBeNull();
  });

  it("narrows the capabilities and saves the subset when an app is unchecked", () => {
    const selected = productsOfferedBy(cloud).filter((id) => id !== "infrastructure");
    expect(capabilityIdsForProducts(cloud, selected)).toEqual([
      "metrics",
      "costs",
      "idle-findings",
      "scanner",
    ]);
    expect(productsToSubmit(cloud, selected)).toEqual(["costs", "observability", "security"]);
  });

  it("saves in the canonical order whatever order the boxes were ticked in", () => {
    expect(productsToSubmit(cloud, ["security", "costs"])).toEqual(["costs", "security"]);
  });

  it("saves null for a plugin that offers no choice", () => {
    const single = { capabilities: [cap("resources")] };
    expect(productsToSubmit(single, ["infrastructure"])).toBeNull();
    expect(productsToSubmit(null, [])).toBeNull();
  });
});
