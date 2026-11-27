/**
 * The app's half of setting up a workspace from git.infrawrench.com
 * (server-core `git/workspace-checkout.ts` has the whole design): open the
 * Pro plan's Checkout session for the person and the organization name a
 * forge token carries, and, when the payment is complete, create the
 * organization with that person as its owner.
 *
 * Nothing new is billed here. The session is the billing page's own
 * (`createProCheckoutSession`: the same prices, seats and metered items), and
 * its subscription is recorded by the same write the webhook makes for any
 * organization (`applyCheckoutSubscription`). What differs is the order: the
 * organization is created after the payment instead of before it, so someone
 * who leaves the payment page leaves nothing behind.
 *
 * {@link settleGitWorkspaceCheckout} is called from two places with the same
 * session: Stripe's webhook, and the route Stripe sends the browser back to.
 * Whichever comes first does the work; the other finds it done.
 */
import type Stripe from "stripe";
import {
  GIT_WORKSPACE_CHECKOUT_PARAM,
  GIT_WORKSPACE_CHECKOUT_PATH,
  verifyGitWorkspaceCheckoutToken,
} from "@infrawrench/client-core";
import {
  gitWorkspaceOfferFor,
  provisionGitWorkspace,
  type GitWorkspaceProvision,
} from "@infrawrench/server-core/git/workspace-checkout";
import { createProCheckoutSession, createStripeCustomer } from "../http/domains/billing/operations";
import { logAudit } from "./audit";
import { appUrl, gitForgeReturnUrl } from "./git-forge-return";
import { getStripe } from "./stripe";
import { applyCheckoutSubscription, idOf } from "./subscription-checkout";

/** What marks a Checkout session as one of these. */
export const GIT_WORKSPACE_CHECKOUT_KIND = "git_workspace";

/** What the forge page is told when the browser comes back to it. */
export type GitWorkspaceCheckoutReturn =
  | "return"
  | "cancelled"
  | "expired"
  | "unavailable"
  /** Paid, and the organization could not be created: the one state that is not "nothing was charged". */
  | "failed";

/** Where the offer also is, for a browser that comes back without a page to name. */
const DEFAULT_RETURN_PATH = "/settings/organisations";

/** A page on the forge, with `?workspace=` saying why the browser is back. */
export function gitWorkspaceReturnUrl(
  returnPath: string | null | undefined,
  state: GitWorkspaceCheckoutReturn,
): string {
  return gitForgeReturnUrl({
    returnPath,
    fallback: DEFAULT_RETURN_PATH,
    param: GIT_WORKSPACE_CHECKOUT_PARAM,
    state,
  });
}

/**
 * The payment page for the workspace a checkout token names, or the forge
 * page to go back to when there is nothing to pay for (the token expired, or
 * the person is in an organization by now) or nothing to pay with (no Stripe
 * key, no Pro price).
 *
 * Writes nothing to the database. The link followed twice opens the same
 * page: the customer and the session are both created under idempotency keys
 * made from the organization's id, which the token carries.
 */
export async function openGitWorkspaceCheckout(token: string): Promise<string> {
  const key = process.env["GIT_JOB_TOKEN_KEY"];
  if (!key || !process.env["STRIPE_SECRET_KEY"] || !process.env["STRIPE_PRICE_ID"]) {
    return gitWorkspaceReturnUrl(null, "unavailable");
  }
  const verified = await verifyGitWorkspaceCheckoutToken(key, token);
  if (!verified.ok) return gitWorkspaceReturnUrl(null, "expired");
  const { organizationId, userId, name, returnPath } = verified.claims;

  const offer = await gitWorkspaceOfferFor(userId);
  if (offer.status === "no_user") return gitWorkspaceReturnUrl(returnPath, "expired");
  // They paid already, or joined one meanwhile: the page shows it, and there is nothing to buy.
  if (offer.status === "has_organization") return gitWorkspaceReturnUrl(returnPath, "return");

  const customer = await createStripeCustomer(
    organizationId,
    offer.email,
    `git-workspace-customer-${organizationId}`,
  );
  const session = await createProCheckoutSession({
    customerId: customer.id,
    organizationId,
    // The webhook reads who, what and where to go back to from here: there is
    // no row of ours to read them from until the payment is complete.
    metadata: {
      kind: GIT_WORKSPACE_CHECKOUT_KIND,
      userId,
      organizationName: name,
      returnPath,
    },
    successUrl: `${appUrl()}${GIT_WORKSPACE_CHECKOUT_PATH}/return?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: gitWorkspaceReturnUrl(returnPath, "cancelled"),
    idempotencyKey: `git-workspace-checkout-${organizationId}`,
  });
  return session.url ?? gitWorkspaceReturnUrl(returnPath, "unavailable");
}

/** Whether this Checkout session sets up a workspace from the forge. */
export function isGitWorkspaceCheckout(session: Stripe.Checkout.Session): boolean {
  return (
    session.mode === "subscription" && session.metadata?.["kind"] === GIT_WORKSPACE_CHECKOUT_KIND
  );
}

/**
 * A workspace's session, as Stripe reports it now: once it is complete and
 * paid, create the organization and record its subscription. Null while it
 * is not (still open, or a delayed payment method that has not settled), or
 * when the session does not say who and what it is for. Safe to call any
 * number of times for one session.
 */
export async function settleGitWorkspaceCheckout(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<GitWorkspaceProvision | null> {
  if (session.status !== "complete" || session.payment_status === "unpaid") return null;
  const organizationId = session.metadata?.["organizationId"];
  const userId = session.metadata?.["userId"];
  const name = session.metadata?.["organizationName"];
  if (!organizationId || !userId || !name || !session.customer) {
    console.error(`[git-workspace] session ${session.id} names no person, name or customer`);
    return null;
  }

  const outcome = await provisionGitWorkspace({
    organizationId,
    name,
    userId,
    stripeCustomerId: idOf(session.customer),
  });
  if (outcome.status === "refused") {
    // Paid for and not created: someone has to look at it. Neither reason
    // happens to a session this module opened for a person who still exists.
    console.error(
      `[git-workspace] session ${session.id} is paid but no organization was created: ${outcome.reason}`,
    );
    return outcome;
  }

  // On its plan from here, whichever of the webhook and the return got here first.
  await applyCheckoutSubscription(stripe, session);

  if (outcome.first) {
    void logAudit({
      organizationId,
      userId,
      action: "organization.create",
      entityType: "organization",
      entityId: organizationId,
      metadata: { name, source: "git.infrawrench.com" },
    });
  }
  if (outcome.connectedNamespace !== null) {
    // The row the forge writes when the organization is chosen on its own pages.
    void logAudit({
      organizationId,
      userId,
      action: "git.workspace.connect",
      entityType: "git_namespace",
      entityId: outcome.connectedNamespace.id,
      metadata: { slug: outcome.connectedNamespace.slug },
    });
  }
  return outcome;
}

/**
 * The browser is back from Stripe with its session's id: settle it if the
 * webhook has not, and answer the forge page to go on to.
 */
export async function returnFromGitWorkspaceCheckout(sessionId: string): Promise<string> {
  if (!process.env["STRIPE_SECRET_KEY"]) return gitWorkspaceReturnUrl(null, "unavailable");
  const stripe = getStripe();
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    // Not a session of ours: nothing to say but where the forge is.
    return gitWorkspaceReturnUrl(null, "expired");
  }
  if (!isGitWorkspaceCheckout(session)) return gitWorkspaceReturnUrl(null, "expired");
  const returnPath = session.metadata?.["returnPath"];
  const outcome = await settleGitWorkspaceCheckout(stripe, session);
  if (outcome === null) return gitWorkspaceReturnUrl(returnPath, "cancelled");
  return gitWorkspaceReturnUrl(returnPath, outcome.status === "provisioned" ? "return" : "failed");
}
