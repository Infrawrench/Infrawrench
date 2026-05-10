import { z } from "../zod";
import { strict, ErrorResponse } from "../common";
import type { BuildContext } from "../index";

export function registerWebhookPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "post",
    path: "/api/v1/webhooks/stripe",
    tags: ["Webhooks"],
    summary: "Stripe webhook endpoint",
    description: "Public; verifies Stripe signature in `Stripe-Signature` header.",
    security: [],
    request: {
      headers: strict({
        "stripe-signature": z.string().openapi({ description: "Stripe webhook signature" }),
      }),
      body: { content: { "application/json": { schema: z.unknown() } }, required: true },
    },
    responses: {
      200: {
        description: "Acknowledged",
        content: { "application/json": { schema: strict({ received: z.literal(true) }) } },
      },
      400: {
        description: "Bad signature",
        content: { "application/json": { schema: ErrorResponse } },
      },
      500: {
        description: "Handler error",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });
}
