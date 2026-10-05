import { afterEach, describe, expect, it, vi } from "vitest";
import type { WarehouseCell, WarehouseColumn } from "@infrawrench/plugin-base";
import { SnowflakeClient } from "../client.js";
import { plugin } from "../plugin.js";
import { decimalText, snowflakeSetupGuide } from "../warehouse-sink.js";
import { CREDS, jsonResponse, mockSnowflake, resultSet, sqlError } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const COLUMNS: WarehouseColumn[] = [
  { name: "export_id", type: "string" },
  { name: "day", type: "date" },
  { name: "provider", type: "string" },
  { name: "amount", type: "decimal" },
];

async function* rows(n: number): AsyncGenerator<WarehouseCell[]> {
  for (let i = 0; i < n; i++) yield ["exp-1", "2026-10-01", i % 2 ? "aws" : null, i + 0.5];
}

const ok = () => jsonResponse(200, resultSet([{ name: "status" }], [["ok"]]));

function request(n: number) {
  return {
    target: { database: "ANALYTICS", schema: "FINOPS", table: "costs" },
    columns: COLUMNS,
    rows: rows(n),
    replace: {
      scopeColumn: "export_id",
      scopeValue: "exp-1",
      dayColumn: "day",
      from: "2026-10-01",
      to: "2026-10-01",
    },
  };
}

describe("loadWarehouseRows", () => {
  it("creates a missing table, stages with bound inserts, and swaps the period in one transaction", async () => {
    const { statements, bodies } = mockSnowflake((s) => {
      if (s.startsWith("SHOW COLUMNS")) return sqlError("002003", "Table does not exist");
      return ok();
    });
    const result = await new SnowflakeClient(CREDS).loadWarehouseRows("acc", request(3));

    expect(result).toEqual({ rowCount: 3, table: "ANALYTICS.FINOPS.COSTS" });
    expect(statements[0]).toBe('SHOW COLUMNS IN TABLE "ANALYTICS"."FINOPS"."COSTS"');
    // An unquoted-style name typed by the user becomes upper-case, as are columns.
    expect(statements[1]).toMatch(
      /^CREATE TABLE IF NOT EXISTS "ANALYTICS"\."FINOPS"\."COSTS" \("EXPORT_ID" VARCHAR, "DAY" DATE, "PROVIDER" VARCHAR, "AMOUNT" NUMBER\(38, 10\)\)/,
    );
    expect(statements[2]).toMatch(
      /^CREATE TRANSIENT TABLE "ANALYTICS"\."FINOPS"\."COSTS__IW_STAGE_/,
    );

    const insert = statements[3]!;
    expect(insert).toMatch(/^INSERT INTO .*COSTS__IW_STAGE_.* VALUES \(\?, \?, \?, \?\), \(\?/);
    const bindings = bodies[3]!["bindings"] as Record<
      string,
      { type: string; value: string | null }
    >;
    expect(Object.keys(bindings)).toHaveLength(12);
    expect(bindings["1"]).toEqual({ type: "TEXT", value: "exp-1" });
    expect(bindings["3"]).toEqual({ type: "TEXT", value: null });
    expect(bindings["4"]).toEqual({ type: "TEXT", value: "0.5" });
    // Values never reach the statement text.
    expect(insert).not.toContain("exp-1");

    const swap = statements[4]!;
    expect(swap).toMatch(
      /^BEGIN; DELETE FROM "ANALYTICS"\."FINOPS"\."COSTS" WHERE "EXPORT_ID" = 'exp-1' AND "DAY" BETWEEN '2026-10-01'::DATE AND '2026-10-01'::DATE; INSERT INTO .* SELECT .* FROM .*__IW_STAGE_.*; COMMIT$/,
    );
    expect((bodies[4]!["parameters"] as Record<string, string>)["MULTI_STATEMENT_COUNT"]).toBe("4");
    expect(bodies[4]!["bindings"]).toBeUndefined();
    expect(statements[5]).toMatch(/^DROP TABLE IF EXISTS .*__IW_STAGE_/);
  });

  it("adds only the columns an existing table is missing", async () => {
    const { statements } = mockSnowflake((s) => {
      if (s.startsWith("SHOW COLUMNS")) {
        return jsonResponse(
          200,
          resultSet([{ name: "column_name" }], [["EXPORT_ID"], ["DAY"], ["AMOUNT"]]),
        );
      }
      return ok();
    });
    await new SnowflakeClient(CREDS).loadWarehouseRows("acc", request(1));
    expect(statements.filter((s) => s.startsWith("ALTER TABLE"))).toEqual([
      'ALTER TABLE "ANALYTICS"."FINOPS"."COSTS" ADD COLUMN IF NOT EXISTS "PROVIDER" VARCHAR',
    ]);
    expect(statements.some((s) => s.startsWith("CREATE TABLE"))).toBe(false);
  });

  it("splits large loads into batches of at most 1,000 rows", async () => {
    const { statements } = mockSnowflake((s) =>
      s.startsWith("SHOW COLUMNS") ? sqlError("002003", "missing") : ok(),
    );
    const result = await new SnowflakeClient(CREDS).loadWarehouseRows("acc", request(2_500));
    expect(result.rowCount).toBe(2_500);
    expect(
      statements.filter((s) => s.startsWith("INSERT INTO") && s.includes("VALUES")),
    ).toHaveLength(3);
  });

  it("leaves the target untouched and drops the stage when staging fails", async () => {
    const { statements } = mockSnowflake((s) => {
      if (s.startsWith("SHOW COLUMNS")) return sqlError("002003", "missing");
      if (s.startsWith("INSERT INTO") && s.includes("VALUES")) {
        return sqlError("003001", "Insufficient privileges to operate on table");
      }
      return ok();
    });
    await expect(new SnowflakeClient(CREDS).loadWarehouseRows("acc", request(2))).rejects.toThrow(
      /SELECT, INSERT and DELETE/,
    );
    expect(statements.some((s) => s.startsWith("BEGIN"))).toBe(false);
    expect(statements.at(-1)).toMatch(/^DROP TABLE IF EXISTS .*__IW_STAGE_/);
  });

  it("refuses an incomplete target before touching Snowflake", async () => {
    const { statements } = mockSnowflake(() => ok());
    await expect(
      new SnowflakeClient(CREDS).loadWarehouseRows("acc", {
        ...request(1),
        target: { database: "ANALYTICS" },
      }),
    ).rejects.toThrow(/database, schema and table/);
    expect(statements).toEqual([]);
  });
});

describe("pickers and setup", () => {
  it("declares the warehouse sink on the manifest", () => {
    expect(plugin.manifest.warehouseSink?.targetFields.map((f) => f.key)).toEqual([
      "warehouse",
      "database",
      "schema",
      "table",
    ]);
  });

  it("lists schemas of the chosen database, hiding INFORMATION_SCHEMA", async () => {
    const { statements } = mockSnowflake(() =>
      jsonResponse(200, resultSet([{ name: "name" }], [["FINOPS"], ["INFORMATION_SCHEMA"]])),
    );
    const options = await new SnowflakeClient(CREDS).listWarehouseTargetOptions("acc", "schema", {
      database: "ANALYTICS",
    });
    expect(statements).toEqual(['SHOW SCHEMAS IN DATABASE "ANALYTICS"']);
    expect(options).toEqual([{ id: "FINOPS", label: "FINOPS" }]);
  });

  it("writes grants for the account's role", () => {
    const guide = snowflakeSetupGuide(
      { warehouse: "LOAD_WH", database: "ANALYTICS", schema: "FINOPS", table: "costs" },
      "INFRAWRENCH_ROLE",
      "INFRAWRENCH",
    );
    expect(guide.sql).toContain('GRANT USAGE ON WAREHOUSE "LOAD_WH" TO ROLE "INFRAWRENCH_ROLE";');
    expect(guide.sql).toContain(
      'GRANT CREATE TABLE ON SCHEMA "ANALYTICS"."FINOPS" TO ROLE "INFRAWRENCH_ROLE";',
    );
    expect(guide.sql).toContain(
      'GRANT SELECT, INSERT, DELETE ON TABLE "ANALYTICS"."FINOPS"."COSTS" TO ROLE "INFRAWRENCH_ROLE";',
    );
  });

  it("prints decimals without exponents", () => {
    expect(decimalText(1e-7)).toBe("0.0000001");
    expect(decimalText(12.5)).toBe("12.5");
  });
});
