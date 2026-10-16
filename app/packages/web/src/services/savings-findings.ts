/**
 * The savings findings list (`GET /savings/findings`): every finder computed
 * now, recorded through server-core's `savings/findings.ts`, and answered from
 * the recorded rows so Completed and Archived findings (which the finders no
 * longer report, or which a person set aside) list beside the open ones.
 *
 * Cost visibility: a finding is per account and carries money, so a scoped
 * caller sees only findings on accounts granted to them outright
 * (`strictlyVisibleAccountIds`, the credits and realized savings rule). Their
 * reads still record new and returning findings, but never overwrite the
 * stored snapshot, whose money an unscoped scan wrote and their narrowed feeds
 * would blank. A caller without `costs:read` gets orphan findings without a
 * figure, exactly as `/orphans` answers them (that figure is billing data);
 * the right-sizing, extended support and seat figures are list prices.
 */
import {
  summarizeSavingsFindings,
  type SavingsFinding,
  type SavingsFindingKind,
  type SavingsFindingMoney,
  type SavingsFindingsResponse,
} from "@infrawrench/client-core";
import { orgAppUrl } from "@infrawrench/server-core/app-url";
import { addDays, isoDay } from "@infrawrench/server-core/cost/dates";
import { strictlyVisibleAccountIds } from "@infrawrench/server-core/cost/visibility-context";
import {
  listRecordedFindings,
  loadResourceContexts,
  observeExtendedSupport,
  observeOrphans,
  observeOversized,
  observeSeats,
  recordFindingObservations,
  type ObservedFinding,
} from "@infrawrench/server-core/savings/findings";
import { isGatewayOnlyError } from "@infrawrench/server-core/runtime/gateway-only";
import { getRealizedSavingsReport } from "@infrawrench/server-core/savings/realized";
import { listSeats } from "@infrawrench/server-core/seats/feed";

import { listExtendedSupportWithBilling } from "./extended-support";
import { listOrphans } from "./orphans";
import { listRightsizing } from "./rightsizing";

/** Trailing days of realized savings the summary compares against monthly potential. */
export const REALIZED_WINDOW_DAYS = 30;

export interface ListSavingsFindingsOptions {
  /** The caller holds `costs:read`. */
  canReadCosts: boolean;
  /** Bypass the right-sizing and extended support caches. */
  refresh?: boolean | undefined;
  now?: Date | undefined;
}

async function attempt<T>(
  kind: SavingsFindingKind,
  unavailable: SavingsFindingsResponse["unavailable"],
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    // On the edge, a finder that needs plugin code must hand the whole read
    // to the gateway, not come back as "unavailable".
    if (isGatewayOnlyError(err)) throw err;
    console.warn(`[savings-findings] ${kind} feed failed:`, err);
    unavailable.push({ kind, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Realized savings over the trailing window, per currency; null on failure. */
async function realizedTotals(
  organizationId: string,
  now: Date,
): Promise<SavingsFindingMoney[] | null> {
  try {
    const today = isoDay(now);
    const report = await getRealizedSavingsReport(organizationId, {
      from: addDays(today, -REALIZED_WINDOW_DAYS),
      to: addDays(today, -1),
      now,
    });
    return report.totals.map((t) => ({ currency: t.currency, amount: t.realized }));
  } catch (err) {
    console.warn("[savings-findings] realized savings failed:", err);
    return null;
  }
}

export async function listSavingsFindings(
  organizationId: string,
  opts: ListSavingsFindingsOptions,
): Promise<SavingsFindingsResponse> {
  const now = opts.now ?? new Date();
  const visible = strictlyVisibleAccountIds(organizationId);
  const unavailable: SavingsFindingsResponse["unavailable"] = [];
  const refresh = opts.refresh === true;

  const [orphans, oversized, extended, seats] = await Promise.all([
    attempt("orphan", unavailable, () =>
      listOrphans(organizationId, { includeCosts: opts.canReadCosts }),
    ),
    attempt("oversized", unavailable, () => listRightsizing(organizationId, { refresh })),
    attempt("extended_support", unavailable, () =>
      listExtendedSupportWithBilling(organizationId, { refresh }),
    ),
    attempt("seat", unavailable, () => listSeats(organizationId, { withoutRemediation: true })),
  ]);

  const scanned = new Set<SavingsFindingKind>();
  if (orphans) scanned.add("orphan");
  if (oversized) scanned.add("oversized");
  if (extended) scanned.add("extended_support");
  if (seats) scanned.add("seat");

  const contexts = await loadResourceContexts(organizationId, [
    ...(orphans?.accounts.flatMap((g) => g.resources.map((r) => r.id)) ?? []),
    ...(oversized?.accounts.flatMap((g) => g.resources.map((r) => r.id)) ?? []),
    ...(extended?.findings.map((f) => f.resourceId) ?? []),
  ]);
  const ctx = (id: string) => contexts.get(id);
  const observed: ObservedFinding[] = [
    ...(orphans ? observeOrphans(orphans, ctx) : []),
    ...(oversized ? observeOversized(oversized, ctx) : []),
    ...(extended ? observeExtendedSupport(extended, ctx) : []),
    ...(seats ? observeSeats(seats) : []),
  ];
  await recordFindingObservations(organizationId, observed, {
    scannedKinds: scanned,
    concludeAbsence: false,
    refreshSnapshots: visible === null && opts.canReadCosts,
    now,
    url: orgAppUrl(organizationId, "costs"),
  });

  let findings: SavingsFinding[] = await listRecordedFindings(organizationId, visible);
  if (!opts.canReadCosts) {
    findings = findings.map((f) => (f.kind === "orphan" ? { ...f, monthlySavings: null } : f));
  }
  const realized = opts.canReadCosts ? await realizedTotals(organizationId, now) : null;
  return {
    findings,
    summary: summarizeSavingsFindings(findings, realized, REALIZED_WINDOW_DAYS),
    unavailable,
    generatedAt: now.toISOString(),
  };
}
