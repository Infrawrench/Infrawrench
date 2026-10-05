import { z } from "../zod";
import { strict, ErrorResponse } from "../common";
import type { BuildContext } from "../context";

export function registerWebhookPaths(ctx: BuildContext) {
  ctx.registry.registerPath({
    method: "post",
    path: "/api/v1/webhooks/workos",
    tags: ["Webhooks"],
    summary: "WorkOS webhook endpoint",
    description:
      "Public; verifies the `WorkOS-Signature` header (HMAC-SHA256 over `<t>.<raw body>`, " +
      "five-minute tolerance) and ignores redelivered event ids. Directory Sync, SSO connection " +
      "and organization domain events.",
    security: [],
    request: {
      headers: strict({
        "workos-signature": z.string().openapi({ description: "WorkOS webhook signature" }),
      }),
      body: { content: { "application/json": { schema: z.unknown() } }, required: true },
    },
    responses: {
      200: {
        description: "Acknowledged",
        content: {
          "application/json": {
            schema: strict({ received: z.literal(true), duplicate: z.boolean().optional() }),
          },
        },
      },
      400: {
        description: "Bad signature or malformed event",
        content: { "application/json": { schema: ErrorResponse } },
      },
      500: {
        description: "Handler error; WorkOS retries",
        content: { "application/json": { schema: ErrorResponse } },
      },
      503: {
        description: "Webhook secret not configured",
        content: { "application/json": { schema: ErrorResponse } },
      },
    },
  });

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
