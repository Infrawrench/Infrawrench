/**
 * Streaming row source for scheduled cost exports.
 *
 * Everything else in `analytics/cost-readers.ts` returns an array, because
 * everything else draws a graph: a few hundred aggregated points. An export is
 * the opposite shape: a year of daily per-resource rows for a large estate is
 * millions of rows, and materialising that result is a poller-wide OOM, not a
 * slow request.
 *
 * So this module never materialises a result. It reads through a postgres.js
 * cursor ({@link streamExportQuery}), which fetches a bounded batch of rows per
 * round trip, and yields one row at a time. Nothing upstream of the
 * destination sink ever holds more than one batch.
 *
 * The query still carries an explicit `ORDER BY` over the full grouping key.
 * That is not for the database's benefit: it is so two runs of the same period
 * produce byte-identical objects, which is what makes "the key was overwritten"
 * a verifiable claim rather than a hope.
 */
import type { CostBasis, CostChargeType, CostFilter } from "@infrawrench/client-core";
import { and, asc, inArray, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { getAnalyticsDb } from "../analytics/client";
import {
  costBasisAmountExpr,
  costDailyOrgCondition,
  dayRange,
  membershipCondition,
  resolveVirtualTags,
} from "../analytics/cost-readers";
import { tagValueExpr } from "../analytics/cost-sql";
import { costDaily } from "../analytics/schema";
import {
  VirtualTagScope,
  withVirtualTagJoins,
  type VirtualTagDefinitions,
} from "../analytics/virtual-tag-sql";

/** The column set an export emits, in order. Drives both the header and each row. */
export interface CostExportColumns {
  /** Dimension columns kept in the output, in the order the user chose. */
  dimensions: string[];
  /** `tag_<key>` columns, one per requested tag key. */
  tagColumns: string[];
  /**
   * `vtag_<key>` columns, one per requested virtual tag key. Optional so a
   * layout built before virtual tags existed still describes its file.
   */
  virtualTagColumns?: string[];
}

export interface CostExportRowQuery {
  organizationId: string;
  from: string;
  to: string;
  /** Row-identity dimensions to keep. Empty aggregates everything but day+currency. */
  dimensions: string[];
  /** Tag keys to emit as their own columns. */
  tagKeys: string[];
  /** Virtual tag keys to emit as their own `vtag_<key>` columns. */
  virtualTagKeys?: string[] | undefined;
  filters: CostFilter[];
  /**
   * The virtual tags the columns and filters reference, compiled for the
   * period. {@link streamCostExportRows} resolves them; the builder needs
   * them handed in because it is synchronous.
   */
  virtualTags?: VirtualTagDefinitions | undefined;
  chargeTypes?: CostChargeType[] | undefined;
  costBasis?: CostBasis | undefined;
}

/** One output row, already flattened to strings/numbers. */
export type CostExportRow = Record<string, string | number>;

/**
 * The column a dimension reads from. Mirrors `cost-readers.ts#dimensionExpr`:
 * restated rather than exported from there because the export needs the column
 * *name* alongside the expression, and the two vocabularies must stay pinned to
 * the same `CostDimensionId` union either way.
 *
 * `tag` returns nothing on purpose: it is not a column, and a tag export names
 * its keys in `tagKeys`, which become their own columns. Selecting the bare
 * dimension would ask "which tag?" with no answer, so it is dropped.
 */
function dimensionExpr(dimension: string): SQL | undefined {
  switch (dimension) {
    case "provider":
      return sql`${costDaily.plugin_id}`;
    case "account":
      return sql`${costDaily.account_id}`;
    case "service":
      return sql`${costDaily.service}`;
    case "region":
      return sql`${costDaily.region}`;
    case "resource":
      return sql`${costDaily.resource_id}`;
    case "charge_type":
      return sql`${costDaily.charge_type}`;
    case "commitment":
      return sql`${costDaily.commitment_id}`;
    default:
      return undefined;
  }
}

/** Column name for a dimension in the output. Same string the UI shows. */
function dimensionColumn(dimension: string): string {
  return dimension === "provider" ? "provider" : dimension;
}

/**
 * The amount expression. Imported from `cost-readers.ts` rather than restated:
 * an export is the artefact someone reconciles a graph against, so the two must
 * be the same arithmetic by construction. A restated copy silently drifted once
 * already: it kept the pre-`amortized_reported` form, which reads a commitment
 * purchase's honest amortized zero as "not reported" and falls back to full
 * cash, so an amortized export double-counted every purchase against its own
 * amortized slices while the graph beside it did not.
 */
function amountExpr(basis: CostBasis | undefined): SQL {
  return costBasisAmountExpr(basis);
}

/** Sanitise a tag key into a column name a CSV header and a warehouse both accept. */
export function tagColumnName(key: string): string {
  return `tag_${key.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Sanitise a virtual tag key into its `vtag_<key>` column name. */
export function virtualTagColumnName(key: string): string {
  return `vtag_${key.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Resolve the output column layout for a query, dropping anything unusable. */
export function resolveColumns(q: {
  dimensions: string[];
  tagKeys: string[];
  virtualTagKeys?: string[] | undefined;
}): CostExportColumns {
  const dimensions = q.dimensions.filter((d) => dimensionExpr(d)).map(dimensionColumn);
  const virtualTagColumns = [...new Set((q.virtualTagKeys ?? []).map(virtualTagColumnName))];
  return {
    dimensions: [...new Set(dimensions)],
    tagColumns: [...new Set(q.tagKeys.map(tagColumnName))],
    ...(virtualTagColumns.length > 0 ? { virtualTagColumns } : {}),
  };
}

/** Virtual tag keys an export query references, in its columns or its filters. */
export function exportVirtualTagKeys(q: {
  virtualTagKeys?: string[] | undefined;
  filters: CostFilter[];
}): string[] {
  const keys = new Set(q.virtualTagKeys ?? []);
  for (const f of q.filters) if (f.dimension === "virtual_tag" && f.tagKey) keys.add(f.tagKey);
  return [...keys];
}

/** A finished export statement: its text and the values bound into it. */
export interface ExportStatement {
  sql: string;
  params: unknown[];
}

interface BuiltQuery extends ExportStatement {
  columns: CostExportColumns;
}

/** The expression a tag column reads from: the tag's value, `''` when absent. */
function tagExpr(key: string): SQL {
  return tagValueExpr(key);
}

/**
 * The WHERE clause every export reads under: the org, the period, the saved
 * filters and the charge types. Shared by the native and the FOCUS query so
 * "filtered to account X" selects the same rows whichever columns they are
 * written as.
 */
export function costExportScope(
  q: {
    organizationId: string;
    from: string;
    to: string;
    filters: CostFilter[];
    chargeTypes?: CostChargeType[] | undefined;
  },
  scope?: VirtualTagScope,
): SQL | undefined {
  return and(
    costDailyOrgCondition(q.organizationId),
    dayRange(q.from, q.to),
    ...q.filters.flatMap((f) => {
      // A virtual tag filter is compiled, never dropped: dropping it would
      // export spend outside the scope the export was configured for. A
      // reader that cannot join virtual tags (the FOCUS layout) refuses it.
      if (f.dimension === "virtual_tag") {
        if (!f.tagKey) throw new Error("A virtual tag filter needs a key");
        if (!scope) {
          throw new Error(
            "FOCUS exports cannot filter by a virtual tag yet. Use Infrawrench columns, or filter by the tags it is built from.",
          );
        }
        return [membershipCondition(scope.value(f.tagKey), f.op, f.values)];
      }
      const expr = f.dimension === "tag" ? tagExpr(f.tagKey ?? "") : dimensionExpr(f.dimension);
      return expr ? [membershipCondition(expr, f.op, f.values)] : [];
    }),
    q.chargeTypes && q.chargeTypes.length > 0
      ? inArray(costDaily.charge_type, q.chargeTypes)
      : undefined,
  );
}

/**
 * Assemble the SELECT. Exported for the tests that assert its shape.
 *
 * Built with the query builder, then rendered to text and parameters: the
 * streaming read below needs a cursor, which is on the driver rather than on
 * Drizzle, so this hands the driver a finished statement. Values are bound
 * parameters, not interpolation: the only thing assembled by hand here is the
 * *column list*, whose names come from `tagColumnName`.
 */
export function buildCostExportQuery(q: CostExportRowQuery): BuiltQuery {
  const columns = resolveColumns(q);
  const scope = new VirtualTagScope(q.virtualTags);

  const dimSelect = Object.fromEntries(
    q.dimensions
      .flatMap((d) => {
        const expr = dimensionExpr(d);
        return expr ? [[dimensionColumn(d), expr.as(dimensionColumn(d))] as const] : [];
      })
      // A dimension listed twice is one column, and `Object.fromEntries` would
      // keep the last of the duplicates rather than erroring: this makes the
      // projection agree with `resolveColumns`, which de-duplicates too.
      .filter(([name], i, all) => all.findIndex(([n]) => n === name) === i),
  );
  const tagSelect = Object.fromEntries(
    q.tagKeys.map((key) => [tagColumnName(key), tagExpr(key).as(tagColumnName(key))]),
  );
  const virtualTagSelect = Object.fromEntries(
    [...new Set(q.virtualTagKeys ?? [])].map((key) => [
      virtualTagColumnName(key),
      scope.value(key).as(virtualTagColumnName(key)),
    ]),
  );
  // Built before the money below: a filter on a split tag joins it, and the
  // weights must include every join.
  const where = costExportScope(q, scope);

  // Grouped and ordered by the *output* column names, which for tag columns are
  // the sanitised `tag_<key>` aliases rather than the map lookup itself. Where a
  // name is also a column (`day`, `service`, `currency`), Postgres groups by the
  // column, which is the same grouping. Quoted, so a dimension named like a
  // keyword cannot change the statement's meaning.
  const groupKeys = [
    "day",
    ...columns.dimensions,
    ...columns.tagColumns,
    ...(columns.virtualTagColumns ?? []),
    "currency",
  ].map((name) => sql`${sql.identifier(name)}`);

  // Weighted after every virtual tag expression above has been built: a split
  // tag's share weight multiplies both measures, so a divided row's shares sum
  // back to exactly the collected row.
  const amount = scope.weighted(amountExpr(q.costBasis));
  const usage = scope.weighted(sql`${costDaily.usage_amount}`);
  const builder = new QueryBuilder()
    .select({
      day: sql<string>`to_char(${costDaily.day}, 'YYYY-MM-DD')`.as("day"),
      ...dimSelect,
      ...tagSelect,
      ...virtualTagSelect,
      currency: costDaily.currency,
      amount: sql<number>`sum(${amount})`.as("amount"),
      usage_amount: sql<number>`sum(${usage})`.as("usage_amount"),
      // Usage units only mean something when the grouped rows agree on one.
      // Summing hours and gigabytes into a single number and then labelling it
      // "hours" would be a lie a warehouse cannot detect, so a mixed group
      // reports its total with no unit at all.
      usage_unit:
        sql<string>`CASE WHEN count(DISTINCT ${costDaily.usage_unit}) = 1 THEN min(${costDaily.usage_unit}) ELSE '' END`.as(
          "usage_unit",
        ),
    })
    .from(costDaily)
    .$dynamic();
  const query = withVirtualTagJoins(builder, scope)
    .where(where)
    .groupBy(...groupKeys)
    .orderBy(...groupKeys.map((key) => asc(key)));

  const { sql: text, params } = query.toSQL();
  return { sql: text, params, columns };
}

/**
 * Stream one period's rows out of `cost_daily`.
 *
 * Yields decoded row objects one at a time. Back-pressure is the consumer's
 * `for await`: the cursor fetches its next batch only once the destination
 * sink has taken the last one, so a slow bucket throttles the query rather
 * than filling the heap.
 */
export async function* streamCostExportRows(
  q: CostExportRowQuery,
): AsyncGenerator<CostExportRow, void, undefined> {
  const virtualTags = await resolveVirtualTags(
    q.organizationId,
    exportVirtualTagKeys(q),
    q.from,
    q.to,
    q.virtualTags,
  );
  yield* streamExportQuery<CostExportRow>(buildCostExportQuery({ ...q, virtualTags }));
}

/** Rows a cursor fetches per round trip: the most an export holds at once. */
const EXPORT_CURSOR_BATCH = 1000;

/**
 * Stream a finished export statement's rows, one decoded object at a time.
 * The native and the FOCUS readers both go through here, so both get the same
 * back-pressure and the same cleanup on an early exit.
 *
 * Through the postgres.js client underneath Drizzle, because Drizzle has no
 * cursor. Leaving the loop early (an upload failure aborts the whole run)
 * closes the cursor and hands its connection back to the pool.
 */
export async function* streamExportQuery<T>(
  statement: ExportStatement,
): AsyncGenerator<T, void, undefined> {
  const client = getAnalyticsDb().$client;
  const cursor = client
    .unsafe(statement.sql, statement.params as never[])
    .cursor(EXPORT_CURSOR_BATCH);
  for await (const batch of cursor) {
    for (const row of batch) yield row as T;
  }
}
