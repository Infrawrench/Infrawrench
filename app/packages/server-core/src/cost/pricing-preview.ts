/**
 * "What would this do to last month": a dry run of a billing rule or a
 * customer's pricing settings against real collected spend.
 *
 * Nothing here writes anything. The preview prices one calendar month twice
 * through the same engine invoices use (`client-core/msp-pricing.ts`): once
 * *without* the rule being previewed (the saved rules minus `ruleId`, with the
 * saved settings), once *with* the candidate rule or settings swapped in, and
 * reports both totals, every effect, re-rating coverage, expression failures
 * and the lines that moved most. It is the answer to "is this expression right"
 * before a customer ever sees the number it produces.
 *
 * Scoped to one customer it uses exactly the invoice's scope (the same
 * allocation, the same account buckets); without one it prices the
 * organisation's whole spend as if it were a single customer, so a rule can be
 * tried before any customer exists.
 */
import {
  DEFAULT_MANAGED_ACCOUNT_PRICING,
  billingRuleAppliesToCustomer,
  dedupeScopeCentres,
  isInvoiceOnlyBillingRuleKind,
  managedAccountPricingError,
  normalizeManagedAccountPricing,
  priceLines,
  pricingTagKeys,
  type BillingRule,
  type ManagedAccountPricing,
  type PricingLine,
  type PricingPreviewChange,
  type PricingPreviewRequest,
  type PricingPreviewResult,
} from "@infrawrench/client-core";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { accounts } from "../db/schema";
import { getPricingLines, type ShowbackRule } from "../clickhouse/cost-readers";
import { listAllocationRules, listCostCentres } from "./allocation";
import {
  BillingRuleError,
  listBillingRules,
  prepareBillingRuleInput,
  resolveBillingAdjustments,
} from "./billing-rules";
import { getManagedAccountRow } from "./managed-accounts";

/** Six places, matching every other money figure. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** `YYYY-MM` of the calendar month before `now`, in UTC. */
export function previousMonth(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Inclusive first and last day of a `YYYY-MM` month. */
export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Kinds the engine applies; reallocation and fixed are not previewed here. */
function engineKind(rule: BillingRule): boolean {
  return (
    rule.adjustment.kind === "percentage" || isInvoiceOnlyBillingRuleKind(rule.adjustment.kind)
  );
}

function sumByCurrency(
  lines: readonly PricingLine[],
  costs: readonly number[],
): Record<string, number> {
  const out: Record<string, number> = {};
  lines.forEach((line, i) => {
    out[line.currency] = round6((out[line.currency] ?? 0) + costs[i]!);
  });
  return out;
}

/**
 * Run a preview. Throws {@link BillingRuleError} with a presentable sentence
 * for anything the caller got wrong (an invalid rule, an unknown customer,
 * invalid settings).
 */
export async function previewPricing(
  organizationId: string,
  request: PricingPreviewRequest,
): Promise<PricingPreviewResult> {
  const month = request.month ?? previousMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new BillingRuleError("month must be YYYY-MM.");
  }
  const { from, to } = monthRange(month);

  const customer = request.managedAccountId
    ? await getManagedAccountRow(organizationId, request.managedAccountId)
    : null;
  if (request.managedAccountId && !customer) {
    throw new BillingRuleError("That managed account was not found.");
  }

  let candidatePricing: ManagedAccountPricing | null = null;
  if (request.pricing) {
    candidatePricing = normalizeManagedAccountPricing(request.pricing);
    const error = managedAccountPricingError(candidatePricing);
    if (error) throw new BillingRuleError(error);
  }
  const savedPricing = customer
    ? normalizeManagedAccountPricing(customer.pricing)
    : DEFAULT_MANAGED_ACCOUNT_PRICING;

  const applyRules = customer ? customer.applyBillingRules : true;
  const savedRules = applyRules ? await listBillingRules(organizationId) : [];

  let candidate: BillingRule | null = null;
  if (!request.rule && request.ruleId) {
    // A saved rule on its own: "what does this rule do to last month".
    const saved = (await listBillingRules(organizationId)).find((r) => r.id === request.ruleId);
    if (!saved) throw new BillingRuleError("That billing rule was not found.");
    candidate = { ...saved, enabled: true };
  } else if (request.rule) {
    const data = prepareBillingRuleInput(request.rule);
    const existing = request.ruleId ? savedRules.find((r) => r.id === request.ruleId) : undefined;
    const now = new Date().toISOString();
    candidate = {
      id: existing?.id ?? "candidate",
      name: data.name,
      description: data.description ?? null,
      // Previewing a rule is asking what it *would* do, so it is in force here.
      enabled: true,
      priority: data.priority,
      match: data.match,
      adjustment: data.adjustment,
      managedAccountIds: data.managedAccountIds ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  const applies = (rule: BillingRule): boolean =>
    rule.enabled &&
    engineKind(rule) &&
    // Without a customer the whole organisation stands in for one, so a rule
    // scoped to particular customers is tried as if this were one of them.
    (customer ? billingRuleAppliesToCustomer(rule, customer.id) : true);
  // Without the rule being previewed, so the difference is exactly what it
  // does on top of everything else in force.
  const beforeRules = savedRules.filter((r) => r.id !== request.ruleId).filter(applies);
  const afterRules = [
    ...savedRules.filter((r) => r.id !== candidate?.id).filter(applies),
    ...(candidate && (customer ? billingRuleAppliesToCustomer(candidate, customer.id) : true)
      ? [candidate]
      : []),
  ];

  /* -- the lines, in the invoice's scope when there is a customer -- */

  const [allocationRules, centres, billing, accountRows] = await Promise.all([
    customer ? listAllocationRules(organizationId) : Promise.resolve([]),
    customer ? listCostCentres(organizationId) : Promise.resolve([]),
    applyRules ? resolveBillingAdjustments(organizationId) : Promise.resolve(null),
    db
      .select({ id: accounts.id, displayName: accounts.displayName })
      .from(accounts)
      .where(eq(accounts.organizationId, organizationId)),
  ]);
  const accountNames = new Map(accountRows.map((a) => [a.id, a.displayName]));

  let rules: ShowbackRule[] = [];
  let buckets: string[] | undefined;
  if (customer) {
    const centreIds = new Set(centres.map((c) => c.id));
    rules = allocationRules
      .filter((r) => centreIds.has(r.costCentreId))
      .map((r) => ({ costCentreId: r.costCentreId, match: r.match }));
    const scopeAccounts = (customer.accountIds ?? []).filter((id) => accountNames.has(id));
    for (const accountId of scopeAccounts) {
      rules.push({ costCentreId: `acct:${accountId}`, match: { accountId } });
    }
    const parentOf = new Map(centres.map((c) => [c.id, c.parentId]));
    const billable = dedupeScopeCentres(
      (customer.costCentreIds ?? []).filter((id) => centreIds.has(id)),
      parentOf,
    );
    const childrenOf = new Map<string, string[]>();
    for (const c of centres) {
      if (c.parentId === null || c.parentId === c.id) continue;
      childrenOf.set(c.parentId, [...(childrenOf.get(c.parentId) ?? []), c.id]);
    }
    const subtree = new Set<string>();
    const stack = [...billable];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (subtree.has(id)) continue;
      subtree.add(id);
      stack.push(...(childrenOf.get(id) ?? []));
    }
    buckets = [...subtree, ...scopeAccounts.map((id) => `acct:${id}`)];
  }

  const rows =
    buckets && buckets.length === 0
      ? []
      : await getPricingLines(organizationId, rules, from, to, {
          costBasis: customer
            ? (customer.costBasis as "cash" | "amortized" | "blended")
            : "amortized",
          reallocations: customer ? billing?.adjustments.reallocations : undefined,
          tagKeys: pricingTagKeys([...beforeRules, ...afterRules]),
          buckets,
        });
  const lines: PricingLine[] = rows.map((r) => ({
    ...r,
    accountName: accountNames.get(r.accountId) ?? r.accountId,
  }));

  const customerName = customer?.name ?? "";
  const before = priceLines(lines, {
    pricing: savedPricing,
    rules: beforeRules,
    customer: customerName,
    withLineCosts: true,
  });
  const after = priceLines(lines, {
    pricing: candidatePricing ?? savedPricing,
    rules: afterRules,
    customer: customerName,
    withLineCosts: true,
  });

  /* -- the lines that moved most, rolled up to what a person recognises -- */

  const grouped = new Map<string, PricingPreviewChange>();
  lines.forEach((line, i) => {
    const b = before.lineCosts![i]!;
    const a = after.lineCosts![i]!;
    if (Math.abs(a - b) < 5e-7) return;
    const key = [line.pluginId, line.service, line.accountId, line.chargeType, line.currency].join(
      "\u0000",
    );
    const entry = grouped.get(key) ?? {
      pluginId: line.pluginId,
      service: line.service,
      accountName: line.accountName,
      chargeType: line.chargeType,
      currency: line.currency,
      collected: 0,
      before: 0,
      after: 0,
    };
    entry.collected += line.collected;
    entry.before += b;
    entry.after += a;
    grouped.set(key, entry);
  });
  const changes = [...grouped.values()]
    .map((c) => ({
      ...c,
      collected: round6(c.collected),
      before: round6(c.before),
      after: round6(c.after),
    }))
    .sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before))
    .slice(0, 25);

  return {
    month,
    from,
    to,
    managedAccountId: customer?.id ?? null,
    collected: sumByCurrency(
      lines,
      lines.map((l) => l.collected),
    ),
    before: sumByCurrency(lines, before.lineCosts!),
    after: sumByCurrency(lines, after.lineCosts!),
    effects: after.effects,
    coverage: after.coverage,
    warnings: after.warnings,
    expressionFailures: after.expressionFailures,
    changes,
    lineCount: lines.length,
  };
}
