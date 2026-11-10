import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  accountInventoryCondition,
  accountProductCondition,
  pluginIdsOffering,
} from "../runtime/account-products";

const dialect = new PgDialect();
const render = (fragment: SQL) => {
  const query = dialect.sqlToQuery(fragment);
  return { text: query.sql.replace(/\s+/g, " ").trim(), params: query.params };
};

describe("accountInventoryCondition", () => {
  it("keeps every account but one connected for Costs alone", () => {
    expect(render(accountInventoryCondition())).toEqual({
      text: "AND (accounts.products IS NULL OR jsonb_array_length(accounts.products - 'costs') > 0)",
      params: [],
    });
  });

  it("names the alias the claim uses", () => {
    expect(render(accountInventoryCondition("a")).text).toBe(
      "AND (a.products IS NULL OR jsonb_array_length(a.products - 'costs') > 0)",
    );
  });
});

describe("accountProductCondition", () => {
  it("asks for the product where the plugin offers it, the inventory rule elsewhere", () => {
    const { text, params } = render(accountProductCondition("security", ["github", "jfrog"], "a"));
    expect(text).toBe(
      "AND (a.products IS NULL OR CASE WHEN a.plugin_id IN ($1, $2) THEN a.products @> $3::jsonb " +
        "ELSE (a.products IS NULL OR jsonb_array_length(a.products - 'costs') > 0) END)",
    );
    expect(params).toEqual(["github", "jfrog", '["security"]']);
  });

  it("uses the accounts table name by default", () => {
    const { text, params } = render(accountProductCondition("costs", ["aws"]));
    expect(text).toContain(
      "CASE WHEN accounts.plugin_id IN ($1) THEN accounts.products @> $2::jsonb",
    );
    expect(params).toEqual(["aws", '["costs"]']);
  });

  // An empty IN () is a syntax error; with nobody offering the choice every
  // account follows the inventory rule.
  it("is the inventory rule when no plugin offers the product", () => {
    expect(render(accountProductCondition("costs", [], "a"))).toEqual(
      render(accountInventoryCondition("a")),
    );
  });
});

describe("pluginIdsOffering", () => {
  const capability = (id: string, product?: "security") => ({
    id,
    label: id,
    requiredPermissions: [],
    ...(product ? { product } : {}),
  });
  const loaded = [
    {
      plugin: {
        manifest: {
          id: "cloud",
          preflight: { capabilities: [capability("resources"), capability("costs")] },
        },
      },
    },
    {
      plugin: {
        manifest: { id: "scanner", preflight: { capabilities: [capability("scan", "security")] } },
      },
    },
    { plugin: { manifest: { id: "plain" } } },
  ];

  it("reads the offer from each manifest's preflight capabilities", () => {
    expect(pluginIdsOffering(loaded, "costs")).toEqual(["cloud"]);
    expect(pluginIdsOffering(loaded, "infrastructure")).toEqual(["cloud"]);
    expect(pluginIdsOffering(loaded, "security")).toEqual(["scanner"]);
    expect(pluginIdsOffering(loaded, "delivery")).toEqual([]);
  });
});
