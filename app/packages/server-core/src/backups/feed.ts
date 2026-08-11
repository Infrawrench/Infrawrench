/**
 * The org's backup coverage, assembled server-side so the web API, the weekly
 * digest and any future alert pass all read one computation.
 *
 * Purely a read over already-synced state, exactly like the orphan finder, the
 * expiry radar and the posture feed: plugins declare `backupRole` /
 * `backupPolicy` on their resource types, the shared pure half lives in
 * `@infrawrench/client-core` (`computeBackupCoverage`), and this module only
 * maps Postgres rows onto its input. No plugin clients, no credentials, no
 * provider API calls, ever.
 *
 * The one thing it reaches outside Postgres for is billing: orphaned backups
 * are pure spend, and a number is what makes anyone delete them. That read is
 * best-effort — ClickHouse being unreachable leaves every cost null, never
 * zero, and the coverage itself is unaffected (the `schedules/feed.ts` rule).
 */
import { and, eq, isNull } from "drizzle-orm";
import { computeBackupCoverage, type BackupCoverageResponse } from "@infrawrench/client-core";
import { db } from "../db/client";
import { accounts, resources } from "../db/schema";
import { getResourceCostTotals } from "../clickhouse/cost-readers";
import { addDays, isoDay } from "../cost/dates";
import { loadPlugins } from "../plugin-loader";
import { listBackupPolicies } from "./store";

/** Trailing window the orphaned-backup spend quote is taken over. */
export const BACKUP_COST_WINDOW_DAYS = 30;

export interface ListBackupCoverageOptions {
  /** Scan instant; defaults to `Date.now()`. Fixed in tests. */
  now?: number;
  /**
   * Skip the billing join. The digest takes this: it needs the risk counts,
   * not a spend quote, and a ClickHouse round trip per org per week to
   * populate a number nobody reads is not worth the latency.
   */
  skipCosts?: boolean;
}

/**
 * Trailing-window spend per `"<accountId> <externalId>"`. Null when ClickHouse
 * is unreachable or unconfigured — the same shape and the same failure stance
 * as the schedules preview quote.
 */
async function loadCostTotals(
  organizationId: string,
): Promise<Map<string, { amount: number; currency: string | null }> | null> {
  const to = isoDay(new Date());
  const from = addDays(to, -(BACKUP_COST_WINDOW_DAYS - 1));
  try {
    const totals = await getResourceCostTotals(organizationId, from, to);
    const byKey = new Map<string, { amount: number; currency: string | null }>();
    for (const t of totals) {
      const key = `${t.accountId} ${t.resourceId}`;
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, { amount: t.amount, currency: t.currency });
      // A resource billed in two currencies has no meaningful total; null
      // marks it and the computation drops the quote rather than adding
      // pounds to dollars.
      else if (existing.currency !== null && existing.currency !== t.currency)
        existing.currency = null;
      else existing.amount += t.amount;
    }
    return byKey;
  } catch {
    return null;
  }
}

/**
 * Every stateful resource the plugin declarations let us judge, the backups
 * protecting it, and the gaps. Soft-deleted accounts and resources are
 * excluded, so a finding can never outlive the thing it belongs to — and an
 * orphan claim can never be made against a source we merely stopped syncing
 * within the same account.
 */
export async function listBackupCoverage(
  organizationId: string,
  opts: ListBackupCoverageOptions = {},
): Promise<BackupCoverageResponse> {
  const [orgResources, orgAccounts, plugins, policies, costs] = await Promise.all([
    db
      .select({
        id: resources.id,
        pluginId: resources.pluginId,
        resourceTypeId: resources.resourceTypeId,
        accountId: resources.accountId,
        displayName: resources.displayName,
        externalId: resources.externalId,
        fieldsJson: resources.fieldsJson,
      })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt))),
    db
      .select({
        id: accounts.id,
        displayName: accounts.displayName,
        pluginId: accounts.pluginId,
      })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt))),
    loadPlugins(),
    listBackupPolicies(organizationId),
    opts.skipCosts ? Promise.resolve(null) : loadCostTotals(organizationId),
  ]);

  return computeBackupCoverage(
    {
      plugins: plugins.map(({ plugin }) => ({
        id: plugin.manifest.id,
        displayName: plugin.manifest.displayName,
        resourceTypes: plugin.resourceTypes,
      })),
      accounts: orgAccounts,
      resources: orgResources.map((r) => ({
        id: r.id,
        pluginId: r.pluginId,
        resourceTypeId: r.resourceTypeId,
        accountId: r.accountId,
        displayName: r.displayName,
        externalId: r.externalId,
        fields: r.fieldsJson,
      })),
      policies,
    },
    {
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      ...(costs ? { costsByResource: costs } : {}),
    },
  );
}
