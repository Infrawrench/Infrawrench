/**
 * Billing: `/api/org/:orgId/billing`, the handlers. The database and Stripe
 * calls are promise code (`./operations.ts`) run through `legacy`; the
 * refusals are checked here, in the order the routes checked them.
 */
import { Effect, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import {
  BadRequest,
  badRequest,
  BillingApi,
  BillingStatus,
  InternalServerError,
  notFound,
  RevnuConsentRefresh,
  ServiceUnavailable,
  StripeRedirectUrl,
} from "@infrawrench/api-contract";
import { refreshUnreportedConsent } from "../../../services/revnu-checkout";
import { getStripeCapacitySlotPriceId } from "../../../services/stripe";
import { makeDomain } from "../../domain";
import { readJsonOr } from "../../request-body";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import {
  MAX_SLOTS_PER_PURCHASE,
  billingStatus,
  isComplimentary,
  measurementFromBody,
  openCapacityCheckout,
  openPortal,
  openSubscriptionCheckout,
  type Buyer,
} from "./operations";

const nothingToBuy = () =>
  new BadRequest({ error: "This organization has complimentary access; nothing to buy" });

const noCheckoutUrl = () => new InternalServerError({ error: "Failed to create checkout session" });

/** The org-tree caller, as a checkout records it. */
const buyer = Effect.gen(function* () {
  const { organizationId, session } = yield* OrgPrincipal;
  const who: Buyer = { userId: session.userId, email: session.email };
  return { organizationId, buyer: who };
});

/**
 * The slots a capacity body asks for: 1 when it names none, otherwise a whole
 * number in range, because it becomes a charge.
 */
const requestedSlots = (raw: unknown): Effect.Effect<number, BadRequest> => {
  if (!Predicate.hasProperty(raw, "quantity")) return Effect.succeed(1);
  const q = raw.quantity;
  return Predicate.isNumber(q) && Number.isInteger(q) && q >= 1 && q <= MAX_SLOTS_PER_PURCHASE
    ? Effect.succeed(q)
    : Effect.fail(
        badRequest(`quantity must be a whole number between 1 and ${MAX_SLOTS_PER_PURCHASE}`),
      );
};

const BillingHandlers = HttpApiBuilder.group(BillingApi, "billing", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const status = yield* legacy(() => billingStatus(organizationId));
        return yield* respond(BillingStatus)(status);
      }),
    )
    // The body is read as `c.req.json().catch(() => ({}))` was: an absent or
    // unreadable one is `{}`, and a measurement that does not parse is dropped.
    .handleRaw("checkout", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, buyer: who } = yield* buyer;
        if (yield* legacy(() => isComplimentary(organizationId))) return yield* nothingToBuy();
        const body = yield* readJsonOr(request, {});
        const url = yield* legacy(() => openSubscriptionCheckout(organizationId, who, body));
        if (!url) return yield* noCheckoutUrl();
        return yield* respond(StripeRedirectUrl)({ url });
      }),
    )
    .handleRaw("capacityCheckout", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, buyer: who } = yield* buyer;
        if (yield* legacy(() => isComplimentary(organizationId))) return yield* nothingToBuy();
        const priceId = getStripeCapacitySlotPriceId();
        if (!priceId) {
          return yield* new ServiceUnavailable({
            error: "Prepaid capacity slots are not configured on this deployment",
          });
        }
        const body = yield* readJsonOr(request, {});
        const quantity = yield* requestedSlots(body);
        const url = yield* legacy(() =>
          openCapacityCheckout(organizationId, who, priceId, quantity, body),
        );
        if (!url) return yield* noCheckoutUrl();
        return yield* respond(StripeRedirectUrl)({ url });
      }),
    )
    .handle("portal", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const url = yield* legacy(() => openPortal(organizationId));
        if (url === null) return yield* notFound("No subscription found");
        return yield* respond(StripeRedirectUrl)({ url });
      }),
    )
    // A visitor changed analytics consent after a checkout session was opened
    // and before it was paid. Paid purchases are left as they were queued,
    // because Revnu refuses a retry with a changed body.
    .handleRaw("measurementConsent", ({ request }) =>
      Effect.gen(function* () {
        const { organizationId, buyer: who } = yield* buyer;
        const measurement = measurementFromBody(yield* readJsonOr(request, {}));
        const updated = yield* legacy(() =>
          refreshUnreportedConsent(organizationId, who.userId, measurement),
        );
        return yield* respond(RevnuConsentRefresh)({ updated });
      }),
    ),
);

export const billingDomain = makeDomain("billing", BillingApi, BillingHandlers);
