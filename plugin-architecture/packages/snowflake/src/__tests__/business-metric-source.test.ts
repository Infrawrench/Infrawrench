import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAccount } from "../account.js";
import type { SnowflakeContext } from "../api.js";
import { SnowflakeAuth } from "../auth.js";
import {
  BUSINESS_METRIC_QUERY_TAG,
  listSnowflakeBusinessMetricOptions,
  runSnowflakeBusinessMetricSource,
  snowflakeBusinessMetricSource,
} from "../business-metric-source.js";
import { SnowflakeClient } from "../client.js";
import { plugin } from "../plugin.js";
import { CREDS, jsonResponse, mockSnowflake, resultSet, sqlError } from "./helpers.js";

function ctx(): SnowflakeContext {
  const account = parseAccount("myorg-myaccount");
  return {
    account,
    auth: new SnowflakeAuth({ kind: "token", token: "t" }, account.jwtAccount, "me"),
    warehouse: "META_WH",
  };
}

const range = {
  from: "2026-09-01",
  to: "2026-09-02",
  timezone: "America/New_York",
  maxRows: 3,
  timeoutMs: 45_000,
};

const params = {
  warehouse: "REPORTING_WH",
  role: "ANALYST_RO",
  database: "PROD",
  schema: "PUBLIC",
  sql: "SELECT d AS day, n AS value FROM events WHERE d >= {{from}} AND d < {{to_exclusive}}",
};

afterEach(() => vi.unstubAllGlobals());

describe("snowflake business metric source manifest", () => {
  it("is declared on the plugin with the expected fields", () => {
    expect(plugin.manifest.businessMetricSource).toBe(snowflakeBusinessMetricSource);
    expect(snowflakeBusinessMetricSource.fields.map((f) => f.key)).toEqual([
      "warehouse",
      "role",
      "database",
      "schema",
      "sql",
    ]);
    expect(snowflakeBusinessMetricSource.readOnly).toBe("validated");
  });

  it("is wired into the client", () => {
    const client = new SnowflakeClient(CREDS);
    expect(typeof client.runBusinessMetricSource).toBe("function");
    expect(typeof client.listBusinessMetricSourceOptions).toBe("function");
  });
});

describe("runSnowflakeBusinessMetricSource", () => {
  it("runs one bound statement with the picked context and session bounds", async () => {
    const { statements, bodies } = mockSnowflake(() =>
      jsonResponse(
        200,
        resultSet(
          [
            { name: "DAY", type: "date" },
            { name: "VALUE", type: "fixed" },
          ],
          [
            ["20697", "10"],
            ["20698", "12"],
          ],
        ),
      ),
    );
    const result = await runSnowflakeBusinessMetricSource(ctx(), params, range);
    expect(result.points).toEqual([
      { date: "2026-09-01", value: 10 },
      { date: "2026-09-02", value: 12 },
    ]);
    expect(statements[0]).toContain("d >= '2026-09-01' AND d < '2026-09-03'");
    expect(bodies[0]).toMatchObject({
      warehouse: "REPORTING_WH",
      role: "ANALYST_RO",
      database: "PROD",
      schema: "PUBLIC",
      timeout: 45,
      parameters: {
        multi_statement_count: 1,
        rows_per_resultset: 4,
        timezone: "America/New_York",
        query_tag: BUSINESS_METRIC_QUERY_TAG,
      },
    });
  });

  it("falls back to the account warehouse when none is picked", async () => {
    const { bodies } = mockSnowflake(() =>
      jsonResponse(200, resultSet([{ name: "DAY" }, { name: "VALUE" }], [])),
    );
    await runSnowflakeBusinessMetricSource(
      ctx(),
      { database: "PROD", sql: "SELECT 1 AS day, 1 AS value" },
      range,
    );
    expect(bodies[0]!["warehouse"]).toBe("META_WH");
    expect(bodies[0]!["role"]).toBeUndefined();
  });

  it("rejects writes before contacting Snowflake", async () => {
    const { fn } = mockSnowflake(() => undefined);
    await expect(
      runSnowflakeBusinessMetricSource(ctx(), { ...params, sql: "DROP TABLE events" }, range),
    ).rejects.toThrow(/SELECT or WITH/);
    await expect(
      runSnowflakeBusinessMetricSource(
        ctx(),
        { ...params, sql: "SELECT 1 AS day, 1 AS value; DELETE FROM events" },
        range,
      ),
    ).rejects.toThrow(/one statement/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("throws rather than truncating when the result passes maxRows", async () => {
    mockSnowflake(() =>
      jsonResponse(
        200,
        resultSet(
          [
            { name: "DAY", type: "date" },
            { name: "VALUE", type: "fixed" },
          ],
          [
            ["20697", "1"],
            ["20698", "1"],
            ["20699", "1"],
            ["20700", "1"],
          ],
        ),
      ),
    );
    await expect(runSnowflakeBusinessMetricSource(ctx(), params, range)).rejects.toThrow(
      /more than 3 rows/,
    );
  });

  it("surfaces Snowflake's SQL error", async () => {
    mockSnowflake(() => sqlError("002003", "Object 'EVENTS' does not exist or not authorized."));
    await expect(runSnowflakeBusinessMetricSource(ctx(), params, range)).rejects.toThrow(
      /EVENTS' does not exist/,
    );
  });

  it("requires a database", async () => {
    await expect(
      runSnowflakeBusinessMetricSource(ctx(), { ...params, database: "" }, range),
    ).rejects.toThrow(/database/);
  });
});

describe("listSnowflakeBusinessMetricOptions", () => {
  it("lists warehouses as the picked role", async () => {
    const { bodies } = mockSnowflake((s) =>
      s === "SHOW WAREHOUSES"
        ? jsonResponse(
            200,
            resultSet(
              [{ name: "name" }, { name: "size" }, { name: "state" }],
              [
                ["Z_WH", "Small", "SUSPENDED"],
                ["A_WH", "X-Small", "STARTED"],
              ],
            ),
          )
        : undefined,
    );
    const options = await listSnowflakeBusinessMetricOptions(ctx(), "warehouse", {
      role: "ANALYST_RO",
    });
    expect(options).toEqual([
      { id: "A_WH", label: "A_WH", description: "X-Small, started" },
      { id: "Z_WH", label: "Z_WH", description: "Small, suspended" },
    ]);
    expect(bodies[0]!["role"]).toBe("ANALYST_RO");
  });

  it("lists schemas of the picked database without INFORMATION_SCHEMA", async () => {
    const { statements } = mockSnowflake(() =>
      jsonResponse(
        200,
        resultSet([{ name: "name" }], [["PUBLIC"], ["INFORMATION_SCHEMA"], ["MARTS"]]),
      ),
    );
    const options = await listSnowflakeBusinessMetricOptions(ctx(), "schema", {
      database: 'my"db',
    });
    expect(options.map((o) => o.id)).toEqual(["MARTS", "PUBLIC"]);
    expect(statements[0]).toBe('SHOW SCHEMAS IN DATABASE "my""db"');
  });

  it("lists the roles granted to the user", async () => {
    mockSnowflake(() =>
      jsonResponse(200, resultSet([{ name: "ROLES" }], [['["PUBLIC","ANALYST_RO"]']])),
    );
    const options = await listSnowflakeBusinessMetricOptions(ctx(), "role", {});
    expect(options.map((o) => o.id)).toEqual(["ANALYST_RO", "PUBLIC"]);
  });

  it("returns nothing for schema before a database is picked", async () => {
    expect(await listSnowflakeBusinessMetricOptions(ctx(), "schema", {})).toEqual([]);
  });
});
