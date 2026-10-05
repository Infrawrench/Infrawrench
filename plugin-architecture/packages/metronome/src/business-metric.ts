import type {
  BusinessMetricSourceDeclaration,
  BusinessMetricSourceOption,
  BusinessMetricSourcePoint,
  BusinessMetricSourceRange,
  BusinessMetricSourceResult,
} from "@infrawrench/plugin-base";
import {
  BUSINESS_METRIC_SOURCE_LIMITS,
  isBusinessMetricDay,
  isValidTimezone,
  localDayOf,
  nextBusinessMetricDay,
  withBusinessMetricTimeout,
  zonedDayStartMs,
} from "@infrawrench/plugin-base";
import type {
  MetronomeApi,
  MetronomeCustomer,
  MetronomeInvoice,
  MetronomeUsageAggregate,
} from "./api.js";
import { PAGE_LIMIT, USD_CENTS_CREDIT_TYPE_ID, creditTypeDivisor, creditTypeUnit } from "./api.js";

/**
 * Metronome as a business-metric source: the denominator of a unit cost is
 * very often exactly what the billing system already meters (API calls, GB
 * processed, seats) or what it invoiced.
 *
 * Two measures:
 *
 * - **usage**: `POST /v1/usage` for one billable metric, in `day` windows, or
 *   `hour` windows summed into local days when that is exact (see
 *   {@link useHourlyWindows}).
 *   https://docs.metronome.com/api-reference/usage/get-batched-usage-data
 * - **revenue**: `GET /v1/customers/{id}/invoices/breakdowns` in `day`
 *   windows, summing each day's invoice totals in one pricing unit.
 *   https://docs.metronome.com/api-reference/invoices/list-invoice-breakdowns
 *
 * Both endpoints only accept windows aligned to UTC midnight. Everything here
 * is a read: no endpoint this file calls can change Metronome state.
 */

export const MEASURE_USAGE = "usage";
export const MEASURE_REVENUE = "revenue";

export const BUSINESS_METRIC_SOURCE: BusinessMetricSourceDeclaration = {
  label: "Metronome usage or revenue",
  description:
    "Import a billable metric's daily usage, or the revenue invoiced each day, from Metronome. Optionally store one value per customer.",
  kind: "metric",
  // Every call is a GET, or the usage query POST, which reads aggregates and
  // writes nothing. A token scoped to read-only access is enough.
  readOnly: "enforced",
  fields: [
    {
      key: "measure",
      label: "Measure",
      type: "select",
      required: true,
      defaultValue: MEASURE_USAGE,
      options: [
        {
          id: MEASURE_USAGE,
          label: "Billable metric usage",
          description: "The daily total of one billable metric, as Metronome aggregates it.",
        },
        {
          id: MEASURE_REVENUE,
          label: "Invoiced revenue",
          description:
            "The daily total of every non-void invoice, from Metronome's daily invoice breakdowns.",
        },
      ],
    },
    {
      key: "billableMetric",
      label: "Billable metric",
      type: "select",
      dependsOn: ["measure"],
      description:
        "The metric to import for usage. Metronome reports usage in UTC days; for SUM and COUNT metrics the importer reads hourly usage and adds it up into days in the importer's timezone, while other aggregations (MAX, UNIQUE, LATEST, SQL) are stored on the UTC day they were measured.",
    },
    {
      key: "creditType",
      label: "Currency or pricing unit",
      type: "select",
      dependsOn: ["measure"],
      defaultValue: USD_CENTS_CREDIT_TYPE_ID,
      description:
        "Which invoices to total for revenue. USD is stored in dollars, not cents. Revenue is stored on the UTC day Metronome bills it to, since invoice breakdowns are only available in UTC days.",
    },
    {
      key: "customer",
      label: "Customer",
      type: "select",
      defaultValue: "",
      description: "Limit the import to one customer, or read every customer.",
    },
    {
      key: "groupByCustomer",
      label: "Break down by customer",
      type: "select",
      required: true,
      defaultValue: "no",
      options: [
        { id: "no", label: "No, store one total per day" },
        { id: "yes", label: "Yes, store a value per customer per day" },
      ],
      description:
        "When on, each day's value is split by customer name, so unit costs can be read per customer. The day's total is unchanged.",
    },
  ],
};

/** Raw API rows one run may page through before giving up, whatever it emits. */
const RAW_ROW_FACTOR = 4;

/** Customers whose revenue is read at once. */
const REVENUE_CONCURRENCY = 4;

/* ------------------------------------------------------------------ *
 * Options.
 * ------------------------------------------------------------------ */

export async function listBusinessMetricSourceOptions(
  api: MetronomeApi,
  fieldKey: string,
  params: Record<string, string>,
): Promise<BusinessMetricSourceOption[]> {
  const measure = params["measure"] || MEASURE_USAGE;
  switch (fieldKey) {
    case "billableMetric": {
      if (measure !== MEASURE_USAGE) return [{ id: "", label: "Not used for revenue" }];
      const metrics = await api.listBillableMetrics();
      return metrics
        .map((m) => ({ id: m.id, label: m.name || m.id, description: describeAggregation(m) }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    case "creditType": {
      if (measure !== MEASURE_REVENUE) return [{ id: "", label: "Not used for usage" }];
      const types = await api.listCreditTypes();
      return types
        .map((t) => ({
          id: t.id,
          label: creditTypeUnit(t.name) || t.name,
          description:
            t.is_currency === false
              ? "Custom pricing unit"
              : creditTypeDivisor(t.name) === 100
                ? "Currency, stored in whole units (Metronome reports cents)"
                : "Currency",
        }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    case "customer": {
      const customers = await api.listCustomers();
      return [
        { id: "", label: "All customers" },
        ...customers
          .map((c) => ({
            id: c.id,
            label: c.name || c.ingest_aliases?.[0] || c.id,
            ...(c.ingest_aliases?.length ? { description: c.ingest_aliases.join(", ") } : {}),
          }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      ];
    }
    default:
      throw new Error(`Metronome has no choices for the field "${fieldKey}".`);
  }
}

function describeAggregation(metric: {
  aggregation_type?: string;
  aggregation_key?: string;
  sql?: string;
}): string {
  if (metric.sql && !metric.aggregation_type) return "SQL metric";
  const type = (metric.aggregation_type ?? "").toUpperCase();
  if (!type) return "";
  return metric.aggregation_key && type !== "COUNT" ? `${type} of ${metric.aggregation_key}` : type;
}

/* ------------------------------------------------------------------ *
 * Run.
 * ------------------------------------------------------------------ */

export async function runBusinessMetricSource(
  api: MetronomeApi,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
): Promise<BusinessMetricSourceResult> {
  validateRange(range);
  const measure = params["measure"] || MEASURE_USAGE;
  const work =
    measure === MEASURE_REVENUE
      ? runRevenue(api, params, range)
      : measure === MEASURE_USAGE
        ? runUsage(api, params, range)
        : Promise.reject(new Error(`Unknown Metronome measure "${measure}".`));
  return withBusinessMetricTimeout(work, range);
}

function validateRange(range: BusinessMetricSourceRange): void {
  if (!isBusinessMetricDay(range.from) || !isBusinessMetricDay(range.to)) {
    throw new Error("The import window must be two YYYY-MM-DD days.");
  }
  if (range.from > range.to) throw new Error("The import window ends before it starts.");
  if (!isValidTimezone(range.timezone)) throw new Error(`Unknown timezone "${range.timezone}".`);
  const days =
    (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > BUSINESS_METRIC_SOURCE_LIMITS.maxDays) {
    throw new Error(
      `The import window is longer than ${BUSINESS_METRIC_SOURCE_LIMITS.maxDays} days.`,
    );
  }
}

function utcMidnightIso(day: string): string {
  return `${day}T00:00:00Z`;
}

/** True when every local day in the range starts exactly at UTC midnight. */
export function isUtcAligned(
  range: Pick<BusinessMetricSourceRange, "from" | "to" | "timezone">,
): boolean {
  const last = nextBusinessMetricDay(range.to);
  for (let day = range.from; day <= last; day = nextBusinessMetricDay(day)) {
    if (zonedDayStartMs(day, range.timezone) !== Date.parse(utcMidnightIso(day))) return false;
  }
  return true;
}

/**
 * Hourly windows are only exact when the metric is additive: an hour's SUM or
 * COUNT adds up into a day, an hour's MAX, UNIQUE or LATEST does not. And they
 * are only needed when the importer's days are not UTC days.
 */
export function useHourlyWindows(
  aggregationType: string | undefined,
  utcAligned: boolean,
): boolean {
  if (utcAligned) return false;
  const type = (aggregationType ?? "").toLowerCase();
  return type === "sum" || type === "count";
}

const DAY_MS = 86_400_000;

function floorUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function ceilUtcDay(ms: number): number {
  return Math.ceil(ms / DAY_MS) * DAY_MS;
}

function checkAborted(range: BusinessMetricSourceRange): void {
  if (range.signal?.aborted) throw new Error("The run was cancelled.");
}

class PointBuckets {
  private readonly values = new Map<string, BusinessMetricSourcePoint>();

  add(date: string, value: number, label: string | undefined): void {
    const key = `${date}\u0000${label ?? ""}`;
    const existing = this.values.get(key);
    if (existing) existing.value += value;
    else this.values.set(key, label ? { date, value, label } : { date, value });
  }

  points(maxRows: number): BusinessMetricSourcePoint[] {
    if (this.values.size > maxRows) {
      throw new Error(
        `Metronome returned more than ${maxRows} daily values. Shorten the window, pick one customer, or turn off the per-customer breakdown.`,
      );
    }
    return [...this.values.values()].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.label ?? "").localeCompare(b.label ?? ""),
    );
  }
}

/** Customer id to display name, archived customers included (they keep history). */
async function customerNames(
  api: MetronomeApi,
  range: BusinessMetricSourceRange,
): Promise<Map<string, string>> {
  const opts = range.signal ? { signal: range.signal } : {};
  const [active, archived] = await Promise.all([
    api.listCustomers(opts),
    api.listCustomers({ ...opts, archived: true }),
  ]);
  const names = new Map<string, string>();
  for (const c of [...active, ...archived]) names.set(c.id, customerLabel(c));
  return names;
}

function customerLabel(c: MetronomeCustomer): string {
  return (c.name || c.ingest_aliases?.[0] || c.id).slice(
    0,
    BUSINESS_METRIC_SOURCE_LIMITS.maxLabelLength,
  );
}

function labelFor(names: Map<string, string> | null, customerId: string): string | undefined {
  if (!names) return undefined;
  return names.get(customerId) ?? `Customer ${customerId.slice(0, 8)}`;
}

async function runUsage(
  api: MetronomeApi,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
): Promise<BusinessMetricSourceResult> {
  const metricId = params["billableMetric"] ?? "";
  if (!metricId) throw new Error("Pick a billable metric to import usage from.");
  const customerId = params["customer"] ?? "";
  const grouped = params["groupByCustomer"] === "yes";
  const signalOpt = range.signal ? { signal: range.signal } : {};

  const [metric, names] = await Promise.all([
    api.getBillableMetric(metricId, range.signal),
    grouped ? customerNames(api, range) : Promise.resolve(null),
  ]);
  checkAborted(range);

  const hourly = useHourlyWindows(metric.aggregation_type, isUtcAligned(range));
  const startMs = hourly
    ? floorUtcDay(zonedDayStartMs(range.from, range.timezone))
    : Date.parse(utcMidnightIso(range.from));
  const endMs = hourly
    ? ceilUtcDay(zonedDayStartMs(nextBusinessMetricDay(range.to), range.timezone))
    : Date.parse(utcMidnightIso(nextBusinessMetricDay(range.to)));

  const body: Record<string, unknown> = {
    window_size: hourly ? "hour" : "day",
    starting_on: new Date(startMs).toISOString().replace(".000Z", "Z"),
    ending_before: new Date(endMs).toISOString().replace(".000Z", "Z"),
    billable_metrics: [{ id: metricId }],
  };
  if (customerId) body["customer_ids"] = [customerId];

  const rawCap = range.maxRows * RAW_ROW_FACTOR * (hourly ? 24 : 1);
  const rows = await api.paginate<MetronomeUsageAggregate>(
    "/v1/usage",
    {},
    {
      method: "POST",
      body,
      ...signalOpt,
      onPage: (_rows, total) => {
        checkAborted(range);
        if (total > rawCap) {
          throw new Error(
            `Metronome returned more than ${rawCap} usage rows. Shorten the window or pick one customer.`,
          );
        }
      },
    },
  );

  const buckets = new PointBuckets();
  for (const row of rows) {
    if (row.billable_metric_id && row.billable_metric_id !== metricId) continue;
    const ts = Date.parse(row.start_timestamp);
    if (Number.isNaN(ts)) {
      throw new Error(
        `Metronome returned a usage window with no start time (${row.start_timestamp}).`,
      );
    }
    const date = hourly ? localDayOf(ts, range.timezone) : row.start_timestamp.slice(0, 10);
    if (date < range.from || date > range.to) continue;
    // A null value means no events matched; that day is genuinely zero.
    const value = typeof row.value === "number" && Number.isFinite(row.value) ? row.value : 0;
    buckets.add(date, value, labelFor(names, row.customer_id));
  }

  return {
    points: buckets.points(range.maxRows),
    notes: [
      `${metric.name}: ${rows.length} ${hourly ? "hourly" : "daily"} usage windows`,
      hourly
        ? `Hourly usage summed into ${range.timezone} days`
        : range.timezone === "UTC"
          ? "Daily usage in UTC days"
          : "Daily usage on UTC days (this metric does not add up across hours)",
    ],
  };
}

async function runRevenue(
  api: MetronomeApi,
  params: Record<string, string>,
  range: BusinessMetricSourceRange,
): Promise<BusinessMetricSourceResult> {
  const creditTypeId = params["creditType"] || USD_CENTS_CREDIT_TYPE_ID;
  const customerId = params["customer"] ?? "";
  const grouped = params["groupByCustomer"] === "yes";

  let customers: Array<{ id: string; label: string }>;
  if (customerId) {
    const c = grouped ? await api.getCustomer(customerId) : null;
    customers = [{ id: customerId, label: c ? customerLabel(c) : customerId }];
  } else {
    const names = await customerNames(api, range);
    customers = [...names.entries()].map(([id, label]) => ({ id, label }));
  }
  checkAborted(range);

  const query: Record<string, string> = {
    window_size: "day",
    starting_on: utcMidnightIso(range.from),
    ending_before: utcMidnightIso(nextBusinessMetricDay(range.to)),
    credit_type_id: creditTypeId,
    limit: String(PAGE_LIMIT),
  };
  const rawCap = range.maxRows * RAW_ROW_FACTOR;
  let rawRows = 0;
  let unit = "";
  const buckets = new PointBuckets();

  const readCustomer = async (customer: { id: string; label: string }) => {
    const breakdowns = await api.paginate<MetronomeInvoice>(
      `/v1/customers/${encodeURIComponent(customer.id)}/invoices/breakdowns`,
      query,
      {
        ...(range.signal ? { signal: range.signal } : {}),
        onPage: (rows) => {
          checkAborted(range);
          rawRows += rows.length;
          if (rawRows > rawCap) {
            throw new Error(
              `Metronome returned more than ${rawCap} invoice breakdowns. Shorten the window or pick one customer.`,
            );
          }
        },
      },
    );
    for (const inv of breakdowns) {
      if ((inv.status ?? "").toUpperCase() === "VOID") continue;
      if (inv.credit_type?.id && inv.credit_type.id !== creditTypeId) continue;
      const start = inv.breakdown_start_timestamp ?? "";
      const date = start.slice(0, 10);
      if (!isBusinessMetricDay(date)) {
        throw new Error(
          `Metronome returned an invoice breakdown with no day (${start || "missing"}).`,
        );
      }
      if (date < range.from || date > range.to) continue;
      const total = typeof inv.total === "number" && Number.isFinite(inv.total) ? inv.total : 0;
      if (!unit && inv.credit_type?.name) unit = inv.credit_type.name;
      buckets.add(
        date,
        total / creditTypeDivisor(inv.credit_type?.name),
        grouped ? customer.label : undefined,
      );
    }
  };

  await runPool(customers, REVENUE_CONCURRENCY, readCustomer);

  return {
    points: buckets.points(range.maxRows),
    notes: [
      `Invoice breakdowns for ${customers.length} ${customers.length === 1 ? "customer" : "customers"}${unit ? ` in ${creditTypeUnit(unit)}` : ""}`,
      "Revenue on UTC days",
    ],
  };
}

/** Run `fn` over `items` with at most `limit` in flight; the first failure fails the run. */
async function runPool<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
