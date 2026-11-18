/**
 * The price-change watch's read of the instance pricing warehouse, with the
 * same read-only token the plugins' estimates use (`host-services.ts`). No
 * token (a self-hosted deployment) means no history to read, which every
 * caller reports as "unavailable" rather than "no changes".
 */
import { queryWarehouse, type Cell } from "../aws-pricing-warehouse/query";

export type WarehouseRow = Record<string, Cell>;

/** Runs one statement and returns its rows as objects keyed by column name. */
export type WarehouseRows = (sql: string, maxRows: number) => Promise<WarehouseRow[]>;

export function priceWarehouse(): WarehouseRows | null {
  const token = process.env["PRICING_WAREHOUSE_READ_TOKEN"];
  if (!token) return null;
  const config = { token, url: process.env["PRICING_WAREHOUSE_URL"] };
  return async (sql, maxRows) => {
    const result = await queryWarehouse(sql, config, { maxRows, timeoutMs: 30_000 });
    const names = result.columns.map((c) => c.name);
    return result.rows.map((row) => Object.fromEntries(names.map((n, i) => [n, row[i] ?? null])));
  };
}
