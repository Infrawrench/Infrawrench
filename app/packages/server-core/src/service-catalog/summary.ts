/**
 * The service page's one read: cost, SLO standing, open findings, current
 * on-call and recent changes for one service, assembled from feeds that
 * already exist (see `signals.ts`) and filtered to the service's members.
 *
 * Partial by design. Each feed is independent, a feed that fails is listed in
 * `findings.unavailable` (or `cost.available = false`) and the rest still
 * renders: during an incident the on-call name matters more than whether the
 * cost warehouse answered.
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type {
  ScorecardResult,
  ServiceBackupFinding,
  ServiceChange,
  ServiceCostSummary,
  ServiceFindings,
  ServiceMember,
  ServiceOnCall,
  ServiceRunbookRef,
  ServiceSloStanding,
  ServiceSummaryResponse,
} from "@infrawrench/client-core";
import { db } from "../db/client";
import { resourceChanges } from "../db/schema";
import { SERVICE_COST_WINDOW_DAYS, ServiceSignals } from "./signals";
import { getServiceWire, type ServiceRecord } from "./store";

/** How far back the change list looks, and how many it shows. */
const CHANGE_WINDOW_DAYS = 7;
const CHANGE_LIMIT = 25;
const POSTURE_ITEM_LIMIT = 25;

/** Drill window the summary judges freshness by; the scorecard check has its own param. */
const SUMMARY_DRILL_DAYS = 90;

export function memberCost(
  members: readonly ServiceMember[],
  spend: Map<string, Array<{ amount: number; currency: string }>> | null,
): ServiceCostSummary {
  if (!spend) {
    return {
      windowDays: SERVICE_COST_WINDOW_DAYS,
      available: false,
      totals: [],
      byProvider: [],
      costedMembers: 0,
    };
  }
  const totals = new Map<string, number>();
  const byProvider = new Map<string, { pluginId: string; currency: string; amount: number }>();
  let costedMembers = 0;
  for (const member of members) {
    if (!member.externalId) continue;
    const rows = spend.get(`${member.accountId} ${member.externalId}`);
    if (!rows || rows.length === 0) continue;
    costedMembers += 1;
    for (const row of rows) {
      totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amount);
      const key = `${member.pluginId} ${row.currency}`;
      const entry = byProvider.get(key) ?? {
        pluginId: member.pluginId,
        currency: row.currency,
        amount: 0,
      };
      entry.amount += row.amount;
      byProvider.set(key, entry);
    }
  }
  return {
    windowDays: SERVICE_COST_WINDOW_DAYS,
    available: true,
    totals: [...totals.entries()]
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => b.amount - a.amount),
    byProvider: [...byProvider.values()].sort((a, b) => b.amount - a.amount),
    costedMembers,
  };
}

export async function memberFindings(
  signals: ServiceSignals,
  members: readonly ServiceMember[],
): Promise<ServiceFindings> {
  const ids = new Set(members.map((m) => m.resourceId));
  const names = new Map(members.map((m) => [m.resourceId, m.resourceName]));
  const [posture, orphans, backups, drills] = await Promise.all([
    signals.posture(),
    signals.orphans(),
    signals.backups(),
    signals.drills(SUMMARY_DRILL_DAYS),
  ]);
  const unavailable: ServiceFindings["unavailable"] = [];

  const postureItems = (posture?.findings ?? []).filter((f) => ids.has(f.resourceId));
  if (!posture) unavailable.push("posture");
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of postureItems) counts[f.severity] += 1;

  if (!orphans) unavailable.push("orphans");
  const orphanItems = (orphans?.accounts ?? [])
    .flatMap((group) => group.resources)
    .filter((r) => ids.has(r.id))
    .map((r) => ({ resourceId: r.id, resourceName: r.displayName, reason: r.reason }));

  if (!backups) unavailable.push("backups");
  const backupItems: ServiceBackupFinding[] = (backups?.findings ?? [])
    .filter((f) => ids.has(f.resourceId) && f.kind !== "orphaned-snapshot")
    .map((f) => ({
      resourceId: f.resourceId,
      resourceName: f.displayName,
      kind: f.kind,
      detail: f.detail,
    }));
  for (const row of drills?.rows ?? []) {
    if (!ids.has(row.resourceId) || row.standing === "verified") continue;
    backupItems.push({
      resourceId: row.resourceId,
      resourceName: names.get(row.resourceId) ?? row.resourceName ?? row.resourceId,
      kind: `drill-${row.standing}`,
      detail:
        row.standing === "never"
          ? "No restore drill has been recorded."
          : row.standing === "failed"
            ? "The most recent restore drill failed."
            : `The last verified restore drill is older than ${SUMMARY_DRILL_DAYS} days.`,
    });
  }

  return {
    posture: { counts, items: postureItems.slice(0, POSTURE_ITEM_LIMIT) },
    orphans: orphanItems,
    backups: backupItems,
    unavailable,
  };
}

async function recentChanges(
  organizationId: string,
  members: readonly ServiceMember[],
  now: number,
): Promise<ServiceChange[]> {
  const ids = members.map((m) => m.resourceId);
  if (ids.length === 0) return [];
  const since = new Date(now - CHANGE_WINDOW_DAYS * 86_400_000);
  const rows = await db
    .select({
      id: resourceChanges.id,
      resourceId: resourceChanges.resourceId,
      displayName: resourceChanges.displayName,
      pluginId: resourceChanges.pluginId,
      changeKind: resourceChanges.changeKind,
      diff: resourceChanges.diff,
      createdAt: resourceChanges.createdAt,
    })
    .from(resourceChanges)
    .where(
      and(
        eq(resourceChanges.organizationId, organizationId),
        inArray(resourceChanges.resourceId, ids.slice(0, 2000)),
        gte(resourceChanges.createdAt, since),
      ),
    )
    .orderBy(desc(resourceChanges.createdAt))
    .limit(CHANGE_LIMIT);
  return rows.map((r) => ({
    id: r.id,
    resourceId: r.resourceId,
    resourceName: r.displayName,
    pluginId: r.pluginId,
    changeKind: r.changeKind,
    fields: r.diff.map((d) => d.field),
    at: r.createdAt.toISOString(),
  }));
}

export async function serviceOnCall(
  signals: ServiceSignals,
  scheduleId: string | null,
): Promise<ServiceOnCall | null> {
  if (!scheduleId) return null;
  const [schedule, resolved] = await Promise.all([
    signals.onCallSchedule(scheduleId),
    signals.onCallNow(scheduleId),
  ]);
  if (!schedule) return null;
  const shift = schedule.enabled ? (resolved?.shift ?? null) : null;
  const next = schedule.enabled ? (resolved?.next ?? null) : null;
  return {
    scheduleId,
    scheduleName: schedule.name,
    enabled: schedule.enabled,
    current: shift
      ? { userId: shift.userId, name: shift.name, email: shift.email, endsAt: shift.endsAt }
      : null,
    next: next ? { userId: next.userId, name: next.name, email: next.email } : null,
  };
}

export async function buildServiceSummary(
  organizationId: string,
  row: ServiceRecord,
  scorecards: ScorecardResult[],
  signals = new ServiceSignals(organizationId),
): Promise<ServiceSummaryResponse> {
  const { service, membership } = await getServiceWire(organizationId, row);
  const members = membership.members.filter((m) => !m.missing);
  const sloIds = new Set(service.sloIds);
  const runbookIds = new Set(service.runbookIds);

  const [spend, findings, changes, sloList, runbookList, onCall] = await Promise.all([
    signals.resourceSpend(),
    memberFindings(signals, members),
    recentChanges(organizationId, members, signals.now).catch((err: unknown) => {
      console.warn("[services] recent changes unavailable:", err);
      return [] as ServiceChange[];
    }),
    signals.slos(),
    signals.runbooks(),
    serviceOnCall(signals, service.onCallScheduleId),
  ]);

  const slos: ServiceSloStanding[] = (sloList ?? [])
    .filter((s) => sloIds.has(s.id))
    .map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      targetPercent: s.targetPercent,
      budgetRemaining: s.budgetRemaining,
    }));
  const runbooks: ServiceRunbookRef[] = (runbookList ?? [])
    .filter((r) => runbookIds.has(r.id))
    .map((r) => ({ id: r.id, name: r.name, enabled: r.enabled }));

  return {
    service,
    memberCount: members.length,
    cost: memberCost(members, spend),
    slos,
    runbooks,
    onCall,
    findings,
    recentChanges: changes,
    scorecards,
    generatedAt: new Date(signals.now).toISOString(),
  };
}
