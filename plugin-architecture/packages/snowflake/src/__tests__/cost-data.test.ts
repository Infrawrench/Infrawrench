import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAccount } from "../account.js";
import type { SnowflakeContext } from "../api.js";
import { SnowflakeAuth } from "../auth.js";
import { parseRates } from "../catalog.js";
import { fetchSnowflakeCostData, splitByWarehouse, summarizeMonth } from "../cost-data.js";
import { mockSnowflake, resultSet, jsonResponse, sqlError } from "./helpers.js";

const account = parseAccount("myorg-myaccount");
const ctx: SnowflakeContext = {
  account,
  auth: new SnowflakeAuth({ kind: "token", token: "t" }, account.jwtAccount, "me"),
};

afterEach(() => vi.unstubAllGlobals());

const meteringByWarehouse = () =>
  jsonResponse(
    200,
    resultSet(
      [{ name: "D" }, { name: "W" }, { name: "C", type: "fixed", scale: 3 }],
      [
        ["2026-09-01", "ETL_WH", "3.000"],
        ["2026-09-01", "BI_WH", "1.000"],
      ],
    ),
  );

describe("billed path (ORGANIZATION_USAGE)", () => {
  it("maps services, charge types and splits warehouse compute pro rata", async () => {
    const { statements } = mockSnowflake((s) => {
      if (s.includes("WAREHOUSE_METERING_HISTORY")) return meteringByWarehouse();
      if (s.includes("USAGE_IN_CURRENCY_DAILY")) {
        return jsonResponse(
          200,
          resultSet(
            [
              { name: "D" },
              { name: "ST" },
              { name: "RT" },
              { name: "BT" },
              { name: "BS" },
              { name: "CUR" },
              { name: "ADJ", type: "boolean" },
              { name: "REGION" },
              { name: "USAGE", type: "fixed", scale: 3 },
              { name: "AMOUNT", type: "fixed", scale: 2 },
            ],
            [
              [
                "2026-09-01",
                "WAREHOUSE_METERING",
                "compute",
                "consumption",
                "capacity",
                "EUR",
                "false",
                "AWS_EU_CENTRAL_1",
                "4.000",
                "10.00",
              ],
              [
                "2026-09-01",
                "STORAGE",
                "storage",
                "consumption",
                "capacity",
                "EUR",
                "false",
                "AWS_EU_CENTRAL_1",
                "0.500",
                "11.50",
              ],
              [
                "2026-09-01",
                "SERVERLESS_TASK",
                "compute",
                "consumption",
                "capacity",
                "EUR",
                "false",
                "AWS_EU_CENTRAL_1",
                "1.000",
                "2.50",
              ],
              [
                "2026-09-01",
                "AI_SERVICES",
                "compute",
                "rebate",
                "rebate",
                "EUR",
                "false",
                "AWS_EU_CENTRAL_1",
                "0.000",
                "-1.00",
              ],
            ],
          ),
        );
      }
      return undefined;
    });
    const result = await fetchSnowflakeCostData(ctx, parseRates({}), "2026-09-01", "2026-09-01");
    expect(result.basis).toBe("billed");
    expect(statements.some((s) => s.includes("ACCOUNT_LOCATOR = CURRENT_ACCOUNT()"))).toBe(true);
    const wh = result.rows.filter((r) => r.service === "Warehouse compute");
    expect(wh.map((r) => [r.resourceId, r.amount])).toEqual([
      ["ETL_WH", 7.5],
      ["BI_WH", 2.5],
    ]);
    expect(wh[0]!.currency).toBe("EUR");
    expect(wh[0]!.tags).toMatchObject({ costBasis: "billed", warehouse: "ETL_WH" });
    expect(result.rows.find((r) => r.service === "Storage")?.usageUnit).toBe("TB");
    expect(result.rows.find((r) => r.service === "Serverless features")?.amount).toBe(2.5);
    const rebate = result.rows.find((r) => r.service === "AI services");
    expect(rebate?.chargeType).toBe("credit");
    expect(rebate?.amount).toBe(-1);
  });
});

describe("estimated path (ACCOUNT_USAGE × prices)", () => {
  it("falls back when organization usage is not authorized", async () => {
    mockSnowflake((s) => {
      if (s.includes("WAREHOUSE_METERING_HISTORY")) return meteringByWarehouse();
      if (s.includes("USAGE_IN_CURRENCY_DAILY")) {
        return sqlError(
          "002003",
          "Schema 'SNOWFLAKE.ORGANIZATION_USAGE' does not exist or not authorized.",
        );
      }
      if (s.includes("CURRENT_REGION()")) {
        return jsonResponse(200, resultSet([{ name: "R" }], [["AWS_US_EAST_1"]]));
      }
      if (s.includes("METERING_DAILY_HISTORY")) {
        return jsonResponse(
          200,
          resultSet(
            [
              { name: "D" },
              { name: "ST" },
              { name: "COMPUTE", type: "fixed", scale: 3 },
              { name: "CLOUD", type: "fixed", scale: 3 },
              { name: "ADJ", type: "fixed", scale: 3 },
            ],
            [
              ["2026-09-01", "WAREHOUSE_METERING", "4.000", "0.600", "-0.400"],
              ["2026-09-01", "PIPE", "1.000", "0.000", "0.000"],
            ],
          ),
        );
      }
      if (s.includes("STORAGE_USAGE")) {
        return jsonResponse(
          200,
          resultSet(
            [{ name: "D" }, { name: "BYTES", type: "fixed" }],
            [["2026-09-01", String(1024 ** 4 * 3)]],
          ),
        );
      }
      return undefined;
    });
    const result = await fetchSnowflakeCostData(
      ctx,
      parseRates({ creditPrice: "2", storagePricePerTb: "30" }),
      "2026-09-01",
      "2026-09-01",
    );
    expect(result.basis).toBe("estimated");
    const byService = (svc: string) => result.rows.filter((r) => r.service === svc);
    expect(byService("Warehouse compute").map((r) => [r.resourceId, r.amount])).toEqual([
      ["ETL_WH", 6],
      ["BI_WH", 2],
    ]);
    expect(byService("Serverless features")[0]?.amount).toBe(2);
    // 0.6 used - 0.4 adjustment = 0.2 credits billed
    expect(byService("Cloud services")[0]?.amount).toBeCloseTo(0.4);
    // 3 TB × 30 / 30 days in September
    expect(byService("Storage")[0]?.amount).toBe(3);
    expect(result.rows.every((r) => r.tags?.["costBasis"] === "estimated")).toBe(true);
    expect(result.rows.every((r) => r.region === "AWS_US_EAST_1")).toBe(true);
  });
});

describe("helpers", () => {
  it("leaves a row alone when there is nothing to split by", () => {
    const row = { date: "2026-09-01", currency: "USD", amount: 5 };
    expect(splitByWarehouse(row, undefined)).toEqual([row]);
  });

  it("summarizes a month by service and warehouse", () => {
    const s = summarizeMonth("2026-09", {
      basis: "billed",
      rows: [
        {
          date: "2026-09-01",
          currency: "USD",
          amount: 4,
          service: "Warehouse compute",
          usageAmount: 2,
          usageUnit: "credits",
          tags: { warehouse: "A" },
        },
        { date: "2026-09-02", currency: "USD", amount: 1, service: "Storage" },
      ],
    });
    expect(s.total).toBe(5);
    expect(s.byService[0]).toEqual({ service: "Warehouse compute", amount: 4 });
    expect(s.byWarehouse).toEqual([{ warehouse: "A", amount: 4, credits: 2 }]);
  });
});
