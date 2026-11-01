import type { Cell, ColumnFormat, QueryResult, StoredView, ViewColumn } from "./types";

/** A result column with how to show it. */
export interface DisplayColumn {
  index: number;
  name: string;
  label: string;
  format: ColumnFormat;
  numeric: boolean;
}

const NUMERIC = /^(?:Nullable\()?(?:LowCardinality\()?(?:U?Int\d+|Float\d+|Decimal)/;

/** The format a column gets when the view does not say. */
export function inferFormat(name: string, type: string): ColumnFormat {
  const n = name.toLowerCase();
  if (/^(?:Nullable\()?Bool/.test(type)) return "bool";
  if (/^(?:Nullable\()?DateTime/.test(type)) return "datetime";
  if (/^(?:Nullable\()?Date/.test(type)) return "date";
  if (n === "instance_type" || n === "instance") return "instance";
  if (NUMERIC.test(type)) {
    if (/usd|price|cost/.test(n)) {
      if (/month/.test(n)) return "usd_month";
      if (/hour|hourly|hr\b/.test(n)) return "usd_hour";
      return "usd";
    }
    if (/gib|memory/.test(n)) return "gib";
    if (/pct|percent/.test(n)) return "percent";
    return "number";
  }
  return "text";
}

/** The view's columns in result order, with labels and formats. */
export function displayColumns(view: StoredView, result: QueryResult): DisplayColumn[] {
  const specs = new Map<string, ViewColumn>(
    view.kind === "table" ? (view.columns ?? []).map((c) => [c.name, c]) : [],
  );
  return result.columns.map((c, index) => {
    const spec = specs.get(c.name);
    const format = spec?.format ?? inferFormat(c.name, c.type);
    return {
      index,
      name: c.name,
      label: spec?.label ?? c.name,
      format,
      numeric:
        NUMERIC.test(c.type) ||
        ["number", "usd", "usd_hour", "usd_month", "gib", "percent"].includes(format),
    };
  });
}

/**
 * The platform a view's instance types belong to when its rows do not say:
 * the one its query filters on (`platform = 'rds'`), else EC2.
 */
export function viewPlatform(sql: string): string {
  const matches = [...sql.matchAll(/\bplatform\s*=\s*'([a-z0-9]+)'/gi)].map((m) =>
    m[1]!.toLowerCase(),
  );
  return new Set(matches).size === 1 ? matches[0]! : "ec2";
}

/** ClickHouse's `YYYY-MM-DD hh:mm:ss` (UTC) as Unix seconds. */
export function parseDateTime(value: Cell): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(value);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)) / 1000;
}

/** Suffixes, translated by the caller. */
export interface Units {
  perHour: (price: string) => string;
  perMonth: (price: string) => string;
  gib: (amount: string) => string;
  yes: string;
  no: string;
}

/** Enough digits to tell small hourly prices apart, and no more. */
function usd(value: number, locale: string): string {
  const abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 5 : abs < 1 ? 4 : abs < 1000 ? 2 : 0;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  }).format(value);
}

export function formatCell(
  value: Cell,
  format: ColumnFormat,
  locale: string,
  units: Units,
): string {
  if (value === null || value === "") return "";
  const n = typeof value === "number" ? value : Number(value);
  switch (format) {
    case "usd":
      return Number.isFinite(n) ? usd(n, locale) : String(value);
    case "usd_hour":
      return Number.isFinite(n) ? units.perHour(usd(n, locale)) : String(value);
    case "usd_month":
      return Number.isFinite(n) ? units.perMonth(usd(n, locale)) : String(value);
    case "gib":
      return Number.isFinite(n)
        ? units.gib(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n))
        : String(value);
    case "percent":
      return Number.isFinite(n)
        ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n)}%`
        : String(value);
    case "number":
      return Number.isFinite(n)
        ? new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(n)
        : String(value);
    case "bool":
      return value === true || value === 1 || value === "true" ? units.yes : units.no;
    case "date":
    case "datetime": {
      const t = parseDateTime(value);
      if (t === null) return String(value);
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        ...(format === "datetime" ? { timeStyle: "short" } : {}),
        timeZone: "UTC",
      }).format(new Date(t * 1000));
    }
    default:
      return String(value);
  }
}

/** A numeric filter (`>4`, `<=0.05`, `2..8`, `=16`), or null when the text is not one. */
export function numericFilter(text: string): ((n: number) => boolean) | null {
  const t = text.trim().replace(/,/g, "");
  const range = /^(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)$/.exec(t);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])];
    return (n) => n >= lo && n <= hi;
  }
  const cmp = /^(<=|>=|<|>|=)\s*(-?[\d.]+)$/.exec(t);
  if (!cmp) return null;
  const v = Number(cmp[2]);
  switch (cmp[1]) {
    case "<":
      return (n) => n < v;
    case "<=":
      return (n) => n <= v;
    case ">":
      return (n) => n > v;
    case ">=":
      return (n) => n >= v;
    default:
      return (n) => n === v;
  }
}

/** The rows as CSV, raw values (not formatted), with a header. */
export function toCsv(columns: DisplayColumn[], rows: Cell[][]): string {
  const esc = (v: Cell) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    columns.map((c) => esc(c.label)).join(","),
    ...rows.map((r) => columns.map((c) => esc(r[c.index] ?? null)).join(",")),
  ].join("\n");
}
