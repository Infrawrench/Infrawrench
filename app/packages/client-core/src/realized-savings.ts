/**
 * Realized savings: the platform-neutral client half.
 *
 * Every savings finder in the product (orphans, right-sizing, sleep schedules,
 * the commitment planner) reports what an action *would* save. This is the
 * other half: what the actions people actually took *did* save, measured
 * against the resource's own spend before the action. A projection is a
 * promise; a realized figure is the receipt finance asks for.
 *
 * Server contract: `/api/org/:orgId/savings/*` (web `api/routes/savings.ts`).
 * Reads are `costs:read`; logging, editing and dismissing an entry, and the
 * settings, are `costs:write`.
 *
 * ## The method, in one place
 *
 * - **Baseline** is the resource's trailing *daily* spend over the days before
 *   the action (`baselineWindowDays`, inside collection coverage), read from
 *   `cost_daily` by provider resource id. When the provider has no
 *   per-resource billing, the baseline falls back to the price-table estimate
 *   that backed the projection, and the result says so (`basis: "estimate"`).
 * - **Realized** for a day is baseline minus that day's actual spend, accrued
 *   day by day from the day after the action. A day collection has not covered
 *   yet is not accrued at all: "we hold no billing" never becomes "it cost
 *   nothing".
 * - **One-off actions** (a resize, a deletion, a manual entry) stop accruing at
 *   the org's horizon (`horizonMonths`, overridable per entry). Recurring ones
 *   (a sleep schedule, commitments) accrue while they are in force.
 * - **Shortfall** is flagged when the trailing realized run-rate falls under
 *   `shortfallThresholdPercent` of the projected rate, or when post-action spend
 *   climbs back over the baseline (the resource grew back).
 *
 * Nothing realized is stored: provider billing restates for days or weeks, so
 * the figure is recomputed on every read and improves as data arrives (the
 * same rule as cost per change). What is stored is the *event*: what was done,
 * when, to what, and what it was projected to save.
 */
import type { CloudFetch } from "./fetch";

/** What kind of action produced the saving. */
export const SAVINGS_EVENT_KINDS = [
  "rightsizing",
  "orphan_deletion",
  "sleep_schedule",
  "commitment",
  "manual",
] as const;
export type SavingsEventKind = (typeof SAVINGS_EVENT_KINDS)[number];

export const SAVINGS_EVENT_KIND_LABELS: Record<SavingsEventKind, string> = {
  rightsizing: "Right-sizing",
  orphan_deletion: "Orphan cleanup",
  sleep_schedule: "Sleep schedule",
  commitment: "Commitments",
  manual: "Logged manually",
};

/**
 * Where the event came from.
 *
 * - `in_app`: recorded at the moment Infrawrench performed the action (the
 *   resize Apply button, a delete, a schedule being created).
 * - `detected`: inferred from an inventory diff on sync: someone resized or
 *   deleted the resource in the provider's console.
 * - `manual`: logged by a person.
 * - `derived`: computed from billing with no event row at all (commitments).
 */
export const SAVINGS_EVENT_SOURCES = ["in_app", "detected", "manual", "derived"] as const;
export type SavingsEventSource = (typeof SAVINGS_EVENT_SOURCES)[number];

export const SAVINGS_EVENT_SOURCE_LABELS: Record<SavingsEventSource, string> = {
  in_app: "In Infrawrench",
  detected: "Detected on sync",
  manual: "Manual entry",
  derived: "From billing",
};

/**
 * How the realized figure was measured.
 *
 * - `billing`: baseline and post-action spend both read from collected cost
 *   rows for this resource. The only basis that can show a shortfall.
 * - `estimate`: no per-resource billing, so the realized figure is the
 *   price-table estimate accrued over elapsed days. Honest about being an
 *   estimate; it cannot fall short by construction.
 * - `manual`: the amount a person logged, accrued over elapsed days.
 * - `unmeasured`: nothing to measure against. Shown, never summed as zero.
 */
export const REALIZED_SAVINGS_BASES = ["billing", "estimate", "manual", "unmeasured"] as const;
export type RealizedSavingsBasis = (typeof REALIZED_SAVINGS_BASES)[number];

export const REALIZED_SAVINGS_BASIS_LABELS: Record<RealizedSavingsBasis, string> = {
  billing: "Measured from billing",
  estimate: "Estimated from list prices",
  manual: "As logged",
  unmeasured: "Not measurable yet",
};

export type SavingsEventStatus = "pending" | "accruing" | "complete" | "ended";

export const SAVINGS_EVENT_STATUS_LABELS: Record<SavingsEventStatus, string> = {
  pending: "Waiting for billing",
  accruing: "Accruing",
  complete: "Horizon reached",
  ended: "Ended",
};

export type SavingsShortfallKind = "below_projection" | "grew_back";

export interface SavingsShortfall {
  kind: SavingsShortfallKind;
  /** Realized per day over the trailing measured days. */
  realizedPerDay: number;
  /** What the projection said per day. Null for `grew_back` with no projection. */
  projectedPerDay: number | null;
}

/** A stored savings event: what was done, when, to what, and what was promised. */
export interface SavingsEvent {
  id: string;
  kind: SavingsEventKind;
  source: SavingsEventSource;
  title: string;
  note: string | null;
  /** The day the action took effect (UTC, YYYY-MM-DD). */
  occurredOn: string;
  /** Last day it was in force, inclusive; null while it still is. */
  endedOn: string | null;
  accountId: string | null;
  accountName: string | null;
  pluginId: string | null;
  resourceTypeId: string | null;
  /** `resources.id`; kept after the resource is deleted. */
  resourceId: string | null;
  resourceName: string | null;
  /** Explicit cost-centre attribution; null means "from the allocation rules". */
  costCentreId: string | null;
  /** Monthly saving the action was projected to deliver, in `currency`. */
  projectedMonthlyAmount: number | null;
  currency: string | null;
  /** Per-entry horizon override in months; null uses the org setting. */
  horizonMonths: number | null;
  /** The cost annotation marking the action on cost charts, when one exists. */
  costAnnotationId: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A savings event with its realized figure computed for the requested range. */
export interface SavingsEventResult extends SavingsEvent {
  basis: RealizedSavingsBasis;
  status: SavingsEventStatus;
  /** Currency the realized figures are in (billing's own when measured). */
  realizedCurrency: string | null;
  /** Spend per day before the action. Null when nothing could be read or estimated. */
  baselinePerDay: number | null;
  /** Actual spend per day over the trailing measured post-action days. */
  currentPerDay: number | null;
  /** Realized since the action, through the newest accrued day. */
  realizedToDate: number | null;
  /** Realized inside the report's range. */
  realizedInRange: number | null;
  /** Projected inside the report's range, over the same accrued days. */
  projectedInRange: number | null;
  /** Days accrued since the action (all time, not only the range). */
  accruedDays: number;
  /** Last day this event can accrue on; null for recurring ones. */
  horizonEndsOn: string | null;
  /** Cost centre the event is attributed to, explicit or by rule. */
  attributedCostCentreId: string | null;
  attributedCostCentreName: string | null;
  shortfall: SavingsShortfall | null;
  /**
   * Manual entries are fully editable; automatic ones keep their facts and
   * take a note, an attribution, a horizon and an end date; derived
   * commitment rows have no stored event to edit.
   */
  editable: "full" | "annotate" | "none";
}

export interface RealizedSavingsTotal {
  currency: string;
  realized: number;
  /** Projected over the same accrued days, for events that carry a projection. */
  projected: number;
}

export interface RealizedSavingsBucket {
  key: string;
  label: string;
  currency: string;
  realized: number;
  projected: number;
  events: number;
}

export interface RealizedSavingsMonth {
  /** `YYYY-MM`. */
  month: string;
  currency: string;
  realized: number;
  projected: number;
}

export interface RealizedSavingsSettings {
  /** How long a one-off action keeps accruing, in months. */
  horizonMonths: number;
  /** Below this percentage of the projected rate, an event is flagged short. */
  shortfallThresholdPercent: number;
  /** Days before the action that make up the baseline. */
  baselineWindowDays: number;
}

export const REALIZED_SAVINGS_LIMITS = {
  minHorizonMonths: 1,
  maxHorizonMonths: 36,
  minShortfallThresholdPercent: 10,
  maxShortfallThresholdPercent: 100,
  minBaselineWindowDays: 3,
  maxBaselineWindowDays: 30,
  /** Longest range one report covers. */
  maxRangeDays: 1100,
  titleMaxLength: 200,
  noteMaxLength: 2000,
  /** A manual entry's monthly amount, in currency units. */
  maxMonthlyAmount: 100_000_000,
} as const;

export const DEFAULT_REALIZED_SAVINGS_SETTINGS: RealizedSavingsSettings = {
  horizonMonths: 12,
  shortfallThresholdPercent: 70,
  baselineWindowDays: 14,
};

export interface RealizedSavingsReport {
  from: string;
  to: string;
  settings: RealizedSavingsSettings;
  /** One per currency, largest realized first. */
  totals: RealizedSavingsTotal[];
  byMonth: RealizedSavingsMonth[];
  byKind: RealizedSavingsBucket[];
  byCostCentre: RealizedSavingsBucket[];
  byAccount: RealizedSavingsBucket[];
  /** Newest first. Includes derived commitment rows. */
  events: SavingsEventResult[];
  /** Events flagged short. */
  shortfallCount: number;
  /** Events that could not be measured; listed, never summed as zero. */
  unmeasuredCount: number;
}

/** Body for logging or editing a manual entry. */
export interface SavingsEventInput {
  title: string;
  note?: string | null | undefined;
  occurredOn: string;
  endedOn?: string | null | undefined;
  projectedMonthlyAmount: number;
  currency: string;
  /** Optional: link a resource, and the realized figure is read from its billing. */
  resourceId?: string | null | undefined;
  accountId?: string | null | undefined;
  costCentreId?: string | null | undefined;
  horizonMonths?: number | null | undefined;
}

/** What an automatic event lets a person change: context, never the facts. */
export interface SavingsEventAnnotationInput {
  note?: string | null | undefined;
  costCentreId?: string | null | undefined;
  horizonMonths?: number | null | undefined;
  /** Ends a recurring or open-ended event on this day. */
  endedOn?: string | null | undefined;
}

export const REALIZED_SAVINGS_GROUPINGS = ["month", "kind", "costCentre", "account"] as const;
export type RealizedSavingsGrouping = (typeof REALIZED_SAVINGS_GROUPINGS)[number];

export const REALIZED_SAVINGS_GROUPING_LABELS: Record<RealizedSavingsGrouping, string> = {
  month: "Month",
  kind: "Action type",
  costCentre: "Cost centre",
  account: "Account",
};

/**
 * A `realized_savings` dashboard card: the report's headline and one
 * breakdown. It stores only a view choice; the events and the figures are the
 * org's, so every card reads the same report.
 */
export interface RealizedSavingsWidgetConfig {
  version: 1;
  grouping: RealizedSavingsGrouping;
  /** Calendar months back, including the current one. */
  months: number;
}

export const REALIZED_SAVINGS_WIDGET_LIMITS = { minMonths: 1, maxMonths: 36 } as const;

export const DEFAULT_REALIZED_SAVINGS_WIDGET_CONFIG: RealizedSavingsWidgetConfig = {
  version: 1,
  grouping: "month",
  months: 12,
};

/** The `from`/`to` a card asks for: whole months back, through yesterday. */
export function realizedSavingsWidgetRange(
  config: Pick<RealizedSavingsWidgetConfig, "months">,
  now: Date = new Date(),
): { from: string; to: string } {
  const months = Math.min(
    REALIZED_SAVINGS_WIDGET_LIMITS.maxMonths,
    Math.max(REALIZED_SAVINGS_WIDGET_LIMITS.minMonths, Math.round(config.months)),
  );
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const to = yesterday < start ? start : yesterday;
  return { from: start.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/** The breakdown rows a grouping selects from a report, in one currency. */
export function realizedSavingsRows(
  report: RealizedSavingsReport,
  grouping: RealizedSavingsGrouping,
  currency: string,
): Array<{ key: string; label: string; realized: number; projected: number }> {
  if (grouping === "month") {
    return report.byMonth
      .filter((m) => m.currency === currency)
      .map((m) => ({ key: m.month, label: m.month, realized: m.realized, projected: m.projected }));
  }
  const buckets =
    grouping === "kind"
      ? report.byKind
      : grouping === "costCentre"
        ? report.byCostCentre
        : report.byAccount;
  return buckets
    .filter((b) => b.currency === currency)
    .map((b) => ({ key: b.key, label: b.label, realized: b.realized, projected: b.projected }));
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A reason the input is unusable, or null. Shared by the API, the editors and the CLI. */
export function savingsEventInputError(input: SavingsEventInput): string | null {
  const L = REALIZED_SAVINGS_LIMITS;
  const title = input.title?.trim() ?? "";
  if (title.length === 0) return "Give the saving a title";
  if (title.length > L.titleMaxLength) return `Keep the title under ${L.titleMaxLength} characters`;
  if (input.note && input.note.length > L.noteMaxLength) {
    return `Keep the note under ${L.noteMaxLength} characters`;
  }
  if (!ISO_DAY.test(input.occurredOn ?? "")) return "Pick the day the saving started";
  if (input.endedOn && !ISO_DAY.test(input.endedOn)) return "The end date is not a date";
  if (input.endedOn && input.endedOn < input.occurredOn) {
    return "The end date is before the start date";
  }
  const amount = Number(input.projectedMonthlyAmount);
  if (!Number.isFinite(amount) || amount <= 0) return "Enter a monthly amount above zero";
  if (amount > L.maxMonthlyAmount) return "That monthly amount is implausibly large";
  if (!/^[A-Z]{3}$/.test(input.currency ?? "")) return "Pick a currency";
  if (
    input.horizonMonths !== undefined &&
    input.horizonMonths !== null &&
    (!Number.isInteger(input.horizonMonths) ||
      input.horizonMonths < L.minHorizonMonths ||
      input.horizonMonths > L.maxHorizonMonths)
  ) {
    return `The horizon must be ${L.minHorizonMonths}–${L.maxHorizonMonths} months`;
  }
  return null;
}

/** Realized as a share of projected, or null when either side is missing or zero. */
export function realizedShareOfProjected(
  realized: number | null,
  projected: number | null,
): number | null {
  if (realized === null || projected === null || projected <= 0) return null;
  return realized / projected;
}

/** The totals row for one currency, or the largest when unspecified. */
export function primarySavingsTotal(
  report: Pick<RealizedSavingsReport, "totals">,
  currency?: string,
): RealizedSavingsTotal | null {
  if (currency) return report.totals.find((t) => t.currency === currency) ?? null;
  return report.totals[0] ?? null;
}

/** One-line description of a shortfall, for every surface's row. */
export function describeSavingsShortfall(
  shortfall: SavingsShortfall,
  format: (amount: number) => string,
): string {
  if (shortfall.kind === "grew_back") {
    return `Spend is back above the pre-action baseline (${format(shortfall.realizedPerDay)}/day)`;
  }
  return shortfall.projectedPerDay !== null
    ? `Realizing ${format(shortfall.realizedPerDay)}/day of a projected ${format(shortfall.projectedPerDay)}/day`
    : `Realizing ${format(shortfall.realizedPerDay)}/day`;
}

/** `GET /savings/realized`, permission `costs:read`. */
export async function fetchRealizedSavings(
  api: CloudFetch,
  orgId: string,
  options: { from?: string; to?: string } = {},
): Promise<RealizedSavingsReport | null> {
  const params = new URLSearchParams();
  if (options.from) params.set("from", options.from);
  if (options.to) params.set("to", options.to);
  const qs = params.toString();
  return api.org<RealizedSavingsReport>(orgId, `/savings/realized${qs ? `?${qs}` : ""}`);
}
