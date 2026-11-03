/**
 * Read-only SQL over the public instance pricing warehouse, shared by
 * `/api/v1/instance-pricing` (and its deprecated `/api/v1/aws-pricing` alias)
 * and the MCP/chat tools. The warehouse token is read-only, which is the real
 * boundary; this only turns the same request into one result shape.
 */
import {
  MAX_QUERY_ROWS,
  QueryError,
  WarehouseUnavailableError,
  queryWarehouse,
  type QueryResult,
  type WarehouseConfig,
} from "@infrawrench/server-core/aws-pricing-warehouse/query";
import {
  QUERYABLE_TABLES,
  SCHEMA_NOTES,
  SYNC_STATE,
} from "@infrawrench/server-core/aws-pricing-warehouse/schema";

/** Rows a query returns unless it asks for fewer. */
export const DEFAULT_QUERY_ROWS = 1000;

/** How long one query may run before it is given up. */
export const QUERY_TIMEOUT_MS = 30_000;

export function instancePricingWarehouse(): WarehouseConfig | null {
  const token = process.env["PRICING_WAREHOUSE_READ_TOKEN"];
  if (!token) return null;
  return { token, url: process.env["PRICING_WAREHOUSE_URL"] };
}

export interface InstancePricingSchema {
  tables: {
    name: string;
    description: string;
    sortingKey: readonly string[];
    columns: { name: string; type: string; description: string }[];
  }[];
  notes: readonly string[];
  /** Null when freshness could not be read. The tables never depend on it. */
  sources: Record<string, string | number | boolean | null>[] | null;
}

/** Tables, notes and each source's freshness. Works with no warehouse token. */
export async function getInstancePricingSchema(): Promise<InstancePricingSchema> {
  const config = instancePricingWarehouse();
  let sources: InstancePricingSchema["sources"] = null;
  if (config) {
    try {
      const result = await queryWarehouse(
        `SELECT source, argMax(version, synced_at) AS version, argMax(price_list_to, synced_at) AS priceListTo, max(synced_at) AS syncedAt, argMax(price_rows, synced_at) AS priceRows FROM ${SYNC_STATE.name} GROUP BY source ORDER BY source`,
        config,
        { maxRows: 100, timeoutMs: 10_000 },
      );
      sources = result.rows.map((row) =>
        Object.fromEntries(result.columns.map((col, i) => [col.name, row[i] ?? null])),
      );
    } catch (error) {
      console.warn("instance-pricing schema: sync state unavailable", error);
    }
  }
  return {
    tables: QUERYABLE_TABLES.map((t) => ({
      name: t.name,
      description: t.comment,
      sortingKey: t.orderBy,
      columns: t.columns.map((col) => ({
        name: col.name,
        type: col.type,
        description: col.comment,
      })),
    })),
    notes: SCHEMA_NOTES,
    sources,
  };
}

export type ParsedInstancePricingQuery =
  { ok: true; sql: string; maxRows: number } | { ok: false; error: string };

/** The `{ sql, maxRows }` body both the route and the tool accept. */
export function parseInstancePricingQuery(
  body: { sql?: unknown; maxRows?: unknown } | null,
): ParsedInstancePricingQuery {
  if (typeof body?.sql !== "string") {
    return { ok: false, error: "`sql` is required: one read-only SELECT statement" };
  }
  const requested = body.maxRows;
  if (
    requested !== undefined &&
    (typeof requested !== "number" ||
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > MAX_QUERY_ROWS)
  ) {
    return {
      ok: false,
      error: `\`maxRows\` must be an integer from 1 to ${MAX_QUERY_ROWS}`,
    };
  }
  return { ok: true, sql: body.sql, maxRows: requested ?? DEFAULT_QUERY_ROWS };
}

/** This deployment has no `PRICING_WAREHOUSE_READ_TOKEN`. */
export class InstancePricingNotConfiguredError extends Error {
  constructor() {
    super("The instance pricing warehouse is not configured on this deployment");
    this.name = "InstancePricingNotConfiguredError";
  }
}

export async function runInstancePricingQuery(
  sql: string,
  maxRows: number,
): Promise<QueryResult & { elapsedMs: number }> {
  const config = instancePricingWarehouse();
  if (!config) throw new InstancePricingNotConfiguredError();
  const started = Date.now();
  const result = await queryWarehouse(sql, config, {
    maxRows,
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  return { ...result, elapsedMs: Date.now() - started };
}

/**
 * The HTTP status and message for a failure of {@link runInstancePricingQuery}.
 * `InstancePricingNotConfiguredError` is the caller's to handle: it is a
 * deployment problem, not a query problem.
 */
export function classifyInstancePricingError(error: unknown): {
  status: 400 | 502 | 504;
  error: string;
} {
  if (error instanceof QueryError) return { status: 400, error: error.message };
  if (error instanceof Error && error.name === "TimeoutError") {
    return { status: 504, error: "The query took longer than 30 seconds" };
  }
  if (!(error instanceof WarehouseUnavailableError)) {
    console.error("instance-pricing query failed", error);
  }
  return {
    status: 502,
    error: "The instance pricing warehouse is unavailable; try again shortly",
  };
}
