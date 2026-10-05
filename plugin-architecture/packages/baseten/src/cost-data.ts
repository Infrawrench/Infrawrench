import type { CostFetchRange, CostRow } from "@infrawrench/plugin-base";
import { CostSetupError } from "@infrawrench/plugin-base";
import { isStatus, type BasetenApi } from "./api.js";
import { money, round, type DeploymentUsage } from "./mappers.js";
import type { BillableResource, UsageSummary } from "./types.js";

/**
 * Billed spend from `GET /v1/billing/usage_summary` (Baseten management API,
 * verified against the published spec 2026-10). One call covers all three
 * billed products:
 *
 * - `dedicated_usage`: per billable resource (model deployment, chainlet,
 *   Loops sampler/trainer) with daily subtotal, compute and surcharge cost,
 *   billed minutes and inference requests.
 * - `training_usage`: per training job, daily subtotal and minutes.
 * - `model_apis_usage`: per Model API model, daily subtotal and input,
 *   output and cached-input tokens.
 *
 * Constraints: a window may not exceed 31 days and nothing before
 * 2026-01-01 is queryable, so the range is clamped and split into 30-day
 * chunks. Rows come from each item's `daily` list; an item that arrives
 * without one makes that chunk re-ask one day at a time, because spreading a
 * window total across days would invent a daily shape.
 *
 * Credits are reported only as a window total with no date, so they are not
 * emitted as rows: the amounts here are usage before credits.
 */

export const BILLING_EARLIEST = "2026-01-01";
const CHUNK_DAYS = 30;
export const COST_HELP_URL = "https://app.baseten.co/settings/billing";

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `[from, to]` inclusive → inclusive chunks of at most `CHUNK_DAYS` days. */
export function chunkRange(from: string, to: string, size = CHUNK_DAYS): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let start = from;
  while (start <= to) {
    const end = addDays(start, size - 1) < to ? addDays(start, size - 1) : to;
    out.push([start, end]);
    start = addDays(end, 1);
  }
  return out;
}

export async function fetchUsageSummary(
  api: BasetenApi,
  from: string,
  to: string,
): Promise<UsageSummary> {
  return (
    (await api.request<UsageSummary>("/v1/billing/usage_summary", {
      query: {
        start_date: `${from}T00:00:00Z`,
        // The end is exclusive midnight after the last requested day.
        end_date: `${addDays(to, 1)}T00:00:00Z`,
      },
    })) ?? {}
  );
}

function compactTags(tags: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (v) out[k] = v;
  return out;
}

const SERVICE_BY_KIND: Record<string, string> = {
  MODEL_DEPLOYMENT: "Dedicated Inference",
  CHAINLET: "Chains",
  LOOPS_SAMPLER: "Loops",
  LOOPS_TRAINER: "Loops",
  TRAINING_JOB: "Training",
};

/**
 * The inventory externalId a billable resource corresponds to, so per-resource
 * spend joins to the synced deployment, chain or training job.
 */
export function billedResourceId(r: BillableResource): string | undefined {
  if (r.kind === "MODEL_DEPLOYMENT") return r.model_id ? `${r.model_id}/${r.id}` : undefined;
  if (r.kind === "CHAINLET") return r.chain_metadata?.chain_id || undefined;
  if (r.kind === "TRAINING_JOB") return r.id;
  return undefined;
}

function resourceTags(r: BillableResource): Record<string, string> {
  return compactTags({
    model: r.model_name,
    deployment: r.kind === "MODEL_DEPLOYMENT" ? r.name : undefined,
    environment: r.environment_name,
    instance_type: r.instance_type,
    base_model: r.base_model,
    chain: r.chain_metadata?.chain_name,
    chainlet: r.kind === "CHAINLET" ? r.name : undefined,
    training_job: r.kind === "TRAINING_JOB" ? r.name : undefined,
    team: r.team_name,
  });
}

interface Converted {
  rows: CostRow[];
  /** True when an item with spend carried no daily breakdown. */
  missingDaily: boolean;
}

/** Turn one usage summary into daily rows within `[from, to]`. */
export function summaryToRows(summary: UsageSummary, from: string, to: string): Converted {
  const rows: CostRow[] = [];
  let missingDaily = false;
  const inRange = (date: string) => date >= from && date <= to;

  for (const item of summary.dedicated_usage?.breakdown ?? []) {
    const r = item.billable_resource;
    if (!item.daily) {
      if (money(item.subtotal) !== 0) missingDaily = true;
      continue;
    }
    const resourceId = billedResourceId(r);
    const tags = resourceTags(r);
    for (const day of item.daily) {
      const date = String(day.date).slice(0, 10);
      if (!inRange(date)) continue;
      const amount = money(day.subtotal);
      if (amount === 0 && !day.minutes) continue;
      rows.push({
        date,
        service: SERVICE_BY_KIND[r.kind] ?? "Dedicated Inference",
        ...(resourceId ? { resourceId } : {}),
        ...(Object.keys(tags).length ? { tags } : {}),
        currency: "USD",
        amount: round(amount, 6),
        ...(day.minutes ? { usageAmount: day.minutes, usageUnit: "minutes" } : {}),
      });
    }
  }

  for (const item of summary.training_usage?.breakdown ?? []) {
    const r = item.billable_resource;
    if (!item.daily) {
      if (money(item.subtotal) !== 0) missingDaily = true;
      continue;
    }
    const resourceId = billedResourceId(r) ?? r.id;
    const tags = resourceTags(r);
    for (const day of item.daily) {
      const date = String(day.date).slice(0, 10);
      if (!inRange(date)) continue;
      const amount = money(day.subtotal);
      if (amount === 0 && !day.minutes) continue;
      rows.push({
        date,
        service: SERVICE_BY_KIND[r.kind] ?? "Training",
        resourceId,
        ...(Object.keys(tags).length ? { tags } : {}),
        currency: "USD",
        amount: round(amount, 6),
        ...(day.minutes ? { usageAmount: day.minutes, usageUnit: "minutes" } : {}),
      });
    }
  }

  for (const item of summary.model_apis_usage?.breakdown ?? []) {
    if (!item.daily) {
      if (money(item.subtotal) !== 0) missingDaily = true;
      continue;
    }
    const tags = compactTags({ model: item.model_name, model_family: item.model_family });
    for (const day of item.daily) {
      const date = String(day.date).slice(0, 10);
      if (!inRange(date)) continue;
      const amount = money(day.subtotal);
      const tokens = (day.input_tokens ?? 0) + (day.output_tokens ?? 0);
      if (amount === 0 && tokens === 0) continue;
      rows.push({
        date,
        service: "Model APIs",
        resourceId: item.model_name,
        tags,
        currency: "USD",
        amount: round(amount, 6),
        ...(tokens ? { usageAmount: tokens, usageUnit: "tokens" } : {}),
      });
    }
  }
  return { rows, missingDaily };
}

/**
 * Collapse a single-day summary (used when `daily` is missing) into rows dated
 * that day, from the item totals.
 */
function singleDayRows(summary: UsageSummary, date: string): CostRow[] {
  const withDaily: UsageSummary = {
    dedicated_usage: summary.dedicated_usage
      ? {
          ...summary.dedicated_usage,
          breakdown: (summary.dedicated_usage.breakdown ?? []).map((i) => ({
            ...i,
            daily: i.daily ?? [
              {
                date,
                subtotal: i.subtotal,
                ...(i.minutes !== undefined ? { minutes: i.minutes } : {}),
                ...(i.inference_requests !== undefined
                  ? { inference_requests: i.inference_requests }
                  : {}),
              },
            ],
          })),
        }
      : null,
    training_usage: summary.training_usage
      ? {
          ...summary.training_usage,
          breakdown: (summary.training_usage.breakdown ?? []).map((i) => ({
            ...i,
            daily: i.daily ?? [
              {
                date,
                subtotal: i.subtotal,
                ...(i.minutes !== undefined ? { minutes: i.minutes } : {}),
              },
            ],
          })),
        }
      : null,
    model_apis_usage: summary.model_apis_usage
      ? {
          ...summary.model_apis_usage,
          breakdown: (summary.model_apis_usage.breakdown ?? []).map((i) => ({
            ...i,
            daily: i.daily ?? [
              {
                date,
                subtotal: i.subtotal,
                ...(i.input_tokens !== undefined ? { input_tokens: i.input_tokens } : {}),
                ...(i.output_tokens !== undefined ? { output_tokens: i.output_tokens } : {}),
                ...(i.cached_input_tokens !== undefined
                  ? { cached_input_tokens: i.cached_input_tokens }
                  : {}),
              },
            ],
          })),
        }
      : null,
  };
  return summaryToRows(withDaily, date, date).rows;
}

function billingDenied(): CostSetupError {
  return new CostSetupError(
    "Baseten refused the billing usage summary for this API key. Use a key created by a workspace member who can see Billing (an organization admin's personal key, or a full-access team key).",
    { label: "Open Baseten billing", url: COST_HELP_URL },
  );
}

export async function fetchBasetenCostData(
  api: BasetenApi,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const from = range.fromDate < BILLING_EARLIEST ? BILLING_EARLIEST : range.fromDate;
  const to = range.toDate;
  if (from > to) return [];
  const rows: CostRow[] = [];
  for (const [start, end] of chunkRange(from, to)) {
    let summary: UsageSummary;
    try {
      summary = await fetchUsageSummary(api, start, end);
    } catch (e) {
      if (isStatus(e, 401, 403)) throw billingDenied();
      throw e;
    }
    const converted = summaryToRows(summary, start, end);
    if (!converted.missingDaily) {
      rows.push(...converted.rows);
      continue;
    }
    for (let i = 0; i <= daysBetween(start, end); i++) {
      const day = addDays(start, i);
      rows.push(...singleDayRows(await fetchUsageSummary(api, day, day), day));
    }
  }
  return rows;
}

/**
 * Inference requests, billed minutes and cost per deployment id over the last
 * `days` days, from the item totals of one usage summary. Returns `null` when
 * billing is unreadable, which callers must treat as "unknown", never zero.
 */
export async function fetchDeploymentUsage(
  api: BasetenApi,
  days: number,
  now = new Date(),
): Promise<Map<string, DeploymentUsage> | null> {
  const to = now.toISOString().slice(0, 10);
  let from = addDays(to, -(days - 1));
  if (from < BILLING_EARLIEST) from = BILLING_EARLIEST;
  let summary: UsageSummary;
  try {
    summary = await fetchUsageSummary(api, from, to);
  } catch (e) {
    if (isStatus(e, 400, 401, 403, 404)) return null;
    throw e;
  }
  const out = new Map<string, DeploymentUsage>();
  for (const item of summary.dedicated_usage?.breakdown ?? []) {
    const r = item.billable_resource;
    if (r.kind !== "MODEL_DEPLOYMENT") continue;
    const prev = out.get(r.id) ?? { requests: 0, minutes: 0, cost: 0 };
    out.set(r.id, {
      requests: prev.requests + (item.inference_requests ?? 0),
      minutes: prev.minutes + (item.minutes ?? 0),
      cost: prev.cost + money(item.subtotal),
    });
  }
  return out;
}
