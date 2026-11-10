import { describe, expect, it } from "vitest";
import {
  PRODUCTS,
  PRODUCT_IDS,
  groupToolsByProduct,
  showsInfrastructureSidebar,
  toolKeyForTabTarget,
} from "../registry.js";

describe("product registry", () => {
  it("lists every product id exactly once", () => {
    expect(PRODUCTS.map((p) => p.id)).toEqual([...PRODUCT_IDS]);
  });

  it("gives every tool to one product only", () => {
    const keys = PRODUCTS.flatMap((p) => p.tools);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("groups a platform's tools by product, in the product's order", () => {
    const tools = [{ key: "invoices" }, { key: "costs" }, { key: "mystery" }, { key: "logs" }];
    const { byProduct, unclaimed } = groupToolsByProduct(tools);
    expect(byProduct.costs.map((t) => t.key)).toEqual(["costs", "invoices"]);
    expect(byProduct.observability.map((t) => t.key)).toEqual(["logs"]);
    expect(byProduct.security).toEqual([]);
    expect(unclaimed.map((t) => t.key)).toEqual(["mystery"]);
  });

  it("maps a tab to its tool, and leaves non-tool tabs out", () => {
    expect(toolKeyForTabTarget({ kind: "costs" })).toBe("costs");
    expect(toolKeyForTabTarget({ kind: "deployments" })).toBe("deploy");
    expect(toolKeyForTabTarget({ kind: "dashboard" })).toBeUndefined();
    expect(toolKeyForTabTarget({ kind: "home" })).toBeUndefined();
    expect(toolKeyForTabTarget(undefined)).toBeUndefined();
  });

  it("shows the accounts tree only in Infrastructure's context", () => {
    expect(showsInfrastructureSidebar(undefined)).toBe(true);
    expect(showsInfrastructureSidebar({ kind: "resource" })).toBe(true);
    expect(showsInfrastructureSidebar({ kind: "account" })).toBe(true);
    expect(showsInfrastructureSidebar({ kind: "graph" })).toBe(true);
    expect(showsInfrastructureSidebar({ kind: "home", productId: "infrastructure" })).toBe(true);
    // Dragging a resource onto a dashboard is how it is pinned.
    expect(showsInfrastructureSidebar({ kind: "dashboard" })).toBe(true);
    expect(showsInfrastructureSidebar({ kind: "home" })).toBe(false);
    expect(showsInfrastructureSidebar({ kind: "home", productId: "costs" })).toBe(false);
    expect(showsInfrastructureSidebar({ kind: "costs" })).toBe(false);
    expect(showsInfrastructureSidebar({ kind: "chat" })).toBe(false);
    expect(showsInfrastructureSidebar({ kind: "settings" })).toBe(false);
  });
});
