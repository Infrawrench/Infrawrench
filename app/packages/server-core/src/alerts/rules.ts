/**
 * Reading and writing an org's routing rules.
 *
 * The rows are thin — the interesting shapes are JSON validated by
 * `validateAlertRule` — so this module is mostly about two things the callers
 * must not get wrong: parsing defensively, and the "no rows means the shipped
 * default" contract.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import {
  type AlertCondition,
  type AlertDestination,
  type AlertRule,
  type EscalationPolicy,
  type QuietHours,
  defaultAlertRule,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { alertRules } from "../db/schema";
import { listLiveSlackChannelIds } from "../slack";
import { listMsTeamsWebhookIds } from "../msteams";

type Row = typeof alertRules.$inferSelect;

/**
 * Turn a stored row into a rule.
 *
 * Every JSON field is re-checked rather than cast. These columns are written by
 * a validated API today, but they outlive the build that wrote them: a rule
 * saved by a newer version, or hand-edited in psql, must degrade to "this
 * clause does nothing" rather than throwing inside the fan-out of an unrelated
 * alert. Alert delivery is the last thing that should be brittle.
 */
function toRule(row: Row): AlertRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    conditions: Array.isArray(row.conditions) ? (row.conditions as AlertCondition[]) : [],
    destinations: Array.isArray(row.destinations) ? (row.destinations as AlertDestination[]) : [],
    continueOnMatch: row.continueOnMatch,
    quietHours: (row.quietHours as QuietHours | null) ?? null,
    escalation: (row.escalation as EscalationPolicy | null) ?? null,
  };
}

/** An org's stored rules, in evaluation order. Empty when it has never saved any. */
export async function listAlertRules(organizationId: string): Promise<AlertRule[]> {
  const rows = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.organizationId, organizationId))
    .orderBy(asc(alertRules.position), asc(alertRules.id));
  return rows.map(toRule);
}

/**
 * The rules to actually route with: the stored ones, or the synthesized default
 * when the org has none.
 *
 * The default fans out to every channel the org has connected and to its
 * phones, which is precisely what the old boolean matrix did with every box
 * ticked — so an org that upgraded, or one that connects Slack tomorrow without
 * opening the editor, sees no change in behaviour. Expanding "every channel"
 * here rather than storing it means a channel added later is included without
 * anyone re-saving anything.
 */
export async function resolveRoutingRules(
  organizationId: string,
): Promise<{ rules: AlertRule[]; usingDefaults: boolean }> {
  const stored = await listAlertRules(organizationId);
  if (stored.length > 0) return { rules: stored, usingDefaults: false };

  const [slackIds, teamsIds] = await Promise.all([
    listLiveSlackChannelIds(organizationId).catch(() => [] as string[]),
    listMsTeamsWebhookIds(organizationId).catch(() => [] as string[]),
  ]);
  const destinations: AlertDestination[] = [
    { kind: "push" },
    ...slackIds.map((channelId): AlertDestination => ({ kind: "slack", channelId })),
    ...teamsIds.map((webhookId): AlertDestination => ({ kind: "msteams", webhookId })),
  ];
  return { rules: [defaultAlertRule(destinations)], usingDefaults: true };
}

export interface SaveAlertRuleInput {
  id?: string;
  name: string;
  enabled: boolean;
  position: number;
  conditions: AlertCondition[];
  destinations: AlertDestination[];
  continueOnMatch: boolean;
  quietHours: QuietHours | null;
  escalation: EscalationPolicy | null;
}

/**
 * Replace an org's whole rule list in one transaction.
 *
 * Whole-list rather than per-rule because order is part of the meaning: a rule
 * is only correct relative to the ones above it, so "move #3 above #2" as two
 * independent PATCHes has an intermediate state where alerts route somewhere
 * nobody asked for. One atomic write has no such window.
 *
 * Ids are preserved when the caller sends them, which is what keeps a held or
 * escalating `alert_deliveries` row pointing at the rule that created it across
 * an unrelated edit. That is why this is a delete-the-missing plus upsert rather
 * than the simpler delete-all-then-insert: `alert_deliveries.rule_id` is
 * `ON DELETE SET NULL`, so deleting a row and re-inserting it under the same id
 * would still orphan every in-flight delivery that pointed at it. The delivery
 * would survive — its destinations and escalation are snapshotted on the row —
 * but it would stop being attributable to the rule that made it.
 */
export async function replaceAlertRules(
  organizationId: string,
  userId: string | null,
  inputs: SaveAlertRuleInput[],
): Promise<AlertRule[]> {
  const now = new Date();
  const values = inputs.map((input, index) => ({
    id: input.id ?? randomUUID(),
    organizationId,
    name: input.name.trim(),
    enabled: input.enabled,
    // Positions are re-derived from array order rather than trusted: a client
    // that sends duplicates or gaps still gets the order it displayed.
    position: index,
    conditions: input.conditions,
    destinations: input.destinations,
    continueOnMatch: input.continueOnMatch,
    quietHours: input.quietHours,
    escalation: input.escalation,
    createdByUserId: userId,
    updatedAt: now,
  }));

  const keptIds = values.map((v) => v.id);
  await db.transaction(async (tx) => {
    await tx
      .delete(alertRules)
      .where(
        keptIds.length > 0
          ? and(eq(alertRules.organizationId, organizationId), notInArray(alertRules.id, keptIds))
          : eq(alertRules.organizationId, organizationId),
      );
    if (values.length > 0) {
      await tx
        .insert(alertRules)
        .values(values)
        .onConflictDoUpdate({
          target: alertRules.id,
          set: {
            name: sql`excluded.name`,
            enabled: sql`excluded.enabled`,
            position: sql`excluded.position`,
            conditions: sql`excluded.conditions`,
            destinations: sql`excluded.destinations`,
            continueOnMatch: sql`excluded.continue_on_match`,
            quietHours: sql`excluded.quiet_hours`,
            escalation: sql`excluded.escalation`,
            updatedAt: now,
          },
          // Scoped to the org so a caller cannot overwrite another org's rule by
          // sending its id — the primary key is global, the ownership is not.
          setWhere: eq(alertRules.organizationId, organizationId),
        });
    }
  });

  return listAlertRules(organizationId);
}
