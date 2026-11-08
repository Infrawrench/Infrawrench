/**
 * Stripe's webhook, `POST /api/v1/webhooks/stripe`, the handler.
 *
 * The body is read as text before anything parses it, and `constructEvent`
 * verifies the signature (and Stripe's tolerance window) over exactly that
 * text. Then the event is applied (`./events.ts`). Every answer is what the
 * Hono route sent, since Stripe retries anything but a 2xx: 400 for a missing
 * or refused signature, 500 `Webhook handler error` when applying failed, and
 * `{ received: true }` otherwise.
 */
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getStripe, getStripeWebhookSecret } from "../../../services/stripe";
import { makeDomain } from "../../domain";
import { BadRequest, InternalServerError } from "../../errors";
import { legacy, legacyTry } from "../../legacy";
import { respond } from "../../response";
import { StripeWebhookAck, StripeWebhookApi } from "./api";
import { applyStripeEvent } from "./events";

const StripeWebhookHandlers = HttpApiBuilder.group(StripeWebhookApi, "stripeWebhook", (handlers) =>
  handlers.handleRaw("receive", ({ request, headers }) =>
    Effect.gen(function* () {
      const stripe = yield* legacy(() => getStripe());
      // The exact text Stripe signed; nothing has parsed or re-encoded it.
      const body = yield* Effect.orDie(request.text);
      const signature = headers["stripe-signature"];
      if (!signature) return yield* new BadRequest({ error: "Missing signature" });

      const event = yield* legacyTry(
        () => stripe.webhooks.constructEvent(body, signature, getStripeWebhookSecret()),
        (err) => {
          console.error("[stripe-webhook] Signature verification failed:", err);
          return new BadRequest({ error: "Invalid signature" });
        },
      );

      yield* legacyTry(
        () => applyStripeEvent(stripe, event),
        (err) => {
          console.error(`[stripe-webhook] Error handling ${event.type}:`, err);
          return new InternalServerError({ error: "Webhook handler error" });
        },
      );

      return yield* respond(StripeWebhookAck)({ received: true });
    }),
  ),
);

export const stripeWebhookDomain = makeDomain(
  "stripeWebhook",
  StripeWebhookApi,
  StripeWebhookHandlers,
);
