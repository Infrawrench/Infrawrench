/**
 * Server-side access to the plugins' `estimateCost` capability.
 *
 * Three callers need the same thing and must not each grow their own version
 * of it: the web app's `/resources/cost-estimate` route (create form, edit
 * delta, resource detail page) and the weekly digest's projected-spend line.
 * So the field-merging rule, the "stringify stored fields" rule, and the
 * bounded fan-out all live here.
 *
 * Everything is best-effort by construction. An estimate is a nicety layered
 * on top of whatever the caller was already doing, so a plugin that throws,
 * an account whose credentials no longer decrypt, or a provider pricing API
 * that is down costs the caller one missing number and never an error.
 */
import { and, eq, inArray } from "drizzle-orm";

import type { CostEstimate } from "@infrawrench/plugin-base";

import { db } from "../db/client";
import { resources } from "../db/schema";
import { getOrgAccountClient } from "../org-accounts";

/**
 * Stored fields are `Record<string, unknown>` (the lister writes numbers and
 * booleans as themselves), while `estimateCost` takes strings — the same
 * shape a create form produces. `null`/`undefined` become absent rather than
 * the strings `"null"`/`"undefined"`, which a plugin would read as a real
 * value.
 */
export function stringifyFields(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

export interface EstimateCostInput {
  accountId: string;
  resourceTypeId: string;
  /** Field values keyed the way the create form keys them. */
  fields?: Record<string, string> | undefined;
  /**
   * An existing resource to price. Its stored fields seed the estimate and
   * `fields` is merged over them, so a caller pricing a proposed edit only
   * has to send the keys that changed.
   */
  resourceId?: string | undefined;
}

/**
 * Estimate one configuration's monthly cost, or `null` when it cannot be
 * priced — the plugin has no `estimateCost`, does not know this type, or
 * could not resolve a rate.
 */
export async function estimateResourceCost(
  organizationId: string,
  input: EstimateCostInput,
): Promise<CostEstimate | null> {
  let storedFields: Record<string, string> = {};
  if (input.resourceId) {
    const [row] = await db
      .select({ fieldsJson: resources.fieldsJson })
      .from(resources)
      .where(and(eq(resources.id, input.resourceId), eq(resources.organizationId, organizationId)))
      .limit(1);
    if (!row) return null;
    storedFields = stringifyFields(row.fieldsJson);
  }

  const ctx = await getOrgAccountClient(input.accountId, organizationId).catch(() => null);
  if (!ctx?.client.estimateCost) return null;

  try {
    return await ctx.client.estimateCost(input.resourceTypeId, {
      ...storedFields,
      ...(input.fields ?? {}),
    });
  } catch {
    // A pricing API that is down or a plugin that throws costs the caller its
    // estimate, never its request.
    return null;
  }
}

/**
 * How many distinct accounts one projection will instantiate plugin clients
 * for. Each client means decrypting credentials and, for most providers, at
 * least one pricing API call, so an org with a long tail of accounts must not
 * turn a weekly digest into a fan-out proportional to its account count.
 */
const MAX_ACCOUNTS_PER_PROJECTION = 12;

/**
 * How many resources one projection will price. Well past the churn of a
 * normal week, and a hard stop on the pathological one — a runaway autoscaler
 * that created ten thousand rows must not make the digest the slowest thing
 * in the tick loop.
 */
export const MAX_RESOURCES_PER_PROJECTION = 250;

export interface ProjectedSpend {
  /** Total monthly cost of the priced resources, in `currency`. */
  monthlyAmount: number;
  currency: string;
  /** How many of the resources could be priced. */
  pricedCount: number;
  /**
   * How many were considered but could not be priced — no `estimateCost` for
   * the plugin, or no rate for the type. Reported rather than hidden, because
   * "$0" and "nothing we can price" must not read the same.
   */
  unpricedCount: number;
  /**
   * True when the set was truncated by one of the caps above, so the figure
   * is a floor rather than the whole story.
   */
  truncated: boolean;
}

/**
 * Sum the monthly estimates of a set of resource ids.
 *
 * Resources are grouped by account so each account's plugin client is built
 * once and its pricing cache is shared across every resource on it — the
 * difference between one GetProducts call per instance type and one per
 * resource.
 *
 * Mixed currencies collapse to the one with the largest total; the rest are
 * counted as unpriced. Every plugin implementing this today quotes USD, and
 * inventing an exchange rate to add them up would be worse than declining to.
 */
export async function projectMonthlySpend(
  organizationId: string,
  resourceIds: string[],
): Promise<ProjectedSpend | null> {
  if (resourceIds.length === 0) return null;

  const capped = resourceIds.slice(0, MAX_RESOURCES_PER_PROJECTION);
  const rows = await db
    .select({
      id: resources.id,
      accountId: resources.accountId,
      resourceTypeId: resources.resourceTypeId,
      fieldsJson: resources.fieldsJson,
    })
    .from(resources)
    .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, capped)));
  if (rows.length === 0) return null;

  const byAccount = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = byAccount.get(row.accountId);
    if (bucket) bucket.push(row);
    else byAccount.set(row.accountId, [row]);
  }

  const accountIds = [...byAccount.keys()];
  const consideredAccounts = accountIds.slice(0, MAX_ACCOUNTS_PER_PROJECTION);
  let truncated =
    capped.length < resourceIds.length || consideredAccounts.length < accountIds.length;
  for (const skipped of accountIds.slice(MAX_ACCOUNTS_PER_PROJECTION)) {
    if ((byAccount.get(skipped)?.length ?? 0) > 0) truncated = true;
  }

  const totalsByCurrency = new Map<string, { amount: number; count: number }>();
  let unpricedCount =
    rows.length - consideredAccounts.reduce((sum, id) => sum + (byAccount.get(id)?.length ?? 0), 0);

  for (const accountId of consideredAccounts) {
    const accountRows = byAccount.get(accountId) ?? [];
    const ctx = await getOrgAccountClient(accountId, organizationId).catch(() => null);
    const estimateCost = ctx?.client.estimateCost?.bind(ctx.client);
    if (!estimateCost) {
      unpricedCount += accountRows.length;
      continue;
    }
    for (const row of accountRows) {
      const estimate = await estimateCost(
        row.resourceTypeId,
        stringifyFields(row.fieldsJson),
      ).catch(() => null);
      if (!estimate) {
        unpricedCount += 1;
        continue;
      }
      const entry = totalsByCurrency.get(estimate.currency) ?? { amount: 0, count: 0 };
      entry.amount += estimate.monthlyAmount;
      entry.count += 1;
      totalsByCurrency.set(estimate.currency, entry);
    }
  }

  const ranked = [...totalsByCurrency.entries()].sort((a, b) => b[1].amount - a[1].amount);
  const winner = ranked[0];
  if (!winner) {
    return { monthlyAmount: 0, currency: "USD", pricedCount: 0, unpricedCount, truncated };
  }
  for (const [, entry] of ranked.slice(1)) unpricedCount += entry.count;

  return {
    monthlyAmount: Number(winner[1].amount.toFixed(2)),
    currency: winner[0],
    pricedCount: winner[1].count,
    unpricedCount,
    truncated,
  };
}
