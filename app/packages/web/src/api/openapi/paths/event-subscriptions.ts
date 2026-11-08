import {
  ALERT_SEVERITIES,
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
import { strict } from "../common";
import type { BuildContext } from "../context";

const Severity = z.enum(ALERT_SEVERITIES as [string, ...string[]]).openapi("EventSeverity");

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

const SIGNATURE_DOC =
  `Webhook requests carry \`${EVENT_SIGNATURE_HEADER}: t=<unix seconds>,v1=<hex>\`, where each v1 is ` +
  "HMAC-SHA256 of `<t>.<raw body>` keyed with the subscription's secret (two v1 values during the 24 hours after a reroll). " +
  `Also \`${EVENT_ID_HEADER}\`, \`${EVENT_TYPE_HEADER}\` and \`${EVENT_DELIVERY_HEADER}\`. ` +
  "Answer 2xx within 10 seconds; anything else is retried with backoff over about a day and a half.";

/**
 * The OpenAPI webhooks Infrawrench sends to an event subscription, one per
 * event type. The `/event-subscriptions` routes themselves are documented by
 * their HttpApi domain (`http/domains/event-subscriptions`), whose
 * `EventSeverity` component replaces the one registered here; the two must
 * stay identical.
 */
export function registerEventWebhooks(ctx: BuildContext) {
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
}
