import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const Subscription = strict({
  status: z.enum(["trialing", "active", "past_due", "canceled", "unpaid"]),
  seatCount: z.number().int().nonnegative(),
  currentPeriodEnd: IsoDateTime.nullable(),
  stripeCustomerId: z.string(),
}).openapi("Subscription");

const CapacitySlot = strict({
  id: z.string(),
  quantity: z.number().int().positive().openapi({
    description: "Seats this purchase grants for the whole of its term.",
  }),
  status: z.enum(["active", "refunded"]).openapi({
    description:
      "A slot is only granting capacity when it is `active` AND `expiresAt` is still in the future.",
  }),
  startsAt: IsoDateTime,
  expiresAt: IsoDateTime,
  termMonths: z.number().int().positive(),
  amountPaidCents: z.number().int().nonnegative().nullable(),
}).openapi("CapacitySlot");

const CapacityStatus = strict({
  purchasable: z.boolean().openapi({
    description:
      "False when this deployment has no one-time capacity price configured; the purchase route returns 503 and clients should hide the offer.",
  }),
  termMonths: z.number().int().positive(),
  priceUsd: z.number().int().positive().openapi({
    description: "List price of one slot in whole dollars, for display copy.",
  }),
  seats: z.number().int().nonnegative().openapi({
    description:
      "Seats from slots still inside their term, excluding lapsed and refunded. ADDITIONAL to `subscription.seatCount`: an org's capacity is the two summed, and an org can hold slots with no subscription at all.",
  }),
  slots: z.array(CapacitySlot).openapi({
    description: "Every purchase ever made, newest first, including lapsed and refunded.",
  }),
}).openapi("CapacityStatus");

const BillingStatus = strict({
  complimentary: z.boolean().openapi({
    description:
      "Platform-granted complimentary access: all paid perks, uncapped AI chat, never billed.",
  }),
  subscription: Subscription.nullable(),
  capacity: CapacityStatus,
}).openapi("BillingStatus");

const RedirectUrl = strict({ url: z.string().url() }).openapi("StripeRedirectUrl");

const RevnuCheckoutMeasurement = strict({
  anonymousId: z.string().optional().openapi({
    description:
      "Opaque Revnu visitor id captured in the browser at checkout. Invalid values are ignored.",
  }),
  consentState: z.enum(["granted", "denied", "pending"]).optional().openapi({
    description:
      "Analytics consent for this checkout. A purchase with no saved answer is reported as unanswered, and one that was declined is not reported. Never copied into Stripe.",
  }),
}).openapi("RevnuCheckoutMeasurement");

const SubscriptionCheckoutRequest = strict({
  measurement: RevnuCheckoutMeasurement.optional(),
}).openapi("SubscriptionCheckoutRequest");

const CapacityCheckoutBody = strict({
  quantity: z.number().int().min(1).max(25).optional().openapi({
    description: "Slots to buy. Defaults to 1. The buyer can still adjust it in Checkout.",
  }),
  measurement: RevnuCheckoutMeasurement.optional(),
}).openapi("CapacityCheckoutRequest");

const RevnuConsentRefresh = strict({
  updated: z.number().int().nonnegative().openapi({
    description: "Unpaid checkouts whose saved consent was updated.",
  }),
}).openapi("RevnuConsentRefresh");

export function registerBillingPaths(ctx: BuildContext) {
  const { registry } = ctx;

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/billing/status",
    tags: ["Billing"],
    summary: "Get the org's billing status (complimentary flag + subscription or `null`)",
    request: { params: OrgIdParam },
    responses: {
      200: {
        description: "Billing status",
        content: { "application/json": { schema: BillingStatus } },
      },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/billing/checkout",
    tags: ["Billing"],
    summary: "Start a Stripe Checkout session",
    description: "Rejected with 400 for complimentary organizations; they are never billed.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: SubscriptionCheckoutRequest } },
        required: false,
      },
    },
    responses: {
      200: {
        description: "Redirect URL",
        content: { "application/json": { schema: RedirectUrl } },
      },
      400: ErrorResponses[400],
      500: ErrorResponses[500],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/billing/capacity/checkout",
    tags: ["Billing"],
    summary: "Start a Stripe Checkout session for prepaid capacity slots",
    description:
      "A capacity slot is one seat bought outright for a fixed term instead of rented monthly, and it grants paid-plan access on its own. This is a one-time payment, so the seats are granted by the `checkout.session.completed` webhook once Stripe confirms the payment; a 200 here only means the buyer was sent to a payment page. Rejected with 400 for complimentary organizations, and 503 when the deployment has no one-time capacity price configured.",
    request: {
      params: OrgIdParam,
      body: { content: { "application/json": { schema: CapacityCheckoutBody } } },
    },
    responses: {
      200: {
        description: "Redirect URL",
        content: { "application/json": { schema: RedirectUrl } },
      },
      400: ErrorResponses[400],
      500: ErrorResponses[500],
      503: ErrorResponses[503],
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

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/billing/measurement-consent",
    tags: ["Billing"],
    summary: "Update consent on unpaid checkouts for this visitor",
    description:
      "Rewrites the saved analytics consent on this user's Checkout Sessions that are not yet paid. A withdrawal reaches all of them; any other answer reaches the matching visitor's sessions and any still pending with no visitor id. A paid session is left as it was queued.",
    request: {
      params: OrgIdParam,
      body: {
        content: { "application/json": { schema: SubscriptionCheckoutRequest } },
        required: true,
      },
    },
    responses: {
      200: {
        description: "How many unpaid checkouts were updated",
        content: { "application/json": { schema: RevnuConsentRefresh } },
      },
      403: ErrorResponses[403],
    },
  });
}
