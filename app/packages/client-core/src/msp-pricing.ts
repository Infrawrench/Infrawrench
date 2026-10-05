/**
 * Managed-account pricing: how a managed service provider turns what the
 * providers charged into what one customer is invoiced.
 *
 * Four controls sit on top of the existing billing rules, and all of them are
 * applied **when an invoice is computed, never written into collected spend**:
 *
 * 1. **Re-rating to public pricing** ({@link ManagedAccountRerate}): present a
 *    customer's usage at the provider's public on-demand list price instead of
 *    the provider's negotiated cost. Where a provider reports a list price for
 *    a line it is used; where it does not, the line falls back to "collected +
 *    an uplift %", and the invoice says how much of the spend went each way.
 * 2. **Discount treatment** ({@link DiscountTreatment}): per customer, whether
 *    provider discounts, credits and commitment benefits are passed through,
 *    partly passed through, or retained.
 * 3. **Tiered rules** (`tiered` billing rules): a rate by monthly volume.
 * 4. **Expression rules** (`expression` billing rules): a sandboxed formula.
 *
 * ## The order, stated once
 *
 * Every line goes through the same pipeline, and each step records what it
 * changed so an invoice can say which rule moved which amount:
 *
 * ```
 * collected
 *   → re-rate (list price, or fallback uplift)       usage lines in scope
 *   → discount treatment                             discounts, credits, covered usage
 *   → billing rules in evaluation order              percentage, tiered, expression
 * = invoiced (before currency conversion)
 * ```
 *
 * Billing rules keep their own order (ascending priority, then creation time,
 * then id). Percentage rules still compound; an expression sees the running
 * `cost` at its position; a tiered rule measures the running cost of the lines
 * it matches. Reallocation and fixed rules are not here: reallocation decides
 * which bucket a line is in before it arrives, and a fixed fee is its own
 * invoice line.
 *
 * ## Why this is pure
 *
 * The engine takes grouped cost lines and returns grouped results. It never
 * queries, so the same function prices a draft invoice, an approval, and a
 * preview against last month, and the tests can pin the arithmetic without a
 * database.
 */

import {
  isInvoiceOnlyBillingRuleKind,
  orderBillingRules,
  type BillingRule,
  type BillingRuleInput,
  type BillingRuleKind,
  type BillingRuleMatch,
  type BillingRuleTier,
} from "./billing-rules.js";
import {
  compilePricingExpression,
  evaluatePricingExpression,
  type CompiledPricingExpression,
} from "./pricing-expression.js";

/* ------------------------------------------------------------------ *
 * Settings on a managed account
 * ------------------------------------------------------------------ */

export const DISCOUNT_TREATMENT_MODES = ["pass_through", "partial", "retain"] as const;
export type DiscountTreatmentMode = (typeof DISCOUNT_TREATMENT_MODES)[number];

export const DISCOUNT_TREATMENT_MODE_LABELS: Record<DiscountTreatmentMode, string> = {
  pass_through: "Pass through",
  partial: "Pass through partly",
  retain: "Retain",
};

/**
 * What happens to one category of provider benefit on this customer's invoice.
 *
 * `passThroughPercent` is the share the customer receives, 0 to 100, and is
 * only meaningful (and required) for `partial`.
 */
export interface DiscountTreatment {
  mode: DiscountTreatmentMode;
  passThroughPercent?: number | null | undefined;
}

/**
 * The benefit categories, and the charge types each one covers.
 *
 * - `discounts`: lines of charge type `commitment_discount` (a Savings Plan's
 *   negation line) and **negative** lines of charge type `other` or
 *   `adjustment`, which is where enterprise-agreement, private-rate and
 *   bundled discounts arrive (AWS files its `Discount` record types there).
 * - `credits`: lines of charge type `credit`.
 * - `commitmentBenefits`: the difference between the public price and the
 *   committed rate on `commitment_covered_usage` lines. Only measurable where
 *   the provider reports a list price for the line; elsewhere there is no
 *   honest figure to retain, and the invoice says so.
 */
export const DISCOUNT_CATEGORIES = ["discounts", "credits", "commitmentBenefits"] as const;
export type DiscountCategory = (typeof DISCOUNT_CATEGORIES)[number];

export const DISCOUNT_CATEGORY_LABELS: Record<DiscountCategory, string> = {
  discounts: "Provider discounts (enterprise agreements, private pricing, Savings Plan negation)",
  credits: "Credits",
  commitmentBenefits: "Reservation and Savings Plan benefits on covered usage",
};

/** One provider (and optionally one service) a setting applies to. */
export interface PricingScopeEntry {
  pluginId: string;
  /** Null or absent means every service of the provider. */
  service?: string | null | undefined;
}

/** A fallback uplift for one provider or service. */
export interface PricingUplift extends PricingScopeEntry {
  percent: number;
}

/**
 * Re-rating to public pricing.
 *
 * `scope` empty means every provider. `fallbackUpliftPercent` is applied to
 * in-scope usage the provider reports no list price for; `uplifts` override it
 * per provider or service (the most specific entry wins).
 */
export interface ManagedAccountRerate {
  enabled: boolean;
  scope: PricingScopeEntry[];
  fallbackUpliftPercent: number;
  uplifts: PricingUplift[];
}

/** Everything about how one customer's invoice is priced, beyond the rules. */
export interface ManagedAccountPricing {
  rerate: ManagedAccountRerate;
  discounts: DiscountTreatment;
  credits: DiscountTreatment;
  commitmentBenefits: DiscountTreatment;
}

export const MANAGED_ACCOUNT_PRICING_LIMITS = {
  maxScopeEntries: 100,
  maxUplifts: 100,
  minUpliftPercent: -100,
  maxUpliftPercent: 1000,
} as const;

export const DEFAULT_MANAGED_ACCOUNT_PRICING: ManagedAccountPricing = {
  rerate: { enabled: false, scope: [], fallbackUpliftPercent: 0, uplifts: [] },
  discounts: { mode: "pass_through", passThroughPercent: null },
  credits: { mode: "pass_through", passThroughPercent: null },
  commitmentBenefits: { mode: "pass_through", passThroughPercent: null },
};

function normalizeScopeEntry<T extends PricingScopeEntry>(entry: T): T {
  return { ...entry, pluginId: entry.pluginId.trim(), service: entry.service?.trim() || null };
}

function normalizeTreatment(t: DiscountTreatment | null | undefined): DiscountTreatment {
  const mode = t?.mode ?? "pass_through";
  return {
    mode,
    passThroughPercent: mode === "partial" ? (t?.passThroughPercent ?? null) : null,
  };
}

/**
 * One representation for "unset": a missing block is the default, empty
 * strings are absent, and a percentage only survives on `partial`.
 */
export function normalizeManagedAccountPricing(
  pricing: Partial<ManagedAccountPricing> | null | undefined,
): ManagedAccountPricing {
  const r = pricing?.rerate;
  return {
    rerate: {
      enabled: r?.enabled === true,
      scope: (r?.scope ?? []).map(normalizeScopeEntry).filter((e) => e.pluginId),
      fallbackUpliftPercent: r?.fallbackUpliftPercent ?? 0,
      uplifts: (r?.uplifts ?? []).map(normalizeScopeEntry).filter((e) => e.pluginId),
    },
    discounts: normalizeTreatment(pricing?.discounts),
    credits: normalizeTreatment(pricing?.credits),
    commitmentBenefits: normalizeTreatment(pricing?.commitmentBenefits),
  };
}

/** Why these settings cannot be saved, as one sentence, or null. */
export function managedAccountPricingError(pricing: ManagedAccountPricing): string | null {
  const L = MANAGED_ACCOUNT_PRICING_LIMITS;
  const r = pricing.rerate;
  if (r.scope.length > L.maxScopeEntries) {
    return `Re-rating can name at most ${L.maxScopeEntries} providers or services.`;
  }
  if (r.uplifts.length > L.maxUplifts) {
    return `Re-rating can have at most ${L.maxUplifts} fallback uplifts.`;
  }
  const pct = (v: unknown) =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    v >= L.minUpliftPercent &&
    v <= L.maxUpliftPercent;
  if (!pct(r.fallbackUpliftPercent)) {
    return `The fallback uplift must be between ${L.minUpliftPercent}% and ${L.maxUpliftPercent}%.`;
  }
  for (const u of r.uplifts) {
    if (!pct(u.percent)) {
      return `The uplift for ${u.pluginId}${u.service ? ` ${u.service}` : ""} must be between ${L.minUpliftPercent}% and ${L.maxUpliftPercent}%.`;
    }
  }
  const seen = new Set<string>();
  for (const u of r.uplifts) {
    const key = `${u.pluginId}\u0000${u.service ?? ""}`;
    if (seen.has(key)) {
      return `There are two fallback uplifts for ${u.pluginId}${u.service ? ` ${u.service}` : ""}.`;
    }
    seen.add(key);
  }
  for (const category of DISCOUNT_CATEGORIES) {
    const t = pricing[category];
    if (!(DISCOUNT_TREATMENT_MODES as readonly string[]).includes(t.mode)) {
      return `Unknown treatment "${String(t.mode)}" for ${DISCOUNT_CATEGORY_LABELS[category].toLowerCase()}.`;
    }
    if (t.mode === "partial") {
      const p = t.passThroughPercent;
      if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p >= 100) {
        return (
          `Partly passing through ${DISCOUNT_CATEGORY_LABELS[category].toLowerCase()} needs a ` +
          "share between 0% and 100% (exclusive); use pass through or retain for the ends."
        );
      }
    }
  }
  return null;
}

/** True when these settings leave every line at its collected amount. */
export function managedAccountPricingIsNeutral(pricing: ManagedAccountPricing): boolean {
  return (
    !pricing.rerate.enabled && DISCOUNT_CATEGORIES.every((c) => pricing[c].mode === "pass_through")
  );
}

/** The share of a benefit the customer receives, 0 to 1. */
export function passThroughShare(t: DiscountTreatment): number {
  if (t.mode === "pass_through") return 1;
  if (t.mode === "retain") return 0;
  return Math.min(100, Math.max(0, t.passThroughPercent ?? 100)) / 100;
}

/** One line per setting that does something, for a summary or a terminal. */
export function describeManagedAccountPricing(pricing: ManagedAccountPricing): string[] {
  const out: string[] = [];
  const r = pricing.rerate;
  if (r.enabled) {
    const scope =
      r.scope.length === 0
        ? "all providers"
        : r.scope.map((s) => (s.service ? `${s.pluginId} ${s.service}` : s.pluginId)).join(", ");
    const fallback = `${r.fallbackUpliftPercent > 0 ? "+" : ""}${r.fallbackUpliftPercent}%`;
    out.push(
      `Re-rated to public pricing on ${scope}; collected ${fallback} where no list price exists` +
        (r.uplifts.length > 0 ? ` (${r.uplifts.length} per-service override(s))` : ""),
    );
  }
  for (const category of DISCOUNT_CATEGORIES) {
    const t = pricing[category];
    if (t.mode === "pass_through") continue;
    const label = DISCOUNT_CATEGORY_LABELS[category];
    out.push(
      t.mode === "retain"
        ? `${label}: retained`
        : `${label}: ${t.passThroughPercent ?? 0}% passed through`,
    );
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The engine's input and output
 * ------------------------------------------------------------------ */

/**
 * One grouped cost line: one bucket (cost centre or account scope), one
 * currency and one calendar month of one account, provider, service, region
 * and charge type, plus the tags any rule reads.
 *
 * `listedCollected` is the part of `collected` the provider reported a list
 * price for, and `listAmount` is that price; the rest of `collected` has none.
 */
export interface PricingLine {
  bucket: string;
  currency: string;
  /** `YYYY-MM`. */
  month: string;
  accountId: string;
  accountName: string;
  pluginId: string;
  service: string;
  region: string;
  chargeType: string;
  usage: number;
  unit: string;
  /** Only the keys some rule reads; absent means the line does not carry it. */
  tags: Record<string, string>;
  collected: number;
  listedCollected: number;
  listAmount: number;
}

/** The pipeline steps that are not billing rules, as effect keys. */
export const PRICING_STEP_KEYS = {
  rerateList: "rerate:list",
  rerateFallback: "rerate:fallback",
  discounts: "treatment:discounts",
  credits: "treatment:credits",
  commitmentBenefits: "treatment:commitment_benefits",
} as const;

export type PricingEffectKind =
  | "rerate_list"
  | "rerate_fallback"
  | "discounts"
  | "credits"
  | "commitment_benefits"
  | BillingRuleKind;

/** One thing that moved money, in pipeline order. */
export interface PricingEffect {
  /** A rule id, or one of {@link PRICING_STEP_KEYS}. */
  key: string;
  ruleId: string | null;
  label: string;
  kind: PricingEffectKind;
  /** Currency → what it added (positive) or removed (negative). */
  totals: Record<string, number>;
}

/** One bucket in one currency after pricing. */
export interface PricedBucket {
  bucket: string;
  currency: string;
  collected: number;
  adjustment: number;
  adjusted: number;
  /** Effect key → amount; sums to `adjustment`. Zero entries are dropped. */
  effects: Record<string, number>;
}

/** How much of the in-scope usage was re-rated from a list price. */
export interface RerateCoverage {
  /** Currency → collected amounts by how they were re-rated. */
  byCurrency: Record<
    string,
    {
      /** Collected spend priced from a provider-reported list price. */
      listPriced: number;
      /** What that spend lists at. */
      listTotal: number;
      /** Collected spend with no list price, priced at collected + uplift. */
      fallback: number;
    }
  >;
  /** Per provider and service, largest first, at most 50 rows. */
  services: Array<{
    pluginId: string;
    service: string;
    currency: string;
    listPriced: number;
    fallback: number;
  }>;
}

/** A rule whose expression failed on some lines; those lines kept their cost. */
export interface PricingExpressionFailure {
  ruleId: string;
  name: string;
  lines: number;
  message: string;
}

export interface PricingResult {
  buckets: PricedBucket[];
  effects: PricingEffect[];
  coverage: RerateCoverage | null;
  /** Things a reader of the invoice should know; sentences. */
  warnings: string[];
  expressionFailures: PricingExpressionFailure[];
  /** Each input line's final amount, in input order, when asked for. */
  lineCosts?: number[];
}

export interface PriceLinesOptions {
  pricing: ManagedAccountPricing;
  /**
   * The billing rules to apply, any order and any kind; disabled rules and
   * reallocation/fixed rules are ignored here. The caller has already decided
   * which rules apply to this customer.
   */
  rules: readonly BillingRule[];
  /** The customer's name, readable as `customer` in expressions. */
  customer?: string | undefined;
  withLineCosts?: boolean | undefined;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** The rule match, evaluated against a grouped line, with SQL's semantics. */
export function pricingLineMatches(match: BillingRuleMatch, line: PricingLine): boolean {
  if (match.tagKey) {
    if (!Object.hasOwn(line.tags, match.tagKey)) return false;
    if (match.tagValue !== undefined && line.tags[match.tagKey] !== match.tagValue) return false;
  }
  if (match.accountId && line.accountId !== match.accountId) return false;
  if (match.pluginId && line.pluginId !== match.pluginId) return false;
  if (match.service && line.service !== match.service) return false;
  if (match.chargeType && line.chargeType !== match.chargeType) return false;
  return true;
}

/** Tag keys the engine needs grouped for these rules. */
export function pricingTagKeys(rules: readonly BillingRule[]): string[] {
  const keys = new Set<string>();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const kind = rule.adjustment.kind;
    if (kind !== "percentage" && kind !== "tiered" && kind !== "expression") continue;
    if (rule.match.tagKey) keys.add(rule.match.tagKey);
    if (kind === "expression" && rule.adjustment.expression) {
      try {
        for (const k of compilePricingExpression(rule.adjustment.expression).tagKeys) keys.add(k);
      } catch {
        // A stored expression that no longer parses is reported when priced.
      }
    }
  }
  return [...keys].sort();
}

function inScope(entries: readonly PricingScopeEntry[], line: PricingLine): boolean {
  if (entries.length === 0) return true;
  return entries.some(
    (e) => e.pluginId === line.pluginId && (!e.service || e.service === line.service),
  );
}

function upliftFor(rerate: ManagedAccountRerate, line: PricingLine): number {
  let best: PricingUplift | null = null;
  for (const u of rerate.uplifts) {
    if (u.pluginId !== line.pluginId) continue;
    if (u.service && u.service !== line.service) continue;
    // The most specific entry wins: a service entry beats a provider entry.
    if (!best || (u.service && !best.service)) best = u;
  }
  return best ? best.percent : rerate.fallbackUpliftPercent;
}

/** Usage-like charge types: the only lines re-rating applies to. */
const RERATABLE_CHARGE_TYPES = new Set(["usage", "commitment_covered_usage"]);

function discountCategoryOf(line: PricingLine): "discounts" | "credits" | null {
  if (line.chargeType === "credit") return "credits";
  if (line.chargeType === "commitment_discount") return "discounts";
  if ((line.chargeType === "other" || line.chargeType === "adjustment") && line.collected < 0) {
    return "discounts";
  }
  return null;
}

/**
 * The amount a tier table charges on a volume.
 *
 * Marginal: each slice at its own tier's rate. Whole-volume: everything at the
 * rate of the tier the volume falls in (a tier's `upTo` is exclusive, so a
 * volume of exactly 10,000 on a "to 10,000" tier is in the next tier).
 */
export function tierAdjustmentForVolume(
  tiers: readonly BillingRuleTier[],
  mode: "marginal" | "volume",
  volume: number,
): number {
  if (!(volume > 0) || tiers.length === 0) return 0;
  if (mode === "volume") {
    const tier = tiers.find((t) => t.upTo === null || volume < t.upTo) ?? tiers[tiers.length - 1]!;
    return (volume * tier.percent) / 100;
  }
  let lower = 0;
  let total = 0;
  for (const tier of tiers) {
    const upper = tier.upTo ?? Infinity;
    const slice = Math.max(0, Math.min(volume, upper) - lower);
    total += (slice * tier.percent) / 100;
    if (volume <= upper) break;
    lower = upper;
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * The engine
 * ------------------------------------------------------------------ */

/**
 * Price grouped cost lines for one customer.
 *
 * Every step adds to a per-line effect ledger, and the buckets are the sums of
 * those ledgers, so `collected + Σ effects = adjusted` holds by construction on
 * every bucket, and every amount on an invoice can be traced to the rule or
 * setting that produced it.
 */
export function priceLines(
  lines: readonly PricingLine[],
  options: PriceLinesOptions,
): PricingResult {
  const pricing = options.pricing;
  const warnings: string[] = [];
  const effectInfo = new Map<string, Omit<PricingEffect, "totals">>();
  const costs = lines.map((l) => l.collected);
  const ledgers = lines.map(() => new Map<string, number>());

  const record = (i: number, key: string, delta: number) => {
    if (delta === 0 || !Number.isFinite(delta)) return;
    const ledger = ledgers[i]!;
    ledger.set(key, (ledger.get(key) ?? 0) + delta);
    costs[i] = costs[i]! + delta;
  };
  const declare = (info: Omit<PricingEffect, "totals">) => {
    if (!effectInfo.has(info.key)) effectInfo.set(info.key, info);
  };

  /* -- 1. re-rate to public pricing -- */

  let coverage: RerateCoverage | null = null;
  if (pricing.rerate.enabled) {
    declare({
      key: PRICING_STEP_KEYS.rerateList,
      ruleId: null,
      label: "Re-rated to public list price",
      kind: "rerate_list",
    });
    declare({
      key: PRICING_STEP_KEYS.rerateFallback,
      ruleId: null,
      label: "Uplift where no list price exists",
      kind: "rerate_fallback",
    });
    const byCurrency: RerateCoverage["byCurrency"] = {};
    const services = new Map<string, RerateCoverage["services"][number]>();
    lines.forEach((line, i) => {
      if (!RERATABLE_CHARGE_TYPES.has(line.chargeType)) return;
      if (!inScope(pricing.rerate.scope, line)) return;
      const listed = line.listedCollected;
      const unlisted = line.collected - listed;
      record(i, PRICING_STEP_KEYS.rerateList, line.listAmount - listed);
      record(
        i,
        PRICING_STEP_KEYS.rerateFallback,
        (unlisted * upliftFor(pricing.rerate, line)) / 100,
      );

      const c = (byCurrency[line.currency] ??= { listPriced: 0, listTotal: 0, fallback: 0 });
      c.listPriced += listed;
      c.listTotal += line.listAmount;
      c.fallback += unlisted;
      const sk = `${line.pluginId}\u0000${line.service}\u0000${line.currency}`;
      const s = services.get(sk) ?? {
        pluginId: line.pluginId,
        service: line.service,
        currency: line.currency,
        listPriced: 0,
        fallback: 0,
      };
      s.listPriced += listed;
      s.fallback += unlisted;
      services.set(sk, s);
    });
    for (const c of Object.values(byCurrency)) {
      c.listPriced = round6(c.listPriced);
      c.listTotal = round6(c.listTotal);
      c.fallback = round6(c.fallback);
    }
    coverage = {
      byCurrency,
      services: [...services.values()]
        .map((s) => ({ ...s, listPriced: round6(s.listPriced), fallback: round6(s.fallback) }))
        .sort(
          (a, b) =>
            Math.abs(b.listPriced) +
            Math.abs(b.fallback) -
            (Math.abs(a.listPriced) + Math.abs(a.fallback)),
        )
        .slice(0, 50),
    };
  }

  /* -- 2. discount treatment -- */

  const discountsShare = passThroughShare(pricing.discounts);
  const creditsShare = passThroughShare(pricing.credits);
  const benefitShare = passThroughShare(pricing.commitmentBenefits);
  if (discountsShare !== 1) {
    declare({
      key: PRICING_STEP_KEYS.discounts,
      ruleId: null,
      label: "Provider discounts retained",
      kind: "discounts",
    });
  }
  if (creditsShare !== 1) {
    declare({
      key: PRICING_STEP_KEYS.credits,
      ruleId: null,
      label: "Credits retained",
      kind: "credits",
    });
  }
  if (benefitShare !== 1) {
    declare({
      key: PRICING_STEP_KEYS.commitmentBenefits,
      ruleId: null,
      label: "Commitment benefits retained",
      kind: "commitment_benefits",
    });
  }
  let unpricedBenefit = 0;
  lines.forEach((line, i) => {
    const category = discountCategoryOf(line);
    if (category === "discounts" && discountsShare !== 1) {
      record(i, PRICING_STEP_KEYS.discounts, costs[i]! * (discountsShare - 1));
    } else if (category === "credits" && creditsShare !== 1) {
      record(i, PRICING_STEP_KEYS.credits, costs[i]! * (creditsShare - 1));
    } else if (line.chargeType === "commitment_covered_usage" && benefitShare !== 1) {
      // A line already re-rated is at list price: there is no benefit left in
      // it to retain, and retaining it again would charge the difference twice.
      if (pricing.rerate.enabled && inScope(pricing.rerate.scope, line)) return;
      const benefit = line.listAmount - line.listedCollected;
      if (benefit > 0)
        record(i, PRICING_STEP_KEYS.commitmentBenefits, benefit * (1 - benefitShare));
      unpricedBenefit += line.collected - line.listedCollected;
    }
  });
  if (benefitShare !== 1 && Math.abs(unpricedBenefit) > 5e-7) {
    warnings.push(
      "Some reservation or Savings Plan covered usage has no reported list price, so its " +
        "benefit could not be measured and was passed through.",
    );
  }

  /* -- 3. billing rules, in evaluation order -- */

  const expressionFailures: PricingExpressionFailure[] = [];
  for (const rule of orderBillingRules(options.rules)) {
    if (!rule.enabled) continue;
    const a = rule.adjustment;
    if (a.kind !== "percentage" && !isInvoiceOnlyBillingRuleKind(a.kind)) continue;
    declare({ key: rule.id, ruleId: rule.id, label: rule.name, kind: a.kind });
    const matched: number[] = [];
    lines.forEach((line, i) => {
      if (pricingLineMatches(rule.match, line)) matched.push(i);
    });

    if (a.kind === "percentage") {
      const factor = 1 + (a.percent ?? 0) / 100;
      for (const i of matched) record(i, rule.id, costs[i]! * (factor - 1));
      continue;
    }

    if (a.kind === "expression") {
      let compiled: CompiledPricingExpression;
      try {
        compiled = compilePricingExpression(a.expression ?? "");
      } catch (e) {
        expressionFailures.push({
          ruleId: rule.id,
          name: rule.name,
          lines: matched.length,
          message: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      let failed = 0;
      let firstMessage = "";
      for (const i of matched) {
        const line = lines[i]!;
        try {
          const next = evaluatePricingExpression(compiled, {
            cost: costs[i]!,
            collected: line.collected,
            // The listed part at its list price, the rest at what it cost; null
            // only when no part of the line has a list price at all.
            listCost:
              line.listedCollected !== 0 || line.listAmount !== 0
                ? line.listAmount + (line.collected - line.listedCollected)
                : null,
            usage: line.usage,
            unit: line.unit,
            service: line.service,
            provider: line.pluginId,
            account: line.accountId,
            accountName: line.accountName,
            region: line.region,
            chargeType: line.chargeType,
            currency: line.currency,
            month: line.month,
            customer: options.customer ?? "",
            tags: new Map(Object.entries(line.tags)),
          });
          record(i, rule.id, next - costs[i]!);
        } catch (e) {
          failed++;
          if (!firstMessage) firstMessage = e instanceof Error ? e.message : String(e);
        }
      }
      if (failed > 0) {
        expressionFailures.push({
          ruleId: rule.id,
          name: rule.name,
          lines: failed,
          message: firstMessage,
        });
      }
      continue;
    }

    // Tiered: volume per month (and per service), in the rule's currency.
    const currency = (a.currency ?? "").toUpperCase();
    const groups = new Map<string, number[]>();
    const skippedCurrencies = new Set<string>();
    for (const i of matched) {
      const line = lines[i]!;
      if (line.currency !== currency) {
        if (line.collected !== 0) skippedCurrencies.add(line.currency);
        continue;
      }
      const key = a.tierScope === "per_service" ? `${line.month}\u0000${line.service}` : line.month;
      const list = groups.get(key) ?? [];
      list.push(i);
      groups.set(key, list);
    }
    for (const members of groups.values()) {
      const volume = members.reduce((sum, i) => sum + costs[i]!, 0);
      if (!(volume > 0)) continue;
      const amount = tierAdjustmentForVolume(a.tiers ?? [], a.tierMode ?? "marginal", volume);
      if (amount === 0) continue;
      // Spread over the lines pro rata, so every line carries its share and an
      // invoice line's breakdown still sums.
      for (const i of members) record(i, rule.id, (amount * costs[i]!) / volume);
    }
    if (skippedCurrencies.size > 0) {
      warnings.push(
        `"${rule.name}" states its tiers in ${currency}, so spend in ` +
          `${[...skippedCurrencies].sort().join(", ")} was not tiered.`,
      );
    }
  }

  /* -- fold the ledgers into buckets -- */

  const bucketMap = new Map<
    string,
    { bucket: string; currency: string; collected: number; effects: Map<string, number> }
  >();
  lines.forEach((line, i) => {
    const key = `${line.bucket}\u0000${line.currency}`;
    const b = bucketMap.get(key) ?? {
      bucket: line.bucket,
      currency: line.currency,
      collected: 0,
      effects: new Map<string, number>(),
    };
    b.collected += line.collected;
    for (const [k, v] of ledgers[i]!) b.effects.set(k, (b.effects.get(k) ?? 0) + v);
    bucketMap.set(key, b);
  });

  const effectTotals = new Map<string, Record<string, number>>();
  const buckets: PricedBucket[] = [...bucketMap.values()].map((b) => {
    const effects: Record<string, number> = {};
    let adjustment = 0;
    for (const [k, v] of b.effects) {
      const r = round6(v);
      if (r === 0) continue;
      effects[k] = r;
      adjustment += r;
      const t = effectTotals.get(k) ?? {};
      t[b.currency] = round6((t[b.currency] ?? 0) + r);
      effectTotals.set(k, t);
    }
    const collected = round6(b.collected);
    adjustment = round6(adjustment);
    return {
      bucket: b.bucket,
      currency: b.currency,
      collected,
      adjustment,
      adjusted: round6(collected + adjustment),
      effects,
    };
  });

  const effects: PricingEffect[] = [...effectInfo.values()]
    .map((info) => ({ ...info, totals: effectTotals.get(info.key) ?? {} }))
    .filter((e) => Object.keys(e.totals).length > 0);

  return {
    buckets,
    effects,
    coverage,
    warnings,
    expressionFailures,
    ...(options.withLineCosts ? { lineCosts: costs.map(round6) } : {}),
  };
}

/** Whether a rule applies to a given customer's invoice. */
export function billingRuleAppliesToCustomer(
  rule: BillingRule,
  managedAccountId: string | null,
): boolean {
  if (!isInvoiceOnlyBillingRuleKind(rule.adjustment.kind)) return true;
  const scope = rule.managedAccountIds ?? [];
  if (scope.length === 0) return true;
  return managedAccountId !== null && scope.includes(managedAccountId);
}

/* ------------------------------------------------------------------ *
 * Preview: the wire shape of "what would this do to last month"
 * ------------------------------------------------------------------ */

/** Request body of `POST /billing-rules/preview`. */
export interface PricingPreviewRequest {
  /**
   * A rule to try. With `ruleId`, it replaces that saved rule in the set;
   * `ruleId` alone previews the saved rule as it stands.
   */
  rule?: BillingRuleInput | null | undefined;
  ruleId?: string | null | undefined;
  /** Price this customer's scope; omitted means the organisation's whole spend. */
  managedAccountId?: string | null | undefined;
  /** Try these customer settings instead of the saved ones. */
  pricing?: ManagedAccountPricing | null | undefined;
  /** `YYYY-MM`; defaults to last calendar month. */
  month?: string | null | undefined;
}

/** One line the candidate changed. */
export interface PricingPreviewChange {
  pluginId: string;
  service: string;
  accountName: string;
  chargeType: string;
  currency: string;
  collected: number;
  before: number;
  after: number;
}

/** Response of `POST /billing-rules/preview`. */
export interface PricingPreviewResult {
  month: string;
  from: string;
  to: string;
  managedAccountId: string | null;
  /** Currency → collected spend in scope. */
  collected: Record<string, number>;
  /**
   * Currency → priced without the candidate: the saved rules minus the one
   * being previewed, with the saved customer settings.
   */
  before: Record<string, number>;
  /** Currency → priced with the candidate. */
  after: Record<string, number>;
  /** The candidate's effects, and everything else's, with the candidate in. */
  effects: PricingEffect[];
  coverage: RerateCoverage | null;
  warnings: string[];
  expressionFailures: PricingExpressionFailure[];
  /** The lines that moved most, largest change first, at most 25. */
  changes: PricingPreviewChange[];
  /** How many grouped lines were priced. */
  lineCount: number;
}
