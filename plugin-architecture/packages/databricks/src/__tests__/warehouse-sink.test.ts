import { describe, expect, it } from "vitest";
import type { WarehouseCell, WarehouseColumn } from "@infrawrench/plugin-base";
import { plugin } from "../plugin.js";
import {
  cellLiteral,
  databricksSetupGuide,
  listDatabricksTargetOptions,
  loadDatabricksRows,
  stringLiteral,
  type ApiFn,
} from "../warehouse-sink.js";

const COLUMNS: WarehouseColumn[] = [
  { name: "export_id", type: "string" },
  { name: "day", type: "date" },
  { name: "provider", type: "string" },
  { name: "amount", type: "decimal" },
];

async function* rows(n: number): AsyncGenerator<WarehouseCell[]> {
  for (let i = 0; i < n; i++) yield ["exp-1", "2026-10-01", "it's \\ aws", i + 0.25];
}

const request = (n: number, target: Record<string, string> = {}) => ({
  target: { warehouseId: "abc123", catalog: "main", schema: "finops", table: "costs", ...target },
  columns: COLUMNS,
  rows: rows(n),
  replace: {
    scopeColumn: "export_id",
    scopeValue: "exp-1",
    dayColumn: "day",
    from: "2026-10-01",
    to: "2026-10-07",
  },
});

/** A fake client `api`: records statements, serves UC table metadata. */
function fakeApi(opts: { existing?: Array<{ name: string; type_text: string }>; failOn?: RegExp }) {
  const statements: string[] = [];
  let created = false;
  const api: ApiFn = async <T>(method: string, path: string, body?: Record<string, unknown>) => {
    if (method === "GET" && path.startsWith("/api/2.1/unity-catalog/tables/")) {
      if (!opts.existing && !created) {
        throw new Error(`Databricks GET ${path} failed: 404 TABLE_DOES_NOT_EXIST`);
      }
      const cols = opts.existing ?? COLUMNS.map((c) => ({ name: c.name, type_text: "string" }));
      return { columns: cols.map((c, i) => ({ ...c, position: i })) } as T;
    }
    if (method === "POST" && path === "/api/2.0/sql/statements") {
      const statement = String(body?.["statement"]);
      statements.push(statement);
      if (statement.startsWith("CREATE TABLE IF NOT EXISTS")) created = true;
      if (opts.failOn?.test(statement)) {
        return {
          status: { state: "FAILED", error: { message: "PERMISSION_DENIED: no MODIFY" } },
        } as T;
      }
      return { statement_id: "s1", status: { state: "SUCCEEDED" } } as T;
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { api, statements };
}

describe("loadDatabricksRows", () => {
  it("creates the Delta table, stages escaped literals, and replaces the period atomically", async () => {
    const { api, statements } = fakeApi({});
    const result = await loadDatabricksRows(api, request(2));

    expect(result).toEqual({ rowCount: 2, table: "main.finops.costs" });
    expect(statements[0]).toBe(
      "CREATE TABLE IF NOT EXISTS `main`.`finops`.`costs` (`export_id` STRING, `day` DATE, `provider` STRING, `amount` DECIMAL(38, 10)) USING DELTA COMMENT 'Cost export rows loaded by Infrawrench'",
    );
    expect(statements[1]).toMatch(/^CREATE TABLE `main`\.`finops`\.`costs__iw_stage_[0-9a-f]{12}`/);
    expect(statements[2]).toContain(
      "VALUES ('exp-1', DATE'2026-10-01', 'it\\'s \\\\ aws', 0.25), ('exp-1', DATE'2026-10-01', 'it\\'s \\\\ aws', 1.25)",
    );
    expect(statements[3]).toMatch(
      /^INSERT INTO `main`\.`finops`\.`costs` REPLACE WHERE `export_id` = 'exp-1' AND `day` >= DATE'2026-10-01' AND `day` <= DATE'2026-10-07' SELECT `export_id`, `day`, `provider`, `amount` FROM `main`\.`finops`\.`costs__iw_stage_/,
    );
    expect(statements[4]).toMatch(/^DROP TABLE IF EXISTS .*costs__iw_stage_/);
  });

  it("adds missing columns and fills the target's other columns with NULL", async () => {
    const { api, statements } = fakeApi({
      existing: [
        { name: "export_id", type_text: "string" },
        { name: "team", type_text: "string" },
        { name: "day", type_text: "date" },
        { name: "amount", type_text: "decimal(38,10)" },
      ],
    });
    await loadDatabricksRows(api, request(1));
    expect(statements[0]).toBe(
      "ALTER TABLE `main`.`finops`.`costs` ADD COLUMNS (`provider` STRING)",
    );
    const replace = statements.find((s) => s.includes("REPLACE WHERE"))!;
    expect(replace).toContain("SELECT `export_id`, CAST(NULL AS string), `day`, `amount` FROM");
  });

  it("explains a permission failure and still drops the stage", async () => {
    const { api, statements } = fakeApi({ failOn: /REPLACE WHERE/ });
    await expect(loadDatabricksRows(api, request(1))).rejects.toThrow(/SELECT and MODIFY/);
    expect(statements.at(-1)).toMatch(/^DROP TABLE IF EXISTS/);
  });

  it("refuses a warehouse id that is not an id", async () => {
    const { api, statements } = fakeApi({});
    await expect(loadDatabricksRows(api, request(1, { warehouseId: "x; DROP" }))).rejects.toThrow(
      /SQL warehouse/,
    );
    expect(statements).toEqual([]);
  });
});

describe("literals", () => {
  it("escapes with backslashes, never doubled quotes", () => {
    expect(stringLiteral("O'Connell")).toBe("'O\\'Connell'");
    expect(stringLiteral("a\\b\nc")).toBe("'a\\\\b\\nc'");
  });

  it("types cells", () => {
    expect(cellLiteral(null, "string")).toBe("NULL");
    expect(cellLiteral("", "date")).toBe("NULL");
    expect(cellLiteral("2026-10-01", "date")).toBe("DATE'2026-10-01'");
    expect(cellLiteral(1e-7, "decimal")).toBe("0.0000001");
    expect(cellLiteral(true, "boolean")).toBe("TRUE");
    expect(cellLiteral("2026-10-02T04:00:00.000Z", "timestamp")).toBe(
      "TIMESTAMP'2026-10-02T04:00:00.000Z'",
    );
  });
});

describe("pickers and setup", () => {
  it("declares the warehouse sink on the manifest", () => {
    expect(plugin.manifest.warehouseSink?.targetFields.map((f) => f.key)).toEqual([
      "warehouseId",
      "catalog",
      "schema",
      "table",
    ]);
  });

  it("lists SQL warehouses by name with their id as the value", async () => {
    const api: ApiFn = async <T>() =>
      ({
        warehouses: [
          {
            id: "abc123",
            name: "Starter",
            cluster_size: "2X-Small",
            state: "STOPPED",
            enable_serverless_compute: true,
          },
        ],
      }) as T;
    expect(await listDatabricksTargetOptions(api, "warehouseId", {})).toEqual([
      { id: "abc123", label: "Starter", description: "Serverless, 2X-Small, stopped" },
    ]);
  });

  it("hides system catalogs", async () => {
    const api: ApiFn = async <T>() =>
      ({ catalogs: [{ name: "main" }, { name: "system" }, { name: "samples" }] }) as T;
    expect(await listDatabricksTargetOptions(api, "catalog", {})).toEqual([
      { id: "main", label: "main" },
    ]);
  });

  it("writes Unity Catalog grants for the token's principal", () => {
    const guide = databricksSetupGuide(
      { catalog: "main", schema: "finops", table: "costs" },
      "svc@example.com",
    );
    expect(guide.sql).toContain("GRANT USE CATALOG ON CATALOG `main` TO `svc@example.com`;");
    expect(guide.sql).toContain(
      "GRANT USE SCHEMA, CREATE TABLE ON SCHEMA `main`.`finops` TO `svc@example.com`;",
    );
    expect(guide.sql).toContain(
      "GRANT SELECT, MODIFY ON TABLE `main`.`finops`.`costs` TO `svc@example.com`;",
    );
    expect(guide.notes.join(" ")).toMatch(/CAN USE/);
  });
});
