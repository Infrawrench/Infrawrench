/**
 * Streaming row source for scheduled cost exports.
 *
 * Everything else in `clickhouse/cost-readers.ts` returns an array, because
 * everything else draws a graph: a few hundred aggregated points. An export is
 * the opposite shape — a year of daily per-resource rows for a large estate is
 * millions of rows, and `await rs.json()` on that is a poller-wide OOM, not a
 * slow request.
 *
 * So this module never materialises a result. `@clickhouse/client` (v1, Node
 * build) exposes `ResultSet.stream()`, a `Readable` in object mode that emits
 * arrays of `Row` as they arrive off the socket; {@link streamCostExportRows}
 * wraps it in an async generator and yields one decoded row at a time. Nothing
 * upstream of the destination sink ever holds more than one chunk.
 *
 * The query still carries an explicit `ORDER BY` over the full grouping key.
 * That is not for the database's benefit — it is so two runs of the same period
 * produce byte-identical objects, which is what makes "the key was overwritten"
 * a verifiable claim rather than a hope. If a future client build ever drops
 * `stream()`, that same total order is what a fallback keyset pager would need,
 * and it is already there.
 */
import type { CostBasis, CostChargeType, CostFilter } from "@infrawrench/client-core";
import { getClickHouseClient, isClickHouseConfigured } from "../clickhouse/client";

/** The column set an export emits, in order. Drives both the header and each row. */
export interface CostExportColumns {
  /** Dimension columns kept in the output, in the order the user chose. */
  dimensions: string[];
  /** `tag_<key>` columns, one per requested tag key. */
  tagColumns: string[];
}

export interface CostExportRowQuery {
  organizationId: string;
  from: string;
  to: string;
  /** Row-identity dimensions to keep. Empty aggregates everything but day+currency. */
  dimensions: string[];
  /** Tag keys to emit as their own columns. */
  tagKeys: string[];
  filters: CostFilter[];
  chargeTypes?: CostChargeType[] | undefined;
  costBasis?: CostBasis | undefined;
}

/** One output row, already flattened to strings/numbers. */
export type CostExportRow = Record<string, string | number>;

/**
 * SQL expression for a dimension. Mirrors `cost-readers.ts#dimensionExpr` —
 * restated rather than exported from there because the export needs the column
 * *name* alongside the expression, and the two vocabularies must stay pinned to
 * the same `CostDimensionId` union either way.
 */
function dimensionExpr(dimension: string): string {
  switch (dimension) {
    case "provider":
      return "plugin_id";
    case "account":
      return "account_id";
    case "service":
      return "service";
    case "region":
      return "region";
    case "resource":
      return "resource_id";
    case "charge_type":
      return "charge_type";
    case "commitment":
      return "commitment_id";
    // `tag` is not a column — a tag export names its keys in `tagKeys`, which
    // become their own columns. Selecting the bare dimension would ask "which
    // tag?" with no answer, so it is dropped.
    default:
      return "";
  }
}

/** Column name for a dimension in the output. Same string the UI shows. */
function dimensionColumn(dimension: string): string {
  return dimension === "provider" ? "provider" : dimension;
}

/** The amount expression, matching `cost-readers.ts#amountExpr` exactly. */
function amountExpr(basis: CostBasis | undefined): string {
  return basis === "amortized" ? "if(amortized_amount != 0, amortized_amount, amount)" : "amount";
}

/** Sanitise a tag key into a column name a CSV header and a warehouse both accept. */
export function tagColumnName(key: string): string {
  return `tag_${key.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Resolve the output column layout for a query, dropping anything unusable. */
export function resolveColumns(q: { dimensions: string[]; tagKeys: string[] }): CostExportColumns {
  const dimensions = q.dimensions.filter((d) => dimensionExpr(d) !== "").map(dimensionColumn);
  return {
    dimensions: [...new Set(dimensions)],
    tagColumns: [...new Set(q.tagKeys.map(tagColumnName))],
  };
}

interface BuiltQuery {
  sql: string;
  params: Record<string, unknown>;
  columns: CostExportColumns;
}

/** Assemble the SELECT. Exported for the tests that assert its shape. */
export function buildCostExportQuery(q: CostExportRowQuery): BuiltQuery {
  const params: Record<string, unknown> = { orgId: q.organizationId, from: q.from, to: q.to };
  const where = [
    "organization_id = {orgId:String}",
    "day >= toDate({from:String})",
    "day <= toDate({to:String})",
  ];

  q.filters.forEach((f, i) => {
    const expr =
      f.dimension === "tag"
        ? (() => {
            params[`ftag${i}`] = f.tagKey ?? "";
            return `tags[{ftag${i}:String}]`;
          })()
        : dimensionExpr(f.dimension);
    if (!expr) return;
    params[`fvals${i}`] = f.values;
    where.push(`${expr} ${f.op === "in" ? "IN" : "NOT IN"} {fvals${i}:Array(String)}`);
  });

  if (q.chargeTypes && q.chargeTypes.length > 0) {
    params["chargeTypes"] = q.chargeTypes;
    where.push("charge_type IN {chargeTypes:Array(String)}");
  }

  const columns = resolveColumns(q);
  const dimSelect = q.dimensions
    .filter((d) => dimensionExpr(d) !== "")
    .map((d) => `${dimensionExpr(d)} AS ${dimensionColumn(d)}`);
  const tagSelect = q.tagKeys.map((key, i) => {
    params[`tk${i}`] = key;
    return `tags[{tk${i}:String}] AS ${tagColumnName(key)}`;
  });

  const groupKeys = ["day", ...columns.dimensions, ...columns.tagColumns, "currency"];

  const sql = `SELECT toString(day) AS day,
            ${[...dimSelect, ...tagSelect].map((s) => `${s},`).join("\n            ")}
            currency,
            sum(${amountExpr(q.costBasis)}) AS amount,
            sum(usage_amount) AS usage_amount,
            -- Usage units only mean something when the grouped rows agree on
            -- one. Summing hours and gigabytes into a single number and then
            -- labelling it "hours" would be a lie a warehouse cannot detect,
            -- so a mixed group reports its total with no unit at all.
            if(uniqExact(usage_unit) = 1, any(usage_unit), '') AS usage_unit
     FROM cost_daily FINAL
     WHERE ${where.join(" AND ")}
     GROUP BY ${groupKeys.join(", ")}
     ORDER BY ${groupKeys.join(", ")}`;

  return { sql, params, columns };
}

/**
 * Stream one period's rows out of ClickHouse.
 *
 * Yields decoded row objects one at a time. Back-pressure is the consumer's
 * `for await` — the underlying `Readable` stays paused while the destination
 * sink is busy uploading a part, so a slow bucket throttles the query rather
 * than filling the heap.
 *
 * Returns nothing at all when ClickHouse is unconfigured, matching every other
 * cost reader: an unconfigured deployment has no cost history to export.
 */
export async function* streamCostExportRows(
  q: CostExportRowQuery,
): AsyncGenerator<CostExportRow, void, undefined> {
  if (!isClickHouseConfigured()) return;
  const { sql, params } = buildCostExportQuery(q);
  const rs = await getClickHouseClient().query({
    query: sql,
    query_params: params,
    format: "JSONEachRow",
  });

  const stream = rs.stream();
  try {
    for await (const chunk of stream) {
      for (const row of chunk) {
        yield row.json<CostExportRow>();
      }
    }
  } finally {
    // Releasing the result set closes the underlying socket if the consumer
    // bailed out early (an upload failure aborts the whole run) — otherwise a
    // failed export would leak a ClickHouse connection per attempt.
    try {
      await rs.close();
    } catch {
      // Already closed, or the socket died with the query. Nothing to do.
    }
  }
}
