/**
 * Depot spend: billed amounts from finalized invoices where Depot has invoiced, and an
 * estimate priced from `UsageService/GetUsage` everywhere else.
 *
 * **Invoiced cycles** come from `BillingService` (see `invoices.ts`): a billing cycle
 * with a finalized invoice gets that invoice's lines, which is what Depot actually
 * charged, sandbox compute and discounts included. Those days are never estimated.
 * When the organization cannot read invoices (the service is not deployed for it, or
 * refuses the token), every day is estimated, as before the service existed.
 *
 * **The estimate** covers the open cycle and any cycle without a finalized invoice.
 * GetUsage answers one aggregate for whatever `[start_at, end_at]` window it is asked
 * about: container build minutes per project, GitHub Actions minutes per repository
 * broken down by workflow and runner label, storage per storage type, agent sandbox
 * minutes per agent type, and Depot CI vCPU-minutes per repository, workflow and
 * runner. There are no daily buckets, so a daily cost row is one request per UTC day.
 * It reports quantities, never money, so every estimated amount is a quantity times a
 * rate from `rates.ts` (the plan the user picked plus their overrides), and the
 * manifest declares `estimated: true`.
 *
 * **Included minutes are a per-cycle pool.** A Startup plan's first 5,000
 * build minutes each cycle cost nothing beyond the plan fee, so pricing a day
 * needs the cycle-to-date total *before* it. The collector therefore always
 * fetches from the start of the billing cycle containing each estimated day,
 * even when the host only asked for the last two days, and walks forward
 * accumulating. Within a day the billable fraction is shared pro rata across
 * that day's rows, so per-project and per-repository amounts still sum to
 * the day's total. Rows inside the allowance are still emitted (amount 0,
 * usage set) so usage stays visible by project before overage starts.
 *
 * Storage is held, not consumed: each day is priced at a
 * 1/(days in cycle) share of the monthly GB rate on whatever GB the window
 * reports beyond the included storage. The plan fee is spread the same way,
 * and only across cycles that show any usage at all, so history from before
 * the organization subscribed is not charged a fee. A day an invoice already
 * bills a subscription fee for (paid in advance for the open cycle) gets no
 * estimated fee.
 */

import { CostSetupError, type CostFetchRange, type CostRow } from "@infrawrench/plugin-base";
import {
  getUsage,
  isPermissionDenied,
  mapLimit,
  type DepotTransport,
  type WireUsage,
} from "./api.js";
import { fetchInvoiceCosts } from "./invoices.js";
import { cycleBounds, cycleLengthDays, type DepotRates } from "./rates.js";
import { SERVICE } from "./services.js";

export { SERVICE };

const DAY_MS = 86_400_000;
const CONCURRENCY = 4;

export interface DepotCostContext {
  transport: DepotTransport;
  rates: DepotRates;
  /** Project name → project id, for `resourceId` on build rows. */
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
  ci: Array<{ repo: string; workflow: string; runner: string; vcpuMinutes: number }>;
}

/** Cycle-to-date usage before a day, in each included pool's own unit. */
export interface CycleUsed {
  builds: number;
  actions: number;
  /**
   * Sandbox compute minutes measured at 2 vCPUs, the unit the plan's allowance is in:
   * Depot CI and agent sandboxes, which draw on one pool (#897).
   */
  compute: number;
}

/** Depot CI bills per vCPU, and the plan's included minutes are measured at 2 vCPUs. */
export const CI_VCPUS_PER_INCLUDED_MINUTE = 2;

export function usedInCycle(day: DayUsage): CycleUsed {
  return {
    builds: day.builds.reduce((s, b) => s + b.minutes, 0),
    actions: day.actions.filter((a) => !a.macos).reduce((s, a) => s + a.billed, 0),
    compute:
      day.ci.reduce((s, c) => s + c.vcpuMinutes, 0) / CI_VCPUS_PER_INCLUDED_MINUTE +
      day.sandboxes.reduce((s, x) => s + x.minutes, 0),
  };
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
    ci: (usage.depotCi ?? []).map((c) => ({
      repo: c.repo ?? "",
      workflow: c.workflow || c.workflowPath || "",
      runner: c.runner ?? "",
      vcpuMinutes: num(c.vcpuMinutesBilled),
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
 * Price one day. `before` is the cycle-to-date usage before this day, used
 * against the included pools.
 */
export function priceDay(
  date: string,
  day: DayUsage,
  rates: DepotRates,
  before: CycleUsed,
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

  const today = usedInCycle(day);
  const buildShare = billableFraction(before.builds, today.builds, rates.includedBuildMinutes);
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

  const actionsShare = billableFraction(
    before.actions,
    today.actions,
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

  // Depot CI and agent sandboxes are one pool of sandbox compute, shared pro rata.
  const computeShare = billableFraction(
    before.compute,
    today.compute,
    rates.includedSandboxMinutes,
  );
  for (const s of day.sandboxes) {
    if (s.minutes <= 0) continue;
    add({
      date,
      service: SERVICE.sandboxes,
      tags: { agentType: s.type },
      currency: "USD",
      amount: s.minutes * computeShare * rates.sandboxMinute,
      usageAmount: s.minutes,
      usageUnit: "billed minutes",
    });
  }

  for (const c of day.ci) {
    if (c.vcpuMinutes <= 0) continue;
    const tags: Record<string, string> = { repo: c.repo };
    if (c.workflow) tags["workflow"] = c.workflow;
    if (c.runner) tags["runner"] = c.runner;
    add({
      date,
      service: SERVICE.ci,
      tags,
      currency: "USD",
      amount: c.vcpuMinutes * computeShare * rates.ciVcpuMinute,
      usageAmount: c.vcpuMinutes,
      usageUnit: "vCPU-minutes",
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
    day.sandboxes.some((s) => s.minutes > 0) ||
    day.ci.some((c) => c.vcpuMinutes > 0)
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
  // Today is partial; `restatementDays` re-reads it once it closes, and re-reads a
  // closed cycle's days once its invoice is finalized.
  const toMs = Math.min(parseIsoDate(range.toDate), todayMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];

  // Billed days first: whatever an invoice settles is not estimated, nor read from GetUsage.
  let billed: Awaited<ReturnType<typeof fetchInvoiceCosts>>;
  try {
    billed = await fetchInvoiceCosts(ctx.transport, fromMs, toMs);
  } catch (err) {
    throw asCostSetupError(err);
  }
  const out: CostRow[] = billed ? [...billed.rows] : [];
  const covered = billed?.coveredDays ?? new Set<number>();
  const feeBilled = billed?.feeBilledDays ?? new Set<number>();

  const { cycleStartDay } = ctx.rates;
  const estimated = new Set<number>();
  for (let d = fromMs; d <= toMs; d += DAY_MS) if (!covered.has(d)) estimated.add(d);
  if (estimated.size === 0) return out;
  // Each estimated day needs its cycle read from the start, for the included pools.
  const fetched = new Set<number>();
  for (const d of estimated) {
    for (let x = cycleBounds(d, cycleStartDay).startMs; x <= d; x += DAY_MS) fetched.add(x);
  }
  const days = [...fetched].sort((a, b) => a - b);

  let usages: DayUsage[];
  try {
    usages = await mapLimit(days, CONCURRENCY, async (d) =>
      normalizeUsage(await getUsage(ctx.transport, d, d + DAY_MS)),
    );
  } catch (err) {
    throw asCostSetupError(err);
  }
  // Rows with no project id have a different key, so the reconcile would zero the attributed
  // rows they replace. Only a token that can never read projects goes without.
  const projectIds = await ctx.projectIdsByName().catch((err) => {
    if (isPermissionDenied(err)) return new Map<string, string>();
    throw err;
  });

  // Which cycles show any usage, so the plan fee only lands on those.
  const activeCycles = new Set<number>();
  days.forEach((d, i) => {
    if (hasUsage(usages[i]!)) activeCycles.add(cycleBounds(d, cycleStartDay).startMs);
  });

  let cycleStart = -1;
  let before: CycleUsed = { builds: 0, actions: 0, compute: 0 };
  days.forEach((d, i) => {
    const day = usages[i]!;
    const cycle = cycleBounds(d, cycleStartDay).startMs;
    if (cycle !== cycleStart) {
      cycleStart = cycle;
      before = { builds: 0, actions: 0, compute: 0 };
    }
    const cycleDays = cycleLengthDays(d, cycleStartDay);
    if (estimated.has(d)) {
      const date = isoDate(d);
      out.push(...priceDay(date, day, ctx.rates, before, cycleDays, projectIds));
      if (ctx.rates.planFee > 0 && activeCycles.has(cycle) && !feeBilled.has(d)) {
        out.push({
          date,
          service: SERVICE.plan,
          currency: "USD",
          amount: round(ctx.rates.planFee / cycleDays),
        });
      }
    }
    const used = usedInCycle(day);
    before = {
      builds: before.builds + used.builds,
      actions: before.actions + used.actions,
      compute: before.compute + used.compute,
    };
  });
  return out;
}
