import type { MetricSeries } from "@infrawrench/plugin-base";
import { pathEncode } from "@infrawrench/plugin-base";
import type { StripeApi } from "./api.js";
import { fromMinor } from "./api.js";
import { dailyVolume, daysBetween, mapLimit, transactionsForDay } from "./balance.js";

/** Days charted on the account Metrics tab, at most. Each is one or more requests. */
const MAX_METRIC_DAYS = 90;
/** Balance transaction pages read per day for metrics (fees and volume). */
const METRIC_PAGES_PER_DAY = 20;
/** Customers charted per meter. */
const MAX_METER_CUSTOMERS = 10;

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * Account metrics from balance transactions, per day and currency: gross
 * payment volume, Stripe fees, refunds, payment count and the effective fee
 * rate (fees / gross).
 */
export async function accountMetrics(
  api: StripeApi,
  startMs: number,
  endMs: number,
): Promise<MetricSeries[]> {
  const to = new Date(Math.min(endMs, Date.now())).toISOString().slice(0, 10);
  const earliest = Math.max(startMs, endMs - MAX_METRIC_DAYS * 86_400_000);
  const from = new Date(earliest).toISOString().slice(0, 10);
  const days = daysBetween(from, to);
  const perDay = await mapLimit(days, 4, (day) =>
    transactionsForDay(api, day, { maxPages: METRIC_PAGES_PER_DAY, partial: true }),
  );
  const volume = dailyVolume(perDay.flat());

  const byCurrency = new Map<string, typeof volume>();
  for (const v of volume) {
    const list = byCurrency.get(v.currency) ?? [];
    list.push(v);
    byCurrency.set(v.currency, list);
  }
  const series: MetricSeries[] = [];
  for (const [currency, rows] of byCurrency) {
    const point = (pick: (r: (typeof rows)[number]) => number) =>
      days.map((day) => {
        const r = rows.find((x) => x.date === day);
        return { timestamp: dayMs(day), value: r ? pick(r) : 0 };
      });
    series.push(
      {
        label: `Gross volume (${currency})`,
        unit: currency,
        points: point((r) => fromMinor(r.grossMinor, currency)),
      },
      {
        label: `Stripe fees (${currency})`,
        unit: currency,
        points: point((r) => fromMinor(r.feesMinor, currency)),
      },
      {
        label: `Refunds (${currency})`,
        unit: currency,
        points: point((r) => fromMinor(r.refundsMinor, currency)),
      },
      { label: `Payments (${currency})`, unit: "count", points: point((r) => r.payments) },
      {
        label: `Effective fee rate (${currency})`,
        unit: "%",
        points: point((r) => (r.grossMinor > 0 ? (100 * r.feesMinor) / r.grossMinor : 0)),
      },
    );
  }
  return series;
}

/**
 * Meter usage per customer. `GET /v1/billing/meters/{id}/event_summaries`
 * requires a `customer`, so there is no meter-wide total to ask for: the
 * customers are found through the meter's prices
 * (`GET /v1/prices` → `recurring.meter`) and the active subscriptions on them
 * (`GET /v1/subscriptions?price=`), capped at {@link MAX_METER_CUSTOMERS}.
 * `start_time`/`end_time` must sit on the grouping window's boundaries, so
 * the range is widened to whole days (or hours for ranges under two days).
 */
export async function meterMetrics(
  api: StripeApi,
  meterId: string,
  startMs: number,
  endMs: number,
): Promise<MetricSeries[]> {
  const prices = await api.getAll("/v1/prices", "data", {
    query: { active: true, type: "recurring" },
    maxPages: 10,
    partial: true,
  });
  const meterPrices = prices.filter((p) => p.recurring?.meter === meterId && p.id);
  const customers = new Map<string, string>();
  for (const price of meterPrices) {
    if (customers.size >= MAX_METER_CUSTOMERS) break;
    const subs = await api.getAll("/v1/subscriptions", "data", {
      query: { price: String(price.id), status: "active", "expand[]": "data.customer" },
      maxPages: 1,
      partial: true,
    });
    for (const sub of subs) {
      const c = sub.customer;
      const id = typeof c === "string" ? c : (c?.id ?? "");
      if (!id || customers.has(id)) continue;
      const label =
        typeof c === "object" && c
          ? ("name" in c && c.name) || ("email" in c && c.email) || id
          : id;
      customers.set(id, label);
      if (customers.size >= MAX_METER_CUSTOMERS) break;
    }
  }
  if (customers.size === 0) return [];

  const hourly = endMs - startMs < 2 * 86_400_000;
  const unit = hourly ? 3_600_000 : 86_400_000;
  const start = Math.floor(startMs / unit) * unit;
  const end = Math.ceil(Math.min(endMs, Date.now()) / unit) * unit;
  const results = await mapLimit([...customers.entries()], 4, async ([id, label]) => {
    const summaries = await api
      .getAll(`/v1/billing/meters/${pathEncode(meterId)}/event_summaries`, "data", {
        query: {
          customer: id,
          start_time: Math.floor(start / 1000),
          end_time: Math.floor(end / 1000),
          value_grouping_window: hourly ? "hour" : "day",
        },
        maxPages: 5,
        partial: true,
      })
      .catch(() => []);
    return {
      label,
      points: summaries
        .filter((s) => typeof s.start_time === "number")
        .map((s) => ({
          timestamp: s.start_time * 1000,
          value: s.aggregated_value ?? 0,
        }))
        .sort((a, b) => a.timestamp - b.timestamp),
    };
  });
  const series: MetricSeries[] = results
    .filter((r) => r.points.length > 0)
    .map((r) => ({ label: `Usage: ${r.label}`, unit: "units", points: r.points }));
  if (series.length > 1) {
    const total = new Map<number, number>();
    for (const s of series)
      for (const p of s.points) total.set(p.timestamp, (total.get(p.timestamp) ?? 0) + p.value);
    series.unshift({
      label: "Usage: charted customers combined",
      unit: "units",
      points: [...total.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([timestamp, value]) => ({ timestamp, value })),
    });
  }
  return series;
}
