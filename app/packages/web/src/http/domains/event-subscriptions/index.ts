/**
 * Event subscriptions, the handlers. The server half lives in
 * `server-core/src/events/`; these parse, gate and audit. Mutations are
 * routed to the gateway (`edge/gateway-routes.ts`).
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  eventTypeInfo,
  isAlertSeverity,
  listEventTypes,
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
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { badRequest, Forbidden, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { inputRefusal } from "../../refusals";
import { readObjectBody } from "../../request-body";
import { holdsPermission, OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  EventCatalog,
  EventDeliveryList,
  EventDeliveryResult,
  EventSubscription,
  EventSubscriptionList,
  EventSubscriptionOptions,
  EventSubscriptionsApi,
  EventSubscriptionWithSecret,
} from "./api";

/** Who is acting, in the shape the store checks cost events against. */
const caller = Effect.gen(function* () {
  const { session } = yield* OrgPrincipal;
  return {
    userId: session.userId ?? null,
    canReadCosts: yield* holdsPermission("costs:read"),
  };
});

/** The store's refusal as the status it carries. */
const storeRefusal = (error: unknown) => {
  if (!(error instanceof EventSubscriptionError)) return undefined;
  if (error.status === 403) return new Forbidden({ error: error.message });
  return inputRefusal({ status: error.status, message: error.message });
};

const stringList = (v: unknown): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.every(Predicate.isString) ? [...v] : null;

const prop = (value: unknown, key: string): unknown =>
  Predicate.hasProperty(value, key) ? value[key] : undefined;

/** Parse a create/update body. Returns the input or a 400 message. */
export function parseSubscriptionBody(body: {
  readonly [key: string]: unknown;
}): EventSubscriptionInput | string {
  const name = body["name"];
  if (!Predicate.isString(name)) return "name is required";
  const enabled = body["enabled"] === undefined ? true : body["enabled"];
  if (!Predicate.isBoolean(enabled)) return "enabled must be a boolean";
  const eventTypes = stringList(body["eventTypes"]);
  const accountIds = stringList(body["accountIds"]);
  const environments = stringList(body["environments"]);
  if (!eventTypes || !accountIds || !environments) {
    return "eventTypes, accountIds and environments must be arrays of strings";
  }
  const minSeverity = body["minSeverity"] ?? null;
  if (minSeverity !== null && !(Predicate.isString(minSeverity) && isAlertSeverity(minSeverity))) {
    return "minSeverity must be info, warning, critical or null";
  }
  const dest = body["destination"];
  if (!Predicate.isObject(dest) || Array.isArray(dest)) return "destination is required";
  let destination: EventDestination;
  const kind = prop(dest, "kind");
  if (kind === "webhook") {
    const url = prop(dest, "url");
    if (!Predicate.isString(url)) return "destination.url is required";
    destination = { kind: "webhook", url };
  } else if (kind === "publish") {
    const accountId = prop(dest, "accountId");
    const resourceTypeId = prop(dest, "resourceTypeId");
    const resourceId = prop(dest, "resourceId");
    if (
      !Predicate.isString(accountId) ||
      !Predicate.isString(resourceTypeId) ||
      !Predicate.isString(resourceId)
    ) {
      return "destination.accountId, resourceTypeId and resourceId are required";
    }
    destination = { kind: "publish", accountId, resourceTypeId, resourceId };
  } else {
    return 'destination.kind must be "webhook" or "publish"';
  }
  return { name, enabled, destination, eventTypes, minSeverity, accountIds, environments };
}

const EventSubscriptionsHandlers = HttpApiBuilder.group(
  EventSubscriptionsApi,
  "eventSubscriptions",
  (handlers) =>
    handlers
      // The event catalog: every type with its versioned payload schema.
      .handle("catalog", () =>
        respond(EventCatalog)({ eventTypes: listEventTypes().map(eventTypeInfo) }),
      )
      // The form's pickers: accounts, environments seen on resources, publish destinations.
      .handle("options", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const who = yield* caller;
          const options = yield* legacy(() => listEventSubscriptionOptions(organizationId, who));
          return yield* respond(EventSubscriptionOptions)(options);
        }),
      )
      // The delivery log, newest first.
      .handle("deliveries", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const limit = query.limit ?? 50;
          const before = query.before ? new Date(query.before) : undefined;
          if (before && Number.isNaN(before.getTime())) {
            return yield* badRequest("before must be an ISO timestamp");
          }
          const { subscriptionId, state, eventType } = query;
          const deliveries = yield* legacy(() =>
            listEventDeliveries(organizationId, {
              limit: Number.isFinite(limit) ? limit : 50,
              ...(subscriptionId ? { subscriptionId } : {}),
              ...(state ? { state } : {}),
              ...(eventType ? { eventType } : {}),
              ...(before ? { before } : {}),
            }),
          );
          return yield* respond(EventDeliveryList)({ deliveries });
        }),
      )
      // A fresh copy of a delivery: same event id, new delivery id.
      .handle("redeliver", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const row = yield* legacyTry(
            () => queueRedelivery(organizationId, params.id),
            storeRefusal,
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId ?? null,
              action: "event_subscription.redeliver",
              entityType: "event-subscription",
              entityId: row.subscriptionId,
              metadata: {
                deliveryId: row.id,
                redeliveryOf: row.redeliveryOf,
                eventType: row.eventType,
              },
            }),
          );
          return yield* respond(EventDeliveryResult)({ delivery: toDelivery(row) });
        }),
      )
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const subscriptions = yield* legacy(() => listEventSubscriptions(organizationId));
          return yield* respond(EventSubscriptionList)({ subscriptions });
        }),
      )
      // The response carries the signing secret, the only time it is ever shown.
      .handleRaw("create", ({ request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const parsed = yield* readObjectBody(request);
          if (!parsed.ok) return yield* badRequest(parsed.error);
          const input = parseSubscriptionBody(parsed.body);
          if (Predicate.isString(input)) return yield* badRequest(input);
          const who = yield* caller;
          const result = yield* legacyTry(
            () => createEventSubscription(organizationId, input, who),
            storeRefusal,
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId ?? null,
              action: "event_subscription.create",
              entityType: "event-subscription",
              entityId: result.subscription.id,
              metadata: {
                name: input.name,
                destination: result.subscription.destinationLabel,
                eventTypes: input.eventTypes,
              },
            }),
          );
          return yield* respond(EventSubscriptionWithSecret, { status: 201 })(result);
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const row = yield* legacy(() => getSubscriptionRow(organizationId, params.id));
          if (!row) return yield* notFound("Event subscription not found");
          return yield* respond(EventSubscription)(toSubscription(row));
        }),
      )
      // Whole-object update. The destination kind is fixed; the webhook URL
      // or picked resource may change.
      .handleRaw("update", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const parsed = yield* readObjectBody(request);
          if (!parsed.ok) return yield* badRequest(parsed.error);
          const input = parseSubscriptionBody(parsed.body);
          if (Predicate.isString(input)) return yield* badRequest(input);
          const who = yield* caller;
          const subscription = yield* legacyTry(
            () => updateEventSubscription(organizationId, params.id, input, who),
            storeRefusal,
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId ?? null,
              action: "event_subscription.update",
              entityType: "event-subscription",
              entityId: subscription.id,
              metadata: { name: input.name, enabled: input.enabled, eventTypes: input.eventTypes },
            }),
          );
          return yield* respond(EventSubscription)(subscription);
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const deleted = yield* legacy(() => deleteEventSubscription(organizationId, params.id));
          if (!deleted) return yield* notFound("Event subscription not found");
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId ?? null,
              action: "event_subscription.delete",
              entityType: "event-subscription",
              entityId: params.id,
            }),
          );
          return ok;
        }),
      )
      // A new signing secret, shown once; the old one keeps signing for 24 hours.
      .handle("rerollSecret", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const result = yield* legacyTry(
            () => rerollEventSubscriptionSecret(organizationId, params.id),
            storeRefusal,
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId ?? null,
              action: "event_subscription.reroll_secret",
              entityType: "event-subscription",
              entityId: result.subscription.id,
            }),
          );
          return yield* respond(EventSubscriptionWithSecret)(result);
        }),
      )
      // An `infrawrench.test` event, sent now; the attempt comes back.
      .handle("test", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const delivery = yield* legacyTry(
            () => sendTestEvent(organizationId, params.id),
            storeRefusal,
          );
          return yield* respond(EventDeliveryResult)({ delivery });
        }),
      ),
);

export const eventSubscriptionsDomain = makeDomain(
  "event-subscriptions",
  EventSubscriptionsApi,
  EventSubscriptionsHandlers,
);
