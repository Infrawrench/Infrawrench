/**
 * Metric threshold alert evaluation — the pipeline half. The window judgement
 * lives in `window.ts` (pure, unit-tested); this module resolves the rule's
 * selector, reads the per-minute samples from ClickHouse, opens/resolves
 * firing events, and fans out through the existing notification transports
 * under the `metricAlerts` trigger.
 *
 * Dedupe and cooldown follow the house conventions:
 *
 * - The partial unique index on `metric_alert_events` (ruleId, resourceId
 *   WHERE status = 'firing') is the *open* claim, exactly like
 *   `paging_incidents_open_unique`: the replica whose `onConflictDoNothing`
 *   insert lands owns the incident and its notification, so N replicas
 *   evaluating the same rule produce one firing.
 * - The resolve is a conditional UPDATE (`… WHERE status = 'firing'
 *   RETURNING`), so only the replica whose statement actually flipped the row
 *   sends the recovery notification.
 * - The rule's `cooldownMinutes` is the flap suppressor, in the anomaly
 *   cooldown's shape: a fresh firing whose (rule, resource) pair was
 *   *notified* within the window is still recorded (the list UI shows it) but
 *   not notified — and its recovery stays quiet too, because recoveries only
 *   ever follow a notified firing (same dedupe key, both directions).
 *
 * Errors are logged, never thrown — evaluation must not break the poller's
 * pass (the `budget-eval.ts` stance).
 */
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/client";
import { metricAlertEvents, metricAlertRules } from "../db/schema";
import { getMetricMinuteSeriesBatch } from "../clickhouse/readers";
import { sendPushToOrg } from "../push/dispatch";
import { sendSlackToOrg } from "../slack";
import { sendMsTeamsToOrg } from "../msteams";
import { resolveSelectorResources, type SelectedResource } from "./selector";
import { judgeWindow, type MetricComparator, type WindowSample } from "./window";

export type MetricAlertRuleRow = typeof metricAlertRules.$inferSelect;

/** Deep link to the metric alerts page, for the Slack/Teams message button. */
function metricAlertsUrl(organizationId: string): string | null {
  const base = process.env["APP_URL"];
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/org/${organizationId}/metric-alerts`;
}

/** `93.42` → `"93.42"`, `93` → `"93"` — no trailing zero noise in alert text. */
function formatValue(value: number): string {
  return Number(value.toFixed(2)).toString();
}

interface OpenEventRow {
  id: string;
  resourceId: string;
  resourceName: string;
  notifiedAt: Date | null;
}

/**
 * True when a firing for this (rule, resource) was *notified* within the
 * rule's cooldown. Unnotified rows are ignored on purpose, the anomaly-eval
 * stance: a firing nobody received must not suppress the alert that would
 * have told them.
 */
async function inCooldown(
  rule: MetricAlertRuleRow,
  resourceId: string,
  now: Date,
): Promise<boolean> {
  if (rule.cooldownMinutes <= 0) return false;
  const since = new Date(now.getTime() - rule.cooldownMinutes * 60_000);
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(metricAlertEvents)
    .where(
      and(
        eq(metricAlertEvents.ruleId, rule.id),
        eq(metricAlertEvents.resourceId, resourceId),
        isNotNull(metricAlertEvents.notifiedAt),
        gte(metricAlertEvents.notifiedAt, since),
      ),
    );
  return Number(rows[0]?.n ?? 0) > 0;
}

async function notifyFiring(
  rule: MetricAlertRuleRow,
  resource: SelectedResource,
  observed: number,
  eventId: string,
): Promise<void> {
  const title = `Metric alert "${rule.name}": ${resource.displayName}`;
  const body =
    `infrawrench metric alert "${rule.name}": ${rule.metricKey} on ` +
    `"${resource.displayName}" is ${formatValue(observed)} (${rule.comparator} ${formatValue(rule.threshold)} ` +
    `for ${rule.forMinutes} minutes)`;
  const context = `${rule.metricKey} ${rule.comparator} ${formatValue(rule.threshold)} · firing`;

  const pushed = await sendPushToOrg(rule.organizationId, "metricAlerts", {
    title,
    body,
    data: {
      type: "metric_alert",
      orgId: rule.organizationId,
      ruleId: rule.id,
      resourceId: resource.id,
      status: "firing",
    },
  });
  const url = metricAlertsUrl(rule.organizationId);
  const slacked = await sendSlackToOrg(rule.organizationId, "metricAlerts", {
    title,
    body,
    context,
    ...(url ? { url } : {}),
  });
  const teamed = await sendMsTeamsToOrg(rule.organizationId, "metricAlerts", {
    title,
    body,
    context,
    ...(url ? { url } : {}),
  });
  if (pushed.succeeded > 0 || slacked.succeeded > 0 || teamed.succeeded > 0) {
    await db
      .update(metricAlertEvents)
      .set({ notifiedAt: new Date() })
      .where(eq(metricAlertEvents.id, eventId));
  }
}

async function notifyResolved(rule: MetricAlertRuleRow, event: OpenEventRow): Promise<void> {
  const title = `Resolved: "${rule.name}" on ${event.resourceName}`;
  const body =
    `infrawrench metric alert "${rule.name}" resolved: ${rule.metricKey} on ` +
    `"${event.resourceName}" is back within threshold (was ${rule.comparator} ${formatValue(rule.threshold)})`;
  const context = `${rule.metricKey} ${rule.comparator} ${formatValue(rule.threshold)} · resolved`;

  const pushed = await sendPushToOrg(rule.organizationId, "metricAlerts", {
    title,
    body,
    data: {
      type: "metric_alert",
      orgId: rule.organizationId,
      ruleId: rule.id,
      resourceId: event.resourceId,
      status: "resolved",
    },
  });
  const url = metricAlertsUrl(rule.organizationId);
  const slacked = await sendSlackToOrg(rule.organizationId, "metricAlerts", {
    title,
    body,
    context,
    ...(url ? { url } : {}),
  });
  const teamed = await sendMsTeamsToOrg(rule.organizationId, "metricAlerts", {
    title,
    body,
    context,
    ...(url ? { url } : {}),
  });
  if (pushed.succeeded > 0 || slacked.succeeded > 0 || teamed.succeeded > 0) {
    await db
      .update(metricAlertEvents)
      .set({ resolvedNotifiedAt: new Date() })
      .where(eq(metricAlertEvents.id, event.id));
  }
}

/** Open a fresh firing for (rule, resource). Notifies unless in cooldown. */
async function openFiring(
  rule: MetricAlertRuleRow,
  resource: SelectedResource,
  observed: number,
  now: Date,
): Promise<void> {
  // The insert is the claim: the partial unique index on (ruleId, resourceId)
  // WHERE status = 'firing' means at most one replica's insert lands while an
  // incident is open, and only that replica notifies.
  const [inserted] = await db
    .insert(metricAlertEvents)
    .values({
      id: randomUUID(),
      ruleId: rule.id,
      organizationId: rule.organizationId,
      resourceId: resource.id,
      resourceName: resource.displayName,
      status: "firing",
      observedValue: observed,
      firedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: metricAlertEvents.id });
  if (!inserted) return; // already open (or another replica won the claim)

  if (await inCooldown(rule, resource.id, now)) return; // recorded, not notified
  await notifyFiring(rule, resource, observed, inserted.id);
}

/**
 * Flip an open firing to resolved and send the recovery notification. The
 * conditional UPDATE is the claim; a recovery is only sent when the firing
 * itself was notified (same dedupe key in both directions).
 */
async function resolveFiring(rule: MetricAlertRuleRow, event: OpenEventRow): Promise<void> {
  const [resolved] = await db
    .update(metricAlertEvents)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(and(eq(metricAlertEvents.id, event.id), eq(metricAlertEvents.status, "firing")))
    .returning({ id: metricAlertEvents.id });
  if (!resolved) return; // another replica resolved it

  if (event.notifiedAt) await notifyResolved(rule, event);
}

/**
 * Evaluate one rule: resolve the selector, judge every matched resource's
 * trailing window, open fresh firings, resolve cleared ones. Never throws.
 */
export async function evaluateMetricAlertRule(
  rule: MetricAlertRuleRow,
  now = new Date(),
): Promise<void> {
  try {
    const selected = await resolveSelectorResources(rule);
    const openEvents: OpenEventRow[] = await db
      .select({
        id: metricAlertEvents.id,
        resourceId: metricAlertEvents.resourceId,
        resourceName: metricAlertEvents.resourceName,
        notifiedAt: metricAlertEvents.notifiedAt,
      })
      .from(metricAlertEvents)
      .where(and(eq(metricAlertEvents.ruleId, rule.id), eq(metricAlertEvents.status, "firing")))
      .orderBy(desc(metricAlertEvents.firedAt));

    // One ClickHouse read covers everything this rule needs: the selected
    // resources plus any open incidents whose resource has left the selector
    // (those still need a verdict so they can resolve).
    const selectedIds = new Set(selected.map((r) => r.id));
    const allIds = [...new Set([...selectedIds, ...openEvents.map((e) => e.resourceId)])];
    const windowMs = rule.forMinutes * 60_000;
    const samplesByResource = await getMetricMinuteSeriesBatch(
      rule.organizationId,
      allIds,
      rule.metricKey,
      now.getTime() - windowMs,
      now.getTime(),
    );

    const judge = (resourceId: string) =>
      judgeWindow((samplesByResource.get(resourceId) ?? []) as WindowSample[], {
        comparator: rule.comparator as MetricComparator,
        threshold: rule.threshold,
        windowMs,
        nowMs: now.getTime(),
      });

    const openByResource = new Map(openEvents.map((e) => [e.resourceId, e]));
    for (const resource of selected) {
      try {
        if (openByResource.has(resource.id)) continue; // handled below
        const verdict = judge(resource.id);
        if (verdict.state === "breaching") {
          await openFiring(rule, resource, verdict.observed, now);
        }
      } catch (err) {
        console.error(
          `[metric-alerts] rule ${rule.id} resource ${resource.id} evaluation failed:`,
          err,
        );
      }
    }

    for (const event of openEvents) {
      try {
        // A resource that left the selector (deleted, re-tagged, re-typed) is
        // no longer covered by the rule — resolve rather than firing forever.
        if (!selectedIds.has(event.resourceId)) {
          await resolveFiring(rule, event);
          continue;
        }
        const verdict = judge(event.resourceId);
        // `no_data` clears too: the resource stopped reporting the series, and
        // an incident that can never observe recovery would be stuck open.
        // `insufficient` keeps it open — sparse-but-breaching is not recovery.
        if (verdict.state === "cleared" || verdict.state === "no_data") {
          await resolveFiring(rule, event);
        }
      } catch (err) {
        console.error(`[metric-alerts] rule ${rule.id} event ${event.id} resolve failed:`, err);
      }
    }
  } catch (err) {
    console.error(`[metric-alerts] rule ${rule.id} evaluation failed:`, err);
  }
}
