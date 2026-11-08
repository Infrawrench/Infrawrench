/**
 * Stripe's webhook, `POST /api/v1/webhooks/stripe`, the endpoint definition.
 *
 * Public: no session or key, the `Stripe-Signature` header over the raw body
 * is the authentication. The handler reads that body itself (`handleRaw`), so
 * the signature is checked over the exact bytes Stripe signed; the payload
 * declared here documents it and is never decoded. Internal in the published
 * spec through its `/api/v1/webhooks/` prefix (`openapi/public-spec.ts`).
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { Security, SuccessDescription } from "../http/annotations";
import { withApiDefaults } from "../http/api-defaults";
import { BadRequest, InternalServerError } from "../http/errors";
import { describeResponse, requiredHeaders } from "../http/schemas/documented";

export const StripeWebhookAck = Schema.Struct({ received: Schema.Literal(true) });

/**
 * The signature header, decoded as optional so a delivery without one reaches
 * the handler's own `Missing signature` 400. `requiredHeaders`
 * documents it as required, as it is.
 */
const StripeWebhookHeaders = Schema.Struct({
  "stripe-signature": Schema.optionalKey(
    Schema.String.annotate({ description: "Stripe webhook signature" }),
  ),
});

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
        )(describeResponse(400, "Bad signature")(requiredHeaders(["stripe-signature"])(operation))),
      ),
  )
  .annotate(OpenApi.Title, "Webhooks") {}

export class StripeWebhookApi extends withApiDefaults(
  HttpApi.make("stripeWebhook").add(StripeWebhookGroup),
) {}
