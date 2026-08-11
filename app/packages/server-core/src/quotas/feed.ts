/**
 * The quota radar feed — every provider limit an org is close to, with the
 * trend that says whether it is getting closer.
 *
 * The reason this is a screen at all: quota exhaustion is currently discovered
 * mid-incident. The provider does not warn you, the console shows the limit
 * only if you go looking for it per-service per-region, and the failure mode
 * is an autoscaler that quietly stops scaling. A limit is knowable in advance
 * and almost never is.
 *
 * Read-time honesty is the design constraint, and it is why this returns three
 * things rather than one list: `rows` is what we know, `accounts` is what we
 * could not read and why, and `unsupportedPluginIds` is what nobody can read.
 * A page that showed only the first would render "no quotas near their limits"
 * for an org whose every account's collection is failing.
 */
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";

import {
  computeQuotaTrend,
  quotaSeverity,
  sortQuotaRows,
  type QuotaAccountStatus,
  type QuotaListResponse,
  type QuotaRow,
  type QuotaSnapshot,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import {
  accountQuotaPolls,
  accountQuotaSnapshots,
  accountQuotaUsage,
  accounts,
} from "../db/schema";
import { loadPlugins } from "../plugin-loader";
import { getQuotaSettings } from "./settings";

/**
 * How far back the trend fit looks.
 *
 * Fourteen days rather than the credits burn's thirty: quota utilisation moves
 * with provisioning decisions, and a month-long window drags a fortnight-old
 * steady state into a fit that should be describing this week's growth. Short
 * enough to notice a change, long enough that a single deploy is one point
 * among many.
 */
export const QUOTA_TREND_WINDOW_DAYS = 14;

/**
 * Retention for the snapshot series. A year, the `pruneCreditSnapshots`
 * number, for the same reason: the rows are tiny and a longer history is the
 * only way to answer "when did this start climbing" after the fact.
 */
export const QUOTA_SNAPSHOT_RETENTION_DAYS = 365;

/**
 * Every quota the org has a reading for, worst first.
 *
 * Sorted by severity and then utilisation rather than by account or service,
 * because the question the page answers is "what is about to break" and any
 * grouping-first sort buries that under alphabetical order. The UI regroups
 * for display; the API's order is the priority order.
 */
export async function getQuotaFeed(
  organizationId: string,
  now = new Date(),
): Promise<QuotaListResponse> {
  const plugins = await loadPlugins();
  const quotaPlugins = new Map(
    plugins
      .filter((p) => p.plugin.manifest.quotas)
      .map((p) => [p.plugin.manifest.id, p.plugin.manifest.quotas!]),
  );

  const settings = await getQuotaSettings(organizationId);

  const orgAccounts = await db
    .select({
      id: accounts.id,
      displayName: accounts.displayName,
      pluginId: accounts.pluginId,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, organizationId));

  // Named, not counted: "Vercel cannot report quotas" is actionable in a way
  // that "3 providers unsupported" is not. Deduped and sorted so the list is
  // stable between requests.
  const unsupportedPluginIds = [
    ...new Set(orgAccounts.map((a) => a.pluginId).filter((id) => !quotaPlugins.has(id))),
  ].sort();

  const relevant = orgAccounts.filter((a) => quotaPlugins.has(a.pluginId));
  if (relevant.length === 0) {
    return { rows: [], accounts: [], threshold: settings.threshold, unsupportedPluginIds };
  }
  const accountById = new Map(relevant.map((a) => [a.id, a]));

  const since = new Date(now.getTime() - QUOTA_TREND_WINDOW_DAYS * 86_400_000);
  const [current, snapshots, polls] = await Promise.all([
    db.select().from(accountQuotaUsage).where(eq(accountQuotaUsage.organizationId, organizationId)),
    db
      .select({
        accountId: accountQuotaSnapshots.accountId,
        quotaKey: accountQuotaSnapshots.quotaKey,
        quotaLimit: accountQuotaSnapshots.quotaLimit,
        used: accountQuotaSnapshots.used,
        utilization: accountQuotaSnapshots.utilization,
        observedAt: accountQuotaSnapshots.observedAt,
      })
      .from(accountQuotaSnapshots)
      .where(
        and(
          eq(accountQuotaSnapshots.organizationId, organizationId),
          gte(accountQuotaSnapshots.observedAt, since),
        ),
      )
      .orderBy(asc(accountQuotaSnapshots.observedAt)),
    db.select().from(accountQuotaPolls).where(eq(accountQuotaPolls.organizationId, organizationId)),
  ]);

  const seriesByQuota = new Map<string, QuotaSnapshot[]>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.accountId}:${snapshot.quotaKey}`;
    const point: QuotaSnapshot = {
      observedAt: snapshot.observedAt.toISOString(),
      used: snapshot.used,
      limit: snapshot.quotaLimit,
      utilization: snapshot.utilization,
    };
    const list = seriesByQuota.get(key);
    if (list) list.push(point);
    else seriesByQuota.set(key, [point]);
  }

  const rows: QuotaRow[] = [];
  const countByAccount = new Map<string, number>();
  for (const row of current) {
    const account = accountById.get(row.accountId);
    if (!account) continue;
    countByAccount.set(row.accountId, (countByAccount.get(row.accountId) ?? 0) + 1);

    const trend = computeQuotaTrend(
      seriesByQuota.get(`${row.accountId}:${row.quotaKey}`) ?? [],
      row.utilization,
    );
    rows.push({
      key: row.quotaKey,
      accountId: row.accountId,
      accountName: account.displayName,
      pluginId: account.pluginId,
      service: row.service,
      name: row.name,
      region: row.region,
      limit: row.quotaLimit,
      used: row.used,
      utilization: row.utilization,
      unit: row.unit,
      adjustable: row.adjustable,
      docsUrl: row.docsUrl ?? quotaPlugins.get(account.pluginId)?.increaseUrl ?? null,
      observedAt: row.observedAt.toISOString(),
      severity: quotaSeverity(row.utilization, settings.threshold, trend),
      trend,
    });
  }

  const pollByAccount = new Map(polls.map((p) => [p.accountId, p]));
  const accountStatuses: QuotaAccountStatus[] = relevant
    .map((account) => {
      const poll = pollByAccount.get(account.id);
      return {
        accountId: account.id,
        accountName: account.displayName,
        pluginId: account.pluginId,
        quotaCount: countByAccount.get(account.id) ?? 0,
        lastPolledAt: poll?.lastPolledAt?.toISOString() ?? null,
        lastError: poll?.lastError ?? null,
        lastErrorHelpLabel: poll?.lastErrorHelpLabel ?? null,
        lastErrorHelpUrl: poll?.lastErrorHelpUrl ?? null,
        partial: quotaPlugins.get(account.pluginId)?.partial === true,
      };
    })
    .sort((a, b) => a.accountName.localeCompare(b.accountName));

  return {
    rows: sortQuotaRows(rows),
    accounts: accountStatuses,
    threshold: settings.threshold,
    unsupportedPluginIds,
  };
}

const SNAPSHOT_PRUNE_BATCH_SIZE = 2_000;
const MAX_SNAPSHOT_PRUNE_BATCHES = 25;

/**
 * Prune quota snapshots past the retention window.
 *
 * Batched like every other prune here: a first run against a long-neglected
 * table must not hold locks for minutes. Whatever is left goes on the next
 * pass an hour later. Idempotent, so replicas repeating it costs an index
 * probe and nothing else — no claim is warranted (the `pruneResourceChanges`
 * stance).
 */
export async function pruneQuotaSnapshots(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - QUOTA_SNAPSHOT_RETENTION_DAYS * 86_400_000);
  let deleted = 0;
  for (let batch = 0; batch < MAX_SNAPSHOT_PRUNE_BATCHES; batch++) {
    const due = await db
      .select({ id: accountQuotaSnapshots.id })
      .from(accountQuotaSnapshots)
      .where(lt(accountQuotaSnapshots.observedAt, cutoff))
      .limit(SNAPSHOT_PRUNE_BATCH_SIZE);
    if (due.length === 0) break;
    await db.delete(accountQuotaSnapshots).where(
      inArray(
        accountQuotaSnapshots.id,
        due.map((r) => r.id),
      ),
    );
    deleted += due.length;
    if (due.length < SNAPSHOT_PRUNE_BATCH_SIZE) break;
  }
  return deleted;
}
