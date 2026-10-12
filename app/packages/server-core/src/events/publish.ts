/**
 * `publishEvent`: the one call a raise site makes to hand an event to the
 * org's event subscriptions.
 *
 * It does no network I/O. It builds the envelope, picks the matching enabled
 * subscriptions, and inserts one outbox row per subscription in
 * `event_deliveries`; the poller's `event-deliveries` pass sends them. That
 * makes it cheap enough to call from a web request on the edge and safe to
 * call from a poller pass that holds a claim: nothing here waits on a
 * customer's receiver.
 *
 * It never throws. An event subscription is a copy of something that already
 * happened (the alert was routed, the incident declared); failing to queue the
 * copy must never undo or fail the original. Call it as
 * `void keepAlive(publishEvent(...))` from request paths.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  eventMatchesFilters,
  isAlertSeverity,
  type AlertSeverity,
  type EventData,
  type EventTypeDef,
  type InfrawrenchEvent,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { eventDeliveries, eventSubscriptions, resources } from "../db/schema";

export interface PublishEventMeta {
  /** One line for a human. */
  title: string;
  /** Defaults to the type's `defaultSeverity`. */
  severity?: AlertSeverity | undefined;
  accountId?: string | null | undefined;
  /** See `resourceEnvironment` for the usual way to get one. */
  environment?: string | null | undefined;
  url?: string | null | undefined;
  /**
   * Makes a re-run of the raise site a no-op per subscription (a retried
   * announcement, a re-scanned window). Omit for events that cannot repeat.
   */
  idempotencyKey?: string | undefined;
  /** Defaults to now. */
  occurredAt?: Date | undefined;
  /**
   * A cost event about a user-scoped (private) object. Never emitted: a
   * subscription is org configuration and would carry one member's private
   * spend to everyone who reads the receiver.
   */
  privateCostObject?: boolean | undefined;
}

export function newEventId(): string {
  return `evt_${randomUUID().replace(/-/g, "")}`;
}

export function buildEnvelope<D extends EventTypeDef>(
  def: D,
  organizationId: string,
  data: EventData<D>,
  meta: PublishEventMeta,
  opts: { test?: boolean; id?: string } = {},
): InfrawrenchEvent {
  return {
    id: opts.id ?? newEventId(),
    type: def.type,
    version: def.version,
    createdAt: (meta.occurredAt ?? new Date()).toISOString(),
    organizationId,
    severity: meta.severity && isAlertSeverity(meta.severity) ? meta.severity : def.defaultSeverity,
    accountId: meta.accountId ?? null,
    environment: meta.environment?.trim() || null,
    title: meta.title,
    url: meta.url ?? null,
    test: opts.test ?? false,
    data: data as Record<string, unknown>,
  };
}

/**
 * Queue `data` for every enabled subscription in the org whose filters match.
 * Returns how many deliveries were queued (0 on any error, which is logged).
 */
export async function publishEvent<D extends EventTypeDef>(
  def: D,
  organizationId: string,
  data: EventData<D>,
  meta: PublishEventMeta,
): Promise<number> {
  try {
    if (def.carriesCost && meta.privateCostObject) return 0;
    const subs = await db
      .select({
        id: eventSubscriptions.id,
        eventTypes: eventSubscriptions.eventTypes,
        minSeverity: eventSubscriptions.minSeverity,
        accountIds: eventSubscriptions.accountIds,
        environments: eventSubscriptions.environments,
      })
      .from(eventSubscriptions)
      .where(
        and(
          eq(eventSubscriptions.organizationId, organizationId),
          eq(eventSubscriptions.enabled, true),
        ),
      );
    if (subs.length === 0) return 0;

    const envelope = buildEnvelope(def, organizationId, data, meta);
    const matching = subs.filter((s) =>
      eventMatchesFilters(
        {
          eventTypes: s.eventTypes,
          minSeverity: isAlertSeverity(s.minSeverity) ? s.minSeverity : null,
          accountIds: s.accountIds,
          environments: s.environments,
        },
        envelope,
      ),
    );
    if (matching.length === 0) return 0;

    const now = new Date();
    const inserted = await db
      .insert(eventDeliveries)
      .values(
        matching.map((s) => ({
          id: randomUUID(),
          organizationId,
          subscriptionId: s.id,
          eventId: envelope.id,
          eventType: envelope.type,
          idempotencyKey: meta.idempotencyKey ?? null,
          payload: envelope as unknown as Record<string, unknown>,
          state: "pending",
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: eventDeliveries.id });
    return inserted.length;
  } catch (err) {
    console.error(`[events] queueing ${def.type} for org ${organizationId} failed:`, err);
    return 0;
  }
}

const ENV_TAG_KEYS = ["env", "environment", "stage"];

/** Pick the environment out of a resource's tag/label map, if it has one. */
export function environmentFromFields(
  fields: Record<string, unknown> | null | undefined,
): string | null {
  if (!fields) return null;
  for (const bag of [fields["tags"], fields["labels"]]) {
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
    for (const [k, v] of Object.entries(bag as Record<string, unknown>)) {
      if (ENV_TAG_KEYS.includes(k.toLowerCase()) && typeof v === "string" && v.trim()) {
        return v.trim();
      }
    }
  }
  return null;
}

/**
 * The environment an event about this resource belongs to: its
 * `env`/`environment`/`stage` tag or label. Null when it has none, which an
 * environment-filtered subscription never matches.
 */
export async function resourceEnvironment(
  organizationId: string,
  resourceId: string,
): Promise<string | null> {
  try {
    const rows = await db.execute(
      sql`SELECT fields_json AS fields FROM resources
          WHERE id = ${resourceId} AND organization_id = ${organizationId} LIMIT 1`,
    );
    const [row] = Array.from(rows as Iterable<{ fields: Record<string, unknown> | null }>);
    return environmentFromFields(row?.fields);
  } catch {
    return null;
  }
}

/** {@link resourceEnvironment} for many resources in one query. */
export async function resourceEnvironments(
  organizationId: string,
  resourceIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (resourceIds.length === 0) return out;
  try {
    const rows = await db
      .select({ id: resources.id, fields: resources.fieldsJson })
      .from(resources)
      .where(and(eq(resources.organizationId, organizationId), inArray(resources.id, resourceIds)));
    for (const r of rows) {
      const env = environmentFromFields(r.fields);
      if (env) out.set(r.id, env);
    }
  } catch (err) {
    console.error(`[events] reading resource environments for org ${organizationId} failed:`, err);
  }
  return out;
}

/** Distinct environment values across the org's resources, for the filter picker. */
export async function listOrgEnvironments(organizationId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT trim(kv.value) AS env
      FROM resources r,
           LATERAL (
             SELECT key, value FROM jsonb_each_text(
               CASE WHEN jsonb_typeof(r.fields_json->'tags') = 'object' THEN r.fields_json->'tags' ELSE '{}'::jsonb END)
             UNION ALL
             SELECT key, value FROM jsonb_each_text(
               CASE WHEN jsonb_typeof(r.fields_json->'labels') = 'object' THEN r.fields_json->'labels' ELSE '{}'::jsonb END)
           ) kv
     WHERE r.organization_id = ${organizationId}
       AND r.deleted_at IS NULL
       AND lower(kv.key) IN ('env', 'environment', 'stage')
       AND trim(kv.value) <> ''
     ORDER BY 1
     LIMIT 200`);
  return Array.from(rows as Iterable<{ env: string }>, (r) => r.env);
}
