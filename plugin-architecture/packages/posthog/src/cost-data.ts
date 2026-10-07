import type { CostFetchRange, CostRow, MetricSeries } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import type { PostHogContext } from "./api.js";
import { phFetch, statusOf } from "./api.js";

/**
 * PostHog Cloud spend: `GET /api/billing/spend/` (scope `billing:read`), the
 * proxy to the billing service the billing page itself uses. With
 * `breakdowns=["type","team"]` and `interval=day` every series is one product
 * in one project: `breakdown_value: [<usage type>, <team id>]`, label
 * `<team>::<Product>`, `data[i]` the USD spent on `dates[i]` (per-day
 * amounts, summed by PostHog's own UI). It reads the API key's current
 * organization. Self-hosted instances have no billing service.
 */

interface SpendSeries {
  label?: string;
  data?: number[];
  dates?: string[];
  breakdown_type?: string | null;
  breakdown_value?: string | string[] | null;
}

interface SpendResponse {
  results?: SpendSeries[];
  next?: string | null;
}

const HELP = { label: "PostHog billing", url: "https://posthog.com/docs/billing" };

/** Product label and team id of one series. */
export function seriesKey(s: SpendSeries): { product: string; teamId?: string } {
  const label = s.label ?? "";
  const product = label.includes("::") ? label.slice(label.indexOf("::") + 2) : label;
  const value = s.breakdown_value;
  const teamId = Array.isArray(value)
    ? value[1]
    : s.breakdown_type === "team"
      ? String(value ?? "")
      : undefined;
  return {
    product: product || (Array.isArray(value) ? String(value[0]) : String(value ?? "PostHog")),
    ...(teamId ? { teamId } : {}),
  };
}

async function spend(
  ctx: PostHogContext,
  query: Record<string, string | number>,
): Promise<SpendSeries[]> {
  const out: SpendSeries[] = [];
  let after: string | undefined;
  for (let i = 0; i < 20; i++) {
    let res: SpendResponse;
    try {
      res = await phFetch<SpendResponse>(ctx, "/api/billing/spend/", {
        query: { ...query, ...(after ? { after } : {}) },
      });
    } catch (err) {
      const status = statusOf(err);
      if (status === 403 || status === 401) {
        throw new CostSetupError(
          "The personal API key cannot read billing. Add the billing:read scope to the key, and make sure its user is an admin of the organization.",
          HELP,
        );
      }
      if (status === 404 && ctx.region === "self-hosted") {
        throw new CostSetupError(
          "Self-hosted PostHog has no billing service, so there is no spend to read.",
          HELP,
        );
      }
      throw err;
    }
    out.push(...(res?.results ?? []));
    after = typeof res?.next === "string" && res.next ? cursorOf(res.next) : undefined;
    if (!after || !query["page_size"]) break;
  }
  return out;
}

function cursorOf(next: string): string | undefined {
  try {
    return new URL(next).searchParams.get("after") ?? next;
  } catch {
    return next;
  }
}

export async function fetchPostHogCost(
  ctx: PostHogContext,
  range: CostFetchRange,
  projectNames: Map<string, string> = new Map(),
): Promise<CostRow[]> {
  const series = await spend(ctx, {
    start_date: range.fromDate,
    end_date: range.toDate,
    interval: "day",
    breakdowns: JSON.stringify(["type", "team"]),
    page_size: 100,
  });
  const merged = new Map<string, CostRow>();
  for (const s of series) {
    const { product, teamId } = seriesKey(s);
    (s.dates ?? []).forEach((date, i) => {
      const day = date.slice(0, 10);
      const amount = Number(s.data?.[i] ?? 0);
      if (
        !day ||
        day < range.fromDate ||
        day > range.toDate ||
        !Number.isFinite(amount) ||
        amount === 0
      )
        return;
      const key = `${day}|${product}|${teamId ?? ""}`;
      const prev = merged.get(key);
      if (prev) {
        prev.amount += amount;
        return;
      }
      merged.set(key, {
        date: day,
        service: product,
        currency: "USD",
        amount,
        ...(teamId
          ? { resourceId: teamId, tags: { project: projectNames.get(teamId) ?? teamId } }
          : {}),
      });
    });
  }
  return Array.from(merged.values());
}

/** Daily spend by product over a window, for the organization's Metrics tab. */
export async function spendSeries(
  ctx: PostHogContext,
  range: { startMs: number; endMs: number },
): Promise<MetricSeries[]> {
  const series = await spend(ctx, {
    start_date: new Date(range.startMs).toISOString().slice(0, 10),
    end_date: new Date(range.endMs).toISOString().slice(0, 10),
    interval: "day",
    breakdowns: JSON.stringify(["type"]),
  });
  return series
    .map((s) => ({
      label: seriesKey(s).product,
      unit: "USD",
      points: (s.dates ?? []).map((d, i) => ({
        timestamp: Date.parse(d),
        value: Number(s.data?.[i] ?? 0),
      })),
    }))
    .filter((s) => s.points.some((p) => p.value > 0));
}
