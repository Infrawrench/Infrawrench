import { describe, expect, it } from "vitest";
import { PRODUCTS, PRODUCT_IDS, groupToolsByProduct } from "../registry.js";

describe("product registry", () => {
  it("lists every product id exactly once", () => {
    expect(PRODUCTS.map((p) => p.id)).toEqual([...PRODUCT_IDS]);
  });

  it("gives every tool to one product only", () => {
    const keys = PRODUCTS.flatMap((p) => p.tools);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only links products that exist, and never a product to itself", () => {
    for (const product of PRODUCTS) {
      for (const other of product.worksWith) {
        expect(PRODUCT_IDS).toContain(other);
        expect(other).not.toBe(product.id);
      }
    }
  });

  it("groups a platform's tools by product, in the product's order", () => {
    const tools = [{ key: "invoices" }, { key: "costs" }, { key: "mystery" }, { key: "logs" }];
    const { byProduct, unclaimed } = groupToolsByProduct(tools);
    expect(byProduct.costs.map((t) => t.key)).toEqual(["costs", "invoices"]);
    expect(byProduct.observability.map((t) => t.key)).toEqual(["logs"]);
    expect(byProduct.security).toEqual([]);
    expect(unclaimed.map((t) => t.key)).toEqual(["mystery"]);
  });
});
