/**
 * The app's half of paying for a short username on git.infrawrench.com
 * (server-core `git/short-usernames.ts` has the whole design): open the
 * Stripe Checkout session for a hold the forge wrote, and, when the payment
 * settles, give the person the name or refund them.
 *
 * {@link settleGitUsernameCheckout} is called from two places with the same
 * session: Stripe's webhook, and the route Stripe sends the browser back to.
 * Whichever comes first does the work; the other finds it done.
 */
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import {
  GIT_USERNAME_CHECKOUT_PARAM,
  GIT_USERNAME_CHECKOUT_PATH,
  verifyGitUsernameCheckoutToken,
} from "@infrawrench/client-core";
import { gitBaseUrl } from "@infrawrench/server-core/ci/source";
import {
  attachGitUsernameCheckout,
  completeGitUsernamePurchase,
  gitUsernameHoldFor,
  gitUsernamePurchaseBySession,
  markGitUsernamePurchaseRefunded,
  type GitUsernamePurchaseOutcome,
} from "@infrawrench/server-core/git/short-usernames";
import { db } from "../db/client";
import { users } from "../db/schema";
import { logAudit } from "./audit";
import { getStripe, getStripeGitShortUsernamePriceId } from "./stripe";

/** What marks a Checkout session, and its PaymentIntent, as one of these. */
export const GIT_USERNAME_CHECKOUT_KIND = "git_short_username";

/**
 * How long the payment page stays open. Stripe's minimum is 30 minutes; the
 * minute on top keeps a slow request from landing under it.
 */
const SESSION_SECONDS = 31 * 60;
/** How much longer than its session a hold lasts, so the two never race. */
const HOLD_GRACE_SECONDS = 5 * 60;

/** What the forge page is told when the browser comes back to it. */
export type GitUsernameCheckoutReturn = "return" | "cancelled" | "expired" | "unavailable";

const DEFAULT_RETURN_PATH = "/onboarding/username";

/** A page on the forge, with `?checkout=` saying why the browser is back. */
export function gitUsernameReturnUrl(
  returnPath: string | null,
  state: GitUsernameCheckoutReturn,
): string {
  // Written by the forge, but it becomes a redirect: only ever a path on that site.
  const path =
    returnPath !== null && /^\/(?![/\\])/.test(returnPath) ? returnPath : DEFAULT_RETURN_PATH;
  const url = new URL(path, gitBaseUrl());
  url.searchParams.set(GIT_USERNAME_CHECKOUT_PARAM, state);
  return url.toString();
}

function appUrl(): string {
  return (process.env["APP_URL"] ?? "http://localhost:3000").replace(/\/$/, "");
}

/**
 * The payment page for the hold a checkout token names, or the forge page to
 * go back to when there is nothing to pay for (the token or the hold expired)
 * or nothing to pay with (no Stripe key, no price).
 */
export async function openGitUsernameCheckout(token: string): Promise<string> {
  const key = process.env["GIT_JOB_TOKEN_KEY"];
  if (!key || !process.env["STRIPE_SECRET_KEY"]) {
    return gitUsernameReturnUrl(null, "unavailable");
  }
  const verified = await verifyGitUsernameCheckoutToken(key, token);
  if (!verified.ok) return gitUsernameReturnUrl(null, "expired");
  const { holdId, userId } = verified.claims;
  const hold = await gitUsernameHoldFor(holdId, userId);
  if (!hold) return gitUsernameReturnUrl(null, "expired");

  const stripe = getStripe();
  // The link followed twice opens the same page, not a second payment.
  if (hold.stripeCheckoutSessionId !== null) {
    const open = await stripe.checkout.sessions.retrieve(hold.stripeCheckoutSessionId);
    if (open.status === "open" && open.url) return open.url;
  }
  const priceId = await getStripeGitShortUsernamePriceId();
  if (priceId === null) return gitUsernameReturnUrl(hold.returnPath, "unavailable");
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return gitUsernameReturnUrl(hold.returnPath, "expired");

  // The webhook reads who and what from here, never from the hold, which may be gone by then.
  const metadata = {
    kind: GIT_USERNAME_CHECKOUT_KIND,
    userId,
    username: hold.slug,
    holdId: hold.id,
  };
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: user.email,
    client_reference_id: userId,
    // Cards settle while the person is still on the page. A method that
    // settles days later would outlive the hold.
    payment_method_types: ["card"],
    metadata,
    payment_intent_data: {
      metadata,
      description: `git.infrawrench.com username ${hold.slug}`,
      receipt_email: user.email,
    },
    expires_at: expiresAt,
    success_url: `${appUrl()}${GIT_USERNAME_CHECKOUT_PATH}/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: gitUsernameReturnUrl(hold.returnPath, "cancelled"),
  });
  if (!session.url) return gitUsernameReturnUrl(hold.returnPath, "unavailable");
  await attachGitUsernameCheckout(
    hold.id,
    session.id,
    new Date((expiresAt + HOLD_GRACE_SECONDS) * 1000),
  );
  return session.url;
}

/** Whether this Checkout session pays for a short username. */
export function isGitUsernameCheckout(session: Stripe.Checkout.Session): boolean {
  return session.mode === "payment" && session.metadata?.["kind"] === GIT_USERNAME_CHECKOUT_KIND;
}

/** Stripe's answer to refunding a charge that is already refunded in full. */
function alreadyRefunded(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "charge_already_refunded"
  );
}

/**
 * A username payment's session, as Stripe reports it now: claim the name if
 * it is paid, or refund it when the name is gone. Null while it is unpaid, or
 * when the session does not say who it is for. Safe to call any number of
 * times for one session.
 */
export async function settleGitUsernameCheckout(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<GitUsernamePurchaseOutcome | null> {
  if (session.payment_status !== "paid") return null;
  const userId = session.metadata?.["userId"];
  const slug = session.metadata?.["username"];
  if (!userId || !slug) {
    console.error(`[git-username] session ${session.id} names no person or no username`);
    return null;
  }
  const paymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  const outcome = await completeGitUsernamePurchase({
    userId,
    slug,
    holdId: session.metadata?.["holdId"] ?? null,
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: paymentIntentId,
    amountPaidCents: session.amount_total,
    currency: session.currency,
  });

  if (outcome.status === "refund_due") {
    // Until this goes through the row stays `refund_due`, and a throw here
    // makes Stripe deliver the event again. The key makes that one refund.
    if (paymentIntentId !== null) {
      try {
        await stripe.refunds.create(
          {
            payment_intent: paymentIntentId,
            metadata: { kind: GIT_USERNAME_CHECKOUT_KIND, reason: "username_unavailable" },
          },
          { idempotencyKey: `git-username-refund-${session.id}` },
        );
      } catch (error) {
        if (!alreadyRefunded(error)) throw error;
      }
    }
    await markGitUsernamePurchaseRefunded(session.id);
    console.log(`[git-username] refunded session ${session.id}: the username was no longer free`);
    return { ...outcome, status: "refunded" };
  }

  if (outcome.first && outcome.connectedOrganizationId !== null && outcome.namespaceId !== null) {
    // The row the forge writes when the organisation is chosen without a payment.
    void logAudit({
      organizationId: outcome.connectedOrganizationId,
      userId,
      action: "git.workspace.connect",
      entityType: "git_namespace",
      entityId: outcome.namespaceId,
      metadata: { slug: outcome.slug },
    });
  }
  return outcome;
}

/**
 * The browser is back from Stripe with its session's id: settle it if the
 * webhook has not, and answer the forge page to go on to.
 */
export async function returnFromGitUsernameCheckout(sessionId: string): Promise<string> {
  if (!process.env["STRIPE_SECRET_KEY"]) return gitUsernameReturnUrl(null, "unavailable");
  const stripe = getStripe();
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    // Not a session of ours: nothing to say but where the forge is.
    return gitUsernameReturnUrl(null, "expired");
  }
  if (!isGitUsernameCheckout(session)) return gitUsernameReturnUrl(null, "expired");
  const outcome = await settleGitUsernameCheckout(stripe, session);
  // A rename's hold is gone once it settled; the purchase says which page it was.
  const purchase = outcome ? await gitUsernamePurchaseBySession(session.id) : null;
  const returnPath = outcome?.returnPath ?? (purchase?.kind === "rename" ? "/settings" : null);
  return gitUsernameReturnUrl(returnPath, outcome ? "return" : "cancelled");
}
