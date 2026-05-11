import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const Subscription = strict({
  status: z.enum(["trialing", "active", "past_due", "canceled", "unpaid"]),
  seatCount: z.number().int().nonnegative(),
  currentPeriodEnd: IsoDateTime.nullable(),
  stripeCustomerId: z.string(),
}).openapi("Subscription");

const RedirectUrl = strict({ url: z.string().url() }).openapi("StripeRedirectUrl");

export function registerBillingPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/billing/status",
    tags: ["Billing"],
    summary: "Get the current subscription (or `null` for free tier)",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Subscription or null",
        content: { "application/json": { schema: Subscription.nullable() } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/billing/checkout",
    tags: ["Billing"],
    summary: "Start a Stripe Checkout session",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Redirect URL",
        content: { "application/json": { schema: RedirectUrl } },
      },
      500: ErrorResponses[500],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/billing/portal",
    tags: ["Billing"],
    summary: "Get a Stripe customer portal URL",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Redirect URL",
        content: { "application/json": { schema: RedirectUrl } },
      },
      404: ErrorResponses[404],
    },
  });
}
