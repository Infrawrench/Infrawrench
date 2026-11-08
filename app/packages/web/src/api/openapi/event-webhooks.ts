/**
 * The OpenAPI `webhooks` Infrawrench sends to an event subscription, one per
 * event type, with their envelope and `data` components.
 *
 * Generated from the client-core event registry (`listEventTypes`), the same
 * field specs the catalog endpoint serves as JSON Schema
 * (`eventDataJsonSchema`), so the documented payload and the delivered one
 * cannot drift. These are not endpoints, so no HttpApi domain describes them;
 * the `/event-subscriptions` routes themselves are `http/domains/event-subscriptions`,
 * whose `EventSeverity` component is the one the envelopes reference (the spec
 * builder fails if the two definitions differ).
 */
import {
  ALERT_SEVERITIES,
  EVENT_DELIVERY_HEADER,
  EVENT_ID_HEADER,
  EVENT_SIGNATURE_HEADER,
  EVENT_TYPE_HEADER,
  eventDataJsonSchema,
  eventSchemaName,
  listEventTypes,
  type EventTypeDef,
} from "@infrawrench/client-core";

type JsonSchema = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const EVENT_SEVERITY: JsonSchema = { type: "string", enum: [...ALERT_SEVERITIES] };

/** The envelope fields common to every event, in wire order. */
const ENVELOPE_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  id: {
    type: "string",
    description:
      "`evt_…`. Unique per event and stable across retries and redeliveries: dedupe on it.",
  },
  version: { type: "integer", description: "Payload schema version of `type`." },
  createdAt: { type: "string", format: "date-time", description: "When the event happened." },
  organizationId: { type: "string" },
  severity: ref("EventSeverity"),
  accountId: {
    type: ["string", "null"],
    description: "The account the event is about; null when it spans several or none.",
  },
  environment: {
    type: ["string", "null"],
    description:
      "The `env`/`environment`/`stage` tag of the resource the event is about; null when there is none.",
  },
  title: { type: "string", description: "One line for a human." },
  url: { type: ["string", "null"], description: "Deep link into Infrawrench." },
  test: { type: "boolean", description: "True only for Send test event." },
};

const SIGNATURE_DOC =
  `Webhook requests carry \`${EVENT_SIGNATURE_HEADER}: t=<unix seconds>,v1=<hex>\`, where each v1 is ` +
  "HMAC-SHA256 of `<t>.<raw body>` keyed with the subscription's secret (two v1 values during the 24 hours after a reroll). " +
  `Also \`${EVENT_ID_HEADER}\`, \`${EVENT_TYPE_HEADER}\` and \`${EVENT_DELIVERY_HEADER}\`. ` +
  "Answer 2xx within 10 seconds; anything else is retried with backoff over about a day and a half.";

const envelopeName = (def: EventTypeDef) => `Event_${def.type.replace(/\./g, "_")}_v${def.version}`;

/** A type's `data`: its fields as the catalog serves them, open to fields added later. */
function dataSchema(def: EventTypeDef): JsonSchema {
  const { properties, required } = eventDataJsonSchema(def);
  return {
    type: "object",
    properties,
    required,
    description: `\`data\` of a \`${def.type}\` event, version ${def.version}. ${def.description}`,
  };
}

function envelopeSchema(def: EventTypeDef): JsonSchema {
  return {
    type: "object",
    properties: {
      ...ENVELOPE_PROPERTIES,
      type: { type: "string", enum: [def.type] },
      data: ref(eventSchemaName(def)),
    },
    required: [...Object.keys(ENVELOPE_PROPERTIES), "type", "data"],
    additionalProperties: false,
    description: def.description,
  };
}

export interface EventWebhooks {
  readonly webhooks: Record<string, Record<string, JsonSchema>>;
  /** The envelope and `data` components the webhooks reference, plus `EventSeverity`. */
  readonly schemas: Record<string, JsonSchema>;
}

export function buildEventWebhooks(): EventWebhooks {
  const webhooks: Record<string, Record<string, JsonSchema>> = {};
  const schemas: Record<string, JsonSchema> = {};
  for (const def of listEventTypes({ includeInternal: true })) {
    schemas[eventSchemaName(def)] = dataSchema(def);
    schemas["EventSeverity"] ??= EVENT_SEVERITY;
    schemas[envelopeName(def)] = envelopeSchema(def);
    webhooks[def.type] = {
      post: {
        tags: ["Event subscriptions"],
        summary: def.label,
        description: `${def.description}\n\n${SIGNATURE_DOC}`,
        requestBody: { content: { "application/json": { schema: ref(envelopeName(def)) } } },
        responses: { "200": { description: "Any 2xx acknowledges the delivery." } },
      },
    };
  }
  return { webhooks, schemas };
}
