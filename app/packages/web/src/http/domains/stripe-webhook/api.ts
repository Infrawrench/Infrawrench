/**
 * Stripe's webhook, `POST /api/v1/webhooks/stripe`, the endpoint definition.
 *
 * Public: no session or key, the `Stripe-Signature` header over the raw body
 * is the authentication. The handler reads that body itself (`handleRaw`), so
 * the signature is checked over the exact bytes Stripe signed; the payload
 * declared here documents it and is never decoded. Internal in the published
 * spec through its `/api/v1/webhooks/` prefix (`openapi/public-spec.ts`).
 */
import { Predicate, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Security, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, InternalServerError } from "../../errors";
import { describeResponse } from "../../schemas/documented";

export const StripeWebhookAck = Schema.Struct({ received: Schema.Literal(true) });

/**
 * The signature header, decoded as optional so a delivery without one reaches
 * the handler's own `Missing signature` 400. {@link requireSignatureHeader}
 * documents it as required, as it is.
 */
const StripeWebhookHeaders = Schema.Struct({
  "stripe-signature": Schema.optionalKey(
    Schema.String.annotate({ description: "Stripe webhook signature" }),
  ),
});

/** An `OpenApi.Transform` marking the `stripe-signature` header parameter required. */
const requireSignatureHeader = (operation: Record<string, unknown>): Record<string, unknown> => {
  const parameters = operation["parameters"];
  if (!Array.isArray(parameters)) return operation;
  return {
    ...operation,
    parameters: parameters.map((parameter: unknown) =>
      Predicate.isObject(parameter) &&
      parameter["in"] === "header" &&
      parameter["name"] === "stripe-signature"
        ? { ...parameter, required: true }
        : parameter,
    ),
  };
};

export class StripeWebhookGroup extends HttpApiGroup.make("stripeWebhook")
  .add(
    HttpApiEndpoint.post("receive", "/api/v1/webhooks/stripe", {
      headers: StripeWebhookHeaders,
      payload: Schema.Unknown,
      success: StripeWebhookAck,
      error: [BadRequest, InternalServerError],
    })
      .annotate(OpenApi.Summary, "Stripe webhook endpoint")
      .annotate(
        OpenApi.Description,
        "Public; verifies Stripe signature in `Stripe-Signature` header.",
      )
      .annotate(SuccessDescription, "Acknowledged")
      .annotate(Security, [])
      .annotate(OpenApi.Transform, (operation) =>
        describeResponse(
          500,
          "Handler error",
        )(describeResponse(400, "Bad signature")(requireSignatureHeader(operation))),
      ),
  )
  .annotate(OpenApi.Title, "Webhooks") {}

export class StripeWebhookApi extends withApiDefaults(
  HttpApi.make("stripeWebhook").add(StripeWebhookGroup),
) {}
