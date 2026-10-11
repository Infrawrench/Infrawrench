/**
 * Event subscription storage: CRUD, signing secrets, destination pickers and
 * the delivery log reads. The send path is `deliver.ts`; the raise-site entry
 * point is `publish.ts`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  EVENT_SECRET_PREFIX,
  EVENT_SECRET_ROLLOVER_MS,
  EVENT_SUBSCRIPTION_LIMITS,
  filtersIncludeCostEvents,
  isAlertSeverity,
  validateEventSubscriptionInput,
  type EventDelivery,
  type EventDeliveryState,
  type EventDestination,
  type EventSubscription,
  type EventSubscriptionInput,
  type InfrawrenchEvent,
} from "@infrawrench/client-core";

import { db } from "../db/client";
import { accounts, eventDeliveries, eventSubscriptions, resources } from "../db/schema";
import { buildAad, decrypt, encrypt } from "../encryption";
import { loadPlugins } from "../plugin-loader";
import { EgressBlockedError, resolveDialAddress } from "../egress-guard";
import { isEdgeRuntime } from "../runtime/gateway-only";

export type SubscriptionRow = typeof eventSubscriptions.$inferSelect;
export type DeliveryRow = typeof eventDeliveries.$inferSelect;

/** A refusal whose message is written for the user. */
export class EventSubscriptionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "EventSubscriptionError";
  }
}

export interface EventSubscriptionCaller {
  userId: string | null;
  /** Holds `costs:read`; required to receive spend-carrying events. */
  canReadCosts: boolean;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toSubscription(row: SubscriptionRow): EventSubscription {
  const destination: EventDestination =
    row.destinationKind === "publish"
      ? {
          kind: "publish",
          accountId: row.publishAccountId ?? "",
          resourceTypeId: row.publishResourceTypeId ?? "",
          resourceId: row.publishResourceId ?? "",
        }
      : { kind: "webhook", url: row.url ?? "" };
  const now = Date.now();
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    destination,
    destinationLabel: row.destinationLabel,
    eventTypes: row.eventTypes,
    minSeverity: isAlertSeverity(row.minSeverity) ? row.minSeverity : null,
    accountIds: row.accountIds,
    environments: row.environments,
    secretHint: row.secretHint,
    previousSecretExpiresAt:
      row.previousSecretExpiresAt && row.previousSecretExpiresAt.getTime() > now
        ? row.previousSecretExpiresAt.toISOString()
        : null,
    disabledReason: row.disabledReason,
    disabledAt: iso(row.disabledAt),
    consecutiveFailures: row.consecutiveFailures,
    failingSince: iso(row.failingSince),
    lastSuccessAt: iso(row.lastSuccessAt),
    lastFailureAt: iso(row.lastFailureAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDelivery(row: DeliveryRow): EventDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    eventId: row.eventId,
    eventType: row.eventType,
    state: row.state as EventDeliveryState,
    attemptCount: row.attemptCount,
    nextAttemptAt:
      row.state === "pending" || row.state === "retrying" ? iso(row.nextAttemptAt) : null,
    lastAttemptAt: iso(row.lastAttemptAt),
    deliveredAt: iso(row.deliveredAt),
    responseStatus: row.responseStatus,
    responseExcerpt: row.responseExcerpt,
    error: row.error,
    test: row.isTest,
    redeliveryOf: row.redeliveryOf,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    payload: row.payload as unknown as InfrawrenchEvent,
  };
}

// --- Secrets ---

function newSecret(): string {
  return EVENT_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

function secretAad(id: string): string {
  return buildAad("event-subscription", id, "secret");
}

async function encryptSecret(id: string, secret: string) {
  const enc = await encrypt(secret, secretAad(id));
  return { encryptedSecret: enc.ciphertext, secretIv: enc.iv, secretHint: secret.slice(-4) };
}

/** Every secret currently signing for this subscription, newest first. */
export async function activeSecrets(row: SubscriptionRow, now = new Date()): Promise<string[]> {
  const out: string[] = [];
  if (row.encryptedSecret && row.secretIv) {
    out.push(await decrypt(row.encryptedSecret, row.secretIv, secretAad(row.id)));
  }
  if (
    row.previousEncryptedSecret &&
    row.previousSecretIv &&
    row.previousSecretExpiresAt &&
    row.previousSecretExpiresAt > now
  ) {
    out.push(await decrypt(row.previousEncryptedSecret, row.previousSecretIv, secretAad(row.id)));
  }
  return out;
}

// --- Destinations ---

export interface EventSinkOption {
  accountId: string;
  accountName: string;
  pluginId: string;
  pluginName: string;
  resourceTypeId: string;
  resourceTypeName: string;
  resourceId: string;
  resourceName: string;
}

/** Resource types any plugin flags `eventSink`, keyed `pluginId/typeId`. */
async function sinkTypes(): Promise<
  Map<string, { pluginName: string; typeName: string; pluginId: string; typeId: string }>
> {
  const out = new Map<
    string,
    { pluginName: string; typeName: string; pluginId: string; typeId: string }
  >();
  for (const { plugin } of await loadPlugins()) {
    for (const rt of plugin.resourceTypes) {
      if (!rt.eventSink) continue;
      out.set(`${plugin.manifest.id}/${rt.id}`, {
        pluginId: plugin.manifest.id,
        pluginName: plugin.manifest.displayName,
        typeId: rt.id,
        typeName: rt.displayName,
      });
    }
  }
  return out;
}

/**
 * Every resource in the org's connected accounts that can receive events: the
 * publish destination picker. Read from the synced inventory, so a topic
 * created a minute ago appears after the next sync.
 */
export async function listEventSinkOptions(organizationId: string): Promise<EventSinkOption[]> {
  const types = await sinkTypes();
  if (types.size === 0) return [];
  const typeIds = [...new Set([...types.values()].map((t) => t.typeId))];
  const rows = await db
    .select({
      resourceId: resources.id,
      resourceName: resources.displayName,
      resourceTypeId: resources.resourceTypeId,
      pluginId: resources.pluginId,
      accountId: accounts.id,
      accountName: accounts.displayName,
    })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(
      and(
        eq(resources.organizationId, organizationId),
        inArray(resources.resourceTypeId, typeIds),
        isNull(resources.deletedAt),
        isNull(accounts.deletedAt),
      ),
    )
    .orderBy(accounts.displayName, resources.displayName)
    .limit(1000);
  const out: EventSinkOption[] = [];
  for (const r of rows) {
    const t = types.get(`${r.pluginId}/${r.resourceTypeId}`);
    if (!t) continue;
    out.push({
      ...r,
      pluginName: t.pluginName,
      resourceTypeName: t.typeName,
    });
  }
  return out;
}

/** Check a destination and return its display label, or throw a user-facing error. */
async function resolveDestination(
  organizationId: string,
  destination: EventDestination,
): Promise<string> {
  if (destination.kind === "webhook") {
    const url = new URL(destination.url);
    // The send path is guarded too (every attempt runs in the org's egress
    // scope); this only turns an obviously internal URL into a form error
    // instead of a delivery log full of refusals. The edge has no DNS of its
    // own to ask, and its fetch cannot reach private space anyway.
    if (!isEdgeRuntime()) {
      try {
        await resolveDialAddress(url.hostname, Number(url.port) || 443, {
          scope: { organizationId },
          label: "Webhook host",
        });
      } catch (err) {
        if (err instanceof EgressBlockedError) throw new EventSubscriptionError(err.message);
        throw new EventSubscriptionError(`Could not resolve ${url.hostname}.`);
      }
    }
    return url.host;
  }
  const [row] = await db
    .select({
      resourceName: resources.displayName,
      resourceTypeId: resources.resourceTypeId,
      pluginId: resources.pluginId,
      accountName: accounts.displayName,
    })
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(
      and(
        eq(resources.id, destination.resourceId),
        eq(resources.accountId, destination.accountId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (!row || row.resourceTypeId !== destination.resourceTypeId) {
    throw new EventSubscriptionError(
      "That resource is not in one of this organization's accounts.",
    );
  }
  const t = (await sinkTypes()).get(`${row.pluginId}/${row.resourceTypeId}`);
  if (!t) throw new EventSubscriptionError("That resource type cannot receive events.");
  return `${t.pluginName} · ${row.accountName} · ${t.typeName} ${row.resourceName}`;
}

function destinationColumns(destination: EventDestination) {
  return destination.kind === "webhook"
    ? {
        destinationKind: "webhook",
        url: destination.url.trim(),
        publishAccountId: null,
        publishResourceTypeId: null,
        publishResourceId: null,
      }
    : {
        destinationKind: "publish",
        url: null,
        publishAccountId: destination.accountId,
        publishResourceTypeId: destination.resourceTypeId,
        publishResourceId: destination.resourceId,
      };
}

function normalizeInput(input: EventSubscriptionInput): EventSubscriptionInput {
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return {
    ...input,
    name: input.name.trim(),
    eventTypes: uniq(input.eventTypes),
    accountIds: uniq(input.accountIds),
    environments: uniq(input.environments),
  };
}

async function checkInput(
  organizationId: string,
  input: EventSubscriptionInput,
  caller: EventSubscriptionCaller,
): Promise<string> {
  const problem = validateEventSubscriptionInput(input);
  if (problem) throw new EventSubscriptionError(problem);
  if (!caller.canReadCosts && filtersIncludeCostEvents(input)) {
    throw new EventSubscriptionError(
      "Cost events carry spend, so receiving them needs the costs:read permission. Pick event types that exclude cost events, or ask someone who can read costs.",
      403,
    );
  }
  if (input.accountIds.length > 0) {
    const found = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(eq(accounts.organizationId, organizationId), inArray(accounts.id, input.accountIds)),
      );
    if (found.length !== input.accountIds.length) {
      throw new EventSubscriptionError("One of the filtered accounts is not in this organization.");
    }
  }
  return resolveDestination(organizationId, input.destination);
}

// --- CRUD ---

export async function listEventSubscriptions(organizationId: string): Promise<EventSubscription[]> {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(eq(eventSubscriptions.organizationId, organizationId))
    .orderBy(eventSubscriptions.createdAt);
  return rows.map(toSubscription);
}

export async function getSubscriptionRow(
  organizationId: string,
  id: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(eventSubscriptions)
    .where(
      and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.organizationId, organizationId)),
    )
    .limit(1);
  return row ?? null;
}

export async function createEventSubscription(
  organizationId: string,
  rawInput: EventSubscriptionInput,
  caller: EventSubscriptionCaller,
): Promise<{ subscription: EventSubscription; secret: string | null }> {
  const input = normalizeInput(rawInput);
  const label = await checkInput(organizationId, input, caller);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(eventSubscriptions)
    .where(eq(eventSubscriptions.organizationId, organizationId));
  if (n >= EVENT_SUBSCRIPTION_LIMITS.maxPerOrg) {
    throw new EventSubscriptionError(
      `An organization can have at most ${EVENT_SUBSCRIPTION_LIMITS.maxPerOrg} event subscriptions.`,
      409,
    );
  }
  const id = randomUUID();
  const secret = input.destination.kind === "webhook" ? newSecret() : null;
  const now = new Date();
  const [row] = await db
    .insert(eventSubscriptions)
    .values({
      id,
      organizationId,
      name: input.name,
      enabled: input.enabled,
      ...destinationColumns(input.destination),
      destinationLabel: label,
      ...(secret ? await encryptSecret(id, secret) : {}),
      eventTypes: input.eventTypes,
      minSeverity: input.minSeverity,
      accountIds: input.accountIds,
      environments: input.environments,
      createdByUserId: caller.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { subscription: toSubscription(row!), secret };
}

/**
 * Whole-object update. Switching between webhook and publish is refused (the
 * secret's lifecycle belongs to the kind); delete and recreate instead.
 * Re-enabling a subscription that was turned off automatically clears its
 * failure history, so it gets a fresh three days.
 */
export async function updateEventSubscription(
  organizationId: string,
  id: string,
  rawInput: EventSubscriptionInput,
  caller: EventSubscriptionCaller,
): Promise<EventSubscription> {
  const existing = await getSubscriptionRow(organizationId, id);
  if (!existing) throw new EventSubscriptionError("Event subscription not found.", 404);
  const input = normalizeInput(rawInput);
  if (input.destination.kind !== existing.destinationKind) {
    throw new EventSubscriptionError(
      "A subscription's destination kind cannot change. Create a new subscription instead.",
    );
  }
  const label = await checkInput(organizationId, input, caller);
  const reenabling = input.enabled && !existing.enabled;
  const [row] = await db
    .update(eventSubscriptions)
    .set({
      name: input.name,
      enabled: input.enabled,
      ...destinationColumns(input.destination),
      destinationLabel: label,
      eventTypes: input.eventTypes,
      minSeverity: input.minSeverity,
      accountIds: input.accountIds,
      environments: input.environments,
      ...(reenabling
        ? { disabledReason: null, disabledAt: null, consecutiveFailures: 0, failingSince: null }
        : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.organizationId, organizationId)),
    )
    .returning();
  return toSubscription(row!);
}

export async function deleteEventSubscription(
  organizationId: string,
  id: string,
): Promise<boolean> {
  const deleted = await db
    .delete(eventSubscriptions)
    .where(
      and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.organizationId, organizationId)),
    )
    .returning({ id: eventSubscriptions.id });
  return deleted.length > 0;
}

/**
 * Replace the signing secret. The old one keeps signing (a second `v1=` in
 * the header) for {@link EVENT_SECRET_ROLLOVER_MS}, so a receiver can be
 * updated without dropping a delivery. Rerolling again inside that window
 * retires the oldest immediately: only two secrets ever sign.
 */
export async function rerollEventSubscriptionSecret(
  organizationId: string,
  id: string,
): Promise<{ subscription: EventSubscription; secret: string }> {
  const existing = await getSubscriptionRow(organizationId, id);
  if (!existing) throw new EventSubscriptionError("Event subscription not found.", 404);
  if (existing.destinationKind !== "webhook") {
    throw new EventSubscriptionError("Only webhook subscriptions are signed.");
  }
  const secret = newSecret();
  const now = new Date();
  const [row] = await db
    .update(eventSubscriptions)
    .set({
      ...(await encryptSecret(id, secret)),
      previousEncryptedSecret: existing.encryptedSecret,
      previousSecretIv: existing.secretIv,
      previousSecretExpiresAt: new Date(now.getTime() + EVENT_SECRET_ROLLOVER_MS),
      updatedAt: now,
    })
    .where(eq(eventSubscriptions.id, id))
    .returning();
  return { subscription: toSubscription(row!), secret };
}

// --- Delivery log ---

export async function listEventDeliveries(
  organizationId: string,
  opts: {
    subscriptionId?: string;
    state?: string;
    eventType?: string;
    limit?: number;
    before?: Date;
  },
): Promise<EventDelivery[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select()
    .from(eventDeliveries)
    .where(
      and(
        eq(eventDeliveries.organizationId, organizationId),
        opts.subscriptionId ? eq(eventDeliveries.subscriptionId, opts.subscriptionId) : undefined,
        opts.state ? eq(eventDeliveries.state, opts.state) : undefined,
        opts.eventType ? eq(eventDeliveries.eventType, opts.eventType) : undefined,
        opts.before ? lt(eventDeliveries.createdAt, opts.before) : undefined,
      ),
    )
    .orderBy(desc(eventDeliveries.createdAt))
    .limit(limit);
  return rows.map(toDelivery);
}

export async function getDeliveryRow(
  organizationId: string,
  id: string,
): Promise<DeliveryRow | null> {
  const [row] = await db
    .select()
    .from(eventDeliveries)
    .where(and(eq(eventDeliveries.id, id), eq(eventDeliveries.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/**
 * Queue a fresh copy of a past delivery: same envelope (same event id, so a
 * receiver that dedupes on it still can), new delivery id, a full retry
 * ladder of its own. The original row is left as it was, as history.
 */
export async function queueRedelivery(
  organizationId: string,
  deliveryId: string,
): Promise<DeliveryRow> {
  const original = await getDeliveryRow(organizationId, deliveryId);
  if (!original) throw new EventSubscriptionError("Delivery not found.", 404);
  const now = new Date();
  const [row] = await db
    .insert(eventDeliveries)
    .values({
      id: randomUUID(),
      organizationId,
      subscriptionId: original.subscriptionId,
      eventId: original.eventId,
      eventType: original.eventType,
      idempotencyKey: null,
      payload: original.payload,
      state: "pending",
      nextAttemptAt: now,
      isTest: original.isTest,
      redeliveryOf: original.id,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}
