/**
 * Warehouse destinations for cost exports: the host half.
 *
 * A warehouse destination names a connected account of a plugin that declares
 * `manifest.warehouseSink` (Snowflake, Databricks) plus the plugin's own
 * target fields. Everything that knows a warehouse (pickers, DDL, staging,
 * the atomic per-period replace, the GRANT statements) lives in that plugin;
 * this file only:
 *
 *   * validates a destination against the plugin's declared fields and the
 *     org's accounts,
 *   * types the export's columns in the portable vocabulary
 *     ({@link warehouseColumns}) and turns rows into cells,
 *   * resolves the account's client and hands the plugin one period at a time.
 *
 * There are no credentials on the export: the account's stored credentials do
 * the loading, so rotating them in Accounts is the only rotation there is.
 */
import { and, eq, inArray } from "drizzle-orm";
import type {
  CostExportWarehouseDestination,
  CostExportWarehouseOption,
  CostExportWarehouseSetup,
  CostExportWarehouseSink,
} from "@infrawrench/client-core";
import { COST_EXPORT_BASE_COLUMNS, COST_EXPORT_PROVENANCE_COLUMNS } from "@infrawrench/client-core";
import type {
  PluginClient,
  WarehouseCell,
  WarehouseColumn,
  WarehouseColumnType,
  WarehouseSinkDeclaration,
} from "@infrawrench/plugin-base";
import { db } from "../db/client";
import { accounts } from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";
import { getPlugin, loadPlugins } from "../plugin-loader";
import type { CostExportColumns, CostExportRow } from "./rows";
import type { ProvenanceStamp } from "./serialize";

/** Thrown for a destination the caller got wrong; the API maps it to 400. */
export class WarehouseDestinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarehouseDestinationError";
  }
}

const TARGET_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TARGET_VALUE = 255;

/**
 * Shape-check a warehouse destination. Synchronous and DB-free, so the store's
 * normaliser can call it; {@link assertWarehouseDestination} does the checks
 * that need the plugin registry and the org's accounts.
 */
export function normalizeWarehouseDestination(
  raw: Record<string, unknown>,
): CostExportWarehouseDestination {
  const pluginId = String(raw["pluginId"] ?? "").trim();
  if (!PLUGIN_ID.test(pluginId)) {
    throw new WarehouseDestinationError("destination.pluginId is required");
  }
  const accountId = String(raw["accountId"] ?? "").trim();
  if (!accountId || accountId.length > 128) {
    throw new WarehouseDestinationError("destination.accountId is required");
  }
  const rawTarget = raw["target"];
  if (rawTarget !== undefined && (typeof rawTarget !== "object" || Array.isArray(rawTarget))) {
    throw new WarehouseDestinationError("destination.target must be an object of strings");
  }
  const target: Record<string, string> = {};
  for (const [key, value] of Object.entries((rawTarget ?? {}) as Record<string, unknown>)) {
    if (!TARGET_KEY.test(key)) {
      throw new WarehouseDestinationError(`destination.target has an invalid key "${key}"`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== "string") {
      throw new WarehouseDestinationError(`destination.target.${key} must be a string`);
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_TARGET_VALUE) {
      throw new WarehouseDestinationError(
        `destination.target.${key} must be ${MAX_TARGET_VALUE} characters or fewer`,
      );
    }
    if (/[\u0000-\u001f]/.test(trimmed)) {
      throw new WarehouseDestinationError(`destination.target.${key} contains control characters`);
    }
    if (trimmed) target[key] = trimmed;
  }
  return { kind: "warehouse", pluginId, accountId, target };
}

async function sinkFor(pluginId: string): Promise<WarehouseSinkDeclaration> {
  const loaded = await getPlugin(pluginId);
  const sink = loaded?.plugin.manifest.warehouseSink;
  if (!sink) {
    throw new WarehouseDestinationError(
      `"${pluginId}" cannot be a warehouse destination. Choose Snowflake or Databricks.`,
    );
  }
  return sink;
}

async function accountOf(
  organizationId: string,
  accountId: string,
): Promise<{ id: string; pluginId: string; displayName: string } | null> {
  const [row] = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId, displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/**
 * Full validation: the plugin is a warehouse sink, the account is the org's
 * and belongs to that plugin, every required field is filled, and no key
 * outside the declared fields is present.
 */
export async function assertWarehouseDestination(
  organizationId: string,
  dest: CostExportWarehouseDestination,
): Promise<CostExportWarehouseDestination> {
  const sink = await sinkFor(dest.pluginId);
  const account = await accountOf(organizationId, dest.accountId);
  if (!account || account.pluginId !== dest.pluginId) {
    throw new WarehouseDestinationError(
      `destination.accountId is not a connected ${dest.pluginId} account in this organization`,
    );
  }
  const known = new Set(sink.targetFields.map((f) => f.key));
  for (const key of Object.keys(dest.target)) {
    // Refused rather than dropped: a client (Terraform especially) that sent a
    // key and reads back a target without it would see a diff it cannot fix.
    if (!known.has(key)) {
      throw new WarehouseDestinationError(
        `destination.target.${key} is not a ${dest.pluginId} target field (expected ${[...known].join(", ")})`,
      );
    }
  }
  const target: Record<string, string> = {};
  for (const field of sink.targetFields) {
    const value = dest.target[field.key];
    if (value) target[field.key] = value;
    else if (!field.optional) {
      throw new WarehouseDestinationError(`Choose a ${field.label.toLowerCase()} for this export`);
    }
  }
  return { ...dest, target };
}

/** Every warehouse-capable plugin, with the org's accounts of each. */
export async function listWarehouseSinks(
  organizationId: string,
): Promise<CostExportWarehouseSink[]> {
  const plugins = (await loadPlugins()).filter((p) => p.plugin.manifest.warehouseSink);
  if (plugins.length === 0) return [];
  const ids = plugins.map((p) => p.plugin.manifest.id);
  const rows = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId, displayName: accounts.displayName })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), inArray(accounts.pluginId, ids)))
    .orderBy(accounts.displayName);
  return plugins.map(({ plugin }) => {
    const sink = plugin.manifest.warehouseSink!;
    return {
      pluginId: plugin.manifest.id,
      displayName: plugin.manifest.displayName,
      label: sink.label,
      description: sink.description ?? null,
      targetFields: sink.targetFields.map((f) => ({
        key: f.key,
        label: f.label,
        description: f.description ?? null,
        dependsOn: f.dependsOn ?? [],
        optional: f.optional === true,
        allowCustom: f.allowCustom === true,
        placeholder: f.placeholder ?? null,
        emptyLabel: f.emptyLabel ?? null,
      })),
      accounts: rows
        .filter((r) => r.pluginId === plugin.manifest.id)
        .map((r) => ({ id: r.id, name: r.displayName })),
    };
  });
}

/** Resolve the account's client and check it can load. */
async function sinkClient(
  organizationId: string,
  accountId: string,
): Promise<{ client: PluginClient; pluginId: string; sink: WarehouseSinkDeclaration }> {
  const resolved = await getOrgAccountClient(accountId, organizationId);
  if (!resolved) {
    throw new WarehouseDestinationError(
      "The connected account this export loads through no longer exists. Pick another account.",
    );
  }
  const sink = resolved.plugin.manifest.warehouseSink;
  if (!sink || !resolved.client.loadWarehouseRows) {
    throw new WarehouseDestinationError(
      `"${resolved.plugin.manifest.displayName}" accounts cannot be a warehouse destination`,
    );
  }
  return { client: resolved.client, pluginId: resolved.plugin.manifest.id, sink };
}

function cleanTarget(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (TARGET_KEY.test(k) && typeof v === "string" && v.trim()) {
      out[k] = v.trim().slice(0, MAX_TARGET_VALUE);
    }
  }
  return out;
}

/** Picker options for one target field, read live from the provider. */
export async function listWarehouseOptions(
  organizationId: string,
  accountId: string,
  field: string,
  target: unknown,
): Promise<CostExportWarehouseOption[]> {
  const { client, sink } = await sinkClient(organizationId, accountId);
  if (!sink.targetFields.some((f) => f.key === field)) {
    throw new WarehouseDestinationError(`Unknown target field "${field}"`);
  }
  if (!client.listWarehouseTargetOptions) return [];
  const options = await client.listWarehouseTargetOptions(accountId, field, cleanTarget(target));
  return options.slice(0, 2_000).map((o) => ({
    id: o.id,
    label: o.label,
    ...(o.description ? { description: o.description } : {}),
  }));
}

/** The least-privilege grants for a target, from the plugin. */
export async function describeWarehouseSetup(
  organizationId: string,
  accountId: string,
  target: unknown,
): Promise<CostExportWarehouseSetup> {
  const { client } = await sinkClient(organizationId, accountId);
  if (!client.describeWarehouseSetup) return { sql: "", notes: [] };
  return await client.describeWarehouseSetup(accountId, cleanTarget(target));
}

/* ------------------------------------------------------------------ *
 * Column mapping
 * ------------------------------------------------------------------ */

/**
 * Column types by name. Covers the native layout and the FOCUS layout's names
 * so either column list maps without a second table; anything unlisted falls
 * through to {@link inferredType}, then `string`.
 */
const COLUMN_TYPES: Record<string, WarehouseColumnType> = {
  export_id: "string",
  period_start: "date",
  day: "date",
  amount: "decimal",
  usage_amount: "decimal",
  exported_at: "timestamp",
  collection_watermark: "date",
  // FOCUS custom columns that do not follow the naming rules below.
  Tags: "json",
  x_CostEstimated: "boolean",
  x_ExportedAt: "timestamp",
  x_CollectionWatermark: "date",
};

/** FOCUS naming conventions: `*Cost` and `*Quantity` are numbers, `*PeriodStart/End` instants. */
function inferredType(name: string): WarehouseColumnType | null {
  if (/^[A-Za-z_]*(Cost|Quantity)$/.test(name)) return "decimal";
  if (/(PeriodStart|PeriodEnd)$/.test(name)) return "timestamp";
  return null;
}

export function warehouseColumnType(name: string): WarehouseColumnType {
  return COLUMN_TYPES[name] ?? inferredType(name) ?? "string";
}

/** The native layout's typed columns: `export_id`, `period_start`, then the object's own columns. */
export function warehouseColumns(columns: CostExportColumns): WarehouseColumn[] {
  return [
    "export_id",
    "period_start",
    "day",
    ...columns.dimensions,
    ...columns.tagColumns,
    ...COST_EXPORT_BASE_COLUMNS,
    ...COST_EXPORT_PROVENANCE_COLUMNS,
  ].map((name) => ({ name, type: warehouseColumnType(name) }));
}

function cell(value: unknown, type: WarehouseColumnType): WarehouseCell {
  if (value === undefined || value === null) return null;
  if (type === "decimal") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") return value === true || value === "true" || value === 1;
  if (type !== "string" && type !== "json" && value === "") return null;
  return typeof value === "number" ? value : String(value);
}

/** Turn a stream of export rows into cells in {@link warehouseColumns} order. */
export async function* warehouseCells(
  rows: AsyncIterable<CostExportRow>,
  columns: WarehouseColumn[],
  fixed: { exportId: string; periodStart: string; stamp: ProvenanceStamp },
): AsyncGenerator<WarehouseCell[], void, undefined> {
  for await (const row of rows) {
    yield columns.map((c) => {
      switch (c.name) {
        case "export_id":
          return fixed.exportId;
        case "period_start":
          return fixed.periodStart;
        case "exported_at":
          return fixed.stamp.exportedAt;
        case "collection_watermark":
          return fixed.stamp.collectionWatermark || null;
        default:
          return cell(row[c.name], c.type);
      }
    });
  }
}

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

export interface WarehouseLoader {
  load(args: {
    columns: WarehouseColumn[];
    rows: AsyncIterable<WarehouseCell[]>;
    exportId: string;
    from: string;
    to: string;
  }): Promise<{ rowCount: number; table: string }>;
}

/**
 * Open the account's client once per run and return a per-period loader.
 * Throws {@link WarehouseDestinationError} when the account or plugin is gone.
 */
export async function openWarehouseLoader(
  organizationId: string,
  dest: CostExportWarehouseDestination,
): Promise<WarehouseLoader> {
  const { client, pluginId } = await sinkClient(organizationId, dest.accountId);
  if (pluginId !== dest.pluginId) {
    throw new WarehouseDestinationError(
      "The connected account this export loads through belongs to a different provider now. Pick another account.",
    );
  }
  return {
    load: async ({ columns, rows, exportId, from, to }) =>
      await client.loadWarehouseRows!(dest.accountId, {
        target: dest.target,
        columns,
        rows,
        replace: {
          scopeColumn: "export_id",
          scopeValue: exportId,
          dayColumn: "day",
          from,
          to,
        },
      }),
  };
}
