/**
 * Billing: `/api/org/:orgId/billing`, the endpoint definitions. Stripe
 * Checkout for the monthly plan and for prepaid capacity slots, the customer
 * portal, and the Revnu consent refresh.
 *
 * The checkout bodies were always read leniently (an absent or unreadable body
 * is `{}`, an invalid measurement is dropped, `quantity` is checked by hand
 * with its own sentence), so those endpoints are served with `handleRaw` and
 * their payloads document the body without decoding it.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import {
  BadRequest,
  Forbidden,
  InternalServerError,
  NotFound,
  ServiceUnavailable,
} from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgParams } from "../../schemas/common";
import { optionalRequestBody } from "../../schemas/documented";

// Described before the bound is checked: Effect drops a description annotated after a check.
const nonNegativeInt = (description?: string) =>
  (description === undefined ? Schema.Int : Schema.Int.annotate({ description })).check(
    Schema.isGreaterThanOrEqualTo(0),
  );
const positiveInt = (description?: string) =>
  (description === undefined ? Schema.Int : Schema.Int.annotate({ description })).check(
    Schema.isGreaterThan(0),
  );

const Subscription = Schema.Struct({
  status: Schema.Literals(["trialing", "active", "past_due", "canceled", "unpaid"]),
  seatCount: nonNegativeInt(),
  currentPeriodEnd: Schema.NullOr(IsoDateTime),
  stripeCustomerId: Schema.String,
}).annotate({ identifier: "Subscription" });

const CapacitySlot = Schema.Struct({
  id: Schema.String,
  quantity: positiveInt("Seats this purchase grants for the whole of its term."),
  status: Schema.Literals(["active", "refunded"]).annotate({
    description:
      "A slot is only granting capacity when it is `active` AND `expiresAt` is still in the future.",
  }),
  startsAt: IsoDateTime,
  expiresAt: IsoDateTime,
  termMonths: positiveInt(),
  amountPaidCents: Schema.NullOr(nonNegativeInt()),
}).annotate({ identifier: "CapacitySlot" });

const CapacityStatus = Schema.Struct({
  purchasable: Schema.Boolean.annotate({
    description:
      "False when this deployment has no one-time capacity price configured; the purchase route returns 503 and clients should hide the offer.",
  }),
  termMonths: positiveInt(),
  priceUsd: positiveInt("List price of one slot in whole dollars, for display copy."),
  seats: nonNegativeInt(
    "Seats from slots still inside their term, excluding lapsed and refunded. ADDITIONAL to `subscription.seatCount`: an org's capacity is the two summed, and an org can hold slots with no subscription at all.",
  ),
  slots: Schema.Array(CapacitySlot).annotate({
    description: "Every purchase ever made, newest first, including lapsed and refunded.",
  }),
}).annotate({ identifier: "CapacityStatus" });

export const BillingStatus = Schema.Struct({
  complimentary: Schema.Boolean.annotate({
    description:
      "Platform-granted complimentary access: all paid perks, uncapped AI chat, never billed.",
  }),
  subscription: Schema.NullOr(Subscription),
  capacity: CapacityStatus,
}).annotate({ identifier: "BillingStatus" });

export const StripeRedirectUrl = Schema.Struct({
  url: Schema.String.annotate({ format: "uri" }),
}).annotate({ identifier: "StripeRedirectUrl" });

const RevnuCheckoutMeasurement = Schema.Struct({
  anonymousId: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Opaque Revnu visitor id captured in the browser at checkout. Invalid values are ignored.",
    }),
  ),
  consentState: Schema.optionalKey(
    Schema.Literals(["granted", "denied", "pending"]).annotate({
      description:
        "Analytics consent for this checkout. A purchase with no saved answer is reported as unanswered, and one that was declined is not reported. Never copied into Stripe.",
    }),
  ),
}).annotate({ identifier: "RevnuCheckoutMeasurement" });

const SubscriptionCheckoutRequest = Schema.Struct({
  measurement: Schema.optionalKey(RevnuCheckoutMeasurement),
}).annotate({ identifier: "SubscriptionCheckoutRequest" });

const CapacityCheckoutRequest = Schema.Struct({
  quantity: Schema.optionalKey(
    Schema.Int.annotate({
      description: "Slots to buy. Defaults to 1. The buyer can still adjust it in Checkout.",
    }).check(Schema.isBetween({ minimum: 1, maximum: 25 })),
  ),
  measurement: Schema.optionalKey(RevnuCheckoutMeasurement),
}).annotate({ identifier: "CapacityCheckoutRequest" });

export const RevnuConsentRefresh = Schema.Struct({
  updated: nonNegativeInt("Unpaid checkouts whose saved consent was updated."),
}).annotate({ identifier: "RevnuConsentRefresh" });

export class BillingGroup extends HttpApiGroup.make("billing")
  .add(
    HttpApiEndpoint.get("status", "/status", {
      params: OrgParams,
      success: BillingStatus,
    })
      .annotate(RequiredPermission, "billing:read")
      .annotate(
        OpenApi.Summary,
        "Get the org's billing status (complimentary flag + subscription or `null`)",
      )
      .annotate(SuccessDescription, "Billing status"),
    HttpApiEndpoint.post("checkout", "/checkout", {
      params: OrgParams,
      payload: SubscriptionCheckoutRequest,
      success: StripeRedirectUrl,
      error: [BadRequest, InternalServerError],
    })
      .annotate(RequiredPermission, "billing:write")
      .annotate(OpenApi.Summary, "Start a Stripe Checkout session")
      .annotate(
        OpenApi.Description,
        "Rejected with 400 for complimentary organizations; they are never billed.",
      )
      .annotate(SuccessDescription, "Redirect URL")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("capacityCheckout", "/capacity/checkout", {
      params: OrgParams,
      payload: CapacityCheckoutRequest,
      success: StripeRedirectUrl,
      error: [BadRequest, InternalServerError, ServiceUnavailable],
    })
      .annotate(RequiredPermission, "billing:write")
      .annotate(OpenApi.Summary, "Start a Stripe Checkout session for prepaid capacity slots")
      .annotate(
        OpenApi.Description,
        "A capacity slot is one seat bought outright for a fixed term instead of rented monthly, and it grants paid-plan access on its own. This is a one-time payment, so the seats are granted by the `checkout.session.completed` webhook once Stripe confirms the payment; a 200 here only means the buyer was sent to a payment page. Rejected with 400 for complimentary organizations, and 503 when the deployment has no one-time capacity price configured.",
      )
      .annotate(SuccessDescription, "Redirect URL")
      .annotate(OpenApi.Transform, optionalRequestBody),
    HttpApiEndpoint.post("portal", "/portal", {
      params: OrgParams,
      success: StripeRedirectUrl,
      error: NotFound,
    })
      .annotate(RequiredPermission, "billing:write")
      .annotate(OpenApi.Summary, "Get a Stripe customer portal URL")
      .annotate(SuccessDescription, "Redirect URL"),
    HttpApiEndpoint.post("measurementConsent", "/measurement-consent", {
      params: OrgParams,
      payload: SubscriptionCheckoutRequest,
      success: RevnuConsentRefresh,
      error: Forbidden,
    })
      .annotate(RequiredPermission, "billing:write")
      .annotate(OpenApi.Summary, "Update consent on unpaid checkouts for this visitor")
      .annotate(
        OpenApi.Description,
        "Rewrites the saved analytics consent on this user's Checkout Sessions that are not yet paid. A withdrawal reaches all of them; any other answer reaches the matching visitor's sessions and any still pending with no visitor id. A paid session is left as it was queued.",
      )
      .annotate(SuccessDescription, "How many unpaid checkouts were updated"),
  )
  .prefix("/api/org/:orgId/billing")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Billing") {}

export class BillingApi extends withApiDefaults(HttpApi.make("billing").add(BillingGroup)) {}
