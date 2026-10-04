/**
 * Custom cost sources: spend Infrawrench has no plugin for, uploaded as a file
 * into a named source that then reads as its own provider in every cost report.
 *
 * Everything that turns a file into cost rows lives here, in one pure module,
 * because three surfaces parse the same files and must agree byte for byte on
 * what they mean: the Settings section on web and desktop (shared through
 * `@infrawrench/ui`) and `infrawrench costs push --format csv|focus` in the
 * CLI. The server never sees the file. It receives already-mapped daily rows
 * in chunks and validates them again (`server-core/src/cost/cost-ingest.ts`),
 * so nothing here is a security boundary; it is the part that has to be
 * friendly.
 *
 * Two input shapes:
 *
 * - **Generic CSV.** Any export with a header row. The user maps file columns
 *   to fields with pickers; {@link detectCsvMapping} pre-fills them from the
 *   header names so the common case is "check and continue".
 * - **FOCUS.** The FinOps Open Cost and Usage Specification (v1.0 through
 *   v1.4). Its column names are fixed by the spec, so there is no mapping
 *   step: {@link isFocusHeader} recognises the file and {@link FOCUS_COLUMNS}
 *   says what each field is read from.
 *
 * Rows are aggregated to one row per day and dimension combination before they
 * leave the client: FOCUS files are often hourly and a CSV may have one line
 * per invoice item, while `cost_daily` holds days. Aggregating on exactly the
 * table's dedupe key is also what keeps two lines of one upload from replacing
 * each other on insert.
 */

/** File formats an upload can come from. `rows` is a JSON array pushed by the CLI or API. */
export const CUSTOM_COST_FORMATS = ["csv", "focus", "rows"] as const;
export type CustomCostFormat = (typeof CUSTOM_COST_FORMATS)[number];

/**
 * What to do with spend already stored for the days an upload covers.
 *
 * - `append`: keep it; the new rows add to it. Right for a second file that
 *   covers different services over the same month.
 * - `replace`: zero every row this source holds in the upload's date range
 *   (from any earlier upload) once the new rows are in. Right for a corrected
 *   re-export of the same period.
 *
 * Neither is the default when the range overlaps an earlier upload: the API
 * answers 409 until the caller picks one, because guessing wrong either
 * doubles a month or deletes one.
 */
export const CUSTOM_COST_UPLOAD_MODES = ["append", "replace"] as const;
export type CustomCostUploadMode = (typeof CUSTOM_COST_UPLOAD_MODES)[number];

/** Bounds the API enforces. */
export const CUSTOM_COST_LIMITS = {
  maxNameLength: 80,
  maxDescriptionLength: 500,
  maxFileNameLength: 255,
  /** Rows per `POST …/uploads/:id/rows` call, after daily aggregation. */
  maxRowsPerChunk: 5_000,
  /** Rows per upload, after daily aggregation. */
  maxRowsPerUpload: 1_000_000,
  /** The widest date range one upload may declare. */
  maxSpanDays: 3 * 366,
  /** Validation problems kept for display; the count beyond this is still reported. */
  maxReportedErrors: 200,
} as const;

/** A custom cost source as the API returns it. */
export interface CustomCostSource {
  id: string;
  name: string;
  description: string | null;
  /** Used for rows whose file has no currency column. Null means the file must carry one. */
  defaultCurrency: string | null;
  /** The value this source's rows carry in the `provider` dimension (`custom:<id>`). */
  pluginId: string;
  uploadCount: number;
  lastUploadAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create/update body for a custom cost source. */
export interface CustomCostSourceInput {
  name: string;
  description?: string | null | undefined;
  defaultCurrency?: string | null | undefined;
}

/** One upload in a source's history. */
export interface CustomCostUpload {
  id: string;
  sourceId: string;
  fileName: string | null;
  format: CustomCostFormat;
  mode: CustomCostUploadMode;
  /**
   * `uploading` until the client calls complete (an interrupted upload stays
   * here and can be deleted); `complete` once finished; `replaced` when a later
   * `replace` upload superseded every row it held.
   */
  status: "uploading" | "complete" | "replaced";
  /** Declared inclusive range. */
  fromDate: string;
  toDate: string;
  /** Rows this upload still holds (a partial replace lowers it). */
  rowCount: number;
  /** Per currency, the money this upload still holds (cash basis). */
  totals: Record<string, number>;
  uploadedBy: { id: string; name: string | null; email: string | null } | null;
  via: "web" | "desktop" | "cli" | "api";
  createdAt: string;
  completedAt: string | null;
}

/**
 * One day of spend for one dimension combination, as the upload API accepts it.
 * `subAccount` is the file's own account label (it never names an Infrawrench
 * account): rows land on a synthetic per-source account so the account
 * dimension can still split them.
 */
export interface CustomCostRow {
  date: string;
  currency: string;
  amount: number;
  service?: string | undefined;
  region?: string | undefined;
  resourceId?: string | undefined;
  subAccount?: string | undefined;
  tags?: Record<string, string> | undefined;
  usageAmount?: number | undefined;
  usageUnit?: string | undefined;
  chargeType?: string | undefined;
  amortizedAmount?: number | undefined;
  commitmentId?: string | undefined;
}

// ─── CSV ────────────────────────────────────────────────────────────────────

export interface ParsedTable {
  headers: string[];
  /** Data rows, each padded or truncated to `headers.length`. */
  rows: string[][];
  delimiter: string;
}

/** Pick the delimiter that splits the header line into the most fields. */
function detectDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const candidate of [",", ";", "\t", "|"]) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === candidate) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * RFC 4180 CSV with the usual real-world allowances: a UTF-8 BOM, CRLF or LF,
 * `;`/tab/`|` delimiters (spreadsheet exports in comma-decimal locales use
 * `;`), quoted fields containing newlines, and trailing blank lines.
 */
export function parseCsv(text: string): ParsedTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstBreak = src.search(/\r?\n/);
  const delimiter = detectDelimiter(firstBreak === -1 ? src : src.slice(0, firstBreak));

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === delimiter) {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ""));
  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const padded = r.slice(0, headers.length);
    while (padded.length < headers.length) padded.push("");
    return padded;
  });
  return { headers, rows, delimiter };
}

// ─── Mapping ────────────────────────────────────────────────────────────────

/** The fields a generic CSV column can be mapped to, in picker order. */
export const CUSTOM_COST_FIELDS = [
  "date",
  "cost",
  "currency",
  "service",
  "account",
  "region",
  "resource",
  "usageQuantity",
  "usageUnit",
  "tags",
] as const;
export type CustomCostField = (typeof CUSTOM_COST_FIELDS)[number];

/** Fields without which a row cannot be built. Currency can come from a default instead. */
export const REQUIRED_CUSTOM_COST_FIELDS: readonly CustomCostField[] = ["date", "cost"];

/** English labels; UIs translate them through their own lookup. */
export const CUSTOM_COST_FIELD_LABELS: Record<CustomCostField, string> = {
  date: "Date",
  cost: "Cost",
  currency: "Currency",
  service: "Service",
  account: "Account",
  region: "Region",
  resource: "Resource",
  usageQuantity: "Usage quantity",
  usageUnit: "Usage unit",
  tags: "Tags",
};

/**
 * Field → column index (null when unmapped), plus extra columns whose values
 * become tags keyed by the column header. Indexes rather than header names
 * because real exports repeat headers.
 */
export type CsvColumnMapping = Record<CustomCostField, number | null> & {
  tagColumns: number[];
};

export function emptyCsvMapping(): CsvColumnMapping {
  const mapping = { tagColumns: [] } as unknown as CsvColumnMapping;
  for (const field of CUSTOM_COST_FIELDS) mapping[field] = null;
  return mapping;
}

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Header names (normalized: lowercase, alphanumerics only) each field is
 * auto-detected from, best first. Covers the common billing exports (AWS CUR,
 * Azure cost details, GCP BigQuery export, FOCUS) and plain hand-made sheets.
 */
const FIELD_SYNONYMS: Record<CustomCostField, string[]> = {
  date: [
    "date",
    "day",
    "usagedate",
    "chargeperiodstart",
    "billingdate",
    "lineitemusagestartdate",
    "usagestartdate",
    "usagestarttime",
    "startdate",
    "period",
    "invoicedate",
    "timestamp",
  ],
  cost: [
    "cost",
    "amount",
    "billedcost",
    "totalcost",
    "costinbillingcurrency",
    "lineitemunblendedcost",
    "unblendedcost",
    "pretaxcost",
    "spend",
    "total",
    "charge",
    "price",
    "costusd",
    "amountusd",
  ],
  currency: [
    "currency",
    "billingcurrency",
    "currencycode",
    "lineitemcurrencycode",
    "billingcurrencycode",
  ],
  service: [
    "service",
    "servicename",
    "productname",
    "product",
    "lineitemproductcode",
    "servicedescription",
    "metercategory",
    "category",
    "sku",
  ],
  account: [
    "account",
    "accountname",
    "accountid",
    "subaccountname",
    "subaccountid",
    "lineitemusageaccountid",
    "subscriptionname",
    "subscriptionid",
    "projectname",
    "projectid",
    "project",
  ],
  region: ["region", "regionid", "regionname", "productregion", "location", "resourcelocation"],
  resource: [
    "resource",
    "resourceid",
    "lineitemresourceid",
    "resourcename",
    "instanceid",
    "instance",
  ],
  usageQuantity: [
    "usagequantity",
    "quantity",
    "consumedquantity",
    "usageamount",
    "lineitemusageamount",
    "usage",
    "units",
  ],
  usageUnit: ["usageunit", "unit", "consumedunit", "pricingunit", "unitofmeasure"],
  tags: ["tags", "labels", "resourcetags"],
};

/**
 * Pre-fill the mapping pickers from header names. Each column is claimed at
 * most once, and fields are matched in synonym order so `BilledCost` beats a
 * generic `Total` further along the row.
 */
export function detectCsvMapping(headers: string[]): CsvColumnMapping {
  const mapping = emptyCsvMapping();
  const normalized = headers.map(normalizeHeader);
  const claimed = new Set<number>();
  for (const field of CUSTOM_COST_FIELDS) {
    for (const synonym of FIELD_SYNONYMS[field]) {
      const index = normalized.findIndex((h, i) => h === synonym && !claimed.has(i));
      if (index !== -1) {
        mapping[field] = index;
        claimed.add(index);
        break;
      }
    }
  }
  return mapping;
}

/**
 * Resolve `field=Column` pairs (the CLI's `--map`) against a header row, by
 * exact header, then case-insensitive header, then 1-based column number.
 * Throws with a message naming the bad pair.
 */
export function applyCsvMappingOverrides(
  headers: string[],
  base: CsvColumnMapping,
  overrides: string[],
): CsvColumnMapping {
  const mapping: CsvColumnMapping = { ...base, tagColumns: [...base.tagColumns] };
  const resolve = (column: string): number => {
    let index = headers.indexOf(column);
    if (index === -1) {
      const lower = column.toLowerCase();
      index = headers.findIndex((h) => h.toLowerCase() === lower);
    }
    if (index === -1 && /^\d+$/.test(column)) {
      const n = Number(column) - 1;
      if (n >= 0 && n < headers.length) index = n;
    }
    if (index === -1) {
      throw new Error(`No column "${column}" in the file (columns: ${headers.join(", ")}).`);
    }
    return index;
  };
  for (const pair of overrides) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`Expected field=Column, got "${pair}".`);
    const field = pair.slice(0, eq).trim();
    const column = pair.slice(eq + 1).trim();
    if (field === "tag") {
      mapping.tagColumns.push(resolve(column));
      continue;
    }
    if (!(CUSTOM_COST_FIELDS as readonly string[]).includes(field)) {
      throw new Error(
        `Unknown field "${field}" (expected one of ${CUSTOM_COST_FIELDS.join(", ")}, or tag).`,
      );
    }
    mapping[field as CustomCostField] = column === "" ? null : resolve(column);
  }
  return mapping;
}

// ─── FOCUS ──────────────────────────────────────────────────────────────────

/**
 * The FOCUS columns an upload reads, by spec name. Checked against the v1.4
 * Cost and Usage dataset (ratified June 2026); every name here also exists in
 * v1.0-v1.3, so older exports read identically.
 */
export const FOCUS_COLUMNS = {
  date: "ChargePeriodStart",
  cost: "BilledCost",
  amortizedCost: "EffectiveCost",
  currency: "BillingCurrency",
  service: "ServiceName",
  regionId: "RegionId",
  regionName: "RegionName",
  resourceId: "ResourceId",
  resourceName: "ResourceName",
  subAccountName: "SubAccountName",
  subAccountId: "SubAccountId",
  billingAccountName: "BillingAccountName",
  billingAccountId: "BillingAccountId",
  consumedQuantity: "ConsumedQuantity",
  consumedUnit: "ConsumedUnit",
  pricingQuantity: "PricingQuantity",
  pricingUnit: "PricingUnit",
  tags: "Tags",
  chargeCategory: "ChargeCategory",
  commitmentDiscountId: "CommitmentDiscountId",
} as const;

/** True when a header row is a FOCUS cost and usage export. */
export function isFocusHeader(headers: string[]): boolean {
  const set = new Set(headers.map((h) => h.trim()));
  return (
    set.has(FOCUS_COLUMNS.cost) && set.has(FOCUS_COLUMNS.date) && set.has(FOCUS_COLUMNS.currency)
  );
}

/**
 * FOCUS `ChargeCategory` (+ whether a commitment discount applies) → our charge
 * type. Usage a commitment covered is `commitment_covered_usage`, which is what
 * commitment coverage is measured from; a Purchase with a commitment id is the
 * commitment fee.
 */
export function focusChargeType(category: string, commitmentId: string): string {
  switch (category.trim().toLowerCase()) {
    case "usage":
      return commitmentId ? "commitment_covered_usage" : "usage";
    case "purchase":
      return commitmentId ? "commitment_fee" : "other";
    case "tax":
      return "tax";
    case "credit":
      return "credit";
    case "adjustment":
      return "adjustment";
    default:
      return "usage";
  }
}

// ─── Values ─────────────────────────────────────────────────────────────────

export type DateFormat = "auto" | "ymd" | "mdy" | "dmy";

const ISO_DATE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;
const SLASH_DATE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:$|[T\s])/;
const OFFSET_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[+-]\d{2}:?\d{2})$/;

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Which order a column's `a/b/yyyy` dates are in. A first part above 12 can
 * only be a day; a second part above 12 can only be a day. A column where
 * neither ever happens is genuinely ambiguous, reported so the UI can ask.
 */
export function detectDateFormat(values: string[]): { format: DateFormat; ambiguous: boolean } {
  let sawSlash = false;
  for (const raw of values) {
    const m = SLASH_DATE.exec(raw.trim());
    if (!m) continue;
    sawSlash = true;
    if (Number(m[1]) > 12) return { format: "dmy", ambiguous: false };
    if (Number(m[2]) > 12) return { format: "mdy", ambiguous: false };
  }
  return sawSlash ? { format: "mdy", ambiguous: true } : { format: "ymd", ambiguous: false };
}

/**
 * A cell → `YYYY-MM-DD` (UTC day), or null. Accepts ISO dates and datetimes
 * (an explicit offset is converted to UTC, as FOCUS timestamps are), `YYYY-MM`
 * for monthly invoices (the 1st), `YYYYMMDD`, and `a/b/yyyy` in the given order.
 */
export function parseCostDate(raw: string, format: DateFormat = "auto"): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (OFFSET_DATETIME.test(value)) {
    const parsed = new Date(value.replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  let m = ISO_DATE.exec(value);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = ISO_MONTH.exec(value);
  if (m) return ymd(Number(m[1]), Number(m[2]), 1);
  m = COMPACT_DATE.exec(value);
  if (m) return ymd(Number(m[1]), Number(m[2]), Number(m[3]));
  m = SLASH_DATE.exec(value);
  if (m) {
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const a = Number(m[1]);
    const b = Number(m[2]);
    return format === "dmy" ? ymd(year, b, a) : ymd(year, a, b);
  }
  return null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
  "₹": "INR",
};

/**
 * A money or quantity cell → number, or null. Handles `(12.50)` accounting
 * negatives, currency symbols and codes, spaces, and both `1,234.56` and
 * `1.234,56` grouping (the last separator present is the decimal point, and a
 * lone comma followed by exactly three digits groups thousands).
 */
export function parseCostNumber(raw: string): number | null {
  let value = raw.trim();
  if (!value) return null;
  // Scientific notation (exports of tiny per-hour amounts) before the symbol
  // stripping below eats the `e`.
  if (/^[-+]?(\d+\.?\d*|\.\d+)e[-+]?\d+$/i.test(value)) return Number(value);
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/[A-Za-z$€£¥₹\s ']/g, "");
  if (value.startsWith("-")) {
    negative = !negative;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  if (lastComma !== -1 && lastDot !== -1) {
    value =
      lastComma > lastDot ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  } else if (lastComma !== -1) {
    value = /^\d{1,3}(,\d{3})+$/.test(value) ? value.replace(/,/g, "") : value.replace(",", ".");
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** A currency cell → ISO code, or null. Accepts codes in any case and the common symbols. */
export function parseCurrency(raw: string): string | null {
  const value = raw.trim();
  if (/^[A-Za-z]{3}$/.test(value)) return value.toUpperCase();
  return CURRENCY_SYMBOLS[value] ?? null;
}

/**
 * A tags cell → map. Accepts a JSON object (FOCUS `Tags`, BigQuery exports) or
 * `key=value` / `key:value` pairs separated by `;`, `,` or `|`.
 */
export function parseTagsCell(raw: string): Record<string, string> | null {
  const value = raw.trim();
  if (!value) return {};
  if (value.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const tags: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v === null || v === undefined) continue;
        tags[k] = typeof v === "string" ? v : JSON.stringify(v);
      }
      return tags;
    } catch {
      return null;
    }
  }
  const tags: Record<string, string> = {};
  for (const part of value.split(/[;,|]/)) {
    const pair = part.trim();
    if (!pair) continue;
    const sep = pair.search(/[=:]/);
    if (sep <= 0) return null;
    tags[pair.slice(0, sep).trim()] = pair.slice(sep + 1).trim();
  }
  return tags;
}

// ─── Building rows ──────────────────────────────────────────────────────────

/** How to read a parsed table. */
export type CustomCostPlan =
  | { format: "csv"; mapping: CsvColumnMapping; dateFormat?: DateFormat | undefined }
  | { format: "focus" };

export interface CustomCostRowError {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  message: string;
}

export interface CustomCostBuildResult {
  /** Aggregated daily rows, ready to upload. */
  rows: CustomCostRow[];
  /** The first {@link CUSTOM_COST_LIMITS.maxReportedErrors} problems. */
  errors: CustomCostRowError[];
  /** Every line rejected, including those beyond the reported cap. */
  errorCount: number;
  /** Data lines read (before aggregation). */
  lineCount: number;
  fromDate: string | null;
  toDate: string | null;
  totals: Record<string, number>;
  /** The CSV's slash dates could be either order; the UI should ask. */
  ambiguousDates: boolean;
}

/** Reserved tag-key prefix the server rejects. */
const RESERVED_TAG_PREFIX = "infrawrench:";
const MAX_FIELD = 256;
const MAX_TAGS = 32;

interface RawRow extends CustomCostRow {
  line: number;
}

function csvRow(
  cells: string[],
  headers: string[],
  plan: Extract<CustomCostPlan, { format: "csv" }>,
  dateFormat: DateFormat,
  defaultCurrency: string | null,
): Omit<RawRow, "line"> | string {
  const m = plan.mapping;
  const cell = (index: number | null): string =>
    index === null ? "" : (cells[index] ?? "").trim();
  if (m.date === null) return "No column is mapped to the date.";
  if (m.cost === null) return "No column is mapped to the cost.";

  const date = parseCostDate(cell(m.date), dateFormat);
  if (!date) return `Unreadable date "${cell(m.date)}".`;
  const amount = parseCostNumber(cell(m.cost));
  if (amount === null) return `Unreadable cost "${cell(m.cost)}".`;
  let currency = defaultCurrency;
  if (m.currency !== null && cell(m.currency)) {
    currency = parseCurrency(cell(m.currency));
    if (!currency) return `Unreadable currency "${cell(m.currency)}" (expected a 3-letter code).`;
  }
  if (!currency) return "No currency: map a currency column or set the source's default currency.";

  let tags: Record<string, string> = {};
  if (m.tags !== null) {
    const parsed = parseTagsCell(cell(m.tags));
    if (!parsed) return `Unreadable tags "${cell(m.tags)}" (expected JSON or key=value pairs).`;
    tags = parsed;
  }
  for (const index of m.tagColumns) {
    const value = cell(index);
    const key = headers[index]?.trim();
    if (key && value) tags[key] = value;
  }

  let usageAmount: number | undefined;
  if (m.usageQuantity !== null && cell(m.usageQuantity)) {
    const n = parseCostNumber(cell(m.usageQuantity));
    if (n === null) return `Unreadable usage quantity "${cell(m.usageQuantity)}".`;
    usageAmount = n;
  }

  return {
    date,
    currency,
    amount,
    service: cell(m.service) || undefined,
    region: cell(m.region) || undefined,
    resourceId: cell(m.resource) || undefined,
    subAccount: cell(m.account) || undefined,
    tags,
    usageAmount,
    usageUnit: cell(m.usageUnit) || undefined,
  };
}

function focusRow(
  cells: string[],
  index: Map<string, number>,
): Omit<RawRow, "line"> | string | null {
  const cell = (name: string): string => {
    const i = index.get(name);
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };
  const date = parseCostDate(cell(FOCUS_COLUMNS.date));
  if (!date) return `Unreadable ChargePeriodStart "${cell(FOCUS_COLUMNS.date)}".`;
  const billed = cell(FOCUS_COLUMNS.cost);
  const amount = billed === "" ? 0 : parseCostNumber(billed);
  if (amount === null) return `Unreadable BilledCost "${billed}".`;
  const currency = parseCurrency(cell(FOCUS_COLUMNS.currency));
  if (!currency) return `Unreadable BillingCurrency "${cell(FOCUS_COLUMNS.currency)}".`;

  let amortizedAmount: number | undefined;
  if (index.has(FOCUS_COLUMNS.amortizedCost) && cell(FOCUS_COLUMNS.amortizedCost) !== "") {
    const n = parseCostNumber(cell(FOCUS_COLUMNS.amortizedCost));
    if (n === null) return `Unreadable EffectiveCost "${cell(FOCUS_COLUMNS.amortizedCost)}".`;
    amortizedAmount = n;
  }

  let usageAmount: number | undefined;
  let usageUnit = cell(FOCUS_COLUMNS.consumedUnit);
  const consumed = cell(FOCUS_COLUMNS.consumedQuantity);
  const pricing = cell(FOCUS_COLUMNS.pricingQuantity);
  if (consumed) {
    usageAmount = parseCostNumber(consumed) ?? undefined;
  } else if (pricing) {
    usageAmount = parseCostNumber(pricing) ?? undefined;
    usageUnit = cell(FOCUS_COLUMNS.pricingUnit);
  }

  const tagsCell = cell(FOCUS_COLUMNS.tags);
  const tags = tagsCell ? parseTagsCell(tagsCell) : {};
  if (!tags) return `Unreadable Tags "${tagsCell}" (FOCUS tags are a JSON object).`;

  const commitmentId = cell(FOCUS_COLUMNS.commitmentDiscountId);
  const category = cell(FOCUS_COLUMNS.chargeCategory);

  // A FOCUS row carrying no money on either basis and no quantity is noise.
  if (amount === 0 && !amortizedAmount && !usageAmount) return null;

  return {
    date,
    currency,
    amount,
    amortizedAmount,
    service: cell(FOCUS_COLUMNS.service) || undefined,
    region: cell(FOCUS_COLUMNS.regionId) || cell(FOCUS_COLUMNS.regionName) || undefined,
    resourceId: cell(FOCUS_COLUMNS.resourceId) || cell(FOCUS_COLUMNS.resourceName) || undefined,
    subAccount:
      cell(FOCUS_COLUMNS.subAccountName) ||
      cell(FOCUS_COLUMNS.subAccountId) ||
      cell(FOCUS_COLUMNS.billingAccountName) ||
      cell(FOCUS_COLUMNS.billingAccountId) ||
      undefined,
    tags,
    usageAmount,
    usageUnit: usageUnit || undefined,
    chargeType: category ? focusChargeType(category, commitmentId) : undefined,
    commitmentId: commitmentId || undefined,
  };
}

/** Bounds the server would reject on, checked here so the preview shows them per line. */
function boundsProblem(row: Omit<RawRow, "line">): string | null {
  for (const [field, value] of [
    ["service", row.service],
    ["region", row.region],
    ["resource", row.resourceId],
    ["account", row.subAccount],
    ["usage unit", row.usageUnit],
  ] as const) {
    if (value && value.length > MAX_FIELD) {
      return `The ${field} is longer than ${MAX_FIELD} characters.`;
    }
  }
  const tags = Object.entries(row.tags ?? {});
  if (tags.length > MAX_TAGS) return `More than ${MAX_TAGS} tags.`;
  for (const [key, value] of tags) {
    if (key.startsWith(RESERVED_TAG_PREFIX)) {
      return `Tag key "${key}" uses the reserved "${RESERVED_TAG_PREFIX}" prefix.`;
    }
    if (key.length > MAX_FIELD || value.length > MAX_FIELD) {
      return `Tag "${key.slice(0, 40)}" is longer than ${MAX_FIELD} characters.`;
    }
  }
  return null;
}

/**
 * The dedupe identity of a row in `cost_daily`: account, day, service, region,
 * resource, tags (+ charge type and commitment, which the server folds into
 * the tag hash), currency. Two lines with the same identity must be summed
 * here, or the second would *replace* the first on insert.
 */
function aggregationKey(row: CustomCostRow): string {
  const tags = Object.keys(row.tags ?? {})
    .sort()
    .map((k) => `${k}=${row.tags![k]}`)
    .join("\u0001");
  return [
    row.subAccount ?? "",
    row.date,
    row.service ?? "",
    row.region ?? "",
    row.resourceId ?? "",
    tags,
    row.chargeType ?? "usage",
    row.commitmentId ?? "",
    row.currency,
  ].join("\u0000");
}

/** Round away float drift from summing many small amounts. */
function round(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

/**
 * Turn a parsed table into aggregated daily rows plus per-line problems.
 * Lines with a problem are skipped (and reported); everything else is kept, so
 * the preview can show exactly what an upload would write.
 */
export function buildCustomCostRows(
  table: ParsedTable,
  plan: CustomCostPlan,
  options: { defaultCurrency?: string | null | undefined } = {},
): CustomCostBuildResult {
  const errors: CustomCostRowError[] = [];
  let errorCount = 0;
  const report = (line: number, message: string) => {
    errorCount++;
    if (errors.length < CUSTOM_COST_LIMITS.maxReportedErrors) errors.push({ line, message });
  };

  let dateFormat: DateFormat = "ymd";
  let ambiguousDates = false;
  if (plan.format === "csv" && plan.mapping.date !== null) {
    const detected = detectDateFormat(table.rows.map((r) => r[plan.mapping.date!] ?? ""));
    ambiguousDates = detected.ambiguous;
    dateFormat = plan.dateFormat && plan.dateFormat !== "auto" ? plan.dateFormat : detected.format;
  }
  const focusIndex = new Map(table.headers.map((h, i) => [h.trim(), i] as const));
  const defaultCurrency = options.defaultCurrency ? options.defaultCurrency.toUpperCase() : null;

  const aggregated = new Map<string, CustomCostRow>();
  table.rows.forEach((cells, i) => {
    const line = i + 2;
    const built =
      plan.format === "focus"
        ? focusRow(cells, focusIndex)
        : csvRow(cells, table.headers, plan, dateFormat, defaultCurrency);
    if (built === null) return;
    if (typeof built === "string") {
      report(line, built);
      return;
    }
    const problem = boundsProblem(built);
    if (problem) {
      report(line, problem);
      return;
    }
    const key = aggregationKey(built);
    const existing = aggregated.get(key);
    if (!existing) {
      aggregated.set(key, { ...built });
      return;
    }
    existing.amount = round(existing.amount + built.amount);
    if (built.amortizedAmount !== undefined) {
      existing.amortizedAmount = round((existing.amortizedAmount ?? 0) + built.amortizedAmount);
    }
    if (built.usageAmount !== undefined) {
      // Quantities only sum within one unit; a second unit on the same key
      // would make the sum meaningless, so the first unit's total stands.
      if (!existing.usageUnit || !built.usageUnit || existing.usageUnit === built.usageUnit) {
        existing.usageAmount = round((existing.usageAmount ?? 0) + built.usageAmount);
        existing.usageUnit ??= built.usageUnit;
      }
    }
  });

  const rows = [...aggregated.values()].map((row) => {
    const out: CustomCostRow = { date: row.date, currency: row.currency, amount: row.amount };
    if (row.service) out.service = row.service;
    if (row.region) out.region = row.region;
    if (row.resourceId) out.resourceId = row.resourceId;
    if (row.subAccount) out.subAccount = row.subAccount;
    if (row.tags && Object.keys(row.tags).length > 0) out.tags = row.tags;
    if (row.usageAmount !== undefined) out.usageAmount = row.usageAmount;
    if (row.usageUnit) out.usageUnit = row.usageUnit;
    if (row.chargeType && row.chargeType !== "usage") out.chargeType = row.chargeType;
    if (row.amortizedAmount !== undefined) out.amortizedAmount = row.amortizedAmount;
    if (row.commitmentId) out.commitmentId = row.commitmentId;
    return out;
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const summary = summarizeCustomCostRows(rows);
  return {
    rows,
    errors,
    errorCount,
    lineCount: table.rows.length,
    fromDate: summary.fromDate,
    toDate: summary.toDate,
    totals: summary.totals,
    ambiguousDates,
  };
}

/** Date range and per-currency totals of a set of rows. */
export function summarizeCustomCostRows(rows: CustomCostRow[]): {
  fromDate: string | null;
  toDate: string | null;
  totals: Record<string, number>;
} {
  let fromDate: string | null = null;
  let toDate: string | null = null;
  const totals: Record<string, number> = {};
  for (const row of rows) {
    if (fromDate === null || row.date < fromDate) fromDate = row.date;
    if (toDate === null || row.date > toDate) toDate = row.date;
    totals[row.currency] = round((totals[row.currency] ?? 0) + row.amount);
  }
  return { fromDate, toDate, totals };
}

/** Uploads in `uploads` whose range intersects `[from, to]` and that still hold rows. */
export function overlappingCustomCostUploads(
  uploads: CustomCostUpload[],
  from: string,
  to: string,
): CustomCostUpload[] {
  return uploads.filter(
    (u) => u.status !== "replaced" && u.rowCount > 0 && u.fromDate <= to && u.toDate >= from,
  );
}

// ─── Uploading ──────────────────────────────────────────────────────────────

/** The minimal transport the upload sequence needs; both apps and the CLI supply one. */
export interface CustomCostUploadTransport {
  post<T>(path: string, body: unknown): Promise<T>;
}

/**
 * Upload built rows into a source: create the upload, send the rows in
 * chunks, then complete it (which is when a `replace` takes effect, so an
 * upload that dies halfway never deletes the spend it was replacing).
 *
 * `basePath` is the source's API path, e.g.
 * `/api/org/<org>/custom-cost-sources/<id>` (web/desktop) or
 * `/custom-cost-sources/<id>` (an org-scoped CLI transport).
 */
export async function uploadCustomCostRows(opts: {
  transport: CustomCostUploadTransport;
  basePath: string;
  rows: CustomCostRow[];
  format: CustomCostFormat;
  fileName?: string | null | undefined;
  mode?: CustomCostUploadMode | undefined;
  via: CustomCostUpload["via"];
  onProgress?: ((sent: number, total: number) => void) | undefined;
}): Promise<CustomCostUpload> {
  const { transport, basePath, rows } = opts;
  const summary = summarizeCustomCostRows(rows);
  if (!summary.fromDate || !summary.toDate) throw new Error("Nothing to upload: no valid rows.");
  if (rows.length > CUSTOM_COST_LIMITS.maxRowsPerUpload) {
    throw new Error(
      `An upload holds at most ${CUSTOM_COST_LIMITS.maxRowsPerUpload} daily rows (this file aggregates to ${rows.length}). Split it by date range.`,
    );
  }
  const upload = await transport.post<CustomCostUpload>(`${basePath}/uploads`, {
    fileName: opts.fileName ?? null,
    format: opts.format,
    ...(opts.mode ? { mode: opts.mode } : {}),
    via: opts.via,
    fromDate: summary.fromDate,
    toDate: summary.toDate,
  });
  const size = CUSTOM_COST_LIMITS.maxRowsPerChunk;
  for (let i = 0; i < rows.length; i += size) {
    await transport.post(`${basePath}/uploads/${upload.id}/rows`, {
      rows: rows.slice(i, i + size),
    });
    opts.onProgress?.(Math.min(i + size, rows.length), rows.length);
  }
  return transport.post<CustomCostUpload>(`${basePath}/uploads/${upload.id}/complete`, {});
}
