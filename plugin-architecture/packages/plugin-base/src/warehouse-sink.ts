/**
 * Warehouse sinks: a plugin that can load rows into a table in the provider's
 * own warehouse (Snowflake, Databricks) declares `manifest.warehouseSink` and
 * implements {@link PluginClient.loadWarehouseRows} plus the two picker/setup
 * helpers. The host's scheduled cost exports use it as a destination type; the
 * host knows nothing about any warehouse's SQL dialect, staging strategy or
 * permission model, all of which stays in the plugin.
 *
 * The contract is the smallest one that lets the host stay generic:
 *
 * - **Target fields** describe what the user picks (a warehouse, a database, a
 *   table…). The host renders them as cascading pickers filled by
 *   {@link PluginClient.listWarehouseTargetOptions} and stores the answers as a
 *   flat `Record<string, string>`; it never interprets them.
 * - **Columns** arrive already typed in a small portable vocabulary
 *   ({@link WarehouseColumnType}); each plugin maps that onto its own types.
 * - **Replace scope** is the idempotency key: every load atomically removes the
 *   rows matching `scopeColumn = scopeValue AND dayColumn BETWEEN from AND to`
 *   and inserts the new ones, so re-delivering a period (a restatement, a
 *   retry, a lease that expired mid-run) replaces rather than duplicates. A
 *   load that fails part-way must leave the table exactly as it was.
 */

/**
 * Portable column types. Plugins map these onto native types; `decimal` is a
 * fixed-point number wide enough for money (at least 38 digits, 10 after the
 * point), `json` is a semi-structured value (Snowflake `VARIANT`, Databricks
 * `STRING` holding JSON, or `VARIANT` where available).
 */
export type WarehouseColumnType = "string" | "date" | "timestamp" | "decimal" | "boolean" | "json";

export interface WarehouseColumn {
  /** Column name as the host emits it (`snake_case` or a FOCUS PascalCase name). */
  name: string;
  type: WarehouseColumnType;
}

/** One cell. Dates are `YYYY-MM-DD`, timestamps ISO 8601, json a serialised string. */
export type WarehouseCell = string | number | boolean | null;

/** A field the user fills to choose where rows land. */
export interface WarehouseTargetField {
  /** Key in the stored target, e.g. `database`. */
  key: string;
  label: string;
  description?: string;
  /** Keys whose values must be chosen before this field can list options. */
  dependsOn?: string[];
  /** May be left empty (the plugin then uses a default, e.g. the account's warehouse). */
  optional?: boolean;
  /**
   * The user may type a value that is not among the options. Set on the table
   * field: a table that does not exist yet is created on the first run.
   */
  allowCustom?: boolean;
  placeholder?: string;
  /** Shown as the option for an empty value when `optional` is set. */
  emptyLabel?: string;
}

export interface WarehouseSinkDeclaration {
  /** Destination type label, e.g. "Snowflake table". */
  label: string;
  /** One-line explanation shown under the destination type picker. */
  description?: string;
  /** In display order; later fields usually depend on earlier ones. */
  targetFields: WarehouseTargetField[];
}

export interface WarehouseLoadRequest {
  /** The stored answers to {@link WarehouseSinkDeclaration.targetFields}. */
  target: Record<string, string>;
  /** Every column a row carries, in the order of each row's cells. */
  columns: WarehouseColumn[];
  /**
   * The rows, streamed. A plugin batches them as its API allows and must not
   * buffer the whole stream when it can avoid it.
   */
  rows: AsyncIterable<WarehouseCell[]>;
  /**
   * The slice of the table this load owns. Rows matching it are replaced
   * atomically by the streamed rows; every streamed row falls inside it.
   */
  replace: {
    /** A `string` column whose value identifies the writer, e.g. the export id. */
    scopeColumn: string;
    scopeValue: string;
    /** A `date` column bounded by `from`..`to` (inclusive, `YYYY-MM-DD`). */
    dayColumn: string;
    from: string;
    to: string;
  };
}

export interface WarehouseLoadResult {
  rowCount: number;
  /** Fully qualified table the rows landed in, for display. */
  table: string;
}

/** Least-privilege setup a user (or their admin) runs once before the first load. */
export interface WarehouseSetupGuide {
  /** Ready-to-paste statements, newline separated, with comments. */
  sql: string;
  /** Anything that is not SQL (workspace permissions, network policies). */
  notes: string[];
}
