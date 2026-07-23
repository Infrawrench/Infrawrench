/**
 * Actual-spend collection from Databricks billing system tables.
 *
 * Databricks has no billing REST API; billed usage lives in Unity Catalog
 * system tables (`system.billing.usage`, `system.billing.list_prices`) and is
 * queried through the SQL Statement Execution API, which needs a SQL warehouse
 * to run on. We pick one automatically (prefer RUNNING so we don't cold-start
 * compute; otherwise the first warehouse — auto-start briefly wakes it).
 *
 * Dollars are DBUs × the *list* price current for the SKU (`price_end_time IS
 * NULL`): negotiated discounts and reserved-capacity commitments are NOT
 * reflected, so amounts are an at-list upper bound.
 *
 * Grants required by the querying principal: `USE CATALOG system` and
 * `SELECT` on the `system.billing` tables (account admins can grant these).
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";

type ApiFn = <T>(method: string, path: string, body?: Record<string, unknown>) => Promise<T>;

interface StatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { message?: string } };
  manifest?: { schema?: { columns?: Array<{ name: string }> } };
  result?: { data_array?: unknown[][] };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Prefer a RUNNING warehouse; fall back to the first one (auto-start wakes it). */
async function pickWarehouseId(api: ApiFn): Promise<string> {
  const data = await api<{ warehouses?: Array<{ id?: string; state?: string }> }>(
    "GET",
    "/api/2.0/sql/warehouses",
  );
  const warehouses = data.warehouses ?? [];
  const chosen = warehouses.find((w) => w.state === "RUNNING") ?? warehouses[0];
  if (!chosen?.id) {
    throw new Error(
      "Databricks plugin: cost collection needs a SQL warehouse to query the " +
        "system.billing tables, but this workspace has none. Create a SQL warehouse " +
        "(a small serverless one is enough) and try again.",
    );
  }
  return chosen.id;
}

/** Run one statement via the SQL Statement Execution API, polling if async. */
async function runStatement(
  api: ApiFn,
  warehouseId: string,
  sql: string,
): Promise<StatementResponse> {
  let result = await api<StatementResponse>("POST", "/api/2.0/sql/statements", {
    warehouse_id: warehouseId,
    statement: sql,
    wait_timeout: "30s",
    disposition: "INLINE",
    format: "JSON_ARRAY",
  });

  let state = result.status?.state ?? "FAILED";
  if (state === "PENDING" || state === "RUNNING") {
    const statementId = result.statement_id;
    if (!statementId) throw new Error("Databricks plugin: statement did not return an ID");
    // Cold warehouses can take minutes to start; poll generously.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      result = await api<StatementResponse>("GET", `/api/2.0/sql/statements/${statementId}`);
      state = result.status?.state ?? "";
      if (state !== "PENDING" && state !== "RUNNING") break;
    }
  }
  if (state !== "SUCCEEDED") {
    const message = result.status?.error?.message ?? `statement ended in state ${state}`;
    throw new Error(
      `Databricks plugin: billing query failed: ${message}. Reading costs requires ` +
        "USE CATALOG system and SELECT on the system.billing tables.",
    );
  }
  return result;
}

export async function fetchDatabricksCostData(
  api: ApiFn,
  range: CostFetchRange,
): Promise<CostRow[]> {
  if (!ISO_DATE.test(range.fromDate) || !ISO_DATE.test(range.toDate)) {
    throw new Error("Databricks plugin: invalid cost range dates");
  }

  const warehouseId = await pickWarehouseId(api);

  // Current list-price row per SKU: price_end_time IS NULL. usage_quantity is
  // summed across all record types, so Databricks restatements/retractions net
  // out on re-fetch (the host's restatement window re-reads recent days).
  const sql = `
    SELECT
      CAST(u.usage_date AS STRING) AS usage_date,
      COALESCE(u.billing_origin_product, '') AS product,
      COALESCE(u.usage_metadata.cluster_id, u.usage_metadata.warehouse_id, '') AS resource_id,
      COALESCE(p.currency_code, 'USD') AS currency,
      SUM(u.usage_quantity * p.pricing.default) AS cost
    FROM system.billing.usage u
    JOIN system.billing.list_prices p
      ON u.sku_name = p.sku_name
     AND u.cloud = p.cloud
     AND u.usage_unit = p.usage_unit
     AND p.price_end_time IS NULL
    WHERE u.usage_date BETWEEN DATE'${range.fromDate}' AND DATE'${range.toDate}'
    GROUP BY 1, 2, 3, 4
    ORDER BY 1`;

  const result = await runStatement(api, warehouseId, sql);
  const columns = result.manifest?.schema?.columns ?? [];
  const index = new Map(columns.map((c, i) => [c.name, i]));
  const col = (row: unknown[], name: string): string => {
    const i = index.get(name);
    return i === undefined ? "" : String(row[i] ?? "");
  };

  const rows: CostRow[] = [];
  for (const raw of result.result?.data_array ?? []) {
    const amount = Number(col(raw, "cost"));
    if (!Number.isFinite(amount) || amount === 0) continue;
    const date = col(raw, "usage_date");
    if (!date) continue;
    const resourceId = col(raw, "resource_id");
    rows.push({
      date,
      service: col(raw, "product"),
      ...(resourceId ? { resourceId } : {}),
      currency: col(raw, "currency") || "USD",
      amount,
    });
  }
  return rows;
}
