/**
 * Estimated Depot spend, priced from `UsageService/GetUsage`.
 *
 * GetUsage answers one aggregate for whatever `[start_at, end_at]` window it
 * is asked about: container build minutes per project, GitHub Actions minutes
 * per repository broken down by workflow and runner label, storage per
 * storage type, and agent sandbox minutes per agent type. There are no daily
 * buckets, so a daily cost row is one request per UTC day.
 *
 * It reports quantities, never money, and Depot has no billing endpoint, so
 * every amount here is a quantity times a rate from `rates.ts` (the plan the
 * user picked plus their overrides) and the manifest declares
 * `estimated: true`.
 *
 * **Included minutes are a per-cycle pool.** A Startup plan's first 5,000
 * build minutes each cycle cost nothing beyond the plan fee, so pricing a day
 * needs the cycle-to-date total *before* it. The collector therefore always
 * fetches from the start of the billing cycle containing `fromDate`, even
 * when the host only asked for the last two days, and walks forward
 * accumulating. Within a day the billable fraction is shared pro rata across
 * that day's rows, so per-project and per-repository amounts still sum to
 * the day's total. Rows inside the allowance are still emitted (amount 0,
 * usage set) so usage stays visible by project before overage starts.
 *
 * Storage is held, not consumed: each day is priced at a
 * 1/(days in cycle) share of the monthly GB rate on whatever GB the window
 * reports beyond the included storage. The plan fee is spread the same way,
 * and only across cycles that show any usage at all, so history from before
 * the organization subscribed is not charged a fee.
 */

import { CostSetupError, type CostFetchRange, type CostRow } from "@infrawrench/plugin-base";
import { getUsage, mapLimit, type DepotTransport, type WireUsage } from "./api.js";
import { cycleBounds, cycleLengthDays, type DepotRates } from "./rates.js";

const DAY_MS = 86_400_000;
const CONCURRENCY = 4;

export const SERVICE = {
  builds: "Container builds",
  actions: "GitHub Actions runners",
  macos: "GitHub Actions runners (macOS)",
  cache: "Cache storage",
  registry: "Registry storage",
  sandboxes: "Agent sandboxes",
  plan: "Depot plan",
} as const;

export interface DepotCostContext {
  transport: DepotTransport;
  rates: DepotRates;
  /** Project name → project id, for `resourceId` on build rows. Best-effort. */
  projectIdsByName: () => Promise<Map<string, string>>;
  now?: () => Date;
}

/** One day of usage, normalised from the wire shape. */
export interface DayUsage {
  builds: Array<{ project: string; minutes: number; saved: number; count: number }>;
  actions: Array<{
    repo: string;
    workflow: string;
    runner: string;
    billed: number;
    elapsed: number;
    jobs: number;
    macos: boolean;
  }>;
  storage: Array<{ type: string; gb: number }>;
  sandboxes: Array<{ type: string; minutes: number; count: number }>;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** macOS runner labels are `depot-macos-<version>`. */
export function isMacosRunner(runner: string): boolean {
  return /macos/i.test(runner);
}

export function normalizeUsage(usage: WireUsage): DayUsage {
  const actions: DayUsage["actions"] = [];
  for (const repo of usage.githubActionsJobs ?? []) {
    const name = repo.repo ?? "";
    const jobs = repo.jobs ?? [];
    if (jobs.length === 0) {
      // No per-workflow breakdown: fall back to the repository total.
      const billed = num(repo.total?.minutesBilled);
      const elapsed = num(repo.total?.minutesElapsed);
      if (billed > 0 || elapsed > 0) {
        actions.push({
          repo: name,
          workflow: "",
          runner: "",
          billed,
          elapsed,
          jobs: num(repo.total?.jobCount),
          macos: false,
        });
      }
      continue;
    }
    for (const job of jobs) {
      const runner = job.runner ?? "";
      actions.push({
        repo: name,
        workflow: job.workflow ?? "",
        runner,
        billed: num(job.minutesBilled),
        elapsed: num(job.minutesElapsed),
        jobs: num(job.jobCount),
        macos: isMacosRunner(runner),
      });
    }
  }
  return {
    builds: (usage.containerBuild ?? []).map((b) => ({
      project: b.projectName ?? "",
      minutes: num(b.minutesBilled),
      saved: num(b.minutesSaved),
      count: num(b.buildCount),
    })),
    actions,
    storage: (usage.storage ?? []).map((s) => ({ type: s.storageType ?? "", gb: num(s.totalGb) })),
    sandboxes: (usage.agentSandbox ?? []).map((s) => ({
      type: s.agentType ?? "",
      minutes: num(s.minutesBilled),
      count: num(s.sandboxesCount),
    })),
  };
}

export function storageService(type: string): string {
  if (/registry/i.test(type)) return SERVICE.registry;
  if (/cache/i.test(type) || type === "") return SERVICE.cache;
  return `Storage (${type})`;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseIsoDate(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

/** Billable share of `today` given `before` already used against `allowance`. */
export function billableFraction(before: number, today: number, allowance: number): number {
  if (today <= 0) return 0;
  const billable = Math.max(0, before + today - allowance) - Math.max(0, before - allowance);
  return Math.min(1, billable / today);
}

const round = (n: number, places = 6): number => Number(n.toFixed(places));

/**
 * Price one day. `buildsBefore` / `actionsBefore` are the cycle-to-date
 * totals before this day, used against the included pools.
 */
export function priceDay(
  date: string,
  day: DayUsage,
  rates: DepotRates,
  buildsBefore: number,
  actionsBefore: number,
  cycleDays: number,
  projectIds: Map<string, string>,
): CostRow[] {
  const rows = new Map<string, CostRow>();
  const add = (row: CostRow) => {
    const key = JSON.stringify([row.service, row.resourceId ?? "", row.tags ?? {}]);
    const existing = rows.get(key);
    if (existing) {
      existing.amount += row.amount;
      existing.usageAmount = (existing.usageAmount ?? 0) + (row.usageAmount ?? 0);
    } else rows.set(key, row);
  };

  const buildMinutes = day.builds.reduce((s, b) => s + b.minutes, 0);
  const buildShare = billableFraction(buildsBefore, buildMinutes, rates.includedBuildMinutes);
  for (const b of day.builds) {
    if (b.minutes <= 0) continue;
    const projectId = projectIds.get(b.project);
    add({
      date,
      service: SERVICE.builds,
      ...(projectId ? { resourceId: projectId } : {}),
      tags: { project: b.project },
      currency: "USD",
      amount: b.minutes * buildShare * rates.buildMinute,
      usageAmount: b.minutes,
      usageUnit: "build minutes",
    });
  }

  const pooled = day.actions.filter((a) => !a.macos);
  const actionsMinutes = pooled.reduce((s, a) => s + a.billed, 0);
  const actionsShare = billableFraction(
    actionsBefore,
    actionsMinutes,
    rates.includedActionsMinutes,
  );
  for (const a of day.actions) {
    const tags: Record<string, string> = { repo: a.repo };
    if (a.workflow) tags["workflow"] = a.workflow;
    if (a.runner) tags["runner"] = a.runner;
    if (a.macos) {
      if (a.elapsed <= 0) continue;
      add({
        date,
        service: SERVICE.macos,
        tags,
        currency: "USD",
        amount: a.elapsed * rates.macosMinute,
        usageAmount: a.elapsed,
        usageUnit: "minutes",
      });
      continue;
    }
    if (a.billed <= 0) continue;
    add({
      date,
      service: SERVICE.actions,
      tags,
      currency: "USD",
      amount: a.billed * actionsShare * rates.actionsMinute,
      usageAmount: a.billed,
      usageUnit: "billed minutes",
    });
  }

  const storageGb = day.storage.reduce((s, x) => s + x.gb, 0);
  const storageShare =
    storageGb > 0 ? Math.max(0, storageGb - rates.includedStorageGb) / storageGb : 0;
  for (const s of day.storage) {
    if (s.gb <= 0) continue;
    add({
      date,
      service: storageService(s.type),
      tags: { storageType: s.type },
      currency: "USD",
      amount: (s.gb * storageShare * rates.storageGbMonth) / cycleDays,
      usageAmount: s.gb,
      usageUnit: "GB",
    });
  }

  for (const s of day.sandboxes) {
    if (s.minutes <= 0) continue;
    add({
      date,
      service: SERVICE.sandboxes,
      tags: { agentType: s.type },
      currency: "USD",
      amount: s.minutes * rates.sandboxMinute,
      usageAmount: s.minutes,
      usageUnit: "billed minutes",
    });
  }

  return [...rows.values()].map((row) => ({
    ...row,
    amount: round(row.amount),
    ...(row.usageAmount !== undefined ? { usageAmount: round(row.usageAmount, 3) } : {}),
  }));
}

function hasUsage(day: DayUsage): boolean {
  return (
    day.builds.some((b) => b.minutes > 0 || b.count > 0) ||
    day.actions.some((a) => a.billed > 0 || a.elapsed > 0) ||
    day.storage.some((s) => s.gb > 0) ||
    day.sandboxes.some((s) => s.minutes > 0)
  );
}

/** Turn an auth failure into the host's "fix your setup" notice. */
export function asCostSetupError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (/ (401|403) |unauthenticated|permission_denied/i.test(message)) {
    return new CostSetupError(
      "Depot rejected the token while reading usage. Usage needs an organization token (project and pull tokens can't read it). Create one under Organization Settings, API Tokens, and update the account.",
      { label: "Open Depot organization settings", url: "https://depot.dev/orgs/_/settings" },
    );
  }
  return err;
}

export async function fetchDepotCostData(
  ctx: DepotCostContext,
  range: CostFetchRange,
): Promise<CostRow[]> {
  const now = (ctx.now ?? (() => new Date()))();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fromMs = parseIsoDate(range.fromDate);
  // Today is partial; `restatementDays` re-reads it once it closes.
  const toMs = Math.min(parseIsoDate(range.toDate), todayMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];

  const { cycleStartDay } = ctx.rates;
  const fetchFromMs = cycleBounds(fromMs, cycleStartDay).startMs;
  const days: number[] = [];
  for (let d = fetchFromMs; d <= toMs; d += DAY_MS) days.push(d);

  let usages: DayUsage[];
  try {
    usages = await mapLimit(days, CONCURRENCY, async (d) =>
      normalizeUsage(await getUsage(ctx.transport, d, d + DAY_MS)),
    );
  } catch (err) {
    throw asCostSetupError(err);
  }
  const projectIds = await ctx.projectIdsByName().catch(() => new Map<string, string>());

  // Which cycles show any usage, so the plan fee only lands on those.
  const activeCycles = new Set<number>();
  days.forEach((d, i) => {
    if (hasUsage(usages[i]!)) activeCycles.add(cycleBounds(d, cycleStartDay).startMs);
  });

  const out: CostRow[] = [];
  let cycleStart = -1;
  let buildsBefore = 0;
  let actionsBefore = 0;
  days.forEach((d, i) => {
    const day = usages[i]!;
    const cycle = cycleBounds(d, cycleStartDay).startMs;
    if (cycle !== cycleStart) {
      cycleStart = cycle;
      buildsBefore = 0;
      actionsBefore = 0;
    }
    const cycleDays = cycleLengthDays(d, cycleStartDay);
    if (d >= fromMs) {
      const date = isoDate(d);
      out.push(
        ...priceDay(date, day, ctx.rates, buildsBefore, actionsBefore, cycleDays, projectIds),
      );
      if (ctx.rates.planFee > 0 && activeCycles.has(cycle)) {
        out.push({
          date,
          service: SERVICE.plan,
          currency: "USD",
          amount: round(ctx.rates.planFee / cycleDays),
        });
      }
    }
    buildsBefore += day.builds.reduce((s, b) => s + b.minutes, 0);
    actionsBefore += day.actions.filter((a) => !a.macos).reduce((s, a) => s + a.billed, 0);
  });
  return out;
}
