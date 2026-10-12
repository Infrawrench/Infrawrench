import {
  ALERT_SEVERITIES,
  EVENT_CATEGORY_LABELS,
  EVENT_DELIVERY_HEADER,
  EVENT_ID_HEADER,
  EVENT_SIGNATURE_HEADER,
  EVENT_TYPE_HEADER,
  eventSchemaName,
  listEventTypes,
  type EventFieldSpec,
  type EventTypeDef,
} from "@infrawrench/client-core";
import { z } from "../zod";
import { strict, ErrorResponses, Ok, OrgIdParam } from "../common";
import type { BuildContext } from "../context";

const Severity = z.enum(ALERT_SEVERITIES as [string, ...string[]]).openapi("EventSeverity");

const IdParam = OrgIdParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

/** Zod for one field of an event's `data`, from the registry's field spec. */
function fieldSchema(f: EventFieldSpec): z.ZodTypeAny {
  let s: z.ZodTypeAny;
  switch (f.type) {
    case "string":
      s = f.enum && f.enum.length > 0 ? z.enum(f.enum as [string, ...string[]]) : z.string();
      break;
    case "datetime":
      s = z.string().openapi({ format: "date-time" });
      break;
    case "number":
      s = z.number();
      break;
    case "integer":
      s = z.number().int();
      break;
    case "boolean":
      s = z.boolean();
      break;
    case "string[]":
      s = z.array(z.string());
      break;
  }
  if (f.nullable) s = s.nullable();
  return s.openapi({ description: f.description });
}

function dataSchema(def: EventTypeDef) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, f] of Object.entries(def.fields)) shape[key] = fieldSchema(f);
  return z
    .object(shape)
    .passthrough()
    .openapi(eventSchemaName(def), {
      description: `\`data\` of a \`${def.type}\` event, version ${def.version}. ${def.description}`,
    });
}

/** The envelope fields common to every event. */
const envelopeShape = {
  id: z.string().openapi({
    description:
      "`evt_…`. Unique per event and stable across retries and redeliveries: dedupe on it.",
  }),
  version: z.number().int().openapi({ description: "Payload schema version of `type`." }),
  createdAt: z.string().openapi({ format: "date-time", description: "When the event happened." }),
  organizationId: z.string(),
  severity: Severity,
  accountId: z.string().nullable().openapi({
    description: "The account the event is about; null when it spans several or none.",
  }),
  environment: z.string().nullable().openapi({
    description:
      "The `env`/`environment`/`stage` tag of the resource the event is about; null when there is none.",
  }),
  title: z.string().openapi({ description: "One line for a human." }),
  url: z.string().nullable().openapi({ description: "Deep link into Infrawrench." }),
  test: z.boolean().openapi({ description: "True only for Send test event." }),
};

function envelopeSchema(def: EventTypeDef, data: z.ZodTypeAny) {
  return strict({ ...envelopeShape, type: z.literal(def.type), data }).openapi(
    `Event_${def.type.replace(/\./g, "_")}_v${def.version}`,
    { description: def.description },
  );
}

const EventDestination = z
  .discriminatedUnion("kind", [
    strict({
      kind: z.literal("webhook"),
      url: z.string().url().openapi({ description: "An https URL. Redirects are not followed." }),
    }),
    strict({
      kind: z.literal("publish"),
      accountId: z.string().openapi({ description: "A connected account." }),
      resourceTypeId: z.string().openapi({
        description:
          "A resource type that can receive events (an AWS EventBridge rule's bus, a GCP Pub/Sub topic). See /event-subscriptions/options.",
      }),
      resourceId: z.string().openapi({ description: "The picked resource's Infrawrench id." }),
    }),
  ])
  .openapi("EventDestination");

const filterShape = {
  eventTypes: z.array(z.string()).openapi({
    description: "Event types to receive (see /event-subscriptions/catalog). Empty means all.",
  }),
  minSeverity: Severity.nullable().openapi({
    description: "Lowest severity to receive. Null means every severity.",
  }),
  accountIds: z.array(z.string()).openapi({
    description:
      "Only events about these accounts. Empty does not filter; an event with no account never matches a non-empty list.",
  }),
  environments: z.array(z.string()).openapi({
    description:
      "Only events whose environment is one of these (case-insensitive). Empty does not filter; an event with no environment never matches a non-empty list.",
  }),
};

const EventSubscription = strict({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  destination: EventDestination,
  destinationLabel: z.string().openapi({ description: "Human label for the destination." }),
  ...filterShape,
  secretHint: z.string().nullable().openapi({
    description: "Last four characters of the signing secret; null for publish destinations.",
  }),
  previousSecretExpiresAt: z.string().nullable().openapi({
    format: "date-time",
    description: "Until when the secret before the last reroll still signs.",
  }),
  disabledReason: z.string().nullable().openapi({
    description: "Set when the subscription was turned off automatically after sustained failure.",
  }),
  disabledAt: z.string().nullable().openapi({ format: "date-time" }),
  consecutiveFailures: z.number().int(),
  failingSince: z.string().nullable().openapi({ format: "date-time" }),
  lastSuccessAt: z.string().nullable().openapi({ format: "date-time" }),
  lastFailureAt: z.string().nullable().openapi({ format: "date-time" }),
  createdAt: z.string().openapi({ format: "date-time" }),
  updatedAt: z.string().openapi({ format: "date-time" }),
}).openapi("EventSubscription");

const EventSubscriptionInput = strict({
  name: z.string().max(120),
  enabled: z.boolean().default(true),
  destination: EventDestination,
  eventTypes: filterShape.eventTypes.default([]),
  minSeverity: filterShape.minSeverity.default(null),
  accountIds: filterShape.accountIds.default([]),
  environments: filterShape.environments.default([]),
}).openapi("EventSubscriptionInput");

const EventSubscriptionWithSecret = strict({
  subscription: EventSubscription,
  secret: z.string().nullable().openapi({
    description:
      "The signing secret (`iwhsec_…`). Returned only here; store it now. Null for publish destinations.",
  }),
}).openapi("EventSubscriptionWithSecret");

const EventDeliveryAttempt = strict({
  at: z.string().openapi({ format: "date-time" }),
  status: z.number().int().nullable(),
  durationMs: z.number().int(),
  error: z.string().nullable(),
}).openapi("EventDeliveryAttempt");

const EventDelivery = strict({
  id: z.string(),
  subscriptionId: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  state: z.enum(["pending", "retrying", "succeeded", "dead", "skipped"]),
  attemptCount: z.number().int(),
  nextAttemptAt: z.string().nullable().openapi({ format: "date-time" }),
  lastAttemptAt: z.string().nullable().openapi({ format: "date-time" }),
  deliveredAt: z.string().nullable().openapi({ format: "date-time" }),
  responseStatus: z.number().int().nullable(),
  responseExcerpt: z.string().nullable(),
  error: z.string().nullable(),
  test: z.boolean(),
  redeliveryOf: z.string().nullable(),
  attempts: z.array(EventDeliveryAttempt),
  createdAt: z.string().openapi({ format: "date-time" }),
  payload: z.record(z.unknown()).openapi({ description: "The envelope as sent." }),
}).openapi("EventDelivery");

const EventTypeInfo = strict({
  type: z.string(),
  version: z.number().int(),
  label: z.string(),
  description: z.string(),
  category: z.enum(Object.keys(EVENT_CATEGORY_LABELS) as [string, ...string[]]),
  defaultSeverity: Severity,
  carriesCost: z.boolean().openapi({
    description: "Receiving it needs costs:read as well as org:settings:write.",
  }),
  schema: z.record(z.unknown()).openapi({ description: "JSON Schema of `data`." }),
}).openapi("EventTypeInfo");

const EventSubscriptionOptions = strict({
  accounts: z.array(strict({ id: z.string(), name: z.string(), pluginId: z.string() })),
  environments: z.array(z.string()),
  sinks: z.array(
    strict({
      accountId: z.string(),
      accountName: z.string(),
      pluginId: z.string(),
      pluginName: z.string(),
      resourceTypeId: z.string(),
      resourceTypeName: z.string(),
      resourceId: z.string(),
      resourceName: z.string(),
    }),
  ),
  canSubscribeToCost: z.boolean(),
}).openapi("EventSubscriptionOptions");

const SIGNATURE_DOC =
  `Webhook requests carry \`${EVENT_SIGNATURE_HEADER}: t=<unix seconds>,v1=<hex>\`, where each v1 is ` +
  "HMAC-SHA256 of `<t>.<raw body>` keyed with the subscription's secret (two v1 values during the 24 hours after a reroll). " +
  `Also \`${EVENT_ID_HEADER}\`, \`${EVENT_TYPE_HEADER}\` and \`${EVENT_DELIVERY_HEADER}\`. ` +
  "Answer 2xx within 10 seconds; anything else is retried with backoff over about a day and a half.";

export function registerEventSubscriptionPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const tags = ["Event subscriptions"];

  // One OpenAPI webhook per event type: the envelope with that type's
  // versioned `data` schema, both generated from the client-core registry.
  for (const def of listEventTypes({ includeInternal: true })) {
    // Registered as components as well: the generator only collects named
    // schemas it meets under `paths`, and these are what SDKs and docs link to.
    const data = registry.register(eventSchemaName(def), dataSchema(def));
    const envelope = registry.register(
      `Event_${def.type.replace(/\./g, "_")}_v${def.version}`,
      envelopeSchema(def, data),
    );
    registry.registerWebhook({
      method: "post",
      path: def.type,
      tags,
      summary: def.label,
      description: `${def.description}\n\n${SIGNATURE_DOC}`,
      request: { body: { content: { "application/json": { schema: envelope } } } },
      responses: { 200: { description: "Any 2xx acknowledges the delivery." } },
    });
  }

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/event-subscriptions/catalog",
    tags,
    summary: "List event types and their payload schemas",
    description: "Every event a subscription can receive, with the JSON Schema of its `data`.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "The catalog",
        content: {
          "application/json": { schema: strict({ eventTypes: z.array(EventTypeInfo) }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/event-subscriptions/options",
    tags,
    summary: "Picker options for the subscription form",
    description:
      "Connected accounts, environment values seen on resource tags, and every resource that can receive events.",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Options",
        content: { "application/json": { schema: EventSubscriptionOptions } },
      },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/event-subscriptions",
    tags,
    summary: "List event subscriptions",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Subscriptions",
        content: {
          "application/json": { schema: strict({ subscriptions: z.array(EventSubscription) }) },
        },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/event-subscriptions",
    tags,
    summary: "Create an event subscription",
    description:
      "Returns the signing secret once. Responds 403 when the filters include cost events and the caller lacks costs:read, 409 at the per-org limit.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: EventSubscriptionInput } } },
    },
    responses: {
      201: {
        description: "Created",
        content: { "application/json": { schema: EventSubscriptionWithSecret } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/event-subscriptions/{id}",
    tags,
    summary: "Get an event subscription",
    request: { params: IdParam },
    responses: {
      200: {
        description: "The subscription",
        content: { "application/json": { schema: EventSubscription } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "put",
    path: "/api/org/{orgId}/event-subscriptions/{id}",
    tags,
    summary: "Replace an event subscription",
    description:
      "Whole-object update. The destination kind cannot change. Re-enabling a subscription that was turned off automatically clears its failure history.",
    request: {
      params: IdParam,
      body: { content: { "application/json": { schema: EventSubscriptionInput } } },
    },
    responses: {
      200: {
        description: "Updated",
        content: { "application/json": { schema: EventSubscription } },
      },
      400: ErrorResponses[400],
      403: ErrorResponses[403],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/api/org/{orgId}/event-subscriptions/{id}",
    tags,
    summary: "Delete an event subscription",
    description: "Its delivery log goes with it.",
    request: { params: IdParam },
    responses: {
      200: { description: "Deleted", content: { "application/json": { schema: Ok } } },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/event-subscriptions/{id}/reroll-secret",
    tags,
    summary: "Reroll a webhook signing secret",
    description:
      "Returns the new secret once. The previous secret keeps signing (a second v1 in the signature header) for 24 hours.",
    request: { params: IdParam },
    responses: {
      200: {
        description: "New secret",
        content: { "application/json": { schema: EventSubscriptionWithSecret } },
      },
      400: ErrorResponses[400],
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/event-subscriptions/{id}/test",
    tags,
    summary: "Send a test event",
    description:
      "Sends an `infrawrench.test` event and returns the attempt. Tried once, never retried, and not counted toward auto-disable. Works on a disabled subscription.",
    request: { params: IdParam },
    responses: {
      200: {
        description: "The test delivery",
        content: { "application/json": { schema: strict({ delivery: EventDelivery }) } },
      },
      404: ErrorResponses[404],
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/event-subscriptions/deliveries",
    tags,
    summary: "List event deliveries",
    description: "The delivery log, newest first. Kept for 30 days.",
    request: {
      params: OrgIdParam,
      query: z.object({
        subscriptionId: z.string().optional(),
        state: z.enum(["pending", "retrying", "succeeded", "dead", "skipped"]).optional(),
        eventType: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        before: z
          .string()
          .optional()
          .openapi({ format: "date-time", description: "Page backwards." }),
      }),
    },
    responses: {
      200: {
        description: "Deliveries",
        content: { "application/json": { schema: strict({ deliveries: z.array(EventDelivery) }) } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/event-subscriptions/deliveries/{id}/redeliver",
    tags,
    summary: "Redeliver an event",
    description:
      "Queues a fresh delivery of the same envelope (same event id) with its own retry ladder.",
    request: { params: IdParam },
    responses: {
      200: {
        description: "The queued delivery",
        content: { "application/json": { schema: strict({ delivery: EventDelivery }) } },
      },
      404: ErrorResponses[404],
    },
  });
}
