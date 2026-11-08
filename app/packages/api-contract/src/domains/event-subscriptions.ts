/**
 * Event subscriptions: `/api/org/:orgId/event-subscriptions`, the endpoint
 * definitions. Org-level outbound delivery of Infrawrench's own events to a
 * signed HTTPS webhook or a publish destination in a connected account
 * (EventBridge, Pub/Sub).
 *
 * Everything is `org:settings:write`, the alert-routing stance: a
 * subscription decides where org events leave the building. The catalog is
 * readable by any member (it is documentation). Subscribing to
 * spend-carrying events also needs `costs:read`, enforced in the store. The
 * per-event OpenAPI webhooks (the envelope and `data` schemas) are not
 * endpoints: `api/openapi/event-webhooks.ts` builds them, referencing this
 * file's `EventSeverity` component.
 */
import { Effect, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { ALERT_SEVERITIES, EVENT_CATEGORY_LABELS } from "@infrawrench/client-core";
import { maxLength } from "../schemas";
import { RequiredPermission, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, Conflict, Forbidden, NotFound } from "../http/errors";
import { OrgAuth } from "../http/middleware-tags";
import { optionalRequestBody } from "../http/schemas/documented";
import { IsoDateTime, Ok, OrgParams } from "../http/schemas/common";
import { isUrl } from "../http/schemas/issue-status";
import { enumQuery, numericQuery } from "../http/schemas/query";

const EventSeverity = Schema.Literals(ALERT_SEVERITIES).annotate({ identifier: "EventSeverity" });

const EventDestination = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("webhook"),
    url: Schema.String.check(isUrl).annotate({
      description: "An https URL. Redirects are not followed.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("publish"),
    accountId: Schema.String.annotate({ description: "A connected account." }),
    resourceTypeId: Schema.String.annotate({
      description:
        "A resource type that can receive events (an AWS EventBridge rule's bus, a GCP Pub/Sub topic). See /event-subscriptions/options.",
    }),
    resourceId: Schema.String.annotate({ description: "The picked resource's Infrawrench id." }),
  }),
]).annotate({ identifier: "EventDestination" });

const filterFields = {
  eventTypes: Schema.Array(Schema.String).annotate({
    description: "Event types to receive (see /event-subscriptions/catalog). Empty means all.",
  }),
  minSeverity: Schema.NullOr(EventSeverity).annotate({
    description: "Lowest severity to receive. Null means every severity.",
  }),
  accountIds: Schema.Array(Schema.String).annotate({
    description:
      "Only events about these accounts. Empty does not filter; an event with no account never matches a non-empty list.",
  }),
  environments: Schema.Array(Schema.String).annotate({
    description:
      "Only events whose environment is one of these (case-insensitive). Empty does not filter; an event with no environment never matches a non-empty list.",
  }),
};

export const EventSubscription = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  enabled: Schema.Boolean,
  destination: EventDestination,
  destinationLabel: Schema.String.annotate({ description: "Human label for the destination." }),
  ...filterFields,
  secretHint: Schema.NullOr(Schema.String).annotate({
    description: "Last four characters of the signing secret; null for publish destinations.",
  }),
  previousSecretExpiresAt: Schema.NullOr(IsoDateTime).annotate({
    description: "Until when the secret before the last reroll still signs.",
  }),
  disabledReason: Schema.NullOr(Schema.String).annotate({
    description: "Set when the subscription was turned off automatically after sustained failure.",
  }),
  disabledAt: Schema.NullOr(IsoDateTime),
  consecutiveFailures: Schema.Int,
  failingSince: Schema.NullOr(IsoDateTime),
  lastSuccessAt: Schema.NullOr(IsoDateTime),
  lastFailureAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
}).annotate({ identifier: "EventSubscription" });

/** The defaults the handler fills in (`parseSubscriptionBody`), stated in the document too. */
const EventSubscriptionInput = Schema.Struct({
  name: Schema.String.check(maxLength(120)),
  enabled: Schema.Boolean.annotate({ default: true }).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  destination: EventDestination,
  eventTypes: filterFields.eventTypes
    .annotate({ default: [] })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  minSeverity: filterFields.minSeverity
    .annotate({ default: null })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  accountIds: filterFields.accountIds
    .annotate({ default: [] })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
  environments: filterFields.environments
    .annotate({ default: [] })
    .pipe(Schema.withDecodingDefaultKey(Effect.sync(() => []))),
}).annotate({ identifier: "EventSubscriptionInput" });

export const EventSubscriptionWithSecret = Schema.Struct({
  subscription: EventSubscription,
  secret: Schema.NullOr(Schema.String).annotate({
    description:
      "The signing secret (`iwhsec_…`). Returned only here; store it now. Null for publish destinations.",
  }),
}).annotate({ identifier: "EventSubscriptionWithSecret" });

/** Any JSON object, documented as zod's `z.record(z.unknown())` was. */
const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter(() => true, { toJsonSchema: () => ({ additionalProperties: {} }) }),
);

const EventDeliveryAttempt = Schema.Struct({
  at: IsoDateTime,
  status: Schema.NullOr(Schema.Int),
  durationMs: Schema.Int,
  error: Schema.NullOr(Schema.String),
}).annotate({ identifier: "EventDeliveryAttempt" });

const DeliveryState = Schema.Literals(["pending", "retrying", "succeeded", "dead", "skipped"]);

const EventDelivery = Schema.Struct({
  id: Schema.String,
  subscriptionId: Schema.String,
  eventId: Schema.String,
  eventType: Schema.String,
  state: DeliveryState,
  attemptCount: Schema.Int,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  lastAttemptAt: Schema.NullOr(IsoDateTime),
  deliveredAt: Schema.NullOr(IsoDateTime),
  responseStatus: Schema.NullOr(Schema.Int),
  responseExcerpt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  test: Schema.Boolean,
  redeliveryOf: Schema.NullOr(Schema.String),
  attempts: Schema.Array(EventDeliveryAttempt),
  createdAt: IsoDateTime,
  payload: UnknownRecord.annotate({
    description: "The envelope as sent.",
  }),
}).annotate({ identifier: "EventDelivery" });

const EventCategory = Schema.Literals(
  Object.keys(EVENT_CATEGORY_LABELS).filter((key): key is keyof typeof EVENT_CATEGORY_LABELS =>
    Object.hasOwn(EVENT_CATEGORY_LABELS, key),
  ),
);

const EventTypeInfo = Schema.Struct({
  type: Schema.String,
  version: Schema.Int,
  label: Schema.String,
  description: Schema.String,
  category: EventCategory,
  defaultSeverity: EventSeverity,
  carriesCost: Schema.Boolean.annotate({
    description: "Receiving it needs costs:read as well as org:settings:write.",
  }),
  schema: UnknownRecord.annotate({
    description: "JSON Schema of `data`.",
  }),
}).annotate({ identifier: "EventTypeInfo" });

export const EventCatalog = Schema.Struct({ eventTypes: Schema.Array(EventTypeInfo) });

export const EventSubscriptionOptions = Schema.Struct({
  accounts: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, pluginId: Schema.String }),
  ),
  environments: Schema.Array(Schema.String),
  sinks: Schema.Array(
    Schema.Struct({
      accountId: Schema.String,
      accountName: Schema.String,
      pluginId: Schema.String,
      pluginName: Schema.String,
      resourceTypeId: Schema.String,
      resourceTypeName: Schema.String,
      resourceId: Schema.String,
      resourceName: Schema.String,
    }),
  ),
  canSubscribeToCost: Schema.Boolean,
}).annotate({ identifier: "EventSubscriptionOptions" });

export const EventSubscriptionList = Schema.Struct({
  subscriptions: Schema.Array(EventSubscription),
});
export const EventDeliveryList = Schema.Struct({ deliveries: Schema.Array(EventDelivery) });
export const EventDeliveryResult = Schema.Struct({ delivery: EventDelivery });

const IdParams = { ...OrgParams, id: Schema.String } as const;

/** Every refusal the store can raise (`EventSubscriptionError` carries its status). */
const StoreErrors = [BadRequest, Forbidden, NotFound, Conflict] as const;

export class EventSubscriptionsGroup extends HttpApiGroup.make("eventSubscriptions")
  .add(
    HttpApiEndpoint.get("catalog", "/catalog", {
      params: OrgParams,
      success: EventCatalog,
    })
      .annotate(OpenApi.Summary, "List event types and their payload schemas")
      .annotate(
        OpenApi.Description,
        "Every event a subscription can receive, with the JSON Schema of its `data`.",
      )
      .annotate(SuccessDescription, "The catalog"),
    HttpApiEndpoint.get("options", "/options", {
      params: OrgParams,
      success: EventSubscriptionOptions,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Picker options for the subscription form")
      .annotate(
        OpenApi.Description,
        "Connected accounts, environment values seen on resource tags, and every resource that can receive events.",
      )
      .annotate(SuccessDescription, "Options"),
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      success: EventSubscriptionList,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List event subscriptions")
      .annotate(SuccessDescription, "Subscriptions"),
    // Checked by hand (`parseSubscriptionBody`), each refusal naming its field.
    HttpApiEndpoint.post("create", "/", {
      params: OrgParams,
      payload: EventSubscriptionInput,
      success: EventSubscriptionWithSecret.pipe(HttpApiSchema.status(201)),
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Create an event subscription")
      .annotate(
        OpenApi.Description,
        "Returns the signing secret once. Responds 403 when the filters include cost events and the caller lacks costs:read, 409 at the per-org limit.",
      )
      .annotate(SuccessDescription, "Created")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.get("get", "/:id", {
      params: IdParams,
      success: EventSubscription,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Get an event subscription")
      .annotate(SuccessDescription, "The subscription"),
    HttpApiEndpoint.put("update", "/:id", {
      params: IdParams,
      payload: EventSubscriptionInput,
      success: EventSubscription,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Replace an event subscription")
      .annotate(
        OpenApi.Description,
        "Whole-object update. The destination kind cannot change. Re-enabling a subscription that was turned off automatically clears its failure history.",
      )
      .annotate(SuccessDescription, "Updated")
      // The hand-written spec never marked the body required.
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.delete("delete", "/:id", {
      params: IdParams,
      success: Ok,
      error: NotFound,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Delete an event subscription")
      .annotate(OpenApi.Description, "Its delivery log goes with it.")
      .annotate(SuccessDescription, "Deleted"),
    HttpApiEndpoint.post("rerollSecret", "/:id/reroll-secret", {
      params: IdParams,
      success: EventSubscriptionWithSecret,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Reroll a webhook signing secret")
      .annotate(
        OpenApi.Description,
        "Returns the new secret once. The previous secret keeps signing (a second v1 in the signature header) for 24 hours.",
      )
      .annotate(SuccessDescription, "New secret"),
    HttpApiEndpoint.post("test", "/:id/test", {
      params: IdParams,
      success: EventDeliveryResult,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Send a test event")
      .annotate(
        OpenApi.Description,
        "Sends an `infrawrench.test` event and returns the attempt. Tried once, never retried, and not counted toward auto-disable. Works on a disabled subscription.",
      )
      .annotate(SuccessDescription, "The test delivery"),
    // Read as the route always read it: `limit` and `before` parsed by hand.
    HttpApiEndpoint.get("deliveries", "/deliveries", {
      params: OrgParams,
      query: {
        subscriptionId: Schema.optionalKey(Schema.String),
        state: Schema.optionalKey(Schema.String),
        eventType: Schema.optionalKey(Schema.String),
        // NaN is wanted: an unreadable limit means the default, never a 400.
        // @effect-diagnostics-next-line schemaNumber:off
        limit: Schema.optionalKey(Schema.NumberFromString),
        before: Schema.optionalKey(IsoDateTime.annotate({ description: "Page backwards." })),
      },
      success: EventDeliveryList,
      error: BadRequest,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "List event deliveries")
      .annotate(OpenApi.Description, "The delivery log, newest first. Kept for 30 days.")
      .annotate(SuccessDescription, "Deliveries")
      .annotate(OpenApi.Transform, (operation) =>
        numericQuery({ limit: { type: "integer", minimum: 1, maximum: 200 } })(
          enumQuery({ state: ["pending", "retrying", "succeeded", "dead", "skipped"] })(operation),
        ),
      ),
    HttpApiEndpoint.post("redeliver", "/deliveries/:id/redeliver", {
      params: IdParams,
      success: EventDeliveryResult,
      error: StoreErrors,
    })
      .annotate(RequiredPermission, "org:settings:write")
      .annotate(OpenApi.Summary, "Redeliver an event")
      .annotate(
        OpenApi.Description,
        "Queues a fresh delivery of the same envelope (same event id) with its own retry ladder.",
      )
      .annotate(SuccessDescription, "The queued delivery"),
  )
  .prefix("/api/org/:orgId/event-subscriptions")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Event subscriptions") {}

export class EventSubscriptionsApi extends withApiDefaults(
  HttpApi.make("event-subscriptions").add(EventSubscriptionsGroup),
) {}
