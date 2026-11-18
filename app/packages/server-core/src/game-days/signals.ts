/**
 * What noticed the failure: the detection half of a game day.
 *
 * Two sources, because the product has no single record of "an alert went
 * out":
 *
 * - {@link recordGameDayAlert} is called by `routeAlert` for every alert it
 *   handles. While an organization has a game day in flight, the alert is
 *   written to `game_day_alerts` with whether it is about the game day, whether
 *   it reached an on-call rotation or a paging provider, and the delivery rows
 *   its acknowledgement will land on.
 * - {@link sampleGameDaySignals} reads the features' own records on every pass
 *   tick: watched probe rows, metric alert events, SLO alert states, declared
 *   incidents, and those alert rows.
 *
 * Both are best-effort and never throw into their caller: a game day that
 * misses a timestamp reports it as not detected, which is the honest reading
 * of a record nobody can find; an alert lost to a game day's bookkeeping would
 * be the opposite of the point.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, isNotNull, min, ne, or } from "drizzle-orm";
import type { GameDaySignals } from "@infrawrench/client-core";
import { db } from "../db/client";
import {
  alertDeliveries,
  gameDayAlerts,
  gameDays,
  incidents,
  metricAlertEvents,
  serviceLinks,
  slos,
  syntheticProbes,
} from "../db/schema";

/** Statuses during which alerts are recorded against a game day. */
const RECORDING = ["injecting", "running", "reverting", "recovering"] as const;

/** Destination kinds that wake a person up. */
const PAGE_KINDS: ReadonlySet<string> = new Set(["on-call", "paging-provider", "provider-on-call"]);

export interface RoutedAlertFacts {
  organizationId: string;
  trigger: string;
  severity: string;
  title: string;
  resourceId: string | undefined;
  lifecycleKey: string | undefined;
  /** Destination kinds the rules chose. */
  destinationKinds: readonly string[];
  unrouted: boolean;
  deliveryIds: readonly string[];
  at: Date;
}

/** Whether an alert is about the game day. */
export function alertIsRelated(
  gameDay: {
    relatedResourceIds: readonly string[];
    watchedProbeIds: readonly string[];
    watchedSloIds: readonly string[];
  },
  alert: Pick<RoutedAlertFacts, "trigger" | "resourceId" | "lifecycleKey">,
): boolean {
  // Any incident declared during a game day is somebody noticing it.
  if (alert.trigger === "incidentAlerts") return true;
  if (alert.resourceId && gameDay.relatedResourceIds.includes(alert.resourceId)) return true;
  const key = alert.lifecycleKey ?? "";
  if (key.startsWith("probe:") && gameDay.watchedProbeIds.includes(key.slice(6))) return true;
  if (key.startsWith("slo:") && gameDay.watchedSloIds.includes(key.slice(4))) return true;
  return false;
}

/** Record a routed alert against every game day in flight in its org. Never throws. */
export async function recordGameDayAlert(alert: RoutedAlertFacts): Promise<void> {
  try {
    const live = await db
      .select({
        id: gameDays.id,
        relatedResourceIds: gameDays.relatedResourceIds,
        watchedProbeIds: gameDays.watchedProbeIds,
        watchedSloIds: gameDays.watchedSloIds,
      })
      .from(gameDays)
      .where(
        and(eq(gameDays.organizationId, alert.organizationId), inArray(gameDays.status, [...RECORDING])),
      );
    if (live.length === 0) return;
    const paged = alert.destinationKinds.some((k) => PAGE_KINDS.has(k));
    await db.insert(gameDayAlerts).values(
      live.map((g) => ({
        id: randomUUID(),
        gameDayId: g.id,
        organizationId: alert.organizationId,
        at: alert.at,
        trigger: alert.trigger,
        severity: alert.severity,
        title: alert.title.slice(0, 500),
        related: alertIsRelated(g, alert),
        paged,
        unrouted: alert.unrouted,
        deliveryIds: [...alert.deliveryIds],
      })),
    );
  } catch (err) {
    console.error("[game-days] recording an alert failed:", err);
  }
}

export interface SamplingGameDay {
  id: string;
  organizationId: string;
  serviceId: string | null;
  injectedAt: Date;
  watchedProbeIds: readonly string[];
  watchedSloIds: readonly string[];
  relatedResourceIds: readonly string[];
}

const isoOf = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

function earliest(values: readonly (Date | null)[]): Date | null {
  let best: Date | null = null;
  for (const v of values) if (v && (!best || v < best)) best = v;
  return best;
}

/** Each detector read separately, so one failing read costs only its own signal. */
async function settle<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`[game-days] reading ${label} failed:`, err);
    return null;
  }
}

/** The detectors' first instants since the inject, as the features recorded them. */
export async function sampleGameDaySignals(g: SamplingGameDay): Promise<Partial<GameDaySignals>> {
  const since = g.injectedAt;
  const out: Partial<GameDaySignals> = {};

  const [probeRows, metricFired, sloAt, incidentAt, alertTimes] = await Promise.all([
    settle("probes", async () =>
      g.watchedProbeIds.length
        ? db
            .select({
              status: syntheticProbes.status,
              consecutiveFailures: syntheticProbes.consecutiveFailures,
              intervalSeconds: syntheticProbes.intervalSeconds,
              lastProbeAt: syntheticProbes.lastProbeAt,
              lastStateChangeAt: syntheticProbes.lastStateChangeAt,
            })
            .from(syntheticProbes)
            .where(
              and(
                eq(syntheticProbes.organizationId, g.organizationId),
                inArray(syntheticProbes.id, [...g.watchedProbeIds]),
              ),
            )
        : [],
    ),
    settle("metric alerts", async () => {
      if (g.relatedResourceIds.length === 0) return null;
      const [row] = await db
        .select({ at: min(metricAlertEvents.firedAt) })
        .from(metricAlertEvents)
        .where(
          and(
            eq(metricAlertEvents.organizationId, g.organizationId),
            gte(metricAlertEvents.firedAt, since),
            inArray(metricAlertEvents.resourceId, [...g.relatedResourceIds]),
          ),
        );
      return row?.at ?? null;
    }),
    settle("SLOs", async () => {
      const linked = g.serviceId
        ? await db
            .select({ id: serviceLinks.targetId })
            .from(serviceLinks)
            .where(and(eq(serviceLinks.serviceId, g.serviceId), eq(serviceLinks.kind, "slo")))
        : [];
      const ids = [...new Set([...g.watchedSloIds, ...linked.map((l) => l.id)])];
      if (ids.length === 0) return null;
      const rows = await db
        .select({ burnAt: slos.burnAlertChangedAt, exhaustedAt: slos.exhaustedAt, burn: slos.burnAlert })
        .from(slos)
        .where(
          and(
            eq(slos.organizationId, g.organizationId),
            inArray(slos.id, ids),
            or(ne(slos.burnAlert, "none"), isNotNull(slos.exhaustedAt)),
          ),
        );
      return earliest(
        rows.flatMap((r) => [
          r.burn !== "none" && r.burnAt && r.burnAt >= since ? r.burnAt : null,
          r.exhaustedAt && r.exhaustedAt >= since ? r.exhaustedAt : null,
        ]),
      );
    }),
    settle("incidents", async () => {
      const [row] = await db
        .select({ at: min(incidents.createdAt) })
        .from(incidents)
        .where(and(eq(incidents.organizationId, g.organizationId), gte(incidents.createdAt, since)));
      return row?.at ?? null;
    }),
    settle("routed alerts", async () =>
      db
        .select({
          at: gameDayAlerts.at,
          paged: gameDayAlerts.paged,
          unrouted: gameDayAlerts.unrouted,
          deliveryIds: gameDayAlerts.deliveryIds,
        })
        .from(gameDayAlerts)
        .where(and(eq(gameDayAlerts.gameDayId, g.id), eq(gameDayAlerts.related, true))),
    ),
  ]);

  for (const p of probeRows ?? []) {
    if (p.consecutiveFailures > 0 && p.lastProbeAt && p.lastProbeAt >= since) {
      // The streak began this many checks before the latest one.
      const first = p.lastProbeAt.getTime() - (p.consecutiveFailures - 1) * p.intervalSeconds * 1000;
      out.probeFailedAt =
        isoOf(earliest([out.probeFailedAt ? new Date(out.probeFailedAt) : null, new Date(Math.max(first, since.getTime()))]));
    }
    if (p.status === "down" && p.lastStateChangeAt && p.lastStateChangeAt >= since) {
      out.probeDownAt = isoOf(
        earliest([out.probeDownAt ? new Date(out.probeDownAt) : null, p.lastStateChangeAt]),
      );
      // A probe that went down also failed, whenever the streak started.
      out.probeFailedAt ??= isoOf(p.lastStateChangeAt);
    }
  }
  if (metricFired) out.metricAlertAt = isoOf(metricFired);
  if (sloAt) out.sloBurnAt = isoOf(sloAt);
  if (incidentAt) out.incidentDeclaredAt = isoOf(incidentAt);

  const routed = alertTimes ?? [];
  out.alertedAt = isoOf(earliest(routed.filter((a) => !a.unrouted).map((a) => a.at)));
  out.pagedAt = isoOf(earliest(routed.filter((a) => a.paged).map((a) => a.at)));
  const deliveryIds = [...new Set(routed.flatMap((a) => a.deliveryIds))];
  if (deliveryIds.length) {
    const acked = await settle("acknowledgements", async () => {
      const [row] = await db
        .select({ at: min(alertDeliveries.acknowledgedAt) })
        .from(alertDeliveries)
        .where(
          and(
            inArray(alertDeliveries.id, deliveryIds),
            eq(alertDeliveries.organizationId, g.organizationId),
          ),
        );
      return row?.at ?? null;
    });
    if (acked) out.acknowledgedAt = isoOf(acked);
  }
  // Drop the nulls: a merge only ever sets a signal, it never clears one.
  for (const key of Object.keys(out) as (keyof GameDaySignals)[]) {
    if (out[key] === null) delete out[key];
  }
  return out;
}

/**
 * Whether every watched probe has been checked green since `undoneAt`, and
 * when the last of them came back. Null while any is still failing or has not
 * been checked since.
 */
export async function watchedProbesRecovered(
  organizationId: string,
  probeIds: readonly string[],
  undoneAt: Date,
): Promise<Date | null> {
  const rows = await db
    .select({
      status: syntheticProbes.status,
      consecutiveFailures: syntheticProbes.consecutiveFailures,
      lastProbeAt: syntheticProbes.lastProbeAt,
      lastStateChangeAt: syntheticProbes.lastStateChangeAt,
      enabled: syntheticProbes.enabled,
    })
    .from(syntheticProbes)
    .where(
      and(eq(syntheticProbes.organizationId, organizationId), inArray(syntheticProbes.id, [...probeIds])),
    );
  // A deleted or paused probe cannot confirm anything, so it does not hold recovery up.
  const live = rows.filter((r) => r.enabled);
  let recoveredAt = undoneAt;
  for (const r of live) {
    if (r.status === "down" || r.consecutiveFailures > 0) return null;
    if (!r.lastProbeAt || r.lastProbeAt < undoneAt) return null;
    if (r.lastStateChangeAt && r.lastStateChangeAt > recoveredAt) recoveredAt = r.lastStateChangeAt;
  }
  return recoveredAt;
}
