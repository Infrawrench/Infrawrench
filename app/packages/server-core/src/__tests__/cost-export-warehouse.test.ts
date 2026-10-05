import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The host half of warehouse destinations: shape checks, the account and
 * plugin checks, and the column typing every plugin receives. The plugins'
 * own SQL is tested in their packages.
 */

let accountRows: Array<{ id: string; pluginId: string; displayName: string }> = [];

vi.mock("../db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const result = Promise.resolve(accountRows) as Promise<typeof accountRows> & {
            limit: () => Promise<typeof accountRows>;
            orderBy: () => Promise<typeof accountRows>;
          };
          result.limit = async () => accountRows.slice(0, 1);
          result.orderBy = async () => accountRows;
          return result;
        },
      }),
    }),
  },
}));
vi.mock("../db/schema", () => ({
  accounts: { id: "id", organizationId: "organization_id", pluginId: "plugin_id" },
}));

const sink = {
  label: "Snowflake table",
  targetFields: [
    { key: "warehouse", label: "Warehouse", optional: true },
    { key: "database", label: "Database" },
    { key: "schema", label: "Schema", dependsOn: ["database"] },
    { key: "table", label: "Table", allowCustom: true },
  ],
};
const snowflake = { manifest: { id: "snowflake", displayName: "Snowflake", warehouseSink: sink } };
const aws = { manifest: { id: "aws", displayName: "AWS" } };

vi.mock("../plugin-loader", () => ({
  getPlugin: async (id: string) =>
    id === "snowflake" ? { plugin: snowflake } : id === "aws" ? { plugin: aws } : undefined,
  loadPlugins: async () => [{ plugin: snowflake }, { plugin: aws }],
}));
vi.mock("../org-accounts", () => ({ getOrgAccountClient: async () => null }));

const {
  assertWarehouseDestination,
  listWarehouseSinks,
  normalizeWarehouseDestination,
  warehouseCells,
  warehouseColumnType,
  warehouseColumns,
  WarehouseDestinationError,
} = await import("../cost-exports/warehouse");

beforeEach(() => {
  accountRows = [{ id: "acct-sf", pluginId: "snowflake", displayName: "Prod Snowflake" }];
});

const dest = (target: Record<string, string>) => ({
  kind: "warehouse" as const,
  pluginId: "snowflake",
  accountId: "acct-sf",
  target,
});

describe("normalizeWarehouseDestination", () => {
  it("trims values and drops empty ones", () => {
    expect(
      normalizeWarehouseDestination({
        pluginId: "snowflake",
        accountId: " acct-sf ",
        target: { database: " ANALYTICS ", warehouse: "" },
      }),
    ).toEqual(dest({ database: "ANALYTICS" }));
  });

  it("refuses keys that could not be a field name and non-string values", () => {
    expect(() =>
      normalizeWarehouseDestination({
        pluginId: "snowflake",
        accountId: "a",
        target: { "a.b": "x" },
      }),
    ).toThrow(WarehouseDestinationError);
    expect(() =>
      normalizeWarehouseDestination({ pluginId: "snowflake", accountId: "a", target: { db: 1 } }),
    ).toThrow(/must be a string/);
    expect(() => normalizeWarehouseDestination({ pluginId: "", accountId: "a" })).toThrow(
      /pluginId/,
    );
  });
});

describe("assertWarehouseDestination", () => {
  it("accepts a complete target on the org's account", async () => {
    const out = await assertWarehouseDestination(
      "org-1",
      dest({ database: "ANALYTICS", schema: "FINOPS", table: "COSTS" }),
    );
    expect(out.target).toEqual({ database: "ANALYTICS", schema: "FINOPS", table: "COSTS" });
  });

  it("names the missing required field", async () => {
    await expect(
      assertWarehouseDestination("org-1", dest({ database: "ANALYTICS", table: "COSTS" })),
    ).rejects.toThrow(/schema/);
  });

  it("refuses an unknown key instead of silently dropping it", async () => {
    await expect(
      assertWarehouseDestination(
        "org-1",
        dest({ database: "A", schema: "B", table: "C", catalog: "D" }),
      ),
    ).rejects.toThrow(/catalog/);
  });

  it("refuses an account of another plugin, or one outside the org", async () => {
    accountRows = [{ id: "acct-sf", pluginId: "aws", displayName: "AWS" }];
    await expect(
      assertWarehouseDestination("org-1", dest({ database: "A", schema: "B", table: "C" })),
    ).rejects.toThrow(/not a connected snowflake account/);
    accountRows = [];
    await expect(
      assertWarehouseDestination("org-1", dest({ database: "A", schema: "B", table: "C" })),
    ).rejects.toThrow(/not a connected/);
  });

  it("refuses a plugin that is not a warehouse sink", async () => {
    await expect(
      assertWarehouseDestination("org-1", { ...dest({}), pluginId: "aws" }),
    ).rejects.toThrow(/cannot be a warehouse destination/);
  });
});

describe("listWarehouseSinks", () => {
  it("lists only warehouse-capable plugins, with the org's accounts of each", async () => {
    const sinks = await listWarehouseSinks("org-1");
    expect(sinks).toHaveLength(1);
    expect(sinks[0]).toMatchObject({
      pluginId: "snowflake",
      label: "Snowflake table",
      accounts: [{ id: "acct-sf", name: "Prod Snowflake" }],
    });
    expect(sinks[0]!.targetFields.find((f) => f.key === "table")).toMatchObject({
      allowCustom: true,
      optional: false,
    });
  });
});

describe("column mapping", () => {
  it("types the native layout", () => {
    const cols = warehouseColumns({
      dimensions: ["provider", "service"],
      tagColumns: ["tag_team"],
    });
    expect(cols.map((c) => `${c.name}:${c.type}`)).toEqual([
      "export_id:string",
      "period_start:date",
      "day:date",
      "provider:string",
      "service:string",
      "tag_team:string",
      "currency:string",
      "amount:decimal",
      "usage_amount:decimal",
      "usage_unit:string",
      "exported_at:timestamp",
      "collection_watermark:date",
    ]);
  });

  it("types FOCUS column names by the specification's conventions", () => {
    expect(warehouseColumnType("BilledCost")).toBe("decimal");
    expect(warehouseColumnType("EffectiveCost")).toBe("decimal");
    expect(warehouseColumnType("PricingQuantity")).toBe("decimal");
    expect(warehouseColumnType("ChargePeriodStart")).toBe("timestamp");
    expect(warehouseColumnType("BillingPeriodEnd")).toBe("timestamp");
    expect(warehouseColumnType("Tags")).toBe("json");
    expect(warehouseColumnType("x_CostEstimated")).toBe("boolean");
    expect(warehouseColumnType("ServiceName")).toBe("string");
  });

  it("turns rows into cells, with provenance and empty dates as null", async () => {
    const cols = warehouseColumns({ dimensions: ["provider"], tagColumns: [] });
    const rows = (async function* () {
      yield {
        day: "2026-10-01",
        provider: "aws",
        currency: "USD",
        amount: "12.5",
        usage_amount: 3,
        usage_unit: "",
      };
    })();
    const out: unknown[][] = [];
    for await (const cells of warehouseCells(rows, cols, {
      exportId: "exp-1",
      periodStart: "2026-10-01",
      stamp: { exportedAt: "2026-10-02T04:00:00.000Z", collectionWatermark: "" },
    })) {
      out.push(cells);
    }
    expect(out).toEqual([
      [
        "exp-1",
        "2026-10-01",
        "2026-10-01",
        "aws",
        "USD",
        12.5,
        3,
        "",
        "2026-10-02T04:00:00.000Z",
        null,
      ],
    ]);
  });
});
