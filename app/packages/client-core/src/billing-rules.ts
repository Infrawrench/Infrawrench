/**
 * Billing rules: the org's own adjustments to collected spend.
 *
 * `cost_daily` holds what the provider charged. What an organization *reports
 * internally* is routinely something else: a platform team recovers shared
 * overhead with a markup, a negotiated discount lands outside the provider's
 * own pricing, a shared cluster is charged back to the teams that use it. Until
 * this existed, all of that happened in a spreadsheet and the product stopped
 * being the source of truth.
 *
 * ## The two rules that everything else follows from
 *
 * 1. **Adjustments are applied at query time and never written into
 *    `cost_daily`.** Collected spend stays exactly what the provider reported,
 *    because that is the audit trail: the row you reconcile against an
 *    invoice. Once it is overwritten there is no way back, and no rule edit can
 *    ever restate history because history was never touched.
 * 2. **The unadjusted number stays visible.** Every adjusted answer carries the
 *    collected figure beside it ({@link CostAdjustmentSummary.rawTotals}) and
 *    names the rules that moved it. A report that silently shows marked-up
 *    spend is a report nobody can reconcile.
 *
 * ## The ordering model, stated once
 *
 * Rules evaluate in ascending `priority`, ties broken by `createdAt` then `id`:
 * total and deterministic, the same convention `orderAllocationRules` uses
 * for allocation. Within that single order the three kinds compose differently,
 * and that difference *is* the model:
 *
 * - **Percentage rules all apply.** Every enabled percentage rule whose match
 *   holds multiplies the row. Two 10% markups give ×1.21, not ×1.20: markups
 *   genuinely compose, and collapsing them to one would silently under-recover.
 *   Multiplication commutes, so priority does not change the arithmetic; the
 *   order still exists so the audit list reads the same way twice.
 * - **Reallocation is first-match-wins.** The first reallocation rule whose
 *   match holds re-attributes the row and no later one fires. A row moves at
 *   most once, which is exactly what makes the total conserved: reallocation
 *   rewrites *where* money lands and never *how much* there is.
 * - **Fixed amounts are not functions of any row.** A "$5,000/month platform
 *   overhead" has no cost row behind it, so it is not multiplied by anything
 *   and cannot be reallocated by anything. It is pro-rated over the queried
 *   range ({@link fixedRuleAmountForRange}) and reported separately.
 *
 * Percentage and reallocation are order-independent *of each other* for the
 * same reason: one changes the amount, the other changes the label.
 *
 * ## Why the types live here
 *
 * Mobile does not depend on `@infrawrench/ui`, and the compiler that turns
 * these rules into SQL lives in `server-core`. One definition in `client-core`
 * is what stops the wire shape, the zod schema (`ui/src/cost/config.ts`) and
 * the ClickHouse compiler from drifting into three different vocabularies.
 */
import type { CostChargeType } from "./costs.js";
import { pricingExpressionError } from "./pricing-expression.js";

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

export const BILLING_RULE_KINDS = [
  "percentage",
  "fixed",
  "reallocation",
  "tiered",
  "expression",
] as const;
export type BillingRuleKind = (typeof BILLING_RULE_KINDS)[number];

/**
 * Kinds that only apply when a managed account's invoice is priced.
 *
 * A tier is a statement about *one customer's* monthly volume, and a custom
 * expression is evaluated per invoice line; neither has a meaning over the
 * organisation's own cost graphs, budgets or showback, so those paths never
 * compile them and never name them in an "adjusted" caption. Saying so in one
 * constant is what keeps a graph from claiming a rule moved it when it did not.
 */
export const BILLING_RULE_INVOICE_KINDS = ["tiered", "expression"] as const;
export type BillingRuleInvoiceKind = (typeof BILLING_RULE_INVOICE_KINDS)[number];

export function isInvoiceOnlyBillingRuleKind(
  kind: BillingRuleKind,
): kind is BillingRuleInvoiceKind {
  return (BILLING_RULE_INVOICE_KINDS as readonly string[]).includes(kind);
}

export const BILLING_RULE_KIND_LABELS: Record<BillingRuleKind, string> = {
  percentage: "Markup or discount",
  fixed: "Fixed amount",
  reallocation: "Reallocation",
  tiered: "Tiered rate",
  expression: "Custom expression",
};

export const BILLING_RULE_KIND_DESCRIPTIONS: Record<BillingRuleKind, string> = {
  percentage:
    "Multiply matched spend by a percentage. Positive marks up, negative discounts. Every " +
    "matching percentage rule applies, so two 10% markups compound to 21%.",
  fixed:
    "Add a flat amount per day or per month over the reported period. Nothing matches it to a " +
    "cost row, so it is pro-rated across the range and always reported as its own figure.",
  reallocation:
    "Move matched spend to a different cost centre or account. The first matching reallocation " +
    "rule wins, so a row moves exactly once and the organisation's total never changes.",
  tiered:
    "Mark up or discount a customer's matched spend by rate tiers on their monthly volume, " +
    "for example +8% up to 10,000, +5% to 50,000 and +3% above. Applies to invoices only.",
  expression:
    "Compute a line's new cost with a small, safe expression such as " +
    '`if service == "AmazonEC2" and tag.env == "prod" then cost * 1.1`. Applies to invoices only.',
};

/**
 * How a tiered rule turns a volume into an amount.
 *
 * - `marginal`: each slice of spend is charged at its own tier's rate, like
 *   income tax. Crossing a threshold never makes the earlier spend dearer.
 * - `volume`: the whole month's spend is charged at the rate of the tier the
 *   total falls in. Simpler to quote, and it has a cliff at every threshold.
 */
export const BILLING_RULE_TIER_MODES = ["marginal", "volume"] as const;
export type BillingRuleTierMode = (typeof BILLING_RULE_TIER_MODES)[number];

export const BILLING_RULE_TIER_MODE_LABELS: Record<BillingRuleTierMode, string> = {
  marginal: "Marginal (each slice at its own rate)",
  volume: "Whole volume (all spend at the reached tier's rate)",
};

/** Whether volume is measured over all matched spend or per service. */
export const BILLING_RULE_TIER_SCOPES = ["overall", "per_service"] as const;
export type BillingRuleTierScope = (typeof BILLING_RULE_TIER_SCOPES)[number];

export const BILLING_RULE_TIER_SCOPE_LABELS: Record<BillingRuleTierScope, string> = {
  overall: "Overall monthly spend",
  per_service: "Each service's monthly spend",
};

/**
 * One rate tier. `upTo` is the exclusive upper bound of monthly spend this
 * tier covers, in the rule's currency; null on the last tier, which is
 * open-ended. Tiers are stored in ascending order and start at zero.
 */
export interface BillingRuleTier {
  upTo: number | null;
  /** Signed: +8 marks up by 8%, -2 discounts by 2%. */
  percent: number;
}

/** How often a fixed-amount rule's amount recurs. */
export const BILLING_RULE_FIXED_PERIODS = ["daily", "monthly"] as const;
export type BillingRuleFixedPeriod = (typeof BILLING_RULE_FIXED_PERIODS)[number];

/** What a reallocation rule moves spend onto. */
export const BILLING_RULE_TARGET_KINDS = ["cost_centre", "account"] as const;
export type BillingRuleTargetKind = (typeof BILLING_RULE_TARGET_KINDS)[number];

/**
 * What a rule matches against a cost row.
 *
 * Deliberately the same vocabulary {@link AllocationRuleMatch} already uses
 * (tag key/value, account, provider, service) plus `chargeType`. Every set
 * field must match (AND); a rule with no fields is a catch-all. `tagKey` alone
 * means "the row carries this tag at all"; with `tagValue` the value must be
 * equal.
 *
 * Inventing a second rule vocabulary for the same `cost_daily` columns is how
 * an org ends up with two dialects that agree on most rows and disagree on the
 * ones that matter, so this shape is a superset of the allocation one rather
 * than a cousin of it.
 */
export interface BillingRuleMatch {
  tagKey?: string | undefined;
  tagValue?: string | undefined;
  accountId?: string | undefined;
  pluginId?: string | undefined;
  service?: string | undefined;
  /**
   * Narrow to one kind of charge. The reason this exists and allocation's match
   * does not have it: a markup that recovers overhead should usually *not*
   * apply to credits, refunds or commitment purchases, and without this field
   * the only way to express "usage only" is to not write the rule at all.
   */
  chargeType?: CostChargeType | undefined;
}

/**
 * The adjustment a rule performs. One flat interface rather than a discriminated
 * union, for the same reasons `CostScenarioAdjustment` is flat: it is stored as
 * jsonb, edited as one row in a table, and rendered by three platforms. Which
 * fields are meaningful follows from `kind`, and {@link billingRuleInputError}
 * refuses every combination that does not.
 */
export interface BillingRuleAdjustment {
  kind: BillingRuleKind;
  /**
   * `percentage` only. Signed: `+15` is a 15% markup, `-10` a 10% discount.
   * Bounded below at -100: a discount larger than the cost would turn spend
   * into income, which is not a thing a cost report can mean.
   */
  percent?: number | null | undefined;
  /** `fixed` only. In `currency`'s major unit, per {@link period}. */
  amount?: number | null | undefined;
  /** `fixed` only. The currency `amount` is denominated in. */
  currency?: string | null | undefined;
  /** `fixed` only. Whether `amount` recurs daily or monthly. */
  period?: BillingRuleFixedPeriod | null | undefined;
  /**
   * `reallocation` (required) and `fixed` (optional, where the flat charge is
   * booked). Absent on a fixed rule means the charge is org-level and lands in
   * the unallocated bucket rather than being invented onto a centre.
   */
  targetKind?: BillingRuleTargetKind | null | undefined;
  /** The cost centre id or account id named by {@link targetKind}. */
  targetId?: string | null | undefined;
  /**
   * `tiered` only. Ascending tiers on monthly spend in {@link currency}; the
   * last one has `upTo: null`.
   */
  tiers?: BillingRuleTier[] | null | undefined;
  /** `tiered` only. */
  tierMode?: BillingRuleTierMode | null | undefined;
  /** `tiered` only. */
  tierScope?: BillingRuleTierScope | null | undefined;
  /**
   * `expression` only. The source of a pricing expression; see
   * `pricing-expression.ts` for the language. Stored as text and parsed on
   * every use, so the stored form is always the one a person wrote.
   */
  expression?: string | null | undefined;
}

export interface BillingRule {
  id: string;
  name: string;
  description: string | null;
  /**
   * Disabled rules are kept, not deleted. A markup switched off for one quarter
   * and back on for the next is the normal life of these objects, and deleting
   * it would lose the wording finance agreed to.
   */
  enabled: boolean;
  /** Lower fires first. See the ordering model in this module's header. */
  priority: number;
  match: BillingRuleMatch;
  adjustment: BillingRuleAdjustment;
  /**
   * `tiered` and `expression` only: the managed accounts (customers) whose
   * invoices this rule prices. Empty means every customer whose billing rules
   * are on.
   */
  managedAccountIds?: string[] | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface BillingRuleInput {
  name: string;
  description?: string | null | undefined;
  enabled: boolean;
  priority: number;
  match: BillingRuleMatch;
  adjustment: BillingRuleAdjustment;
  managedAccountIds?: string[] | undefined;
}

export const BILLING_RULE_LIMITS = {
  maxNameLength: 120,
  maxDescriptionLength: 2000,
  /**
   * More than this is not a policy anybody reasons about, and every rule is a
   * branch in the one SQL expression these compile into.
   */
  maxRules: 100,
  /** -100% is "this becomes free"; anything below turns spend into income. */
  minPercent: -100,
  /** +1000% is an eleven-fold markup. Past that it is a typo. */
  maxPercent: 1000,
  /** ±$1bn per period: far above any real overhead, far below overflow. */
  maxFixedAmount: 1_000_000_000,
  /** Tiers on one tiered rule. */
  maxTiers: 20,
  /** Customers one invoice-only rule can be scoped to. */
  maxManagedAccounts: 100,
} as const;

export const DEFAULT_BILLING_RULE_INPUT: BillingRuleInput = {
  name: "",
  description: null,
  enabled: true,
  priority: 0,
  match: {},
  adjustment: { kind: "percentage", percent: 0 },
  managedAccountIds: [],
};

/* ------------------------------------------------------------------ *
 * Validation: one sentence, shared by the editor and the API.
 * ------------------------------------------------------------------ */

/**
 * Why this rule cannot be saved, as a sentence a form and a 400 can both show,
 * or null when it is fine.
 *
 * A presentable sentence rather than an error code, on purpose: the settings
 * form and the HTTP API must refuse in identical words, or a user who fixes
 * what the form said and still gets a 400 has no way forward.
 */
export function billingRuleInputError(input: BillingRuleInput): string | null {
  const name = input.name?.trim() ?? "";
  if (name.length === 0) return "A billing rule needs a name.";
  if (name.length > BILLING_RULE_LIMITS.maxNameLength) {
    return `A billing rule's name can be at most ${BILLING_RULE_LIMITS.maxNameLength} characters.`;
  }
  if ((input.description ?? "").length > BILLING_RULE_LIMITS.maxDescriptionLength) {
    return `A billing rule's description can be at most ${BILLING_RULE_LIMITS.maxDescriptionLength} characters.`;
  }
  if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100_000) {
    return "Priority must be a whole number between 0 and 100000.";
  }

  const m = input.match;
  if (m.tagValue?.trim() && !m.tagKey?.trim()) {
    return "A tag value needs a tag key — a value on its own matches nothing.";
  }

  const a = input.adjustment;
  if (!(BILLING_RULE_KINDS as readonly string[]).includes(a.kind)) {
    return `Unknown adjustment kind "${a.kind}".`;
  }

  if (a.kind === "percentage") {
    if (typeof a.percent !== "number" || !Number.isFinite(a.percent)) {
      return "A markup or discount needs a percentage.";
    }
    if (a.percent < BILLING_RULE_LIMITS.minPercent || a.percent > BILLING_RULE_LIMITS.maxPercent) {
      return `A percentage must be between ${BILLING_RULE_LIMITS.minPercent}% and ${BILLING_RULE_LIMITS.maxPercent}%.`;
    }
    if (a.percent === 0) {
      // Refused rather than stored: a 0% rule appears in every "these rules are
      // in force" caption and changes nothing, which is the most confusing
      // possible state for a feature whose whole job is to be legible.
      return "A markup or discount of 0% changes nothing — delete the rule or give it a percentage.";
    }
  } else if (a.percent !== null && a.percent !== undefined) {
    return `A ${BILLING_RULE_KIND_LABELS[a.kind].toLowerCase()} rule cannot carry a percentage.`;
  }

  if (a.kind === "fixed") {
    if (typeof a.amount !== "number" || !Number.isFinite(a.amount) || a.amount === 0) {
      return "A fixed-amount rule needs a non-zero amount.";
    }
    if (Math.abs(a.amount) > BILLING_RULE_LIMITS.maxFixedAmount) {
      return `A fixed amount must be within ±${BILLING_RULE_LIMITS.maxFixedAmount}.`;
    }
    if (!a.currency || !/^[A-Za-z]{3}$/.test(a.currency)) {
      return "A fixed-amount rule needs a three-letter currency code.";
    }
    if (!(BILLING_RULE_FIXED_PERIODS as readonly string[]).includes(a.period ?? "")) {
      return "A fixed-amount rule must recur daily or monthly.";
    }
  } else if (a.amount !== null && a.amount !== undefined) {
    return `A ${BILLING_RULE_KIND_LABELS[a.kind].toLowerCase()} rule cannot carry an amount.`;
  }

  if (a.kind === "reallocation") {
    if (!(BILLING_RULE_TARGET_KINDS as readonly string[]).includes(a.targetKind ?? "")) {
      return "A reallocation rule must move spend onto a cost centre or an account.";
    }
    if (!a.targetId?.trim()) return "A reallocation rule needs a target to move spend onto.";
  } else if (a.kind === "percentage" && (a.targetKind || a.targetId)) {
    return "A markup or discount cannot move spend — use a reallocation rule for that.";
  } else if (a.kind === "fixed" && a.targetKind && !a.targetId?.trim()) {
    return "A fixed-amount rule with a target needs the target itself.";
  } else if ((a.kind === "tiered" || a.kind === "expression") && (a.targetKind || a.targetId)) {
    return "A tiered or expression rule cannot move spend; use a reallocation rule for that.";
  }

  if (a.kind === "tiered") {
    const tierError = billingRuleTiersError(a.tiers ?? []);
    if (tierError) return tierError;
    if (!a.currency || !/^[A-Za-z]{3}$/.test(a.currency)) {
      return "A tiered rule needs the three-letter currency its thresholds are stated in.";
    }
    if (!(BILLING_RULE_TIER_MODES as readonly string[]).includes(a.tierMode ?? "")) {
      return "A tiered rule must be marginal or whole-volume.";
    }
    if (!(BILLING_RULE_TIER_SCOPES as readonly string[]).includes(a.tierScope ?? "")) {
      return "A tiered rule must measure overall spend or each service's spend.";
    }
  } else if (a.tiers && a.tiers.length > 0) {
    return `A ${BILLING_RULE_KIND_LABELS[a.kind].toLowerCase()} rule cannot carry tiers.`;
  }

  if (a.kind === "expression") {
    if (!a.expression?.trim()) return "An expression rule needs an expression.";
    const exprError = pricingExpressionError(a.expression);
    if (exprError) {
      return `Expression error at character ${exprError.position + 1}: ${exprError.message}`;
    }
  } else if (a.expression) {
    return `A ${BILLING_RULE_KIND_LABELS[a.kind].toLowerCase()} rule cannot carry an expression.`;
  }

  const scoped = input.managedAccountIds ?? [];
  if (scoped.length > 0 && !isInvoiceOnlyBillingRuleKind(a.kind)) {
    return (
      "Only tiered and expression rules can be limited to particular customers; the other kinds " +
      "apply to the organisation's own figures too."
    );
  }
  if (scoped.length > BILLING_RULE_LIMITS.maxManagedAccounts) {
    return `A rule can name at most ${BILLING_RULE_LIMITS.maxManagedAccounts} customers.`;
  }

  return null;
}

/**
 * Why a tier list is unusable, or null. Shared by the editor and the API.
 *
 * Tiers must be ascending with strictly increasing positive thresholds, and
 * only the last may be open-ended: a gap or an overlap would leave some
 * monthly volume with no rate or two.
 */
export function billingRuleTiersError(tiers: readonly BillingRuleTier[]): string | null {
  if (tiers.length === 0) return "A tiered rule needs at least one tier.";
  if (tiers.length > BILLING_RULE_LIMITS.maxTiers) {
    return `A tiered rule can have at most ${BILLING_RULE_LIMITS.maxTiers} tiers.`;
  }
  let previous = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i]!;
    if (typeof tier.percent !== "number" || !Number.isFinite(tier.percent)) {
      return `Tier ${i + 1} needs a percentage.`;
    }
    if (
      tier.percent < BILLING_RULE_LIMITS.minPercent ||
      tier.percent > BILLING_RULE_LIMITS.maxPercent
    ) {
      return `Tier ${i + 1}'s percentage must be between ${BILLING_RULE_LIMITS.minPercent}% and ${BILLING_RULE_LIMITS.maxPercent}%.`;
    }
    const last = i === tiers.length - 1;
    if (last) {
      if (tier.upTo !== null) return "The last tier must be open-ended (no upper bound).";
    } else {
      if (typeof tier.upTo !== "number" || !Number.isFinite(tier.upTo)) {
        return `Tier ${i + 1} needs an upper bound; only the last tier is open-ended.`;
      }
      if (tier.upTo <= previous) {
        return `Tier ${i + 1}'s upper bound must be greater than ${previous}.`;
      }
      if (tier.upTo > BILLING_RULE_LIMITS.maxFixedAmount) {
        return `Tier ${i + 1}'s upper bound must be at most ${BILLING_RULE_LIMITS.maxFixedAmount}.`;
      }
      previous = tier.upTo;
    }
  }
  return null;
}

/**
 * Drop empty strings and kind-inapplicable fields so "unset" has exactly one
 * representation: the same normalisation `normalizeMatch` performs for
 * allocation rules, extended over the adjustment.
 *
 * Normalising *before* validating is deliberate: a user typing `usd` into a
 * currency box has not made a mistake.
 */
export function normalizeBillingRuleInput(input: BillingRuleInput): BillingRuleInput {
  const match: BillingRuleMatch = {};
  if (input.match.tagKey?.trim()) match.tagKey = input.match.tagKey.trim();
  if (match.tagKey && input.match.tagValue?.trim()) match.tagValue = input.match.tagValue.trim();
  if (input.match.accountId?.trim()) match.accountId = input.match.accountId.trim();
  if (input.match.pluginId?.trim()) match.pluginId = input.match.pluginId.trim();
  if (input.match.service?.trim()) match.service = input.match.service.trim();
  if (input.match.chargeType) match.chargeType = input.match.chargeType;

  const a = input.adjustment;
  const kind = a.kind;
  const targetless = kind === "percentage" || kind === "tiered" || kind === "expression";
  const adjustment: BillingRuleAdjustment = {
    kind,
    percent: kind === "percentage" ? (a.percent ?? 0) : null,
    amount: kind === "fixed" ? (a.amount ?? 0) : null,
    currency:
      kind === "fixed" || kind === "tiered" ? (a.currency?.trim().toUpperCase() ?? null) : null,
    period: kind === "fixed" ? (a.period ?? "monthly") : null,
    // A percentage, tiered or expression rule can never carry a target; a fixed
    // rule may, and a reallocation rule must.
    targetKind: targetless ? null : (a.targetKind ?? null),
    targetId: targetless ? null : a.targetId?.trim() || null,
    tiers:
      kind === "tiered"
        ? (a.tiers ?? []).map((t) => ({ upTo: t.upTo ?? null, percent: t.percent }))
        : null,
    tierMode: kind === "tiered" ? (a.tierMode ?? "marginal") : null,
    tierScope: kind === "tiered" ? (a.tierScope ?? "overall") : null,
    expression: kind === "expression" ? (a.expression?.trim() ?? "") : null,
  };
  // A target kind with no id (or the reverse) is half a target; collapse it so
  // validation sees one state rather than two.
  if (!adjustment.targetId) adjustment.targetKind = null;
  if (!adjustment.targetKind) adjustment.targetId = null;

  return {
    name: input.name.trim(),
    description: input.description?.trim() || null,
    enabled: input.enabled,
    priority: input.priority,
    match,
    adjustment,
    managedAccountIds: [
      ...new Set((input.managedAccountIds ?? []).map((id) => id.trim()).filter(Boolean)),
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Ordering and compilation: pure, and the single source of the model.
 * ------------------------------------------------------------------ */

/**
 * The org's rules in evaluation order: ascending priority, then creation time,
 * then id. Total and deterministic, so two clients that fetch the same rules
 * compile the same expression and the settings list reads in the order the
 * query actually evaluates.
 */
export function orderBillingRules(rules: readonly BillingRule[]): BillingRule[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** A percentage rule, reduced to the multiplier the SQL applies. */
export interface CompiledBillingFactor {
  ruleId: string;
  name: string;
  match: BillingRuleMatch;
  /** `1 + percent/100`. `1.1` for a 10% markup, `0.85` for a 15% discount. */
  factor: number;
}

/** A reallocation rule, reduced to a match and a destination. */
export interface CompiledBillingReallocation {
  ruleId: string;
  name: string;
  match: BillingRuleMatch;
  targetKind: BillingRuleTargetKind;
  targetId: string;
}

/** A fixed-amount rule, which no scan can produce. */
export interface CompiledBillingFixed {
  ruleId: string;
  name: string;
  amount: number;
  currency: string;
  period: BillingRuleFixedPeriod;
  targetKind: BillingRuleTargetKind | null;
  targetId: string | null;
}

/**
 * The rule set split by how it is applied, in evaluation order within each
 * bucket.
 *
 * The split is the ordering model made concrete: `factors` all apply (a
 * product), `reallocations` are first-match-wins (a `multiIf`), and `fixed`
 * never touches a row at all. `server-core/clickhouse/cost-readers.ts` turns
 * the first two into one expression each, inside the query that was going to
 * run anyway.
 */
export interface CompiledBillingAdjustments {
  factors: CompiledBillingFactor[];
  reallocations: CompiledBillingReallocation[];
  fixed: CompiledBillingFixed[];
}

/** True when nothing in the set would change any number. */
export function billingAdjustmentsAreEmpty(a: CompiledBillingAdjustments): boolean {
  return a.factors.length === 0 && a.reallocations.length === 0 && a.fixed.length === 0;
}

/**
 * Split ordered, enabled rules into the three application strategies.
 *
 * Disabled rules are dropped here rather than filtered by the caller, so there
 * is exactly one place that decides whether a rule is in force.
 */
export function compileBillingRules(rules: readonly BillingRule[]): CompiledBillingAdjustments {
  const out: CompiledBillingAdjustments = { factors: [], reallocations: [], fixed: [] };
  for (const rule of orderBillingRules(rules)) {
    if (!rule.enabled) continue;
    const a = rule.adjustment;
    if (a.kind === "percentage") {
      const percent = a.percent ?? 0;
      if (percent === 0) continue;
      out.factors.push({
        ruleId: rule.id,
        name: rule.name,
        match: rule.match,
        factor: 1 + percent / 100,
      });
    } else if (a.kind === "reallocation") {
      if (!a.targetKind || !a.targetId) continue;
      out.reallocations.push({
        ruleId: rule.id,
        name: rule.name,
        match: rule.match,
        targetKind: a.targetKind,
        targetId: a.targetId,
      });
    } else if (a.kind === "fixed") {
      if (!a.amount || !a.currency || !a.period) continue;
      out.fixed.push({
        ruleId: rule.id,
        name: rule.name,
        amount: a.amount,
        currency: a.currency,
        period: a.period,
        targetKind: a.targetKind ?? null,
        targetId: a.targetId ?? null,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Fixed amounts: arithmetic over the range, never a query.
 * ------------------------------------------------------------------ */

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * What a fixed-amount rule contributes over the inclusive range `[from, to]`.
 *
 * A daily rule contributes its amount once per day. A monthly rule contributes
 * its amount for each whole calendar month and a **pro-rated** share of each
 * partial one: `amount × daysOfThatMonthInRange / daysInThatMonth`. Pro-rating
 * is the only honest reading: a $3,000/month overhead shown in full on a
 * ten-day chart is a number that reconciles against nothing, and shown as zero
 * it silently disappears.
 *
 * Pure arithmetic over two dates: no scan, no query, no dependence on whether
 * any cost row exists. That is what a fixed charge *is*: it is owed whether or
 * not the provider billed anything that month.
 */
export function fixedRuleAmountForRange(
  rule: { amount: number; period: BillingRuleFixedPeriod },
  from: string,
  to: string,
): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  const dayCount = Math.round((end - start) / 86_400_000) + 1;

  if (rule.period === "daily") return rule.amount * dayCount;

  let total = 0;
  let cursor = start;
  while (cursor <= end) {
    const d = new Date(cursor);
    const year = d.getUTCFullYear();
    const monthIndex = d.getUTCMonth();
    const inMonth = daysInMonth(year, monthIndex);
    const monthEnd = Date.UTC(year, monthIndex, inMonth);
    const sliceEnd = Math.min(monthEnd, end);
    const sliceDays = Math.round((sliceEnd - cursor) / 86_400_000) + 1;
    total += (rule.amount * sliceDays) / inMonth;
    cursor = monthEnd + 86_400_000;
  }
  return total;
}

/** Fixed contributions over a range, summed per currency. */
export function fixedTotalsForRange(
  fixed: readonly CompiledBillingFixed[],
  from: string,
  to: string,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const rule of fixed) {
    const amount = fixedRuleAmountForRange(rule, from, to);
    if (amount === 0) continue;
    totals[rule.currency] = round6((totals[rule.currency] ?? 0) + amount);
  }
  return totals;
}

/** Six places, matching `cost/currency-convert.ts` so totals agree everywhere. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ *
 * The wire shape that keeps raw visible.
 * ------------------------------------------------------------------ */

/** One rule named in an adjusted answer, so a caption can list what moved it. */
export interface CostAdjustmentRule {
  id: string;
  name: string;
  kind: BillingRuleKind;
  /** A one-line human summary: "+15% on tag team=platform". */
  summary: string;
}

/**
 * What an adjusted answer did, attached to every response that was asked for
 * one.
 *
 * Present whenever the caller set `adjusted`, **even when the org has no rules**:
 * its absence must mean "these are the collected numbers" and nothing else.
 * An empty `rules` array with `rawTotals` equal to the totals is the honest
 * answer to "adjust this" in an org that has not written any adjustments.
 */
export interface CostAdjustmentSummary {
  /** The rules in force for this answer, in evaluation order. */
  rules: CostAdjustmentRule[];
  /**
   * Currency → the collected, unadjusted total for exactly the same rows,
   * summed in the same scan.
   *
   * This is the number an invoice reconciles against and it is always returned
   * beside the adjusted one. Per-*series* raw figures are deliberately not
   * offered: after a reallocation the series are a different partition of the
   * same money, so a per-series "before" would answer a question about a
   * grouping that did not exist.
   */
  rawTotals: Record<string, number>;
  /**
   * Currency → fixed-amount charges over the period, pro-rated.
   *
   * Reported separately and **not** folded into `totals`, because `totals` is
   * the sum of the series and every existing client relies on that identity. A
   * fixed charge has no row, no day and no provider behind it; the figure an
   * org reports internally is the adjusted total plus this.
   */
  fixedTotals: Record<string, number>;
}

/* ------------------------------------------------------------------ *
 * Presentation: shared so every surface says the same thing.
 * ------------------------------------------------------------------ */

/** A one-line description of what a rule matches: "tag team=platform on aws". */
export function describeBillingRuleMatch(match: BillingRuleMatch): string {
  const parts: string[] = [];
  if (match.tagKey) {
    parts.push(
      match.tagValue !== undefined
        ? `tag ${match.tagKey}=${match.tagValue}`
        : `has tag ${match.tagKey}`,
    );
  }
  if (match.accountId) parts.push(`account ${match.accountId}`);
  if (match.pluginId) parts.push(`provider ${match.pluginId}`);
  if (match.service) parts.push(`service ${match.service}`);
  if (match.chargeType) parts.push(`charge type ${match.chargeType}`);
  return parts.length > 0 ? parts.join(" and ") : "all spend";
}

/** A one-line description of what a rule does: "+15%", "move to cost centre X". */
export function describeBillingRuleAdjustment(adjustment: BillingRuleAdjustment): string {
  switch (adjustment.kind) {
    case "percentage": {
      const percent = adjustment.percent ?? 0;
      return `${percent > 0 ? "+" : ""}${percent}%`;
    }
    case "fixed": {
      const per = adjustment.period === "daily" ? "day" : "month";
      return `${adjustment.amount ?? 0} ${adjustment.currency ?? ""}/${per}`.trim();
    }
    case "reallocation":
      return `move to ${adjustment.targetKind === "account" ? "account" : "cost centre"} ${
        adjustment.targetId ?? "?"
      }`;
    case "tiered":
      return describeBillingRuleTiers(adjustment);
    case "expression":
      return `expression: ${adjustment.expression ?? ""}`;
  }
}

/** "marginal tiers on monthly spend (USD): to 10000 +8%, to 50000 +5%, above +3%". */
export function describeBillingRuleTiers(adjustment: BillingRuleAdjustment): string {
  const signed = (p: number) => `${p > 0 ? "+" : ""}${p}%`;
  const tiers = (adjustment.tiers ?? [])
    .map((t) =>
      t.upTo === null ? `above ${signed(t.percent)}` : `to ${t.upTo} ${signed(t.percent)}`,
    )
    .join(", ");
  const mode = adjustment.tierMode === "volume" ? "whole-volume" : "marginal";
  const scope = adjustment.tierScope === "per_service" ? "per-service" : "monthly";
  return `${mode} tiers on ${scope} spend (${adjustment.currency ?? "?"}): ${tiers}`;
}

/** "Platform overhead: +15% on tag team=platform"; the caption everywhere. */
export function describeBillingRule(rule: {
  match: BillingRuleMatch;
  adjustment: BillingRuleAdjustment;
}): string {
  return `${describeBillingRuleAdjustment(rule.adjustment)} on ${describeBillingRuleMatch(rule.match)}`;
}

/** The `rules` entries an adjusted response carries. */
export function summarizeBillingRules(rules: readonly BillingRule[]): CostAdjustmentRule[] {
  return (
    orderBillingRules(rules)
      // Invoice-only kinds never move a graph, a budget or a showback figure, so
      // naming them in that caption would be a claim the number does not bear out.
      .filter((r) => r.enabled && !isInvoiceOnlyBillingRuleKind(r.adjustment.kind))
      .map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.adjustment.kind,
        summary: describeBillingRule(r),
      }))
  );
}
