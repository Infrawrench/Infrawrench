/**
 * The savings scan: a poller pass that turns the recomputed-on-read orphan
 * and rightsizing feeds into events with a beginning and an end.
 *
 * Every six hours per org it computes both feeds, compares them with what it
 * saw last time (`savings_finding_states`), and:
 *
 * - raises one `savingsFindings` alert per **new** finding, carrying the
 *   finding so a `github-issues` routing destination can file it
 *   ("every new finding over $200/month → GitHub" is an `amountCents` rule);
 * - resolves the GitHub issue of every finding that has **gone away**
 *   (close or comment, per the org's GitHub issue settings);
 * - on an org's very first scan, records what exists without raising
 *   anything. Turning the feature on must not file a hundred issues for the
 *   estate as it already was; the backlog is a click away on the Savings page.
 *
 * A feed that failed to compute (rightsizing reaches provider APIs and can
 * fail per org) neither raises nor resolves for its kind that pass: "could
 * not tell" must never read as "the finding went away".
 *
 * Claimed with the same conditional upsert the daily alert radars use, so N
 * poller replicas scan an org once per window. Never throws.
 */
import { and, eq, inArray, isNull, lte, or } from "drizzle-orm";
import type {
  GithubIssueSourceKind,
  OrphanListResponse,
  RightsizingListResponse,
} from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { accounts, savingsFindingScans, savingsFindingStates } from "../db/schema.js";
import { routeAlert } from "../alerts/route.js";
import { orgAppUrl } from "../app-url.js";
import { listOrphans } from "../savings/orphans.js";
import { listRightsizing } from "../savings/rightsizing.js";
import {
  formatMoney,
  reopenResolvedLinks,
  resolveFindingIssues,
  type GithubFinding,
} from "./filing.js";

export const SAVINGS_SCAN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** At most this many alerts per org per scan; the rest wait for the next. */
export const MAX_NEW_FINDING_ALERTS = 25;

export interface ScannedFinding {
  sourceKind: Extract<GithubIssueSourceKind, "orphan" | "oversized">;
  sourceId: string;
  accountId: string;
  pluginId: string;
  resourceTypeId: string;
  title: string;
  body: string;
  /** Monthly money at stake; null when unpriced. */
  monthly: { amount: number; currency: string } | null;
  finding: GithubFinding;
}

/** Orphans as findings. Pure, for tests. 30 days of spend reads as monthly. */
export function orphanFindings(feed: OrphanListResponse, appUrl: string | null): ScannedFinding[] {
  const out: ScannedFinding[] = [];
  for (const group of feed.accounts) {
    for (const r of group.resources) {
      const monthly = r.cost
        ? { amount: (r.cost.amount * 30) / feed.costWindowDays, currency: r.cost.currency }
        : null;
      const title = `${r.displayName} (${r.resourceTypeName}) looks orphaned`;
      out.push({
        sourceKind: "orphan",
        sourceId: r.id,
        accountId: group.accountId,
        pluginId: group.pluginId,
        resourceTypeId: r.resourceTypeId,
        title,
        body: `${r.reason}${monthly ? ` About ${formatMoney(monthly.amount, monthly.currency)}/month.` : ""}`,
        monthly,
        finding: {
          sourceKind: "orphan",
          sourceId: r.id,
          title,
          resourceId: r.id,
          details: [
            { label: "Resource", value: r.displayName },
            { label: "Type", value: r.resourceTypeName },
            { label: "Provider", value: group.pluginName },
            { label: "Account", value: group.accountName },
            { label: "Provider id", value: r.externalId },
            { label: "Last synced", value: r.lastSyncedAt },
          ],
          note: r.reason,
          ...(monthly ? { monthlyCost: monthly } : {}),
          appUrl,
        },
      });
    }
  }
  return out;
}

/** Oversized resources as findings. Pure, for tests. */
export function oversizedFindings(
  feed: RightsizingListResponse,
  appUrl: string | null,
): ScannedFinding[] {
  const out: ScannedFinding[] = [];
  for (const group of feed.accounts) {
    for (const r of group.resources) {
      const monthly =
        r.monthlySaving !== null ? { amount: r.monthlySaving, currency: r.currency } : null;
      const title = `Right-size ${r.displayName} from ${r.currentSize.label} to ${r.recommendedSize.label}`;
      out.push({
        sourceKind: "oversized",
        sourceId: r.id,
        accountId: group.accountId,
        pluginId: r.pluginId,
        resourceTypeId: r.resourceTypeId,
        title,
        body:
          `p95 CPU ${r.cpuP95}% over ${feed.windowDays} days` +
          (monthly ? `; saves about ${formatMoney(monthly.amount, monthly.currency)}/month.` : "."),
        monthly,
        finding: {
          sourceKind: "oversized",
          sourceId: r.id,
          title,
          resourceId: r.id,
          details: [
            { label: "Resource", value: r.displayName },
            { label: "Type", value: r.resourceTypeName },
            { label: "Account", value: group.accountName },
            { label: "Current size", value: r.currentSize.label },
            { label: "Recommended size", value: r.recommendedSize.label },
            { label: `p95 CPU (${feed.windowDays}d)`, value: `${r.cpuP95}%` },
            {
              label: "p95 memory",
              value: r.memoryMeasured && r.memoryP95 !== null ? `${r.memoryP95}%` : "not measured",
            },
            { label: "Projected p95 CPU", value: `${r.projectedCpuP95}%` },
          ],
          ...(r.resizeNote ? { note: r.resizeNote } : {}),
          ...(monthly
            ? { monthlyCost: { amount: monthly.amount, currency: monthly.currency } }
            : {}),
          appUrl,
        },
      });
    }
  }
  return out;
}

export interface SavingsScanOutcome {
  status: "scanned" | "baselined" | "cooling-down" | "failed";
  raised?: number;
  resolved?: number;
  error?: string;
}

async function findDueOrgs(now: Date, limit: number): Promise<string[]> {
  const cutoff = new Date(now.getTime() - SAVINGS_SCAN_COOLDOWN_MS);
  const rows = await db
    .selectDistinct({ organizationId: accounts.organizationId })
    .from(accounts)
    .leftJoin(savingsFindingScans, eq(savingsFindingScans.organizationId, accounts.organizationId))
    .where(
      and(
        isNull(accounts.deletedAt),
        or(
          isNull(savingsFindingScans.organizationId),
          isNull(savingsFindingScans.lastScanAt),
          lte(savingsFindingScans.lastScanAt, cutoff),
        ),
      ),
    )
    .orderBy(accounts.organizationId)
    .limit(limit);
  return rows.map((r) => r.organizationId);
}

/** Claim the org's scan slot; returns the row's prior baseline, or null when lost. */
async function claim(
  organizationId: string,
  now: Date,
): Promise<{ baselinedAt: Date | null } | null> {
  const cutoff = new Date(now.getTime() - SAVINGS_SCAN_COOLDOWN_MS);
  const rows = await db
    .insert(savingsFindingScans)
    .values({ organizationId, lastScanAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: savingsFindingScans.organizationId,
      set: { lastScanAt: now, updatedAt: now },
      setWhere: or(
        isNull(savingsFindingScans.lastScanAt),
        lte(savingsFindingScans.lastScanAt, cutoff),
      )!,
    })
    .returning({ baselinedAt: savingsFindingScans.baselinedAt });
  return rows[0] ?? null;
}

async function scanOrg(
  organizationId: string,
  baselined: boolean,
  now: Date,
): Promise<SavingsScanOutcome> {
  const appUrl = orgAppUrl(organizationId, "savings");
  const kinds: ScannedFinding["sourceKind"][] = [];
  const current: ScannedFinding[] = [];

  try {
    current.push(...orphanFindings(await listOrphans(organizationId), appUrl));
    kinds.push("orphan");
  } catch (err) {
    console.error(`[savings-scan] orphan scan for org ${organizationId} failed:`, err);
  }
  try {
    current.push(...oversizedFindings(await listRightsizing(organizationId), appUrl));
    kinds.push("oversized");
  } catch (err) {
    console.error(`[savings-scan] rightsizing scan for org ${organizationId} failed:`, err);
  }
  if (kinds.length === 0) return { status: "failed", error: "both feeds failed" };

  const known = await db
    .select({
      sourceKind: savingsFindingStates.sourceKind,
      sourceId: savingsFindingStates.sourceId,
    })
    .from(savingsFindingStates)
    .where(
      and(
        eq(savingsFindingStates.organizationId, organizationId),
        inArray(savingsFindingStates.sourceKind, kinds),
      ),
    );
  const key = (k: string, id: string) => `${k}\x00${id}`;
  const knownKeys = new Set(known.map((k) => key(k.sourceKind, k.sourceId)));
  const currentKeys = new Set(current.map((f) => key(f.sourceKind, f.sourceId)));

  const fresh = current.filter((f) => !knownKeys.has(key(f.sourceKind, f.sourceId)));
  const gone = known.filter((k) => !currentKeys.has(key(k.sourceKind, k.sourceId)));

  // Record what exists now.
  for (let i = 0; i < current.length; i += 500) {
    const chunk = current.slice(i, i + 500);
    await db
      .insert(savingsFindingStates)
      .values(
        chunk.map((f) => ({
          organizationId,
          sourceKind: f.sourceKind,
          sourceId: f.sourceId,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          savingsFindingStates.organizationId,
          savingsFindingStates.sourceKind,
          savingsFindingStates.sourceId,
        ],
        set: { lastSeenAt: now },
      });
  }

  // Forget, and resolve, what went away.
  let resolved = 0;
  if (gone.length > 0) {
    for (const kind of kinds) {
      const ids = gone.filter((g) => g.sourceKind === kind).map((g) => g.sourceId);
      for (let i = 0; i < ids.length; i += 500) {
        await db
          .delete(savingsFindingStates)
          .where(
            and(
              eq(savingsFindingStates.organizationId, organizationId),
              eq(savingsFindingStates.sourceKind, kind),
              inArray(savingsFindingStates.sourceId, ids.slice(i, i + 500)),
            ),
          );
      }
    }
    const r = await resolveFindingIssues(
      organizationId,
      gone.map((g) => ({
        sourceKind: g.sourceKind as GithubIssueSourceKind,
        sourceId: g.sourceId,
      })),
      "the resource was resized, removed or is in use again.",
    );
    resolved = r.closed + r.commented;
  }
  await reopenResolvedLinks(
    organizationId,
    current.map((f) => ({ sourceKind: f.sourceKind, sourceId: f.sourceId })),
  ).catch((err: unknown) => console.warn("[savings-scan] reopen failed:", err));

  if (!baselined) {
    await db
      .update(savingsFindingScans)
      .set({ baselinedAt: now, updatedAt: now })
      .where(eq(savingsFindingScans.organizationId, organizationId));
    return { status: "baselined", raised: 0, resolved };
  }

  // Biggest money first, so the cap drops the cheap ones.
  const ordered = [...fresh].sort((a, b) => (b.monthly?.amount ?? 0) - (a.monthly?.amount ?? 0));
  const raise = ordered.slice(0, MAX_NEW_FINDING_ALERTS);
  // Findings over the cap are forgotten again so the next scan raises them.
  const deferred = ordered.slice(MAX_NEW_FINDING_ALERTS);
  for (const f of deferred) {
    await db
      .delete(savingsFindingStates)
      .where(
        and(
          eq(savingsFindingStates.organizationId, organizationId),
          eq(savingsFindingStates.sourceKind, f.sourceKind),
          eq(savingsFindingStates.sourceId, f.sourceId),
        ),
      );
  }

  let raised = 0;
  for (const f of raise) {
    try {
      await routeAlert({
        organizationId,
        trigger: "savingsFindings",
        title: f.sourceKind === "orphan" ? `Orphaned: ${f.title}` : f.title,
        body: f.body,
        context: f.sourceKind === "orphan" ? "Savings · orphaned" : "Savings · oversized",
        url: appUrl,
        pushData: {
          type: "savings_finding",
          orgId: organizationId,
          kind: f.sourceKind,
          resourceId: f.sourceId,
        },
        facts: {
          accountId: f.accountId,
          pluginId: f.pluginId,
          resourceTypeId: f.resourceTypeId,
          resourceId: f.sourceId,
          key: f.title,
          ...(f.monthly
            ? { amountCents: Math.round(f.monthly.amount * 100), currency: f.monthly.currency }
            : {}),
        },
        finding: f.finding,
      });
      raised += 1;
    } catch (err) {
      console.error(`[savings-scan] alert for ${f.sourceId} failed:`, err);
    }
  }
  return { status: "scanned", raised, resolved };
}

/** The poller pass: claim up to `limit` due orgs and scan each. Never throws. */
export async function runSavingsFindingScan(
  { limit = 3 }: { limit?: number } = {},
  now = new Date(),
): Promise<Record<string, SavingsScanOutcome>> {
  const outcomes: Record<string, SavingsScanOutcome> = {};
  let due: string[];
  try {
    due = await findDueOrgs(now, limit);
  } catch (err) {
    console.error("[savings-scan] finding due orgs failed:", err);
    return outcomes;
  }
  for (const organizationId of due) {
    try {
      const claimed = await claim(organizationId, now);
      if (!claimed) {
        outcomes[organizationId] = { status: "cooling-down" };
        continue;
      }
      outcomes[organizationId] = await scanOrg(organizationId, claimed.baselinedAt !== null, now);
    } catch (err) {
      console.error(`[savings-scan] scan for org ${organizationId} failed:`, err);
      outcomes[organizationId] = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return outcomes;
}
