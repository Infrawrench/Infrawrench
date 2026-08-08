/**
 * Scheduled cost data exports — the wire contract shared by the API, the
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
 * vocabulary rather than inventing a second filter shape — the same values the
 * dashboards, budgets and reports already store, so a filter means the same
 * thing everywhere.
 *
 * Destination credentials never travel in this direction. Every response type
 * here carries a redacted hint (`…a7f2`) and nothing else; see
 * `server-core/src/cost-exports/store.ts`.
 */
import type { CostBasis, CostChargeType, CostDimensionId, CostFilter } from "./costs";

/** Serialisation of the row stream. */
export const COST_EXPORT_FORMATS = ["csv", "ndjson"] as const;
export type CostExportFormat = (typeof COST_EXPORT_FORMATS)[number];

export const COST_EXPORT_FORMAT_LABELS: Record<CostExportFormat, string> = {
  csv: "CSV",
  ndjson: "NDJSON (one JSON object per line)",
};

/**
 * How often a run happens, and — because a run writes one object per period —
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

export const COST_EXPORT_DESTINATION_KINDS = ["s3", "http"] as const;
export type CostExportDestinationKind = (typeof COST_EXPORT_DESTINATION_KINDS)[number];

export const COST_EXPORT_DESTINATION_LABELS: Record<CostExportDestinationKind, string> = {
  s3: "S3-compatible object storage",
  http: "HTTPS endpoint (signed URL)",
};

/**
 * Where an S3-compatible run writes. One implementation covers AWS S3,
 * Cloudflare R2, DigitalOcean Spaces, Scaleway, Backblaze B2 and MinIO — they
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
 * right — a pre-signed PUT/POST target usually carries its own signature in the
 * query string — so it is encrypted at rest and never returned.
 */
export interface CostExportHttpDestination {
  kind: "http";
  /** `POST` (default) or `PUT`. Some signed-URL schemes only accept one. */
  method: "POST" | "PUT";
  /** Non-secret display hint for the stored URL, e.g. `warehouse.acme.com/…a7f2`. */
  urlHint: string;
}

export type CostExportDestination = CostExportS3Destination | CostExportHttpDestination;

/**
 * The rows a run selects. Deliberately the same vocabulary as a cost graph,
 * minus everything about *drawing* one.
 *
 * `dimensions` are the row-identity columns kept in the output. Dropping one
 * aggregates over it — an export grouped to `provider` + `service` is a much
 * smaller object than a per-resource one, and for a finance system that is
 * usually the right grain.
 */
export interface CostExportQuery {
  version: 1;
  /** Row-identity columns to keep. Empty means "one row per period, per currency". */
  dimensions: CostDimensionId[];
  /** Tag keys to emit as their own columns; only meaningful with the `tag` dimension. */
  tagKeys: string[];
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
 * `{periodStart}` is the period's first day as `YYYY-MM-DD` — for every
 * cadence, so keys sort lexicographically and nobody has to know ISO week
 * numbering to find last week's file. `{format}` is `csv` or `ndjson`.
 *
 * Deterministic on purpose: re-exporting a period writes the *same* key, so a
 * restatement overwrites the previous copy instead of leaving two files that
 * both claim to be July. This is the mechanism the whole restatement story
 * rests on — see the docs page.
 */
export const COST_EXPORT_KEY_TEMPLATE =
  "{prefix}/cost-export/{exportId}/{cadence}/{periodStart}.{format}";

/** One export, as every read endpoint returns it. Never carries a secret. */
export interface CostExport {
  id: string;
  name: string;
  format: CostExportFormat;
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
 * folded into one output row disagree on a unit — a total labelled with one of
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
