/**
 * Depot's published plans and rates, and the user's overrides of them.
 *
 * Depot meters usage through its API (`UsageService/GetUsage`) but never
 * prices it, and the API does not say which plan an organization is on. So
 * the account carries two editable credential fields: the plan (a picker) and
 * optional rate overrides, for a Business contract or a price change. Both
 * are editable later from the account's credentials, which is how a user
 * corrects the estimate without anyone touching code.
 *
 * Verified against https://depot.dev/pricing and
 * https://depot.dev/docs/github-actions/runner-types (October 2026):
 *
 * | Plan      | Fee    | Docker build min | GitHub Actions min | Cache + registry |
 * |-----------|--------|------------------|--------------------|------------------|
 * | Developer | $20/mo | 500              | 2,000              | 25 GB            |
 * | Startup   | $200/mo| 5,000            | 20,000             | 250 GB           |
 * | Business  | custom | custom           | custom             | custom           |
 *
 * Overage: Docker builds $0.04/min, GitHub Actions $0.006/min (per *billed*
 * minute: the API's `minutes_billed` already applies the runner-size
 * multiplier, 1x for a 2-CPU Linux runner up to 64x), agent sandboxes
 * $0.01/min, cache and registry storage $0.20/GB/month. macOS runners are
 * listed at a flat $0.08/min with no multiplier; they are priced from elapsed
 * minutes at that rate and kept out of the included-minutes pool.
 */

export interface DepotRates {
  /** Monthly plan fee in USD. Spread evenly across the days of each cycle. */
  planFee: number;
  includedBuildMinutes: number;
  includedActionsMinutes: number;
  includedStorageGb: number;
  /** USD per container build minute beyond the allowance. */
  buildMinute: number;
  /** USD per billed GitHub Actions minute beyond the allowance. */
  actionsMinute: number;
  /** USD per elapsed macOS runner minute. */
  macosMinute: number;
  /** USD per billed agent sandbox minute. */
  sandboxMinute: number;
  /** USD per GB-month of cache and registry storage beyond the allowance. */
  storageGbMonth: number;
  /** Day of the month a billing cycle starts on (1 to 28). */
  cycleStartDay: number;
}

export interface DepotPlan {
  id: string;
  label: string;
  /** Shown under the label in the plan picker. */
  summary: string;
  rates: Pick<
    DepotRates,
    "planFee" | "includedBuildMinutes" | "includedActionsMinutes" | "includedStorageGb"
  >;
}

/** Published overage rates, shared by every plan. */
export const LIST_RATES = {
  buildMinute: 0.04,
  actionsMinute: 0.006,
  macosMinute: 0.08,
  sandboxMinute: 0.01,
  storageGbMonth: 0.2,
} as const;

export const DEPOT_PLANS: readonly DepotPlan[] = [
  {
    id: "developer",
    label: "Developer ($20/month)",
    summary: "500 build min, 2,000 Actions min, 25 GB storage included",
    rates: {
      planFee: 20,
      includedBuildMinutes: 500,
      includedActionsMinutes: 2000,
      includedStorageGb: 25,
    },
  },
  {
    id: "startup",
    label: "Startup ($200/month)",
    summary: "5,000 build min, 20,000 Actions min, 250 GB storage included",
    rates: {
      planFee: 200,
      includedBuildMinutes: 5000,
      includedActionsMinutes: 20000,
      includedStorageGb: 250,
    },
  },
  {
    id: "business",
    label: "Business (custom contract)",
    summary: "No fee or allowance assumed; set yours under Rate overrides",
    rates: { planFee: 0, includedBuildMinutes: 0, includedActionsMinutes: 0, includedStorageGb: 0 },
  },
  {
    id: "usage-only",
    label: "Usage only (list rates, no plan)",
    summary: "Every minute and GB priced at the published overage rate",
    rates: { planFee: 0, includedBuildMinutes: 0, includedActionsMinutes: 0, includedStorageGb: 0 },
  },
];

export const DEFAULT_PLAN_ID = "developer";

/** Keys accepted in the rate-overrides field, in the order the docs list them. */
export const OVERRIDE_KEYS = [
  "planFee",
  "includedBuildMinutes",
  "includedActionsMinutes",
  "includedStorageGb",
  "buildMinute",
  "actionsMinute",
  "macosMinute",
  "sandboxMinute",
  "storageGbMonth",
  "cycleStartDay",
] as const satisfies ReadonlyArray<keyof DepotRates>;

export interface ResolvedRates {
  plan: DepotPlan;
  rates: DepotRates;
  /** Entries in the overrides field that were not understood, verbatim. */
  ignored: string[];
}

/**
 * Resolve the effective rates: the plan's allowances and the list rates,
 * with any `key=value` overrides on top. Entries may be separated by commas
 * or new lines. Unknown keys and unparseable values are reported, never
 * fatal: a typo should not stop cost collection, it should show up in the
 * account's detail view.
 */
export function resolveRates(
  planId: string | undefined,
  overrides: string | undefined,
): ResolvedRates {
  const plan =
    DEPOT_PLANS.find((p) => p.id === (planId ?? "").trim()) ??
    DEPOT_PLANS.find((p) => p.id === DEFAULT_PLAN_ID)!;
  const rates: DepotRates = { ...LIST_RATES, ...plan.rates, cycleStartDay: 1 };
  const ignored: string[] = [];
  for (const raw of (overrides ?? "").split(/[,\n]/)) {
    const entry = raw.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const key = (eq === -1 ? "" : entry.slice(0, eq).trim()) as keyof DepotRates;
    const value = Number(
      eq === -1
        ? NaN
        : entry
            .slice(eq + 1)
            .trim()
            .replace(/^\$/, ""),
    );
    if (
      !(OVERRIDE_KEYS as readonly string[]).includes(key) ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      ignored.push(entry);
      continue;
    }
    if (key === "cycleStartDay") {
      if (!Number.isInteger(value) || value < 1 || value > 28) {
        ignored.push(entry);
        continue;
      }
    }
    rates[key] = value;
  }
  return { plan, rates, ignored };
}

const DAY_MS = 86_400_000;

/**
 * The billing cycle containing `dayMs` (a UTC midnight), as
 * `[startMs, endMs)` UTC midnights. Cycles start on `cycleStartDay` of each
 * month; Depot bills from the subscription date, which a user on a cycle
 * that does not start on the 1st sets through the overrides field.
 */
export function cycleBounds(
  dayMs: number,
  cycleStartDay: number,
): { startMs: number; endMs: number } {
  const d = new Date(dayMs);
  // Date.UTC normalises month -1 and 12 into the neighbouring year.
  const month = d.getUTCMonth() - (d.getUTCDate() < cycleStartDay ? 1 : 0);
  const startMs = Date.UTC(d.getUTCFullYear(), month, cycleStartDay);
  const endMs = Date.UTC(d.getUTCFullYear(), month + 1, cycleStartDay);
  return { startMs, endMs };
}

/** Days in the cycle containing `dayMs`. */
export function cycleLengthDays(dayMs: number, cycleStartDay: number): number {
  const { startMs, endMs } = cycleBounds(dayMs, cycleStartDay);
  return Math.round((endMs - startMs) / DAY_MS);
}
