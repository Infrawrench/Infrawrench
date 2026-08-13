/**
 * Scenario models — **known future cost the trend cannot see.**
 *
 * Forecasting is a least-squares fit over trailing daily totals. That is a
 * trend estimate and nothing else: it cannot anticipate a purchase nobody has
 * made yet, a reserved-instance charge that lands next quarter, a team that
 * starts in September, or a tier change that takes 20% off the run rate from
 * the day it ships. Every one of those is a fact somebody in the org already
 * knows. A scenario model is where they write it down.
 *
 * The division of labour is the whole design, and it is load-bearing:
 *
 * - The **trend** answers "if nothing changes, what does this cost?"
 * - The **scenario** answers "here is what we already know is changing."
 *
 * They are never merged into one number. `POST /costs/query` returns the
 * unadjusted `forecast` alongside the adjusted `scenario.points`, so a reader
 * can always see what the trend said *before* somebody's assumptions touched
 * it, and every surface labels the adjusted line with the model's name.
 *
 * Three further rules the rest of the feature is built on:
 *
 * 1. **A scenario never alters recorded history.** Adjustments are evaluated
 *    only on days strictly after the last observed day. An adjustment dated in
 *    the past is not an error — a recurring cost that started in June is a
 *    perfectly sensible thing to describe — it simply contributes nothing to
 *    days that already have real spend behind them.
 * 2. **A model never silently mixes currencies.** The model declares one, and
 *    every amount in it must be in that currency.
 * 3. **Composition is defined, not incidental** — see
 *    {@link applyCostScenario}.
 *
 * Types live here rather than in `@infrawrench/ui` because mobile doesn't
 * depend on that package; `ui/src/cost/config.ts` holds the zod schema and
 * proves at compile time that it parses to exactly these shapes.
 */

import type { CostFilter } from "./costs";
import { CloudApiError, type CloudFetch } from "./fetch";

/* ------------------------------------------------------------------ *
 * The adjustment vocabulary.
 * ------------------------------------------------------------------ */

/**
 * What one adjustment says about the future.
 *
 * - `one_off` — a single amount on a single day. An annual licence renewal, a
 *   reserved-instance purchase, a data-migration egress bill.
 * - `recurring` — an amount every month (or every day) from a date, optionally
 *   ending. A new team's fixed cost, a support contract, a pilot that stops in
 *   November.
 * - `rate_change` — ±X% of the trend from a date, optionally ending. A
 *   migration that takes a fifth off compute, a pricing tier that adds 8%.
 *
 * The split between "an amount" and "a percentage of the trend" is the one
 * distinction that matters, and it is why the composition order below is what
 * it is: a percentage describes the *running* cost, an amount does not.
 */
export const COST_SCENARIO_ADJUSTMENT_KINDS = ["one_off", "recurring", "rate_change"] as const;
export type CostScenarioAdjustmentKind = (typeof COST_SCENARIO_ADJUSTMENT_KINDS)[number];

export const COST_SCENARIO_ADJUSTMENT_KIND_LABELS: Record<CostScenarioAdjustmentKind, string> = {
  one_off: "One-off amount",
  recurring: "Recurring amount",
  rate_change: "Step change in rate",
};

export const COST_SCENARIO_ADJUSTMENT_KIND_DESCRIPTIONS: Record<
  CostScenarioAdjustmentKind,
  string
> = {
  one_off: "A single charge on a single day — a purchase, an annual licence.",
  recurring: "The same amount every period from a date, optionally ending.",
  rate_change: "±X% of the trend from a date — a migration, a tier change.",
};

/**
 * How often a `recurring` adjustment charges.
 *
 * A monthly amount is spread evenly across the days of each calendar month it
 * covers, rather than landing as a spike on the 1st. Two reasons: a daily-binned
 * chart with a $30,000 spike on one day and nothing either side is unreadable,
 * and — more importantly — a month the scenario only partly covers should cost
 * proportionally less. A team that starts on the 20th costs a third of a month
 * in its first month, which is what "from the 20th" means.
 */
export const COST_SCENARIO_PERIODS = ["daily", "monthly"] as const;
export type CostScenarioPeriod = (typeof COST_SCENARIO_PERIODS)[number];

export const COST_SCENARIO_PERIOD_LABELS: Record<CostScenarioPeriod, string> = {
  daily: "per day",
  monthly: "per month",
};

/**
 * One adjustment inside a model.
 *
 * A single flat shape rather than a discriminated union of three, because it is
 * stored as jsonb, edited as a row in a table, and rendered by three platforms.
 * Which fields are meaningful follows from `kind`, and
 * {@link costScenarioModelInputError} refuses every combination that isn't:
 * an amount on a rate change, a percent on a one-off, an end date on a one-off.
 */
export interface CostScenarioAdjustment {
  /** Stable within the model. Used for ordering and for per-adjustment totals. */
  id: string;
  /** What this adjustment is — shown on the chart's scenario breakdown. */
  label: string;
  kind: CostScenarioAdjustmentKind;
  /** Inclusive first day this applies, YYYY-MM-DD. */
  startDate: string;
  /**
   * Inclusive last day, or null for "indefinitely". Meaningless (and refused)
   * for `one_off`, which is a single day by definition.
   */
  endDate: string | null;
  /**
   * The amount, in the model's currency's minor unit. Set for `one_off` and
   * `recurring`, null for `rate_change`. May be negative — "we are turning off
   * the old cluster" is as real a known future cost as buying a new one.
   */
  amountCents: number | null;
  /** The amount's currency; always the model's own. Null for `rate_change`. */
  currency: string | null;
  /** How often a `recurring` amount charges. Null for the other two kinds. */
  period: CostScenarioPeriod | null;
  /**
   * Percent change to the trend, for `rate_change`. -20 is "a fifth cheaper";
   * -100 is "this scope goes to zero". Null for the amount kinds.
   */
  percent: number | null;
  /**
   * Which spend this adjustment describes, in the same vocabulary as every
   * other cost filter. Empty is the whole organization.
   *
   * For a `rate_change` the scope is what the percentage is *of*: -20% scoped
   * to `provider = 'aws'` takes a fifth off the AWS trend and leaves everything
   * else alone. For an amount it decides whether the adjustment applies to a
   * given chart at all — a $40,000 GCP commitment does not belong on a chart
   * filtered to AWS.
   */
  scope: CostFilter[];
}

/** A scenario model as the API returns it. */
export interface CostScenarioModel {
  id: string;
  name: string;
  description: string | null;
  /** The one currency every amount in this model is denominated in. */
  currency: string;
  adjustments: CostScenarioAdjustment[];
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Create/update payload (POST/PUT /cost-scenarios). */
export interface CostScenarioModelInput {
  name: string;
  description?: string | undefined;
  currency: string;
  adjustments: CostScenarioAdjustment[];
}

/** What kind of object opted into a scenario model. */
export type CostScenarioReferentKind = "budget" | "cost_report" | "cost_graph_widget";

/**
 * One object still pointing at a scenario model — what a refused DELETE lists.
 *
 * Same stance as saved filters, for a sharper reason: a **budget** can opt into
 * a model, and deleting the model out from under it would silently move the
 * budget's forecast thresholds back to the bare trend. That changes when real
 * people get paged, so it is never a side effect of a delete.
 */
export interface CostScenarioReferent {
  kind: CostScenarioReferentKind;
  id: string;
  name: string;
  dashboardId?: string | undefined;
  dashboardName?: string | undefined;
}

/** Bounds the API enforces; the editors enforce the same ones locally. */
export const COST_SCENARIO_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  maxLabelLength: 120,
  /** More than this is a spreadsheet, not a scenario somebody reasons about. */
  maxAdjustments: 50,
  maxScopeFilters: 20,
  /** ±$1bn in cents — far above any real adjustment, far below overflow. */
  maxAmountCents: 100_000_000_000,
  /** -100% is "this goes to zero"; nothing below it means anything. */
  minPercent: -100,
  /** +1000% is an eleven-fold increase; past that it is a typo. */
  maxPercent: 1000,
  maxModelsPerOrg: 200,
} as const;

/** What a fresh editor starts from. */
export const DEFAULT_COST_SCENARIO_MODEL_INPUT: CostScenarioModelInput = {
  name: "",
  currency: "USD",
  adjustments: [],
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDay(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The single validation of a scenario model, run by the editors *and* by the
 * service on every write, so a form refuses exactly what the API refuses and in
 * the same words. Returns null when the input is valid.
 *
 * The currency rule is the one worth reading twice: a model with a EUR amount
 * and a USD amount would produce a projection that is the sum of two different
 * kinds of money. Rather than convert behind the user's back — at rates they
 * may not have stated, on a date nobody chose — the model refuses to hold both.
 */
export function costScenarioModelInputError(input: CostScenarioModelInput): string | null {
  const name = input.name?.trim() ?? "";
  if (!name) return "A scenario model needs a name.";
  if (name.length > COST_SCENARIO_LIMITS.maxNameLength) {
    return `Name must be ${COST_SCENARIO_LIMITS.maxNameLength} characters or fewer.`;
  }
  if ((input.description?.length ?? 0) > COST_SCENARIO_LIMITS.maxDescriptionLength) {
    return `Description must be ${COST_SCENARIO_LIMITS.maxDescriptionLength} characters or fewer.`;
  }

  const currency = input.currency?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(currency)) {
    return "Currency must be a three-letter code, e.g. USD.";
  }

  const adjustments = input.adjustments ?? [];
  if (adjustments.length === 0) {
    return (
      "A scenario model needs at least one adjustment — an empty model changes nothing, " +
      "which is the same as applying no scenario at all."
    );
  }
  if (adjustments.length > COST_SCENARIO_LIMITS.maxAdjustments) {
    return `A model can hold at most ${COST_SCENARIO_LIMITS.maxAdjustments} adjustments.`;
  }

  const seen = new Set<string>();
  for (const adjustment of adjustments) {
    const where = adjustment.label?.trim()
      ? `Adjustment "${adjustment.label.trim()}"`
      : "One adjustment";

    if (!adjustment.id?.trim()) return `${where} is missing its id.`;
    if (seen.has(adjustment.id)) return `Two adjustments share the id "${adjustment.id}".`;
    seen.add(adjustment.id);

    if (!adjustment.label?.trim()) {
      return "Every adjustment needs a label — it is what the chart names when the scenario moves a number.";
    }
    if (adjustment.label.length > COST_SCENARIO_LIMITS.maxLabelLength) {
      return `${where}: label must be ${COST_SCENARIO_LIMITS.maxLabelLength} characters or fewer.`;
    }
    if (!(COST_SCENARIO_ADJUSTMENT_KINDS as readonly string[]).includes(adjustment.kind)) {
      return `${where} has an unknown kind.`;
    }
    if (!isIsoDay(adjustment.startDate)) {
      return `${where} needs a valid start date (YYYY-MM-DD).`;
    }

    if (adjustment.kind === "one_off") {
      if (adjustment.endDate) {
        return `${where} is a one-off, which happens on one day — remove its end date, or make it recurring.`;
      }
    } else if (adjustment.endDate !== null && adjustment.endDate !== undefined) {
      if (!isIsoDay(adjustment.endDate)) {
        return `${where} needs a valid end date (YYYY-MM-DD), or none at all.`;
      }
      if (adjustment.endDate < adjustment.startDate) {
        return `${where} ends before it starts.`;
      }
    }

    if (adjustment.kind === "rate_change") {
      if (adjustment.amountCents !== null && adjustment.amountCents !== undefined) {
        return `${where} is a rate change, so it carries a percent, not an amount.`;
      }
      const percent = adjustment.percent;
      if (typeof percent !== "number" || !Number.isFinite(percent)) {
        return `${where} needs a percent.`;
      }
      if (percent === 0) {
        return `${where} changes the rate by 0%, which is not a change.`;
      }
      if (percent < COST_SCENARIO_LIMITS.minPercent || percent > COST_SCENARIO_LIMITS.maxPercent) {
        return `${where}: percent must be between ${COST_SCENARIO_LIMITS.minPercent} and ${COST_SCENARIO_LIMITS.maxPercent}.`;
      }
    } else {
      if (adjustment.percent !== null && adjustment.percent !== undefined) {
        return `${where} is an amount, so it carries no percent.`;
      }
      const amount = adjustment.amountCents;
      if (typeof amount !== "number" || !Number.isInteger(amount)) {
        return `${where} needs an amount, in whole ${currency} cents.`;
      }
      if (amount === 0) return `${where} is for nothing.`;
      if (Math.abs(amount) > COST_SCENARIO_LIMITS.maxAmountCents) {
        return `${where}: amount is implausibly large.`;
      }
      const adjustmentCurrency = adjustment.currency?.trim().toUpperCase() ?? "";
      if (adjustmentCurrency !== currency) {
        return (
          `${where} is in ${adjustmentCurrency || "no currency"}, but this model is in ${currency}. ` +
          "A model holds one currency — split the other amounts into their own model rather " +
          "than summing two kinds of money into one projection."
        );
      }
      if (adjustment.kind === "recurring") {
        if (!(COST_SCENARIO_PERIODS as readonly string[]).includes(adjustment.period ?? "")) {
          return `${where} needs a period — per day or per month.`;
        }
      } else if (adjustment.period !== null && adjustment.period !== undefined) {
        return `${where} is a one-off, so it has no period.`;
      }
    }

    if ((adjustment.scope?.length ?? 0) > COST_SCENARIO_LIMITS.maxScopeFilters) {
      return `${where}: a scope of more than ${COST_SCENARIO_LIMITS.maxScopeFilters} terms is a query, not a scope.`;
    }
    for (const term of adjustment.scope ?? []) {
      if (term.dimension === "tag" && !term.tagKey?.trim()) {
        return `${where}: a tag scope needs a tag key.`;
      }
      if ((term.values?.length ?? 0) === 0) {
        return `${where}: a scope term with no values matches nothing.`;
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * The composition engine — pure, and shared by every surface.
 * ------------------------------------------------------------------ */

/** A projected day, in the currency the caller is working in. */
export interface ScenarioDayPoint {
  /** YYYY-MM-DD. */
  day: string;
  amount: number;
}

/**
 * What one adjustment added over the whole projected horizon. Rendered under a
 * scenario chart so "the line moved because of X" is answerable without
 * re-reading the model.
 */
export interface CostScenarioContribution {
  adjustmentId: string;
  label: string;
  kind: CostScenarioAdjustmentKind;
  /** Signed total this adjustment added across the horizon, in major units. */
  amount: number;
}

/** The adjusted projection, alongside the untouched baseline it came from. */
export interface CostScenarioProjection {
  modelId: string;
  modelName: string;
  /** The currency `points` and `contributions` are expressed in. */
  currency: string;
  /**
   * The adjusted daily projection — exactly the same days as the response's
   * `forecast`, never one day more or fewer. A scenario modifies the projected
   * region; it does not extend it.
   */
  points: Array<{ bucket: string; amount: number }>;
  /** Per-adjustment totals, in model order. Zero-contribution rows are kept. */
  contributions: CostScenarioContribution[];
  /** Signed total difference from the baseline across the horizon. */
  totalDelta: number;
  /**
   * Set when the model's amounts were converted into `currency` at the org's
   * stated rates — the caveat belongs next to the number, not in a tooltip.
   */
  convertedFrom?: string | undefined;
  /**
   * Adjustments the chart's own filters exclude, by label. A $40,000 GCP
   * commitment on a chart filtered to AWS is *correctly* left out, and saying
   * so is the difference between a projection a reader trusts and one they
   * quietly assume is broken.
   */
  outOfScope: string[];
}

function daysInMonthOf(day: string): number {
  const d = new Date(`${day}T00:00:00.000Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

/** Whether `day` falls inside an adjustment's own window. */
function isActiveOn(adjustment: CostScenarioAdjustment, day: string): boolean {
  if (adjustment.kind === "one_off") return day === adjustment.startDate;
  if (day < adjustment.startDate) return false;
  if (adjustment.endDate && day > adjustment.endDate) return false;
  return true;
}

/**
 * The amount an absolute adjustment contributes on one day, in major units.
 * A monthly amount is spread evenly across that calendar month's days — see
 * {@link COST_SCENARIO_PERIODS}.
 */
function absoluteAmountOn(adjustment: CostScenarioAdjustment, day: string): number {
  if (!isActiveOn(adjustment, day)) return 0;
  const amount = (adjustment.amountCents ?? 0) / 100;
  if (adjustment.kind === "one_off") return amount;
  if (adjustment.period === "monthly") return amount / daysInMonthOf(day);
  return amount;
}

/**
 * A stable key for an adjustment's scope, so the orchestrator can fetch one
 * sub-baseline per distinct scope rather than one per adjustment.
 */
export function costScenarioScopeKey(scope: CostFilter[]): string {
  if (scope.length === 0) return "";
  return JSON.stringify(
    [...scope]
      .map((f) => ({
        dimension: f.dimension,
        op: f.op,
        tagKey: f.tagKey ?? null,
        values: [...f.values].sort(),
      }))
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
  );
}

/**
 * Whether a chart's own filters make an adjustment's scope impossible.
 *
 * Purely syntactic and deliberately conservative: it answers "no" unless it can
 * *prove* the two cannot overlap (`provider = 'gcp'` on the chart against
 * `provider = 'aws'` on the adjustment, or a chart that excludes exactly what
 * the adjustment includes). Anything it cannot decide is treated as in scope,
 * because a rate change's real contribution is measured from its own scoped
 * baseline anyway — where a genuinely disjoint scope produces zero spend and
 * therefore zero delta. The check exists for the *amount* kinds, which have no
 * baseline to be measured against and would otherwise add a GCP commitment to
 * an AWS-only chart.
 */
export function scenarioScopeExcluded(scope: CostFilter[], chartFilters: CostFilter[]): boolean {
  for (const term of scope) {
    if (term.op !== "in") continue;
    const values = new Set(term.values);
    for (const chartTerm of chartFilters) {
      if (chartTerm.dimension !== term.dimension) continue;
      if (term.dimension === "tag" && chartTerm.tagKey !== term.tagKey) continue;
      if (chartTerm.op === "in") {
        // Disjoint `in` sets: nothing can satisfy both.
        if (!chartTerm.values.some((v) => values.has(v))) return true;
      } else if (term.values.every((v) => chartTerm.values.includes(v))) {
        // The chart excludes every value the adjustment includes.
        return true;
      }
    }
  }
  return false;
}

/** Everything {@link applyCostScenario} needs, already fetched. */
export interface ApplyCostScenarioInput {
  model: Pick<CostScenarioModel, "id" | "name" | "currency">;
  adjustments: CostScenarioAdjustment[];
  /** The unadjusted trend projection. Never mutated. */
  baseline: ScenarioDayPoint[];
  /**
   * Per-scope trend projections over the *same days as `baseline`*, keyed by
   * {@link costScenarioScopeKey}. The empty key is the whole chart, and falls
   * back to `baseline` when absent.
   */
  scopedBaselines?: Map<string, ScenarioDayPoint[]> | undefined;
  /** The chart's own filters, for the out-of-scope check. */
  chartFilters?: CostFilter[] | undefined;
  /** Multiply every amount by this before adding it. 1 when no conversion. */
  amountRate?: number | undefined;
  /** The currency the result is expressed in; defaults to the model's. */
  currency?: string | undefined;
  /** Named on the result when `amountRate` is not 1. */
  convertedFrom?: string | undefined;
}

/**
 * Overlay a scenario on a baseline projection.
 *
 * ## The composition order
 *
 * Two stages, and the order between them is the contract:
 *
 * 1. **Rate changes**, measured against the trend. Each contributes
 *    `scopedBaseline(day) × percent/100` — a *delta*, computed from the
 *    unadjusted baseline of its own scope. Two overlapping rate changes
 *    therefore compose additively (+10% and −20% is −10%, not ×1.1×0.8), and
 *    because every one of them reads the same untouched baseline, **their order
 *    among themselves cannot matter.**
 * 2. **Absolute amounts**, added afterwards.
 *
 * Rates first, amounts second, and never the reverse. "We are migrating, so
 * everything gets 20% cheaper" is a statement about the *running* cost; it is
 * not a discount on the annual licence you also told us about. Applying the
 * percentage to the amounts would quietly rewrite a number the user typed in
 * full — a $50,000 purchase would appear as $40,000 with nothing saying why.
 *
 * The result is clamped at zero per day, exactly as the trend forecast is: a
 * projection cannot be negative spend.
 *
 * **History is untouched by construction** — this function only ever sees the
 * projected days, and returns exactly those days back.
 */
export function applyCostScenario(input: ApplyCostScenarioInput): CostScenarioProjection {
  const {
    model,
    adjustments,
    baseline,
    scopedBaselines,
    chartFilters = [],
    amountRate = 1,
    currency = model.currency,
    convertedFrom,
  } = input;

  const baselineByDay = new Map(baseline.map((p) => [p.day, p.amount]));
  const scopedFor = (scope: CostFilter[]): Map<string, number> => {
    const key = costScenarioScopeKey(scope);
    if (key === "") return baselineByDay;
    const points = scopedBaselines?.get(key);
    // No sub-baseline fetched (or none fittable) means no measurable spend in
    // that scope, so a percentage of it is zero — never a percentage of the
    // whole chart, which would silently widen the adjustment.
    return points ? new Map(points.map((p) => [p.day, p.amount])) : new Map();
  };

  const outOfScope: string[] = [];
  const active: Array<{ adjustment: CostScenarioAdjustment; scoped: Map<string, number> }> = [];
  for (const adjustment of adjustments) {
    if (scenarioScopeExcluded(adjustment.scope ?? [], chartFilters)) {
      outOfScope.push(adjustment.label);
      continue;
    }
    active.push({ adjustment, scoped: scopedFor(adjustment.scope ?? []) });
  }

  const contributions = new Map<string, number>();
  const points: Array<{ bucket: string; amount: number }> = [];
  let totalDelta = 0;

  for (const point of baseline) {
    let delta = 0;

    // Stage 1 — rate changes, every one of them measured against the untouched
    // baseline of its own scope.
    for (const { adjustment, scoped } of active) {
      if (adjustment.kind !== "rate_change") continue;
      if (!isActiveOn(adjustment, point.day)) continue;
      const base = scoped.get(point.day) ?? 0;
      const contribution = base * ((adjustment.percent ?? 0) / 100);
      delta += contribution;
      contributions.set(adjustment.id, (contributions.get(adjustment.id) ?? 0) + contribution);
    }

    // Stage 2 — absolute amounts, added on top of the re-rated trend.
    for (const { adjustment } of active) {
      if (adjustment.kind === "rate_change") continue;
      const contribution = absoluteAmountOn(adjustment, point.day) * amountRate;
      if (contribution === 0) continue;
      delta += contribution;
      contributions.set(adjustment.id, (contributions.get(adjustment.id) ?? 0) + contribution);
    }

    // Clamped like the trend itself: a day cannot project negative spend. The
    // clamp is applied to the total, not to each adjustment, so a -100% rate
    // change plus a purchase still shows the purchase.
    const adjusted = Math.max(0, point.amount + delta);
    totalDelta += adjusted - point.amount;
    points.push({ bucket: point.day, amount: round6(adjusted) });
  }

  return {
    modelId: model.id,
    modelName: model.name,
    currency,
    points,
    contributions: adjustments.map((a) => ({
      adjustmentId: a.id,
      label: a.label,
      kind: a.kind,
      amount: round6(contributions.get(a.id) ?? 0),
    })),
    totalDelta: round6(totalDelta),
    ...(convertedFrom ? { convertedFrom } : {}),
    outOfScope,
  };
}

/** Six places, matching `cost/currency-convert.ts` — see its AMOUNT_DECIMALS. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ *
 * Presentation helpers — shared so every surface says the same thing.
 * ------------------------------------------------------------------ */

/** "+$40,000 on 12 Sep 2026", "−20% from 1 Oct 2026", "+$8,000 per month". */
export function describeCostScenarioAdjustment(
  adjustment: CostScenarioAdjustment,
  currency: string,
): string {
  const from = formatScenarioDay(adjustment.startDate);
  const until = adjustment.endDate ? ` until ${formatScenarioDay(adjustment.endDate)}` : "";
  if (adjustment.kind === "rate_change") {
    const pct = adjustment.percent ?? 0;
    return `${pct > 0 ? "+" : ""}${pct}% from ${from}${until}`;
  }
  const amount = (adjustment.amountCents ?? 0) / 100;
  const money = formatScenarioMoney(amount, adjustment.currency ?? currency);
  if (adjustment.kind === "one_off") return `${amount > 0 ? "+" : ""}${money} on ${from}`;
  const per = adjustment.period === "daily" ? "per day" : "per month";
  return `${amount > 0 ? "+" : ""}${money} ${per} from ${from}${until}`;
}

/** "3 adjustments · +$120,000 over the horizon" for a list row. */
export function describeCostScenarioModel(model: CostScenarioModel): string {
  const count = model.adjustments.length;
  const rates = model.adjustments.filter((a) => a.kind === "rate_change").length;
  const amounts = count - rates;
  const parts: string[] = [];
  if (amounts > 0) parts.push(`${amounts} amount${amounts === 1 ? "" : "s"}`);
  if (rates > 0) parts.push(`${rates} rate change${rates === 1 ? "" : "s"}`);
  return `${parts.join(", ")} · ${model.currency}`;
}

/** "budget \"prod\", dashboard graph \"Spend\" on Ops" — how a refusal reads. */
export function describeCostScenarioReferents(referents: CostScenarioReferent[]): string {
  const label: Record<CostScenarioReferentKind, string> = {
    budget: "budget",
    cost_report: "report",
    cost_graph_widget: "dashboard graph",
  };
  return referents
    .map((r) => `${label[r.kind]} "${r.name}"${r.dashboardName ? ` on ${r.dashboardName}` : ""}`)
    .join(", ");
}

function formatScenarioDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatScenarioMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: Math.abs(amount) < 10 ? 2 : 0,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/* ------------------------------------------------------------------ *
 * Fetch helpers — used by mobile (web and desktop go through their own
 * transports, like the rest of the cost surface).
 * ------------------------------------------------------------------ */

/** The org's scenario models (`GET /cost-scenarios`, `costs:read`). */
export async function listCostScenarioModels(
  api: CloudFetch,
  orgId: string,
): Promise<CostScenarioModel[]> {
  const res = await api.org<{ models: CostScenarioModel[] }>(orgId, "/cost-scenarios");
  return res?.models ?? [];
}

/** One model by id, or null when the server says it doesn't exist. */
export async function getCostScenarioModel(
  api: CloudFetch,
  orgId: string,
  modelId: string,
): Promise<CostScenarioModel | null> {
  try {
    return await api.org<CostScenarioModel>(
      orgId,
      `/cost-scenarios/${encodeURIComponent(modelId)}`,
    );
  } catch (error) {
    // Only a 404 means "no such model". Anything else (network, auth, 5xx)
    // propagates so callers show an error state instead of "not found".
    if (error instanceof CloudApiError && error.status === 404) return null;
    throw error;
  }
}
