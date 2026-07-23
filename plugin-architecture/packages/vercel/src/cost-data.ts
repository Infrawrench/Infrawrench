/**
 * Actual-spend collection via Vercel's FOCUS billing charges endpoint.
 *
 * `GET /v1/billing/charges` streams FOCUS v1.3 rows as newline-delimited
 * JSON (JSONL) at 1-day granularity, max 1-year range per request. `from` is
 * inclusive and `to` is EXCLUSIVE (ISO 8601 UTC) — the host's range is
 * inclusive on both ends, so `to` is bumped by one day. Rows are aggregated
 * per (day, ServiceName, RegionId, project) so re-fetching a day reproduces
 * the same dimension keys for the host's dedupe.
 *
 * Uses the same bearer token as the rest of the plugin; the endpoint is
 * available to the Owner, Member, Developer, Security, Billing, and
 * Enterprise Viewer team roles (no extra token scope to mint).
 */

import type { CostFetchRange, CostRow, HttpHostServices } from "@infrawrench/plugin-base";

/** FOCUS v1.3 charge row — only the fields this module consumes. */
interface FocusChargeRow {
  BilledCost?: number;
  BillingCurrency?: string;
  /** Usage / Credit / Tax / Adjustment / Purchase */
  ChargeCategory?: string;
  /** Inclusive start of the charge period, ISO 8601 UTC. */
  ChargePeriodStart?: string;
  ServiceName?: string;
  RegionId?: string;
  /** Carries the Vercel ProjectId / ProjectName for project-scoped charges. */
  Tags?: Record<string, string> | null;
}

export interface VercelCostFetchOptions {
  accessToken: string;
  teamId: string | null;
  /** Optional trust anchor — same semantics as the client's jsonRestFetch path. */
  caCert: string;
  http: HttpHostServices | undefined;
}

/**
 * Fetch the raw JSONL body. `jsonRestFetch` can't be used here because it
 * JSON-parses the whole body, so this mirrors its dual path: route through
 * the host's HTTP service when a custom CA is configured (bastion routing +
 * trust anchor), plain `fetch` otherwise. `Accept-Encoding: identity` keeps
 * the body uncompressed — the host HTTP service doesn't gunzip for us.
 */
async function fetchJsonlBody(url: string, opts: VercelCostFetchOptions): Promise<string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    "Accept-Encoding": "identity",
  };

  if (opts.caCert && opts.http) {
    const result = await opts.http.request({
      url,
      method: "GET",
      headers,
      caCert: opts.caCert,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `Vercel API error ${result.status} for /v1/billing/charges: ${result.body.slice(0, 500)}`,
      );
    }
    return result.body;
  }

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Vercel API error ${res.status} for /v1/billing/charges: ${body.slice(0, 500)}`,
    );
  }
  return res.text();
}

export async function fetchVercelCostData(
  opts: VercelCostFetchOptions,
  range: CostFetchRange,
): Promise<CostRow[]> {
  // `to` is exclusive; the host's range is inclusive — bump by one day.
  const toExclusive = new Date(`${range.toDate}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

  const params = new URLSearchParams({
    from: `${range.fromDate}T00:00:00.000Z`,
    to: `${toExclusive.toISOString().slice(0, 10)}T00:00:00.000Z`,
  });
  if (opts.teamId) params.set("teamId", opts.teamId);

  const body = await fetchJsonlBody(
    `https://api.vercel.com/v1/billing/charges?${params.toString()}`,
    opts,
  );

  // Aggregate BilledCost per (day, service, region, project). All charge
  // categories are kept — Credits arrive as negative amounts and Tax /
  // Adjustment / Purchase are real money, so the daily net matches the
  // invoice. Currency is tracked per bucket (the API only emits USD today).
  const buckets = new Map<
    string,
    {
      date: string;
      service: string;
      region: string;
      project: string;
      currency: string;
      amount: number;
    }
  >();

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: FocusChargeRow;
    try {
      row = JSON.parse(trimmed) as FocusChargeRow;
    } catch {
      throw new Error(
        `Vercel API returned a malformed JSONL line from /v1/billing/charges: ${trimmed.slice(0, 200)}`,
      );
    }

    const date = (row.ChargePeriodStart ?? "").slice(0, 10);
    if (!date) continue;
    const amount = Number(row.BilledCost ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;

    const tags = row.Tags ?? {};
    const project = tags["ProjectName"] ?? tags["projectName"] ?? tags["ProjectId"] ?? "";
    const service = row.ServiceName ?? "";
    const region = row.RegionId ?? "";
    const currency = row.BillingCurrency ?? "USD";

    const key = `${date}|${service}|${region}|${project}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.amount += amount;
    } else {
      buckets.set(key, { date, service, region, project, currency, amount });
    }
  }

  const rows: CostRow[] = [];
  for (const b of buckets.values()) {
    if (b.amount === 0) continue; // e.g. a usage charge fully offset by a credit
    rows.push({
      date: b.date,
      service: b.service,
      region: b.region,
      currency: b.currency,
      amount: b.amount,
      ...(b.project ? { tags: { project: b.project } } : {}),
    });
  }
  return rows;
}
