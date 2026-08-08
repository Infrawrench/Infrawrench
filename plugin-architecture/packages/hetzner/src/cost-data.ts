/**
 * Estimated spend for a Hetzner Cloud project: inventory × the first-party
 * rate card.
 *
 * ## Why this is an estimate and not a bill
 *
 * Hetzner Cloud exposes no billing data. The public API spec has 151 paths and
 * not one of them is an invoice or a spend endpoint; the spec's own "Billing"
 * tag group contains only "Pricing". Invoices live behind a different product
 * line and a different credential that this plugin does not hold. So the only
 * honest number available from the project token is: enumerate what exists,
 * price it at `GET /pricing`, and label the result an estimate.
 *
 * The manifest declares `estimated: true` for exactly this reason.
 *
 * ## Why there is no backfill — read this before comparing to an invoice
 *
 * A past day reconstructed from *today's* inventory is not a measurement of
 * that day, it is a guess that systematically under-reports. Anything created
 * and destroyed inside the period has vanished from the listing, and its cost
 * vanishes with it — a server that ran for three weeks and was deleted on the
 * 22nd contributes nothing. Traffic counters compound the problem: they cover
 * the current billing period only and reset with no history at all.
 *
 * So this collector refuses to invent history. **It only ever emits rows for
 * the day it runs**, whatever range the host asks for; a chunk that does not
 * contain today produces nothing and costs no requests. The manifest sets a
 * deliberately tiny `maxHistoryDays` so the host never asks for a year it
 * cannot be given, and the series builds forward from the day the account was
 * connected. A user looking at a month that predates the connection is looking
 * at a gap, not at zero spend.
 *
 * ## What it prices
 *
 * | Service        | Basis                                                    |
 * | -------------- | -------------------------------------------------------- |
 * | Server         | hourly rate, capped at the monthly price for the period   |
 * | Server Backup  | `server_backup.percentage` of the server's own cost       |
 * | Load Balancer  | hourly rate, capped at the monthly price                  |
 * | Primary IP     | hourly rate, capped at the monthly price                  |
 * | Floating IP    | monthly price, prorated across the month                  |
 * | Volume         | size × price per GB-month, prorated                       |
 * | Snapshot       | compressed size × price per GB-month, prorated            |
 * | Traffic        | outgoing beyond the allowance × price per TB              |
 *
 * Every amount is **net of VAT** — the rate card's `gross` is simply
 * `net × (1 + vat_rate/100)`, and applying tax downstream to a gross figure
 * would double-count it.
 *
 * Not priced, because the rate card does not price them: networks, firewalls,
 * placement groups, SSH keys (all free), and anything that is not a cloud
 * resource at all — credits, refunds, tax lines, and one-off charges have no
 * inventory to hang off and can never appear here.
 */

import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import {
  BYTES_PER_TB,
  createRateCardCache,
  cappedCost,
  mulDiv,
  parseDecimal,
  percentOf,
  proratedDailyCost,
  SCALE,
  toNumber,
  type CappedRate,
  type HetznerRateCard,
  type RateCardCache,
  type Scaled,
  type ServerTypeRate,
} from "./pricing.js";

/** Service names used as the `service` dimension. Stable — they are row keys. */
const SERVICE = {
  server: "Server",
  backup: "Server Backup",
  loadBalancer: "Load Balancer",
  primaryIp: "Primary IP",
  floatingIp: "Floating IP",
  volume: "Volume",
  snapshot: "Snapshot",
  traffic: "Traffic",
} as const;

/**
 * Everything this module needs from the outside world, so the pricing logic
 * runs in tests with no network and a frozen clock.
 */
export interface HetznerCostContext {
  /** Single GET against the Hetzner API, path relative to `/v1`. */
  fetch<T>(path: string): Promise<T>;
  /** Paginated GET, collecting `rootKey` across every page. */
  fetchAll<T>(path: string, rootKey: string): Promise<T[]>;
  /** The clock. Injected so "today" is deterministic under test. */
  now: Date;
  /** Shared per collection pass so `/pricing` is fetched once, not per chunk. */
  rateCard?: RateCardCache;
}

interface HetznerServer {
  id: number;
  name?: string;
  status?: string;
  created?: string;
  server_type?: { name?: string };
  datacenter?: { name?: string; location?: { name?: string } };
  /** Non-null exactly when backups are enabled, e.g. "22-02". */
  backup_window?: string | null;
  outgoing_traffic?: number | null;
  included_traffic?: number | null;
}

interface HetznerVolume {
  id: number;
  size?: number;
  created?: string;
  location?: { name?: string };
}

interface HetznerLoadBalancer {
  id: number;
  created?: string;
  load_balancer_type?: { name?: string };
  location?: { name?: string };
  outgoing_traffic?: number | null;
  included_traffic?: number | null;
}

interface HetznerPrimaryIp {
  id: number;
  type?: string;
  created?: string;
  location?: { name?: string };
  datacenter?: { name?: string; location?: { name?: string } };
}

interface HetznerFloatingIp {
  id: number;
  type?: string;
  created?: string;
  home_location?: { name?: string };
}

interface HetznerImage {
  id: number;
  type?: string;
  created?: string;
  /** Compressed size in GB — null while the snapshot is still being written. */
  image_size?: number | null;
}

/** `YYYY-MM-DD` in UTC. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfDayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** First day of `day`'s calendar month — Hetzner's billing period boundary. */
function periodStartDay(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function daysInMonth(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function inRange(day: string, range: CostFetchRange): boolean {
  return day >= range.fromDate && day <= range.toDate;
}

/** RFC3339 `created` to epoch ms; unparseable or absent means "always existed". */
function createdMs(created: string | undefined, fallback: number): number {
  if (!created) return fallback;
  const parsed = Date.parse(created);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Location slug for a resource.
 *
 * Most objects carry `location.name` directly. Servers nest it under
 * `datacenter.location`, and a datacenter name is `<location>-dcN`, which is
 * the last-resort fallback.
 */
function locationName(
  location: { name?: string } | undefined,
  datacenter: { name?: string; location?: { name?: string } } | undefined,
): string {
  return (
    location?.name ??
    datacenter?.location?.name ??
    (datacenter?.name ? (datacenter.name.split("-")[0] ?? "") : "")
  );
}

/** Pick a location's rate, tolerating a location absent from the rate card. */
function rateFor<T>(
  table: Map<string, Map<string, T>> | undefined,
  type: string,
  location: string,
) {
  return table?.get(type)?.get(location);
}

/**
 * One billing day of a resource priced hourly under a monthly cap.
 *
 * The cap is per billing period, not per day, so a day's cost is the
 * difference between the period-to-date cost at the end of the day and at the
 * start of it. Early in the month that is a full 24 hours of the hourly rate;
 * on the day the cap binds it is the remainder; after that it is zero, which is
 * exactly what Hetzner bills. Summed across a month the rows total the cap,
 * never more.
 *
 * Everything is derived from `created` and the calendar, so a re-run on the
 * same day reproduces the same amount as well as the same key.
 */
function dailyCappedAmount(
  rate: CappedRate,
  resourceCreatedMs: number,
  periodStartMs: number,
  dayStartMs: number,
  dayEndMs: number,
): Scaled {
  const start = Math.max(resourceCreatedMs, periodStartMs);
  const toEndOfDay = cappedCost(rate, start, dayEndMs);
  const toStartOfDay = cappedCost(rate, start, dayStartMs);
  const delta = toEndOfDay - toStartOfDay;
  return delta > 0n ? delta : 0n;
}

/** Milliseconds of the run day during which a resource existed. */
function coveredMsInDay(resourceCreatedMs: number, dayStartMs: number, dayEndMs: number): number {
  return Math.max(0, dayEndMs - Math.max(resourceCreatedMs, dayStartMs));
}

/**
 * Outgoing traffic beyond the included allowance, priced per TB.
 *
 * `included_traffic` is in bytes and a "TB" here is 2^40 bytes — a 20 TB
 * allowance arrives as 21990232555520. Hetzner bills overage in 100 MB blocks,
 * rounding partial blocks up; that rounding is deliberately not modelled, since
 * it moves the figure by well under a cent and the unit it rounds in is not
 * documented precisely enough to reproduce.
 */
function trafficOverageAmount(
  outgoing: number | null | undefined,
  included: number | null | undefined,
  perTbTraffic: Scaled,
): { amount: Scaled; overageBytes: bigint } {
  const used = BigInt(Math.max(0, Math.trunc(outgoing ?? 0)));
  const allowance = BigInt(Math.max(0, Math.trunc(included ?? 0)));
  const overageBytes = used > allowance ? used - allowance : 0n;
  if (overageBytes === 0n || perTbTraffic === 0n) return { amount: 0n, overageBytes: 0n };
  return { amount: mulDiv(perTbTraffic, overageBytes, BYTES_PER_TB), overageBytes };
}

/**
 * Accumulates rows keyed on the full dimension tuple the host dedupes by
 * (`day, service, region, resource, currency`), so a second run of the same day
 * produces byte-identical keys and replaces rather than appends.
 */
class RowAccumulator {
  private readonly rows = new Map<string, { row: CostRow; amount: Scaled }>();

  constructor(private readonly currency: string) {}

  add(
    date: string,
    service: string,
    region: string,
    resourceId: string,
    amount: Scaled,
    usage?: { amount: Scaled; unit: string },
  ): void {
    if (amount <= 0n) return;
    const key = `${date} ${service} ${region} ${resourceId}`;
    const existing = this.rows.get(key);
    if (existing) {
      existing.amount += amount;
      return;
    }
    this.rows.set(key, {
      amount,
      row: {
        date,
        service,
        ...(region ? { region } : {}),
        ...(resourceId ? { resourceId } : {}),
        currency: this.currency,
        amount: 0,
        ...(usage ? { usageAmount: toNumber(usage.amount), usageUnit: usage.unit } : {}),
      },
    });
  }

  /** Materialize, converting to `number` exactly once per row. */
  toRows(): CostRow[] {
    return [...this.rows.values()].map(({ row, amount }) => ({ ...row, amount: toNumber(amount) }));
  }
}

/**
 * Estimate the project's spend for the day this runs.
 *
 * Returns `[]` — without issuing a single request — when the requested range
 * covers neither the run day nor the current billing period's first day, which
 * is what makes the host's month-chunked restatement re-fetches cheap and
 * exactly-once.
 */
export async function fetchHetznerCostData(
  ctx: HetznerCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const today = isoDay(ctx.now);
  const periodStart = periodStartDay(today);

  // Daily rows land on the run day. The traffic row is the one exception: the
  // counters are cumulative over the billing period and reset with it, so a
  // cumulative figure written to each day would sum to many times the real
  // overage. Dating it to the period's first day means every run rewrites one
  // row with the latest period-to-date figure instead of appending another.
  const emitDaily = inRange(today, range);
  const emitTraffic = inRange(periodStart, range);
  if (!emitDaily && !emitTraffic) return [];

  const cache = ctx.rateCard ?? createRateCardCache();
  const card = await cache.load(ctx);

  const [servers, volumes, loadBalancers, primaryIps, floatingIps, snapshots] = await Promise.all([
    ctx.fetchAll<HetznerServer>("/servers", "servers"),
    emitDaily ? ctx.fetchAll<HetznerVolume>("/volumes", "volumes") : [],
    ctx.fetchAll<HetznerLoadBalancer>("/load_balancers", "load_balancers"),
    emitDaily ? ctx.fetchAll<HetznerPrimaryIp>("/primary_ips", "primary_ips") : [],
    emitDaily ? ctx.fetchAll<HetznerFloatingIp>("/floating_ips", "floating_ips") : [],
    // Filtered server-side: the unfiltered listing is the whole public image
    // catalogue, and only snapshots are billed per GB. Backups are billed as a
    // percentage of their server instead, below.
    emitDaily ? ctx.fetchAll<HetznerImage>("/images?type=snapshot", "images") : [],
  ]);

  const acc = new RowAccumulator(card.currency);
  const dayStartMs = startOfDayMs(today);
  const dayEndMs = dayStartMs + 86_400_000;
  const periodStartMs = startOfDayMs(periodStart);
  const monthDays = daysInMonth(today);

  for (const server of servers) {
    const region = locationName(undefined, server.datacenter);
    const typeName = server.server_type?.name ?? "";
    const rate = rateFor<ServerTypeRate>(card.serverTypes, typeName, region);
    if (!rate) continue;
    const resourceId = String(server.id);
    const created = createdMs(server.created, periodStartMs);

    if (emitDaily) {
      // A powered-off server bills in full: Hetzner allocates its resources
      // regardless of power state, and charges "for as long as it exists". The
      // status field is deliberately not consulted.
      const amount = dailyCappedAmount(rate, created, periodStartMs, dayStartMs, dayEndMs);
      acc.add(today, SERVICE.server, region, resourceId, amount);

      // Backups are a percentage uplift on the server's own price, not an
      // absolute rate, and `backup_window` is non-null exactly when they are on.
      if (server.backup_window && card.serverBackupPercent > 0n) {
        acc.add(
          today,
          SERVICE.backup,
          region,
          resourceId,
          percentOf(amount, card.serverBackupPercent),
        );
      }
    }

    if (emitTraffic) {
      const { amount, overageBytes } = trafficOverageAmount(
        server.outgoing_traffic,
        server.included_traffic ?? Number(rate.includedTraffic),
        rate.perTbTraffic,
      );
      acc.add(periodStart, SERVICE.traffic, region, resourceId, amount, {
        amount: mulDiv(SCALE, overageBytes, BYTES_PER_TB),
        unit: "TB",
      });
    }
  }

  for (const lb of loadBalancers) {
    const region = locationName(lb.location, undefined);
    const rate = rateFor<ServerTypeRate>(
      card.loadBalancerTypes,
      lb.load_balancer_type?.name ?? "",
      region,
    );
    if (!rate) continue;
    const resourceId = String(lb.id);
    const created = createdMs(lb.created, periodStartMs);

    if (emitDaily) {
      acc.add(
        today,
        SERVICE.loadBalancer,
        region,
        resourceId,
        dailyCappedAmount(rate, created, periodStartMs, dayStartMs, dayEndMs),
      );
    }
    if (emitTraffic) {
      const { amount, overageBytes } = trafficOverageAmount(
        lb.outgoing_traffic,
        lb.included_traffic ?? Number(rate.includedTraffic),
        rate.perTbTraffic,
      );
      acc.add(periodStart, SERVICE.traffic, region, resourceId, amount, {
        amount: mulDiv(SCALE, overageBytes, BYTES_PER_TB),
        unit: "TB",
      });
    }
  }

  if (emitDaily) {
    for (const volume of volumes) {
      const region = locationName(volume.location, undefined);
      const size = Math.max(0, Math.trunc(volume.size ?? 0));
      if (size === 0 || card.volumePerGbMonth === 0n) continue;
      const covered = coveredMsInDay(createdMs(volume.created, dayStartMs), dayStartMs, dayEndMs);
      acc.add(
        today,
        SERVICE.volume,
        region,
        String(volume.id),
        proratedDailyCost(card.volumePerGbMonth * BigInt(size), covered, monthDays),
        { amount: BigInt(size) * SCALE, unit: "GB" },
      );
    }

    for (const ip of primaryIps) {
      const region = locationName(ip.location, ip.datacenter);
      const rate = rateFor<CappedRate>(card.primaryIps, ip.type ?? "", region);
      if (!rate) continue;
      // IPv6 primary IPs are free; their rate is zero and the row is dropped.
      acc.add(
        today,
        SERVICE.primaryIp,
        region,
        String(ip.id),
        dailyCappedAmount(
          rate,
          createdMs(ip.created, periodStartMs),
          periodStartMs,
          dayStartMs,
          dayEndMs,
        ),
      );
    }

    for (const ip of floatingIps) {
      const region = locationName(ip.home_location, undefined);
      const monthly =
        card.floatingIps.get(ip.type ?? "")?.get(region) ?? card.floatingIpFallbackMonthly;
      if (monthly == null || monthly === 0n) continue;
      const covered = coveredMsInDay(createdMs(ip.created, dayStartMs), dayStartMs, dayEndMs);
      acc.add(
        today,
        SERVICE.floatingIp,
        region,
        String(ip.id),
        proratedDailyCost(monthly, covered, monthDays),
      );
    }

    for (const snapshot of snapshots) {
      // Defensive: `?type=snapshot` already filters, but backups share the
      // endpoint and are billed through their server, not per GB.
      if (snapshot.type && snapshot.type !== "snapshot") continue;
      const sizeGb = snapshot.image_size;
      if (sizeGb == null || !(sizeGb > 0) || card.imagePerGbMonth === 0n) continue;
      const scaledGb = parseDecimal(sizeGb, "image_size");
      const monthly = mulDiv(card.imagePerGbMonth, scaledGb, SCALE);
      const covered = coveredMsInDay(createdMs(snapshot.created, dayStartMs), dayStartMs, dayEndMs);
      // Snapshots are not tied to a location in the API, so they carry no region.
      acc.add(
        today,
        SERVICE.snapshot,
        "",
        String(snapshot.id),
        proratedDailyCost(monthly, covered, monthDays),
        {
          amount: scaledGb,
          unit: "GB",
        },
      );
    }
  }

  return acc.toRows();
}

export type { HetznerRateCard };
