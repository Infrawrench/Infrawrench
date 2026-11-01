import { Hono, type Context } from "hono";
import {
  MAX_QUERY_ROWS as MAX_ROWS,
  QueryError,
  WarehouseUnavailableError,
  queryWarehouse,
  type WarehouseConfig,
} from "@infrawrench/server-core/aws-pricing-warehouse/query";
import {
  SCHEMA_NOTES,
  SYNC_STATE,
  TABLES,
} from "@infrawrench/server-core/aws-pricing-warehouse/schema";
import { authenticateApiRequest } from "@/auth/api-auth";

const app = new Hono();

/**
 * `/api/v1/aws-pricing`: read-only SQL over the AWS pricing warehouse, the
 * ClickHouse database behind instances.infrawrench.com's chat (tables in
 * `server-core/src/aws-pricing-warehouse/schema.ts`, loaded by the bulk
 * pricing sync).
 *
 * - `GET /schema`: every table and column with what it holds, the notes a
 *   correct query depends on, and how fresh each source is.
 * - `POST /query` `{ sql, maxRows? }`: one read-only statement's result.
 *
 * Any credential `authenticateApiRequest` accepts may call it, with no scope,
 * like `/api/v1/whoami` and `/api/v1/aws-bulk-pricing`: it is AWS's public
 * price list. The warehouse token is read-only, which is the real boundary.
 */

/** Rows a query returns unless it asks for fewer. */
const DEFAULT_ROWS = 1000;

function warehouse(): WarehouseConfig | null {
  const token = process.env["PRICING_WAREHOUSE_READ_TOKEN"];
  if (!token) return null;
  return { token, url: process.env["PRICING_WAREHOUSE_URL"] };
}

function unavailable(c: Context) {
  return c.json({ error: "The AWS pricing warehouse is not configured on this deployment" }, 503);
}

app.use("*", async (c, next) => {
  const auth = await authenticateApiRequest(c.req.raw);
  if (!auth) return c.json({ error: "Unauthorized" }, 401);
  return next();
});

app.get("/schema", async (c) => {
  const config = warehouse();
  // Freshness is a bonus: the schema itself never depends on the warehouse.
  let sources: unknown[] | null = null;
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
      console.warn("aws-pricing schema: sync state unavailable", error);
    }
  }
  return c.json(
    {
      tables: TABLES.map((t) => ({
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
    },
    200,
    { "cache-control": "private, max-age=300" },
  );
});

app.post("/query", async (c) => {
  const config = warehouse();
  if (!config) return unavailable(c);
  const body = (await c.req.json().catch(() => null)) as {
    sql?: unknown;
    maxRows?: unknown;
  } | null;
  if (typeof body?.sql !== "string") {
    return c.json({ error: "`sql` is required: one read-only SELECT statement" }, 400);
  }
  const requested = body.maxRows;
  if (
    requested !== undefined &&
    (typeof requested !== "number" ||
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > MAX_ROWS)
  ) {
    return c.json({ error: `\`maxRows\` must be an integer from 1 to ${MAX_ROWS}` }, 400);
  }
  const started = Date.now();
  try {
    const result = await queryWarehouse(body.sql, config, {
      maxRows: requested ?? DEFAULT_ROWS,
      timeoutMs: 30_000,
    });
    return c.json({ ...result, elapsedMs: Date.now() - started }, 200, {
      "cache-control": "private, no-store",
    });
  } catch (error) {
    if (error instanceof QueryError) return c.json({ error: error.message }, 400);
    if (error instanceof Error && error.name === "TimeoutError") {
      return c.json({ error: "The query took longer than 30 seconds" }, 504);
    }
    if (!(error instanceof WarehouseUnavailableError))
      console.error("aws-pricing query failed", error);
    return c.json({ error: "The AWS pricing warehouse is unavailable; try again shortly" }, 502);
  }
});

export { app as awsPricingRoutes };
