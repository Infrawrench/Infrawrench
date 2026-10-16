/**
 * Resource reports: saved, filterable inventory tables over the synced
 * resources of every connected account, with per-resource cost beside them.
 *
 * A cost report answers "where did the money go"; a resource report answers
 * "what do we have, and what does each thing cost". It is a table, not a
 * graph: one row per synced resource, with the columns the person picked in
 * the order they picked them. The columns come from four places:
 *
 * - **core**: what every resource has (name, type, provider, account, region,
 *   status, created, provider id);
 * - **field**: a key of the resource's synced fields, offered from the
 *   resource type definitions and from the keys synced resources actually
 *   carry, never from a hardcoded list;
 * - **tag** / **vtag**: one provider tag key (the value read from the
 *   resource's own tags) or one virtual tag key (the value its own cost rows
 *   carry, see {@link RESOURCE_REPORT_COLUMN_KINDS});
 * - **cost**: spend joined from the cost store by provider resource id, over
 *   the report's date range, month to date, or the previous month.
 *
 * Everything here is pure and shared by the API (which validates and runs),
 * the editors (which validate as the API does), the CLI and the Terraform
 * provider's documented bounds. The zod schemas live in
 * `ui/src/cost/config.ts` with compile-time proofs against these types.
 */

import type { CostReportFolder } from "./cost-reports";
import type { CostBasis, CostDateRange } from "./costs";
import type { CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * Limits
 * ------------------------------------------------------------------ */

/** Bounds the API enforces; the editors and the Terraform validators mirror them. */
export const RESOURCE_REPORT_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  /** Columns one report may show. */
  maxColumns: 40,
  /** Values one list filter (providers, accounts, regions...) may hold. */
  maxFilterValues: 200,
  /** Tag conditions one report may hold. */
  maxTagFilters: 10,
  /** Virtual tag columns and conditions together: each is one cost-store read. */
  maxVirtualTagKeys: 5,
  maxNameContainsLength: 200,
  maxKeyLength: 256,
  maxValueLength: 256,
  /** Rows one page may return. */
  maxPageSize: 500,
  defaultPageSize: 50,
  /** Rows a CSV export may hold; past it the file says it was cut. */
  maxCsvRows: 50_000,
  /**
   * Resources a report evaluates in memory when a filter or the sort cannot be
   * answered by Postgres alone (tags, created date, a metadata field, cost).
   * Past it the total is a lower bound and the response says so.
   */
  maxScan: 100_000,
} as const;

/** Page sizes the table offers; any value up to the maximum is accepted. */
export const RESOURCE_REPORT_PAGE_SIZES = [25, 50, 100, 250, 500] as const;

/* ------------------------------------------------------------------ *
 * Columns
 * ------------------------------------------------------------------ */

/**
 * The column families. A column id is `<kind>:<key>`:
 *
 * - `core:<field>` one of {@link RESOURCE_REPORT_CORE_FIELDS};
 * - `field:<key>` a key of the resource's synced fields;
 * - `tag:<key>` a provider tag key, read from the resource's own tags;
 * - `vtag:<key>` a virtual tag key. Virtual tags are rules over cost rows, so
 *   a resource's value is the one its own cost rows carry over the report's
 *   cost range (the value holding the most spend when a split divides it). A
 *   resource with no cost rows has none;
 * - `cost:<window>` one of {@link RESOURCE_REPORT_COST_WINDOWS}.
 */
export const RESOURCE_REPORT_COLUMN_KINDS = ["core", "field", "tag", "vtag", "cost"] as const;
export type ResourceReportColumnKind = (typeof RESOURCE_REPORT_COLUMN_KINDS)[number];

export const RESOURCE_REPORT_CORE_FIELDS = [
  "name",
  "type",
  "provider",
  "account",
  "region",
  "status",
  "created",
  "external_id",
] as const;
export type ResourceReportCoreField = (typeof RESOURCE_REPORT_CORE_FIELDS)[number];

/** English labels; the UI translates its own and the CLI and CSV use these. */
export const RESOURCE_REPORT_CORE_FIELD_LABELS: Record<ResourceReportCoreField, string> = {
  name: "Name",
  type: "Type",
  provider: "Provider",
  account: "Account",
  region: "Region",
  status: "Status",
  created: "Created",
  external_id: "Provider ID",
};

/**
 * Cost windows: `range` is the report's own date range; `mtd` and
 * `previous_month` are calendar windows in UTC, whatever the range says.
 */
export const RESOURCE_REPORT_COST_WINDOWS = ["range", "mtd", "previous_month"] as const;
export type ResourceReportCostWindow = (typeof RESOURCE_REPORT_COST_WINDOWS)[number];

export const RESOURCE_REPORT_COST_WINDOW_LABELS: Record<ResourceReportCostWindow, string> = {
  range: "Accrued cost",
  mtd: "Month to date",
  previous_month: "Previous month",
};

/** Field keys a resource's region is read from, first non-empty wins. */
export const RESOURCE_REGION_FIELD_KEYS = ["region", "location", "zone"] as const;

/**
 * Field keys a provider creation time is read from, first parseable wins. The
 * list is the spellings synced plugins actually use, most common first. A
 * resource with none reads as created when Infrawrench first saw it.
 */
export const RESOURCE_CREATED_FIELD_KEYS = [
  "createdAt",
  "created",
  "created_at",
  "createTime",
  "createdOn",
  "created_on",
  "creationTimestamp",
  "dateCreated",
  "creationDate",
  "CreationDate",
  "createDate",
  "createdDate",
  "timeCreated",
  "creation_date",
  "launchTime",
] as const;

/** Field keys that carry tags rather than metadata (the tag-policy convention). */
export const RESOURCE_TAG_FIELD_KEYS = ["tags", "labels"] as const;

export interface ParsedResourceReportColumn {
  kind: ResourceReportColumnKind;
  key: string;
}

/** Build a column id. */
export function resourceReportColumnId(kind: ResourceReportColumnKind, key: string): string {
  return `${kind}:${key}`;
}

/** Split a column id into kind and key; null when it is not one. */
export function parseResourceReportColumn(id: string): ParsedResourceReportColumn | null {
  const idx = id.indexOf(":");
  if (idx <= 0) return null;
  const kind = id.slice(0, idx);
  const key = id.slice(idx + 1);
  if (!(RESOURCE_REPORT_COLUMN_KINDS as readonly string[]).includes(kind)) return null;
  if (key.length === 0 || key.length > RESOURCE_REPORT_LIMITS.maxKeyLength) return null;
  if (kind === "core" && !(RESOURCE_REPORT_CORE_FIELDS as readonly string[]).includes(key)) {
    return null;
  }
  if (kind === "cost" && !(RESOURCE_REPORT_COST_WINDOWS as readonly string[]).includes(key)) {
    return null;
  }
  return { kind: kind as ResourceReportColumnKind, key };
}

/** An English label for a column id, for the CLI, the CSV header and fallbacks. */
export function resourceReportColumnLabel(id: string, fieldLabel?: string | null): string {
  const parsed = parseResourceReportColumn(id);
  if (!parsed) return id;
  switch (parsed.kind) {
    case "core":
      return RESOURCE_REPORT_CORE_FIELD_LABELS[parsed.key as ResourceReportCoreField];
    case "field":
      return fieldLabel || parsed.key;
    case "tag":
      return `Tag: ${parsed.key}`;
    case "vtag":
      return `Virtual tag: ${parsed.key}`;
    case "cost":
      return RESOURCE_REPORT_COST_WINDOW_LABELS[parsed.key as ResourceReportCostWindow];
  }
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/** A tag condition: provider tags, or virtual tags (from the resource's cost rows). */
export interface ResourceReportTagFilter {
  source: "tag" | "virtual_tag";
  key: string;
  /**
   * `in` / `not_in` compare the value against `values`; `exists` / `missing`
   * ask whether the resource carries the key at all and take no values.
   */
  op: "in" | "not_in" | "exists" | "missing";
  values: string[];
}

export const RESOURCE_REPORT_TAG_OPS = ["in", "not_in", "exists", "missing"] as const;

/** One resource type, addressed by its plugin, since type ids repeat across plugins. */
export interface ResourceReportTypeRef {
  pluginId: string;
  resourceTypeId: string;
}

/**
 * What a report selects. Every list is "any of"; an empty list does not
 * filter. Conditions across fields are AND-ed.
 */
export interface ResourceReportFilters {
  pluginIds: string[];
  accountIds: string[];
  resourceTypes: ResourceReportTypeRef[];
  /** Matched exactly, as synced. */
  regions: string[];
  /** Matched ignoring case: providers spell `RUNNING` and `running`. */
  statuses: string[];
  tags: ResourceReportTagFilter[];
  /** Case-insensitive substring of the display name; null for none. */
  nameContains: string | null;
  /** Inclusive UTC days on the created column; null for open-ended. */
  createdFrom: string | null;
  createdTo: string | null;
}

export interface ResourceReportSort {
  /** A column id; it need not be one of the shown columns. */
  column: string;
  direction: "asc" | "desc";
}

export interface ResourceReportConfig {
  version: 1;
  filters: ResourceReportFilters;
  /** Shown columns, in display order. */
  columns: string[];
  /** Null is by name, ascending. */
  sort: ResourceReportSort | null;
  /** The `cost:range` window and the window virtual tag values are read over. */
  costRange: CostDateRange;
  costBasis: CostBasis;
  pageSize: number;
}

export const EMPTY_RESOURCE_REPORT_FILTERS: ResourceReportFilters = {
  pluginIds: [],
  accountIds: [],
  resourceTypes: [],
  regions: [],
  statuses: [],
  tags: [],
  nameContains: null,
  createdFrom: null,
  createdTo: null,
};

export const DEFAULT_RESOURCE_REPORT_CONFIG: ResourceReportConfig = {
  version: 1,
  filters: EMPTY_RESOURCE_REPORT_FILTERS,
  columns: ["core:name", "core:type", "core:account", "core:region", "core:status", "cost:range"],
  sort: null,
  costRange: { kind: "relative", preset: "30d" },
  costBasis: "cash",
  pageSize: RESOURCE_REPORT_LIMITS.defaultPageSize,
};

/** Create/update payload (POST/PUT /resource-reports). */
export interface ResourceReportInput {
  name: string;
  description?: string | undefined;
  config: ResourceReportConfig;
  /** A report folder (shared with cost reports); null is the top level. */
  folderId?: string | null | undefined;
}

/** A saved report as the API returns it. */
export interface ResourceReport {
  id: string;
  name: string;
  description: string | null;
  config: ResourceReportConfig;
  folderId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The virtual tag keys a config reads (columns and conditions together). */
export function resourceReportVirtualTagKeys(config: ResourceReportConfig): string[] {
  const keys = new Set<string>();
  for (const id of config.columns) {
    const parsed = parseResourceReportColumn(id);
    if (parsed?.kind === "vtag") keys.add(parsed.key);
  }
  if (config.sort) {
    const parsed = parseResourceReportColumn(config.sort.column);
    if (parsed?.kind === "vtag") keys.add(parsed.key);
  }
  for (const f of config.filters.tags) if (f.source === "virtual_tag") keys.add(f.key);
  return [...keys];
}

/** Whether a config needs anything from the cost store. */
export function resourceReportUsesCostData(config: ResourceReportConfig): boolean {
  if (resourceReportVirtualTagKeys(config).length > 0) return true;
  const ids = [...config.columns, ...(config.sort ? [config.sort.column] : [])];
  return ids.some((id) => parseResourceReportColumn(id)?.kind === "cost");
}

/**
 * Semantic problems the shape check cannot see, worded for a person. Shared by
 * the editor and the API so the form refuses exactly what the server refuses.
 * Null when the config is fine.
 */
export function resourceReportConfigError(config: ResourceReportConfig): string | null {
  const L = RESOURCE_REPORT_LIMITS;
  if (config.columns.length === 0) return "Pick at least one column.";
  if (config.columns.length > L.maxColumns) return `At most ${L.maxColumns} columns.`;
  const seen = new Set<string>();
  for (const id of config.columns) {
    if (!parseResourceReportColumn(id)) return `"${id}" is not a column.`;
    if (seen.has(id)) return `The column "${id}" appears twice.`;
    seen.add(id);
  }
  if (config.sort && !parseResourceReportColumn(config.sort.column)) {
    return `"${config.sort.column}" is not a column to sort by.`;
  }
  const f = config.filters;
  for (const list of [f.pluginIds, f.accountIds, f.regions, f.statuses]) {
    if (list.length > L.maxFilterValues) return `At most ${L.maxFilterValues} values per filter.`;
  }
  if (f.resourceTypes.length > L.maxFilterValues) {
    return `At most ${L.maxFilterValues} resource types.`;
  }
  if (f.tags.length > L.maxTagFilters) return `At most ${L.maxTagFilters} tag conditions.`;
  for (const t of f.tags) {
    if (!t.key.trim()) return "Every tag condition needs a key.";
    if ((t.op === "in" || t.op === "not_in") && t.values.length === 0) {
      return `The condition on "${t.key}" needs at least one value.`;
    }
    if ((t.op === "exists" || t.op === "missing") && t.values.length > 0) {
      return `The condition on "${t.key}" takes no values.`;
    }
    if (t.values.length > L.maxFilterValues) {
      return `At most ${L.maxFilterValues} values per tag condition.`;
    }
  }
  if (resourceReportVirtualTagKeys(config).length > L.maxVirtualTagKeys) {
    return `At most ${L.maxVirtualTagKeys} virtual tags per report.`;
  }
  if (f.createdFrom !== null && !ISO_DAY.test(f.createdFrom)) return "Created from is not a date.";
  if (f.createdTo !== null && !ISO_DAY.test(f.createdTo)) return "Created to is not a date.";
  if (f.createdFrom !== null && f.createdTo !== null && f.createdFrom > f.createdTo) {
    return "Created from is after created to.";
  }
  if (config.costRange.kind === "absolute" && config.costRange.from > config.costRange.to) {
    return "The cost range starts after it ends.";
  }
  if (
    !Number.isInteger(config.pageSize) ||
    config.pageSize < 1 ||
    config.pageSize > L.maxPageSize
  ) {
    return `Rows per page must be between 1 and ${L.maxPageSize}.`;
  }
  return null;
}

/** How many filter conditions are set, for a "Filters (3)" badge. */
export function resourceReportFilterCount(filters: ResourceReportFilters): number {
  return (
    (filters.pluginIds.length > 0 ? 1 : 0) +
    (filters.accountIds.length > 0 ? 1 : 0) +
    (filters.resourceTypes.length > 0 ? 1 : 0) +
    (filters.regions.length > 0 ? 1 : 0) +
    (filters.statuses.length > 0 ? 1 : 0) +
    filters.tags.length +
    (filters.nameContains ? 1 : 0) +
    (filters.createdFrom || filters.createdTo ? 1 : 0)
  );
}

/* ------------------------------------------------------------------ *
 * Reading a resource's stored record
 * ------------------------------------------------------------------ */

/** The region a resource's fields carry, first non-empty of the region keys. */
export function resourceRegionFromFields(
  fields: Record<string, unknown> | null | undefined,
): string | null {
  if (!fields) return null;
  for (const key of RESOURCE_REGION_FIELD_KEYS) {
    const v = fields[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/** Parse a provider timestamp: ISO text, or epoch seconds or milliseconds. */
export function parseProviderTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Seconds until the year 5138; anything bigger is milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return parseProviderTimestamp(Number(trimmed));
    // Only text that starts like a date: `Date.parse` accepts "1" and "May".
    if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * When the provider says a resource was created, from its synced fields, as
 * an ISO timestamp; null when no created key parses.
 */
export function resourceCreatedFromFields(
  fields: Record<string, unknown> | null | undefined,
): string | null {
  if (!fields) return null;
  for (const key of RESOURCE_CREATED_FIELD_KEYS) {
    const d = parseProviderTimestamp(fields[key]);
    if (d) return d.toISOString();
  }
  return null;
}

/**
 * A field value as table text: strings as stored, numbers and booleans
 * printed, arrays of scalars comma-joined, anything else as compact JSON.
 * Null for absent and empty.
 */
export function resourceFieldText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object")) {
    const text = value.filter((v) => v !== null && v !== "").join(", ");
    return text === "" ? null : text;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Running: the wire shapes
 * ------------------------------------------------------------------ */

/** A resolved column, with the label the server would print. */
export interface ResourceReportColumn {
  id: string;
  kind: ResourceReportColumnKind;
  key: string;
  /** English label (the UI translates core and cost labels itself). */
  label: string;
}

/** Spend in one currency. A resource billed in two currencies has two. */
export interface ResourceReportMoney {
  currency: string;
  amount: number;
}

/** One resource. */
export interface ResourceReportRow {
  /** `resources.id`: what the resource detail view is addressed by. */
  id: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  /** Text per non-cost column id; null when the resource has no value. */
  values: Record<string, string | null>;
  /**
   * Spend per cost column id, largest first. Empty when the resource had no
   * cost rows in the window (no spend, or a provider that does not report
   * spend per resource).
   */
  costs: Record<string, ResourceReportMoney[]>;
}

export interface ResourceReportCostWindowRange {
  window: ResourceReportCostWindow;
  from: string;
  to: string;
}

/** What a run says about its cost columns. Null on a report with none. */
export interface ResourceReportCostInfo {
  /**
   * False when the caller lacks `costs:read` or there is no cost store; the
   * cost and virtual tag cells are then empty and `reason` says why.
   */
  available: boolean;
  reason: string | null;
  basis: CostBasis;
  windows: ResourceReportCostWindowRange[];
}

/** POST /resource-reports/query and GET /resource-reports/:id/rows. */
export interface ResourceReportRowsResult {
  columns: ResourceReportColumn[];
  rows: ResourceReportRow[];
  /** Matching resources. A lower bound when `truncated`. */
  total: number;
  offset: number;
  limit: number;
  /** The in-memory evaluation stopped at {@link RESOURCE_REPORT_LIMITS.maxScan}. */
  truncated: boolean;
  sort: ResourceReportSort;
  cost: ResourceReportCostInfo | null;
}

/** POST /resource-reports/query body. */
export interface ResourceReportQueryRequest {
  config: ResourceReportConfig;
  offset?: number | undefined;
  limit?: number | undefined;
}

/** A value offered by a filter picker, with how many resources carry it. */
export interface ResourceReportCountedValue {
  value: string;
  label: string;
  count: number;
}

/** A metadata field the selected resource types expose. */
export interface ResourceReportFieldOption {
  key: string;
  label: string;
  /** Synced resources (of the selected types) that carry a value for it, in the sample. */
  count: number;
  /** Declared by a resource type definition, rather than only seen in synced data. */
  declared: boolean;
}

/** GET /resource-reports/options: everything the pickers offer. */
export interface ResourceReportOptions {
  providers: ResourceReportCountedValue[];
  accounts: Array<ResourceReportCountedValue & { pluginId: string }>;
  resourceTypes: Array<{
    pluginId: string;
    resourceTypeId: string;
    label: string;
    count: number;
  }>;
  regions: ResourceReportCountedValue[];
  statuses: ResourceReportCountedValue[];
  /** Metadata fields, narrowed to the `types` the request named (all types when none). */
  fields: ResourceReportFieldOption[];
  /** Provider tag keys seen on synced resources, hidden keys dropped, preferred first. */
  tagKeys: string[];
  preferredTagKeys: string[];
  /** The org's virtual tag keys; empty without `costs:read`. */
  virtualTagKeys: string[];
  /** Whether cost and virtual tag columns can be filled for this caller. */
  costAvailable: boolean;
}

/* ------------------------------------------------------------------ *
 * Sorting and output
 * ------------------------------------------------------------------ */

/** The sort a run applies: the config's, or by name. */
export function effectiveResourceReportSort(config: ResourceReportConfig): ResourceReportSort {
  return config.sort ?? { column: "core:name", direction: "asc" };
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Compare two cell texts the way a person expects a table to sort: numbers
 * by value, text naturally ("node-2" before "node-10"), empty last in both
 * directions.
 */
export function compareResourceReportText(
  a: string | null,
  b: string | null,
  direction: "asc" | "desc",
): number {
  const aEmpty = a === null || a === "";
  const bEmpty = b === null || b === "";
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const an = Number(a);
  const bn = Number(b);
  const cmp =
    Number.isFinite(an) && Number.isFinite(bn) && a.trim() !== "" && b.trim() !== ""
      ? an - bn
      : collator.compare(a, b);
  return direction === "asc" ? cmp : -cmp;
}

/**
 * Compare two cost cells by their amount in `currency` (the result's main
 * currency). A resource with no spend in it sorts as zero, so "most expensive
 * first" puts the spenders on top and the rest after.
 */
export function compareResourceReportCost(
  a: readonly ResourceReportMoney[],
  b: readonly ResourceReportMoney[],
  currency: string,
  direction: "asc" | "desc",
): number {
  const av = a.find((m) => m.currency === currency)?.amount ?? 0;
  const bv = b.find((m) => m.currency === currency)?.amount ?? 0;
  return direction === "asc" ? av - bv : bv - av;
}

/** The currency with the most spend across cells, for sorting and the CSV. */
export function primaryResourceReportCurrency(
  cells: Iterable<readonly ResourceReportMoney[]>,
): string | null {
  const totals = new Map<string, number>();
  for (const cell of cells) {
    for (const m of cell)
      totals.set(m.currency, (totals.get(m.currency) ?? 0) + Math.abs(m.amount));
  }
  let best: string | null = null;
  let bestAmount = -1;
  for (const [currency, amount] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (amount > bestAmount) {
      best = currency;
      bestAmount = amount;
    }
  }
  return best;
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();

/**
 * One cost cell for a table: `$12.30`, `$12.30 + €4.00`, or empty. Always two
 * decimals, unlike the graphs' compact `formatMoney`: a column of per-resource
 * figures reads by its cents.
 */
export function formatResourceReportMoney(cell: readonly ResourceReportMoney[]): string {
  return cell
    .map((m) => {
      let fmt = moneyFormatters.get(m.currency);
      if (!fmt) {
        try {
          fmt = new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: m.currency || "USD",
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
        } catch {
          fmt = new Intl.NumberFormat(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
        }
        moneyFormatters.set(m.currency, fmt);
      }
      return fmt.format(m.amount);
    })
    .join(" + ");
}

/** One cost cell as plain text: `12.30 USD`, `12.30 USD + 4.00 EUR`, or empty. */
export function resourceReportMoneyText(cell: readonly ResourceReportMoney[]): string {
  return cell.map((m) => `${m.amount.toFixed(2)} ${m.currency}`).join(" + ");
}

function csvField(value: string): string {
  // Leading = + - @ would be evaluated as a formula by a spreadsheet: a cell
  // text from a provider (a resource name, a tag value) is not ours to trust.
  const guarded =
    /^[=+\-@\t\r]/.test(value) && !/^-?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * The rows as CSV. Every non-cost column is one CSV column; every cost column
 * is one numeric CSV column per currency present (`Accrued cost (USD)`), so a
 * spreadsheet can sum it. A resource with no spend in a currency writes 0.
 * The resource id and its account id are appended so a row can be traced
 * back.
 */
export function buildResourceReportCsv(
  columns: readonly ResourceReportColumn[],
  rows: readonly ResourceReportRow[],
): string {
  const currenciesByColumn = new Map<string, string[]>();
  for (const col of columns) {
    if (col.kind !== "cost") continue;
    const set = new Set<string>();
    for (const row of rows) for (const m of row.costs[col.id] ?? []) set.add(m.currency);
    currenciesByColumn.set(col.id, [...set].sort());
  }

  const header: string[] = [];
  for (const col of columns) {
    if (col.kind === "cost") {
      const currencies = currenciesByColumn.get(col.id) ?? [];
      if (currencies.length === 0) header.push(col.label);
      for (const c of currencies) header.push(`${col.label} (${c})`);
    } else {
      header.push(col.label);
    }
  }
  header.push("Resource ID", "Account ID");

  const lines = [header.map(csvField).join(",")];
  for (const row of rows) {
    const cells: string[] = [];
    for (const col of columns) {
      if (col.kind === "cost") {
        const currencies = currenciesByColumn.get(col.id) ?? [];
        if (currencies.length === 0) cells.push("");
        for (const c of currencies) {
          const m = (row.costs[col.id] ?? []).find((x) => x.currency === c);
          cells.push(String(m ? Math.round(m.amount * 1e6) / 1e6 : 0));
        }
      } else {
        cells.push(row.values[col.id] ?? "");
      }
    }
    cells.push(row.id, row.accountId);
    lines.push(cells.map(csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** A safe file name for a report's CSV. */
export function resourceReportCsvFilename(name: string, today = new Date()): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "resource-report";
  return `${slug}-${today.toISOString().slice(0, 10)}.csv`;
}

/**
 * The calendar windows behind `mtd` and `previous_month`, plus the report's
 * own range, as inclusive UTC days.
 */
export function resourceReportCostWindows(
  range: { from: string; to: string },
  today = new Date(),
): ResourceReportCostWindowRange[] {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  return [
    { window: "range", from: range.from, to: range.to },
    { window: "mtd", from: iso(new Date(Date.UTC(y, m, 1))), to: iso(today) },
    {
      window: "previous_month",
      from: iso(new Date(Date.UTC(y, m - 1, 1))),
      to: iso(new Date(Date.UTC(y, m, 0))),
    },
  ];
}

/**
 * Pick the dominant value per resource from `(resource, value, amount)`
 * rows: the value holding the most spend, ties broken by name so a run is
 * deterministic. Empty values are ignored (a row no rule matched and the tag
 * has no default value).
 */
export function dominantValues(
  rows: ReadonlyArray<{ key: string; value: string; amount: number }>,
): Map<string, string> {
  const byKey = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.value === "") continue;
    const values = byKey.get(r.key) ?? new Map<string, number>();
    values.set(r.value, (values.get(r.value) ?? 0) + Math.abs(r.amount));
    byKey.set(r.key, values);
  }
  const out = new Map<string, string>();
  for (const [key, values] of byKey) {
    let best: string | null = null;
    let bestAmount = -1;
    for (const [value, amount] of values) {
      if (amount > bestAmount || (amount === bestAmount && best !== null && value < best)) {
        best = value;
        bestAmount = amount;
      }
    }
    if (best !== null) out.set(key, best);
  }
  return out;
}

/**
 * Whether a resource's value for a tag condition passes it. `value` is null
 * when the resource does not carry the key.
 */
export function resourceReportTagFilterMatches(
  filter: Pick<ResourceReportTagFilter, "op" | "values">,
  value: string | null,
): boolean {
  switch (filter.op) {
    case "exists":
      return value !== null;
    case "missing":
      return value === null;
    case "in":
      return value !== null && filter.values.includes(value);
    case "not_in":
      return value === null || !filter.values.includes(value);
  }
}

/* ------------------------------------------------------------------ *
 * Bearer clients (mobile; web and desktop go through their own transports)
 * ------------------------------------------------------------------ */

export async function fetchResourceReports(
  api: CloudFetch,
  orgId: string,
): Promise<ResourceReport[]> {
  return (await api.org<ResourceReport[]>(orgId, "/resource-reports")) ?? [];
}

export async function fetchResourceReportFolders(
  api: CloudFetch,
  orgId: string,
): Promise<CostReportFolder[]> {
  return (await api.org<CostReportFolder[]>(orgId, "/resource-reports/folders")) ?? [];
}

/** One page of a saved report's rows (`GET /resource-reports/:id/rows`). */
export async function fetchResourceReportRows(
  api: CloudFetch,
  orgId: string,
  reportId: string,
  opts: { offset?: number; limit?: number; sort?: ResourceReportSort } = {},
): Promise<ResourceReportRowsResult> {
  const params = new URLSearchParams();
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.sort) {
    params.set("sort", opts.sort.column);
    params.set("direction", opts.sort.direction);
  }
  const qs = params.toString();
  const result = await api.org<ResourceReportRowsResult>(
    orgId,
    `/resource-reports/${encodeURIComponent(reportId)}/rows${qs ? `?${qs}` : ""}`,
  );
  if (!result) throw new Error("The report returned no rows.");
  return result;
}
