/**
 * Scheduled cost data exports: the wire contract shared by the API, the
 * settings UI, and the CLI.
 *
 * A cost export is a saved query plus a schedule plus a destination: on its
 * cadence the server streams the org's `cost_daily` rows for the periods that
 * have come due and writes **one object per period** to S3-compatible object
 * storage or an HTTPS endpoint. It is the raw-row counterpart to a cost report
 * (which is a named *graph*): a report is for looking at, an export is for
 * loading into a warehouse.
 *
 * The query scope deliberately reuses {@link CostFilter} and the cost dimension
 * vocabulary rather than inventing a second filter shape: the same values the
 * dashboards, budgets and reports already store, so a filter means the same
 * thing everywhere.
 *
 * Destination credentials never travel in this direction. Every response type
 * here carries a redacted hint (`…a7f2`) and nothing else; see
 * `server-core/src/cost-exports/store.ts`.
 */
import {
  resolveCostDateRange,
  type CostBasis,
  type CostChargeType,
  type CostDimensionId,
  type CostFilter,
  type CostGraphConfig,
} from "./costs";

/** Serialisation of the row stream. */
export const COST_EXPORT_FORMATS = ["csv", "ndjson"] as const;
export type CostExportFormat = (typeof COST_EXPORT_FORMATS)[number];

export const COST_EXPORT_FORMAT_LABELS: Record<CostExportFormat, string> = {
  csv: "CSV",
  ndjson: "NDJSON (one JSON object per line)",
};

/**
 * Which columns an object carries.
 *
 * - `native`: Infrawrench's own layout: `day`, the identity columns the export
 *   keeps, the measures, then provenance. Compact, and shaped by the query's
 *   `dimensions` and `tagKeys`.
 * - `focus-1.4` / `focus-1.3`: the FinOps Open Cost and Usage Specification
 *   (https://focus.finops.org/focus-specification/) at that version. Fixed
 *   columns at the full row grain (account, service, region, resource, charge
 *   type, commitment, tags), with billed and effective cost side by side. The
 *   query's `dimensions`, `tagKeys` and `costBasis` do not apply; its
 *   `filters` and `chargeTypes` still do. See {@link FOCUS_COLUMNS_BY_VERSION}.
 *
 * Versioned in the value so a later specification is an additive option
 * rather than a silent change to what an existing export writes: an export
 * saved as `focus-1.3` keeps writing 1.3 headers until someone switches it.
 */
export const COST_EXPORT_SCHEMAS = ["native", "focus-1.4", "focus-1.3"] as const;
export type CostExportSchema = (typeof COST_EXPORT_SCHEMAS)[number];

export const COST_EXPORT_SCHEMA_LABELS: Record<CostExportSchema, string> = {
  native: "Infrawrench columns",
  "focus-1.4": "FOCUS 1.4",
  "focus-1.3": "FOCUS 1.3",
};

/** The FOCUS specification versions a file can be written in, newest first. */
export const FOCUS_VERSIONS = ["1.4", "1.3"] as const;
export type FocusVersion = (typeof FOCUS_VERSIONS)[number];

/** What a new export or an ad-hoc download from our own clients writes. */
export const FOCUS_LATEST_VERSION: FocusVersion = "1.4";

/**
 * What `POST /costs/focus-export` writes when the request names no version.
 * Pinned to the version the route shipped with, because 1.4 drops two columns
 * (`ProviderName`, `PublisherName`) a script reading the old header may use.
 * Our own clients always send {@link FOCUS_LATEST_VERSION}.
 */
export const FOCUS_DEFAULT_DOWNLOAD_VERSION: FocusVersion = "1.3";

/**
 * The FOCUS version a schema value writes, or null for the native layout.
 * Absent reads as native, which is what a row from before FOCUS support was.
 */
export function focusVersionOfSchema(schema: string | null | undefined): FocusVersion | null {
  const version = schema?.startsWith("focus-") ? schema.slice("focus-".length) : "";
  return (FOCUS_VERSIONS as readonly string[]).includes(version) ? (version as FocusVersion) : null;
}

/**
 * The FOCUS v1.3 columns a FOCUS-schema object carries, in the order they are
 * written (alphabetical, which the specification allows): every Mandatory
 * column, the Recommended `ChargeFrequency` and `ServiceSubcategory`, and the
 * Conditional ones whose condition our cost data meets. Conditional columns
 * we have no data for (SKU, pricing category, unit prices, invoice id, sub
 * account, capacity reservation, allocation) are left out, which the
 * specification permits, rather than written as all-null.
 *
 * Changing this list changes the header of every object an existing export
 * writes. It only ever changes alongside a new `focus-<version>` schema value.
 */
export const FOCUS_1_3_COLUMNS = [
  "BilledCost",
  "BillingAccountId",
  "BillingAccountName",
  "BillingCurrency",
  "BillingPeriodEnd",
  "BillingPeriodStart",
  "ChargeCategory",
  "ChargeClass",
  "ChargeDescription",
  "ChargeFrequency",
  "ChargePeriodEnd",
  "ChargePeriodStart",
  "CommitmentDiscountCategory",
  "CommitmentDiscountId",
  "CommitmentDiscountName",
  "CommitmentDiscountStatus",
  "CommitmentDiscountType",
  "ContractedCost",
  "EffectiveCost",
  "HostProviderName",
  "InvoiceIssuerName",
  "ListCost",
  "PricingQuantity",
  "PricingUnit",
  "ProviderName",
  "PublisherName",
  "RegionId",
  "RegionName",
  "ResourceId",
  "ResourceName",
  "ServiceCategory",
  "ServiceName",
  "ServiceProviderName",
  "ServiceSubcategory",
  "Tags",
] as const;

/**
 * The FOCUS v1.4 columns, chosen the same way as {@link FOCUS_1_3_COLUMNS}.
 *
 * 1.4 removed the deprecated `ProviderName` and `PublisherName` (their values
 * live on in `ServiceProviderName` and `HostProviderName`) and added two
 * Conditional Cost and Usage columns we have no data for, so they are left
 * out: `InvoiceDetailId` (needs the provider's invoice line ids) and
 * `CommitmentProgramEligibilityDetails` (must list every public commitment
 * program a charge is eligible for, which no collector knows; a partial list
 * would be non-conformant). Its new Billing Period, Contract Commitment and
 * Invoice Detail datasets are separate files and are not written.
 */
export const FOCUS_1_4_COLUMNS = FOCUS_1_3_COLUMNS.filter(
  (c): c is Exclude<(typeof FOCUS_1_3_COLUMNS)[number], "ProviderName" | "PublisherName"> =>
    c !== "ProviderName" && c !== "PublisherName",
);

/** The specification columns per version, in the order they are written. */
export const FOCUS_COLUMNS_BY_VERSION: Record<
  FocusVersion,
  readonly (typeof FOCUS_1_3_COLUMNS)[number][]
> = {
  "1.3": FOCUS_1_3_COLUMNS,
  "1.4": FOCUS_1_4_COLUMNS,
};

/**
 * Custom columns appended after the FOCUS ones. The specification requires
 * the `x_` prefix and that they come last, unmixed.
 *
 * - `x_InfrawrenchProviderId`: the plugin id (`aws`, `openai`…), the stable
 *   key the provider dimension filters on.
 * - `x_InfrawrenchChargeType`: our finer-grained charge type, which
 *   `ChargeCategory` folds (covered and on-demand usage are both `Usage`).
 * - `x_UsageQuantity` / `x_UsageUnit`: the consumption quantity the provider
 *   reported. FOCUS's own quantity columns must be null without a SKU price
 *   id, which no collector supplies, so the quantity travels here instead.
 * - `x_ResourceType`: the resource's type in the Infrawrench inventory, when
 *   the row's resource is in it.
 * - `x_CostEstimated`: `true` when the provider's amounts are derived by
 *   Infrawrench (inventory times a rate card) rather than billed.
 * - `x_ExportedAt` / `x_CollectionWatermark`: the same provenance a native
 *   object carries as `exported_at` / `collection_watermark`.
 */
export const FOCUS_CUSTOM_COLUMNS = [
  "x_InfrawrenchProviderId",
  "x_InfrawrenchChargeType",
  "x_UsageQuantity",
  "x_UsageUnit",
  "x_ResourceType",
  "x_CostEstimated",
  "x_ExportedAt",
  "x_CollectionWatermark",
] as const;

/**
 * An ad-hoc FOCUS download (`POST /costs/focus-export`). The same filter
 * vocabulary as a cost query (structured `filters` or cost-query-language
 * `query`, plus an optional saved filter) over an inclusive day range.
 */
export interface FocusExportRequest {
  /** First day, `YYYY-MM-DD` (UTC). */
  from: string;
  /** Last day, inclusive, `YYYY-MM-DD` (UTC). */
  to: string;
  filters?: CostFilter[] | undefined;
  /** Cost query language text. Mutually exclusive with `filters`. */
  query?: string | undefined;
  /** ANDed with whichever inline filter spelling was sent. */
  savedFilterId?: string | undefined;
  chargeTypes?: CostChargeType[] | undefined;
  /**
   * The FOCUS version to write. Absent means
   * {@link FOCUS_DEFAULT_DOWNLOAD_VERSION}, for scripts written before 1.4.
   */
  version?: FocusVersion | undefined;
}

/** Longest range one ad-hoc FOCUS download may span, in days (inclusive). */
export const FOCUS_EXPORT_MAX_DAYS = 366;

/**
 * The FOCUS download for a saved cost report or graph: its date range resolved
 * against `today`, its filters, and its saved filter by reference. Grouping,
 * binning and basis are dropped because a FOCUS file has none of them; every
 * charge type is included, because the file says which each row is.
 */
export function focusExportRequestForConfig(
  config: CostGraphConfig,
  today = new Date(),
): FocusExportRequest {
  const { from, to } = resolveCostDateRange(config.dateRange, today);
  return {
    from,
    to,
    version: FOCUS_LATEST_VERSION,
    filters: config.filters,
    ...(config.savedFilterId ? { savedFilterId: config.savedFilterId } : {}),
  };
}

/** `focus-<slug>-<from>-to-<to>.csv`, the filename a download is saved under. */
export function focusExportFilename(
  req: Pick<FocusExportRequest, "from" | "to">,
  name = "",
): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `focus-${slug ? `${slug}-` : ""}${req.from}-to-${req.to}.csv`;
}

/**
 * How often a run happens, and (because a run writes one object per period)
 * what a period *is*. `daily` writes one object per calendar day, `weekly` one
 * per ISO week (Monday-start), `monthly` one per calendar month.
 */
export const COST_EXPORT_CADENCES = ["daily", "weekly", "monthly"] as const;
export type CostExportCadence = (typeof COST_EXPORT_CADENCES)[number];

export const COST_EXPORT_CADENCE_LABELS: Record<CostExportCadence, string> = {
  daily: "Daily",
  weekly: "Weekly (Monday)",
  monthly: "Monthly (1st)",
};

export const COST_EXPORT_DESTINATION_KINDS = ["s3", "http", "warehouse"] as const;
export type CostExportDestinationKind = (typeof COST_EXPORT_DESTINATION_KINDS)[number];

export const COST_EXPORT_DESTINATION_LABELS: Record<CostExportDestinationKind, string> = {
  s3: "S3-compatible object storage",
  http: "HTTPS endpoint (signed URL)",
  warehouse: "Warehouse table",
};

/**
 * Where an S3-compatible run writes. One implementation covers AWS S3,
 * Cloudflare R2, DigitalOcean Spaces, Scaleway, Backblaze B2 and MinIO: they
 * differ only in `endpoint` and `region`, and all of them speak SigV4.
 */
export interface CostExportS3Destination {
  kind: "s3";
  bucket: string;
  /**
   * Key prefix, no leading or trailing slash. Everything the export writes
   * lives under it; see {@link COST_EXPORT_KEY_TEMPLATE}.
   */
  prefix: string;
  /** AWS-style region. R2 wants `auto`; MinIO usually `us-east-1`. */
  region: string;
  /**
   * Endpoint origin. Empty means AWS S3 proper (`https://s3.<region>.amazonaws.com`).
   * Anything else is the provider's S3 API origin, e.g.
   * `https://<accountid>.r2.cloudflarestorage.com` or `https://fra1.digitaloceanspaces.com`.
   * A bare host or an `https://` origin; the server refuses plain `http` and
   * private or reserved addresses.
   */
  endpoint: string;
  /**
   * Address the bucket as a path segment (`https://host/bucket/key`) instead of
   * a subdomain. MinIO and most self-hosted gateways need this; AWS, R2 and
   * Spaces do not.
   */
  forcePathStyle: boolean;
}

/**
 * Where an HTTPS run posts. The URL is treated as a credential in its own
 * right (a pre-signed PUT/POST target usually carries its own signature in the
 * query string) so it is encrypted at rest and never returned.
 */
export interface CostExportHttpDestination {
  kind: "http";
  /** `POST` (default) or `PUT`. Some signed-URL schemes only accept one. */
  method: "POST" | "PUT";
  /** Non-secret display hint for the stored URL, e.g. `warehouse.acme.com/…a7f2`. */
  urlHint: string;
}

/**
 * Where a warehouse run loads: a table in a connected account of a plugin that
 * declares a warehouse sink (Snowflake, Databricks). The account's own stored
 * credentials do the loading, so the export holds no secret of its own.
 *
 * `target` holds the answers to the plugin's target fields (for Snowflake
 * `warehouse`, `database`, `schema`, `table`; for Databricks `warehouseId`,
 * `catalog`, `schema`, `table`), listed by `GET /cost-exports/warehouse-sinks`
 * and filled from `POST /cost-exports/warehouse-options`. Hosts never
 * interpret them.
 *
 * Every run replaces, per period, the rows matching `export_id` and the
 * period's days in one transaction, so restatements overwrite rather than
 * append, the same guarantee an S3 object at a deterministic key gives.
 */
export interface CostExportWarehouseDestination {
  kind: "warehouse";
  /** Plugin that owns the warehouse, e.g. `snowflake` or `databricks`. */
  pluginId: string;
  /** Connected account (of `pluginId`) whose credentials load the rows. */
  accountId: string;
  target: Record<string, string>;
}

export type CostExportDestination =
  CostExportS3Destination | CostExportHttpDestination | CostExportWarehouseDestination;

/**
 * Columns a warehouse destination adds in front of the layout's own: which
 * export wrote the row (the replace scope, so several exports can share a
 * table) and which period it belongs to.
 */
export const COST_EXPORT_WAREHOUSE_COLUMNS = ["export_id", "period_start"] as const;

/** A plugin that can be a warehouse destination, with the org's eligible accounts. */
export interface CostExportWarehouseSink {
  pluginId: string;
  displayName: string;
  /** Destination type label, e.g. "Snowflake table". */
  label: string;
  description: string | null;
  targetFields: CostExportWarehouseTargetField[];
  accounts: Array<{ id: string; name: string }>;
}

export interface CostExportWarehouseTargetField {
  key: string;
  label: string;
  description: string | null;
  dependsOn: string[];
  optional: boolean;
  allowCustom: boolean;
  placeholder: string | null;
  emptyLabel: string | null;
}

/** `POST /cost-exports/warehouse-options` body. */
export interface CostExportWarehouseOptionsRequest {
  accountId: string;
  field: string;
  /** Values chosen so far, for fields that depend on them. */
  target: Record<string, string>;
}

export interface CostExportWarehouseOption {
  id: string;
  label: string;
  description?: string;
}

/** `POST /cost-exports/warehouse-setup` answer: grants to run once, plus non-SQL notes. */
export interface CostExportWarehouseSetup {
  sql: string;
  notes: string[];
}

/**
 * The rows a run selects. Deliberately the same vocabulary as a cost graph,
 * minus everything about *drawing* one.
 *
 * `dimensions` are the row-identity columns kept in the output. Dropping one
 * aggregates over it: an export grouped to `provider` + `service` is a much
 * smaller object than a per-resource one, and for a finance system that is
 * usually the right grain.
 */
export interface CostExportQuery {
  version: 1;
  /** Row-identity columns to keep. Empty means "one row per period, per currency". */
  dimensions: CostDimensionId[];
  /** Tag keys to emit as their own columns; only meaningful with the `tag` dimension. */
  tagKeys: string[];
  /**
   * Virtual tag keys to emit as their own `vtag_<key>` columns. A row a split
   * rule divides is exported once per share, with its amounts weighted, so the
   * file still sums to the collected total. Absent on every export written
   * before virtual tags existed, which is exactly the file they produced.
   */
  virtualTagKeys?: string[] | undefined;
  filters: CostFilter[];
  chargeTypes?: CostChargeType[] | undefined;
  /** Which money column to sum. Absent is `cash`. */
  costBasis?: CostBasis | undefined;
}

export const DEFAULT_COST_EXPORT_QUERY: CostExportQuery = {
  version: 1,
  dimensions: ["provider", "account", "service", "region"],
  tagKeys: [],
  filters: [],
};

/** `pending` before the first run; then the outcome of the most recent one. */
export const COST_EXPORT_STATUSES = ["pending", "succeeded", "failed"] as const;
export type CostExportStatus = (typeof COST_EXPORT_STATUSES)[number];

/**
 * The object key a run writes, as a template.
 *
 * `{periodStart}` is the period's first day as `YYYY-MM-DD`, for every
 * cadence, so keys sort lexicographically and nobody has to know ISO week
 * numbering to find last week's file. `{format}` is `csv` or `ndjson`.
 *
 * Deterministic on purpose: re-exporting a period writes the *same* key, so a
 * restatement overwrites the previous copy instead of leaving two files that
 * both claim to be July. This is the mechanism the whole restatement story
 * rests on: see the docs page.
 */
export const COST_EXPORT_KEY_TEMPLATE =
  "{prefix}/cost-export/{exportId}/{cadence}/{periodStart}.{format}";

/** One export, as every read endpoint returns it. Never carries a secret. */
export interface CostExport {
  id: string;
  name: string;
  format: CostExportFormat;
  /** Column layout. Exports created before FOCUS existed read as `native`. */
  schema: CostExportSchema;
  query: CostExportQuery;
  cadence: CostExportCadence;
  /** Local hour (0–23) in {@link timezone} a run fires at. */
  hour: number;
  /** IANA zone the schedule and the period boundaries are expressed in. */
  timezone: string;
  /**
   * How many trailing days of already-exported periods every run re-writes.
   * See the restatement note in the docs: providers restate spend for days
   * after the fact, so the object written for "yesterday" on the following
   * morning is not final.
   */
  restatementDays: number;
  enabled: boolean;
  destination: CostExportDestination;
  /** `true` once destination credentials are stored. Never the credentials. */
  hasCredentials: boolean;
  /** Non-secret marker for the stored credential, e.g. `AKIA…7F2Q`. */
  credentialHint: string | null;
  lastRunAt: string | null;
  lastStatus: CostExportStatus;
  /** Human-readable reason for the last failure. Null when the last run was fine. */
  lastError: string | null;
  /** How many objects the last successful run wrote, and how many rows in total. */
  lastObjectCount: number | null;
  lastRowCount: number | null;
  /** When the next scheduled run is due. Null while disabled. */
  nextRunAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Create/update payload. Credentials are write-only: omit them to keep what is
 * stored, which is what a blank field in the settings form means.
 */
export interface CostExportInput {
  name: string;
  format: CostExportFormat;
  /** Column layout. Omitted means `native`, which is what every older client sends. */
  schema?: CostExportSchema | undefined;
  query: CostExportQuery;
  cadence: CostExportCadence;
  hour: number;
  timezone: string;
  restatementDays: number;
  enabled: boolean;
  destination: CostExportDestination;
  /** S3 only. Omit to keep the stored pair. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** HTTP only. Omit to keep the stored URL. */
  url?: string;
}

/** One object a run wrote (or would have written). */
export interface CostExportObject {
  /** The period's first day (`YYYY-MM-DD`), in the export's own timezone. */
  periodStart: string;
  /** Inclusive day range the object covers. */
  from: string;
  to: string;
  key: string;
  rowCount: number;
  byteCount: number;
}

/** What `POST /cost-exports/:id/run` answers with. */
export interface CostExportRunResult {
  exportId: string;
  status: CostExportStatus;
  objects: CostExportObject[];
  rowCount: number;
  /**
   * The collection watermark stamped into every row and onto every object:
   * the newest day for which *every* cost-collecting account in the org has
   * reported. Rows dated after it are still arriving.
   */
  collectionWatermark: string | null;
  error: string | null;
}

export const DEFAULT_COST_EXPORT_INPUT: CostExportInput = {
  name: "",
  format: "csv",
  schema: "native",
  query: DEFAULT_COST_EXPORT_QUERY,
  cadence: "daily",
  hour: 4,
  timezone: "UTC",
  restatementDays: 7,
  enabled: true,
  destination: {
    kind: "s3",
    bucket: "",
    prefix: "infrawrench",
    region: "us-east-1",
    endpoint: "",
    forcePathStyle: false,
  },
};

/**
 * The measure columns every object carries, in order, after `day` and the
 * chosen identity columns. `usage_unit` is emitted empty whenever the rows
 * folded into one output row disagree on a unit: a total labelled with one of
 * several units would be a lie the file could not warn a consumer about.
 */
export const COST_EXPORT_BASE_COLUMNS = [
  "currency",
  "amount",
  "usage_amount",
  "usage_unit",
] as const;

/**
 * Columns appended to every row regardless of the selected dimensions. They are
 * what lets a consumer reconcile a restated period without reading object
 * metadata: `exported_at` says when this copy was produced and
 * `collection_watermark` says how far the underlying collection had got.
 */
export const COST_EXPORT_PROVENANCE_COLUMNS = ["exported_at", "collection_watermark"] as const;

/** The table a warehouse destination loads into, dotted (`DB.SCHEMA.TABLE`). */
export function costExportWarehouseTable(d: CostExportWarehouseDestination): string {
  return ["database", "catalog", "schema", "table"]
    .map((k) => d.target[k])
    .filter(Boolean)
    .join(".");
}

/**
 * One-line destination summary every compact surface prints (CLI, mobile):
 * `s3://bucket/prefix`, `POST host/…a7f2`, or `snowflake: DB.SCHEMA.TABLE`.
 */
export function describeCostExportDestination(d: CostExportDestination): string {
  if (d.kind === "s3") return `s3://${d.bucket}/${d.prefix}`;
  if (d.kind === "http") return `${d.method} ${d.urlHint}`;
  return `${d.pluginId}: ${costExportWarehouseTable(d)}`;
}
