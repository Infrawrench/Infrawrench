/**
 * Event subscriptions (`/api/org/:orgId/event-subscriptions/*`): org-level
 * outbound delivery of Infrawrench's own events to a signed HTTPS webhook or
 * a publish destination in a connected account (EventBridge, Pub/Sub).
 *
 * Everything is `org:settings:write`, the alert-routing stance: a
 * subscription decides where org events leave the building. The catalog is
 * readable by any member (it is documentation). Subscribing to spend-carrying
 * events additionally needs `costs:read`, enforced in the store.
 *
 * The server half lives in `server-core/src/events/`; these handlers parse,
 * gate and audit. Mutations are routed to the gateway
 * (`edge/gateway-routes.ts`).
 */
import { Hono, type Context } from "hono";
import {
  isAlertSeverity,
  listEventTypes,
  eventTypeInfo,
  type EventDestination,
  type EventSubscriptionInput,
} from "@infrawrench/client-core";
import {
  EventSubscriptionError,
  createEventSubscription,
  deleteEventSubscription,
  getSubscriptionRow,
  listEventDeliveries,
  listEventSubscriptionOptions,
  listEventSubscriptions,
  queueRedelivery,
  rerollEventSubscriptionSecret,
  toDelivery,
  toSubscription,
  updateEventSubscription,
} from "@infrawrench/server-core/events/store";
import { sendTestEvent } from "@infrawrench/server-core/events/deliver";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";

import { requirePermission } from "../../auth/permissions";
import { logAudit } from "../../services/audit";
import type { AuthSession } from "../auth-middleware";
import { readObjectBody } from "../object-body";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

const app = new Hono();

function caller(c: Context) {
  const granted = (c.get("permissions") as string[] | undefined) ?? [];
  return {
    userId: c.get("session")?.userId ?? null,
    canReadCosts: hasPermission(granted, "costs:read"),
  };
}

function fail(c: Context, err: unknown): Response {
  if (err instanceof EventSubscriptionError) return c.json({ error: err.message }, err.status);
  throw err;
}

const stringList = (v: unknown): string[] | null =>
  v === undefined
    ? []
    : Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : null;

/** Parse a create/update body. Returns the input or a 400 message. */
export function parseSubscriptionBody(
  body: Record<string, unknown>,
): EventSubscriptionInput | string {
  if (typeof body["name"] !== "string") return "name is required";
  const enabled = body["enabled"] === undefined ? true : body["enabled"];
  if (typeof enabled !== "boolean") return "enabled must be a boolean";
  const eventTypes = stringList(body["eventTypes"]);
  const accountIds = stringList(body["accountIds"]);
  const environments = stringList(body["environments"]);
  if (!eventTypes || !accountIds || !environments) {
    return "eventTypes, accountIds and environments must be arrays of strings";
  }
  const minSeverity = body["minSeverity"] ?? null;
  if (minSeverity !== null && !isAlertSeverity(minSeverity)) {
    return "minSeverity must be info, warning, critical or null";
  }
  const d = body["destination"];
  if (!d || typeof d !== "object" || Array.isArray(d)) return "destination is required";
  const dest = d as Record<string, unknown>;
  let destination: EventDestination;
  if (dest["kind"] === "webhook") {
    if (typeof dest["url"] !== "string") return "destination.url is required";
    destination = { kind: "webhook", url: dest["url"] };
  } else if (dest["kind"] === "publish") {
    const { accountId, resourceTypeId, resourceId } = dest;
    if (
      typeof accountId !== "string" ||
      typeof resourceTypeId !== "string" ||
      typeof resourceId !== "string"
    ) {
      return "destination.accountId, resourceTypeId and resourceId are required";
    }
    destination = { kind: "publish", accountId, resourceTypeId, resourceId };
  } else {
    return 'destination.kind must be "webhook" or "publish"';
  }
  return {
    name: body["name"],
    enabled,
    destination,
    eventTypes,
    minSeverity,
    accountIds,
    environments,
  };
}

/** The event catalog: every type with its versioned payload schema. */
app.get("/catalog", (c) => {
  return c.json({ eventTypes: listEventTypes().map(eventTypeInfo) });
});

/** The form's pickers: accounts, environments seen on resources, publish destinations. */
app.get("/options", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json(await listEventSubscriptionOptions(c.get("organizationId"), caller(c)));
});

/** The delivery log, newest first. */
app.get("/deliveries", async (c) => {
  requirePermission(c, "org:settings:write");
  const limit = Number(c.req.query("limit") ?? 50);
  const beforeRaw = c.req.query("before");
  const before = beforeRaw ? new Date(beforeRaw) : undefined;
  if (before && Number.isNaN(before.getTime())) {
    return c.json({ error: "before must be an ISO timestamp" }, 400);
  }
  const subscriptionId = c.req.query("subscriptionId");
  const state = c.req.query("state");
  const eventType = c.req.query("eventType");
  return c.json({
    deliveries: await listEventDeliveries(c.get("organizationId"), {
      limit: Number.isFinite(limit) ? limit : 50,
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(state ? { state } : {}),
      ...(eventType ? { eventType } : {}),
      ...(before ? { before } : {}),
    }),
  });
});

/** Queue a fresh copy of a delivery (same event id, new delivery id). */
app.post("/deliveries/:id/redeliver", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    const row = await queueRedelivery(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId ?? null,
      action: "event_subscription.redeliver",
      entityType: "event-subscription",
      entityId: row.subscriptionId,
      metadata: { deliveryId: row.id, redeliveryOf: row.redeliveryOf, eventType: row.eventType },
    });
    return c.json({ delivery: toDelivery(row) });
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/", async (c) => {
  requirePermission(c, "org:settings:write");
  return c.json({ subscriptions: await listEventSubscriptions(c.get("organizationId")) });
});

/** Create. The response carries the signing secret, the only time it is ever shown. */
app.post("/", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const input = parseSubscriptionBody(parsed.body);
  if (typeof input === "string") return c.json({ error: input }, 400);
  try {
    const result = await createEventSubscription(organizationId, input, caller(c));
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId ?? null,
      action: "event_subscription.create",
      entityType: "event-subscription",
      entityId: result.subscription.id,
      metadata: {
        name: input.name,
        destination: result.subscription.destinationLabel,
        eventTypes: input.eventTypes,
      },
    });
    return c.json(result, 201);
  } catch (err) {
    return fail(c, err);
  }
});

app.get("/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const row = await getSubscriptionRow(c.get("organizationId"), c.req.param("id"));
  if (!row) return c.json({ error: "Event subscription not found" }, 404);
  return c.json(toSubscription(row));
});

/** Whole-object update. The destination kind is fixed; the webhook URL or picked resource may change. */
app.put("/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const parsed = await readObjectBody(c.req);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const input = parseSubscriptionBody(parsed.body);
  if (typeof input === "string") return c.json({ error: input }, 400);
  try {
    const subscription = await updateEventSubscription(
      organizationId,
      c.req.param("id"),
      input,
      caller(c),
    );
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId ?? null,
      action: "event_subscription.update",
      entityType: "event-subscription",
      entityId: subscription.id,
      metadata: { name: input.name, enabled: input.enabled, eventTypes: input.eventTypes },
    });
    return c.json(subscription);
  } catch (err) {
    return fail(c, err);
  }
});

app.delete("/:id", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  const id = c.req.param("id");
  if (!(await deleteEventSubscription(organizationId, id))) {
    return c.json({ error: "Event subscription not found" }, 404);
  }
  void logAudit({
    organizationId,
    userId: c.get("session")?.userId ?? null,
    action: "event_subscription.delete",
    entityType: "event-subscription",
    entityId: id,
  });
  return c.json({ ok: true });
});

/** New signing secret, shown once; the old one keeps signing for 24 hours. */
app.post("/:id/reroll-secret", async (c) => {
  requirePermission(c, "org:settings:write");
  const organizationId = c.get("organizationId");
  try {
    const result = await rerollEventSubscriptionSecret(organizationId, c.req.param("id"));
    void logAudit({
      organizationId,
      userId: c.get("session")?.userId ?? null,
      action: "event_subscription.reroll_secret",
      entityType: "event-subscription",
      entityId: result.subscription.id,
    });
    return c.json(result);
  } catch (err) {
    return fail(c, err);
  }
});

/** Send an `infrawrench.test` event now and return the attempt. */
app.post("/:id/test", async (c) => {
  requirePermission(c, "org:settings:write");
  try {
    const delivery = await sendTestEvent(c.get("organizationId"), c.req.param("id"));
    return c.json({ delivery });
  } catch (err) {
    return fail(c, err);
  }
});

export { app as eventSubscriptionRoutes };
