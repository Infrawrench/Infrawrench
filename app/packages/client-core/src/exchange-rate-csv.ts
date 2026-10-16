/**
 * Bulk exchange rates from a CSV file: the parser, the per-row validation and
 * the template, shared by the Currency settings page (preview before upload),
 * the API (`POST /currency/rates/import`, which re-validates everything) and
 * the CLI (`infrawrench currency import`).
 *
 * Pure and dependency-free, so the rules a preview shows are byte-for-byte the
 * rules the server applies: a row the preview calls valid is never refused
 * after upload for a reason the preview could have known.
 *
 * ## The file
 *
 * One rate per line, with a header row. Columns are matched by name, case and
 * punctuation insensitive, so `From`, `from_currency` and `From Currency` all
 * work (spreadsheet exports rarely agree on spelling). Each row needs a pair
 * and a rate, plus **either** an effective date **or** a billing period:
 *
 * - `effective_from` (+ optional `effective_to`): the same open-ended or
 *   bounded rate the single-rate form states.
 * - `billing_period` (`YYYY-MM`): shorthand for "this rate, for exactly this
 *   month", i.e. `effective_from` = the 1st and `effective_to` = the last day.
 *   This is the shape a month-end close produces, and the bounded end matters:
 *   the day after the month falls back to the next rate or the automatic feed
 *   instead of carrying a stale close rate forward indefinitely.
 *
 * Uploaded rows are ordinary stated rates. Nothing about an upload ranks
 * differently from a rate typed into the form, which is why there is no
 * "source" column: a stated rate always wins over the automatic feed for the
 * days it covers (see `RateBook` in server-core).
 */
import { parseCsv } from "./custom-costs";
import { EXCHANGE_RATE_LIMITS, normalizeCurrencyCode, type ExchangeRateInput } from "./currency";

/** Bounds on one upload. The server enforces the same numbers. */
export const EXCHANGE_RATE_CSV_LIMITS = {
  /** Data rows per file. Matches the whole table's cap, so one file can fill it. */
  maxRows: EXCHANGE_RATE_LIMITS.maxRates,
  /** Characters per file: 2,000 rows of a generous width. */
  maxChars: 512 * 1024,
} as const;

/** Canonical column names, in template order. */
export const EXCHANGE_RATE_CSV_COLUMNS = [
  "from",
  "to",
  "rate",
  "effective_from",
  "effective_to",
  "billing_period",
] as const;
export type ExchangeRateCsvColumn = (typeof EXCHANGE_RATE_CSV_COLUMNS)[number];

/**
 * Accepted header spellings, after {@link normalizeHeader}. The first entry of
 * each list is the canonical name the template uses.
 */
const HEADER_ALIASES: Record<ExchangeRateCsvColumn, readonly string[]> = {
  from: ["from", "fromcurrency", "source", "sourcecurrency", "base", "basecurrency"],
  to: ["to", "tocurrency", "target", "targetcurrency", "quote", "quotecurrency"],
  rate: ["rate", "exchangerate", "fxrate", "value"],
  effective_from: [
    "effectivefrom",
    "effectivedate",
    "date",
    "fromdate",
    "startdate",
    "start",
    "validfrom",
  ],
  effective_to: ["effectiveto", "todate", "enddate", "end", "until", "validto", "validuntil"],
  billing_period: ["billingperiod", "period", "month", "billingmonth"],
};

/** Lower-case, letters and digits only: `From Currency` → `fromcurrency`. */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * The downloadable template: the header plus three example rows, one per
 * shape (open-ended, bounded override, billing period). The examples are
 * plausible but deliberately round, so nobody mistakes them for real rates.
 */
export const EXCHANGE_RATE_CSV_TEMPLATE =
  `${EXCHANGE_RATE_CSV_COLUMNS.join(",")}\n` +
  "EUR,USD,1.08,2026-01-01,,\n" +
  "GBP,USD,1.27,2026-03-01,2026-03-31,\n" +
  "JPY,USD,0.0067,,,2026-04\n";

/** File name the template downloads as. */
export const EXCHANGE_RATE_CSV_TEMPLATE_FILENAME = "exchange-rates-template.csv";

/** One data row of an upload, judged on its own. */
export interface ExchangeRateCsvRow {
  /** 1-based line number in the file, counting the header as line 1. */
  line: number;
  /** The normalized rate, or null when the row is invalid. */
  input: ExchangeRateInput | null;
  /** Why the row is invalid, in English (translated at the UI edge by code). */
  error: string | null;
}

export interface ExchangeRateCsvParse {
  /** Every data row, valid or not, in file order. */
  rows: ExchangeRateCsvRow[];
  /**
   * A problem with the file as a whole (no header, a missing column, too many
   * rows). When set, `rows` is empty: nothing in the file can be trusted to
   * mean what its columns say.
   */
  fileError: string | null;
  /** Which canonical column each header cell was read as, for the preview. */
  columns: Partial<Record<ExchangeRateCsvColumn, string>>;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD = /^(\d{4})-(\d{2})$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/** A real calendar day (rejects 2026-02-30, which the regex alone accepts). */
export function isValidIsoDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** `YYYY-MM` to its first and last day, or null when it is not a month. */
export function billingPeriodBounds(period: string): { from: string; to: string } | null {
  const m = PERIOD.exec(period.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, "0");
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, "0")}` };
}

/**
 * Normalize a rate cell to the decimal string the API stores, or null.
 *
 * Accepts a comma as the decimal separator when it is the only separator
 * (`1,0850`), which is what a spreadsheet in a comma-decimal locale writes.
 * Thousands separators are refused rather than guessed at: `1,085` could be
 * either, and a rate off by a factor of a thousand is the worst possible
 * silent error in this table.
 */
export function normalizeRateCell(raw: string): string | null {
  let s = raw.trim();
  if (s === "") return null;
  if (!s.includes(".") && /^\d+,\d+$/.test(s)) s = s.replace(",", ".");
  if (!DECIMAL.test(s)) return null;
  // Trim to the column's scale; more digits than that is noise from a float.
  const [whole, frac] = s.split(".");
  const trimmedFrac = (frac ?? "").slice(0, EXCHANGE_RATE_LIMITS.rateScale).replace(/0+$/, "");
  const normalized = trimmedFrac ? `${whole}.${trimmedFrac}` : whole!;
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return normalized.replace(/^0+(?=\d)/, "");
}

/** The row's unique key, matching the table's unique index. */
export function exchangeRateKey(input: {
  fromCurrency: string;
  toCurrency: string;
  effectiveFrom: string;
}): string {
  return `${input.fromCurrency}>${input.toCurrency}@${input.effectiveFrom}`;
}

function judgeRow(cells: Record<ExchangeRateCsvColumn, string>): ExchangeRateInput | string {
  const fromRaw = cells.from.trim();
  const toRaw = cells.to.trim();
  const fromCurrency = normalizeCurrencyCode(fromRaw);
  const toCurrency = normalizeCurrencyCode(toRaw);
  if (!fromCurrency) {
    return fromRaw ? `"${fromRaw}" is not a three-letter currency code` : "from is empty";
  }
  if (!toCurrency) {
    return toRaw ? `"${toRaw}" is not a three-letter currency code` : "to is empty";
  }
  if (fromCurrency === toCurrency) return `a rate from ${fromCurrency} to itself has no meaning`;

  const rateRaw = cells.rate.trim();
  if (rateRaw === "") return "rate is empty";
  const rate = normalizeRateCell(rateRaw);
  if (rate === null) return `"${rateRaw}" is not a decimal number`;
  const value = Number(rate);
  if (value < EXCHANGE_RATE_LIMITS.rateMin) return "rate must be greater than 0";
  if (value > EXCHANGE_RATE_LIMITS.rateMax) {
    return `rate must be at most ${EXCHANGE_RATE_LIMITS.rateMax}`;
  }

  const fromDay = cells.effective_from.trim();
  const toDay = cells.effective_to.trim();
  const period = cells.billing_period.trim();
  if (period) {
    if (fromDay || toDay) {
      return "give either a billing period or effective dates, not both";
    }
    const bounds = billingPeriodBounds(period);
    if (!bounds) return `"${period}" is not a billing period (expected YYYY-MM)`;
    return { fromCurrency, toCurrency, rate, effectiveFrom: bounds.from, effectiveTo: bounds.to };
  }
  if (!fromDay) return "needs an effective_from date or a billing_period";
  if (!isValidIsoDay(fromDay)) return `"${fromDay}" is not a date (expected YYYY-MM-DD)`;
  if (toDay && !isValidIsoDay(toDay)) return `"${toDay}" is not a date (expected YYYY-MM-DD)`;
  if (toDay && toDay < fromDay) return "effective_to is before effective_from";
  return { fromCurrency, toCurrency, rate, effectiveFrom: fromDay, effectiveTo: toDay || null };
}

/**
 * Parse and validate an upload. Never throws: every problem is a `fileError`
 * or a row `error`, because the caller's job is to show all of them at once
 * (a finance user fixing a 300-line file one error per round trip would not
 * finish).
 *
 * A pair and effective date that appears twice in one file is an error on the
 * second occurrence: the table holds one rate per pair per day, so the file
 * would otherwise mean "whichever row happened to be written last".
 */
export function parseExchangeRateCsv(text: string): ExchangeRateCsvParse {
  if (text.length > EXCHANGE_RATE_CSV_LIMITS.maxChars) {
    return {
      rows: [],
      columns: {},
      fileError: `The file is larger than ${Math.round(EXCHANGE_RATE_CSV_LIMITS.maxChars / 1024)} KB; split it into smaller files.`,
    };
  }
  const table = parseCsv(text);
  if (table.headers.length === 0) {
    return { rows: [], columns: {}, fileError: "The file is empty." };
  }

  const columns: Partial<Record<ExchangeRateCsvColumn, string>> = {};
  const index: Partial<Record<ExchangeRateCsvColumn, number>> = {};
  table.headers.forEach((header, i) => {
    const norm = normalizeHeader(header);
    for (const column of EXCHANGE_RATE_CSV_COLUMNS) {
      if (index[column] === undefined && HEADER_ALIASES[column].includes(norm)) {
        index[column] = i;
        columns[column] = header;
        return;
      }
    }
  });
  const missing = (["from", "to", "rate"] as const).filter((c) => index[c] === undefined);
  if (missing.length > 0) {
    return {
      rows: [],
      columns,
      fileError: `Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. The header row needs from, to, rate, and effective_from or billing_period.`,
    };
  }
  if (index.effective_from === undefined && index.billing_period === undefined) {
    return {
      rows: [],
      columns,
      fileError: "Missing column: the header row needs effective_from or billing_period.",
    };
  }
  if (table.rows.length === 0) {
    return { rows: [], columns, fileError: "The file has a header row but no rates." };
  }
  if (table.rows.length > EXCHANGE_RATE_CSV_LIMITS.maxRows) {
    return {
      rows: [],
      columns,
      fileError: `The file has ${table.rows.length} rates; one upload takes at most ${EXCHANGE_RATE_CSV_LIMITS.maxRows}.`,
    };
  }

  // Line numbers: `parseCsv` drops blank lines, so count from the header as 1
  // and number data rows in order. A quoted cell containing a newline would
  // shift a raw-line count anyway; row order is what a spreadsheet shows.
  const seen = new Map<string, number>();
  const rows: ExchangeRateCsvRow[] = table.rows.map((cells, i) => {
    const line = i + 2;
    const pick = (c: ExchangeRateCsvColumn) => {
      const at = index[c];
      return at === undefined ? "" : (cells[at] ?? "");
    };
    const judged = judgeRow({
      from: pick("from"),
      to: pick("to"),
      rate: pick("rate"),
      effective_from: pick("effective_from"),
      effective_to: pick("effective_to"),
      billing_period: pick("billing_period"),
    });
    if (typeof judged === "string") return { line, input: null, error: judged };
    const key = exchangeRateKey(judged);
    const first = seen.get(key);
    if (first !== undefined) {
      return {
        line,
        input: null,
        error: `duplicates line ${first} (same pair and effective date)`,
      };
    }
    seen.set(key, line);
    return { line, input: judged, error: null };
  });

  return { rows, columns, fileError: null };
}

/* ------------------------------------------------------------------ *
 * The API contract: POST /currency/rates/import
 * ------------------------------------------------------------------ */

/** What an upload would do (or did) to one row. */
export const EXCHANGE_RATE_IMPORT_ACTIONS = ["create", "update", "unchanged", "error"] as const;
export type ExchangeRateImportAction = (typeof EXCHANGE_RATE_IMPORT_ACTIONS)[number];

export interface ExchangeRateImportRequest {
  /** The file's text. Parsed and validated on the server with the same rules. */
  csv: string;
  /** Validate and classify only; write nothing. */
  dryRun?: boolean | undefined;
  /**
   * Write the valid rows even when others are invalid. Off by default: an
   * upload with errors writes nothing, so a half-applied file never leaves the
   * table in a state nobody chose.
   */
  skipInvalid?: boolean | undefined;
}

export interface ExchangeRateImportRow {
  line: number;
  action: ExchangeRateImportAction;
  /** The normalized rate; absent on an `error` row. */
  rate?: ExchangeRateInput | undefined;
  /** The stored rate an `update` replaces, as stored. */
  previousRate?: string | undefined;
  /** The stored end date an `update` replaces. */
  previousEffectiveTo?: string | null | undefined;
  error?: string | undefined;
}

export interface ExchangeRateImportResult {
  /** True when nothing was written (a dry run, or a refused upload). */
  dryRun: boolean;
  /** True when the rows were written. */
  applied: boolean;
  rows: ExchangeRateImportRow[];
  counts: Record<ExchangeRateImportAction, number>;
  /** A whole-file problem; `rows` is then empty. */
  fileError: string | null;
}

/** Tally actions, for the summary line every surface prints. */
export function countExchangeRateImportActions(
  rows: readonly Pick<ExchangeRateImportRow, "action">[],
): Record<ExchangeRateImportAction, number> {
  const counts: Record<ExchangeRateImportAction, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    error: 0,
  };
  for (const row of rows) counts[row.action] += 1;
  return counts;
}

/**
 * Two stated rates say the same thing: same decimal value (so `1.08` and
 * `1.0800000000` match, which is how `numeric` echoes it back) and same end.
 */
export function sameStatedRate(
  a: { rate: string; effectiveTo: string | null | undefined },
  b: { rate: string; effectiveTo: string | null | undefined },
): boolean {
  return Number(a.rate) === Number(b.rate) && (a.effectiveTo ?? null) === (b.effectiveTo ?? null);
}
