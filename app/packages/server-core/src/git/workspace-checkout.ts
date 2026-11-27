/**
 * A workspace set up from git.infrawrench.com: an organization on the Pro
 * plan for a person who belongs to none, so their repositories there have
 * somewhere to run CI and review agents (client-core `git-forge.ts`,
 * `GIT_WORKSPACE_CHECKOUT_PATH`).
 *
 * The forge and the app each do half:
 *
 * - **The forge asks** for the organization's name and sends the browser to
 *   the app with a signed token (client-core
 *   `git-workspace-checkout-token.ts`) naming the person, the name and the
 *   id the organization will have. It writes nothing and has no Stripe key.
 * - **The app takes the payment**, with the same Pro Checkout its billing
 *   page opens, and when Stripe says it is complete creates the organization
 *   ({@link provisionGitWorkspace}): exactly what `POST /api/orgs` creates
 *   (`organizations/create.ts`), its subscription row, and the person's
 *   namespace connected to it when they already have one.
 *
 * Three things to know before changing it:
 *
 * - **Nothing exists until the payment is complete.** No organization, no
 *   subscription row, no hold. Someone who closes the payment page leaves a
 *   Stripe customer with no subscription and a session that expires, and
 *   nothing in this database: there is no unpaid organization to sweep.
 * - **The organization's id is the token's**, carried in the Checkout
 *   session's metadata. One token is one session (Stripe's idempotency key)
 *   and one organization (the primary key), which is what makes a redelivered
 *   webhook, and the browser's return racing it, create one.
 * - **A first username is the forge's to claim.** Someone still choosing
 *   their username has no namespace to connect; the forge's own claim
 *   connects it when they come back, as it does for any organization.
 *
 * Postgres only. Not for the forge's Worker to import: creating an
 * organization reaches modules a Worker bundle should not carry.
 */
import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { gitNamespaces, organizationMembers, subscriptions, users } from "../db/schema.js";
import { createOrganization } from "../organizations/create.js";
import { gitWorkspaceOf, setGitWorkspace } from "./workspace.js";

/**
 * Whether a person may be offered a workspace: `ok` when they exist and
 * belong to no organization. Someone who belongs to one has somewhere to run
 * already and is never offered a second from the forge.
 */
export async function gitWorkspaceOfferFor(
  userId: string,
): Promise<
  | { readonly status: "ok"; readonly email: string }
  | { readonly status: "no_user" }
  | { readonly status: "has_organization" }
> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return { status: "no_user" };
  const [membership] = await db
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, userId))
    .limit(1);
  return membership ? { status: "has_organization" } : { status: "ok", email: user.email };
}

export interface GitWorkspacePayment {
  /** The id the organization gets, from the session's metadata. */
  readonly organizationId: string;
  /** Its name, from the session's metadata. */
  readonly name: string;
  /** Who paid and becomes its owner, from the session's metadata. */
  readonly userId: string;
  /** The Stripe customer the session was opened for. */
  readonly stripeCustomerId: string;
}

export type GitWorkspaceProvision =
  | {
      readonly status: "provisioned";
      /** False when an earlier call had already created the organization. */
      readonly first: boolean;
      readonly organizationId: string;
      /** The person's namespace this call connected to it, for the audit log. */
      readonly connectedNamespace: { readonly id: string; readonly slug: string } | null;
    }
  /**
   * `no_user`: the account that paid is gone. `taken`: the id is someone
   * else's organization. Nothing was written; neither happens to a session
   * this module's caller opened, and the caller says so loudly.
   */
  | { readonly status: "refused"; readonly reason: "no_user" | "taken" };

/**
 * A workspace's payment is complete: create the organization with the person
 * as its owner, give it the subscription row its Stripe customer is found
 * by, and connect the person's namespace to it when they have one that runs
 * nowhere. Safe to call any number of times for one payment.
 */
export async function provisionGitWorkspace(
  payment: GitWorkspacePayment,
): Promise<GitWorkspaceProvision> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, payment.userId))
    .limit(1);
  if (!user) return { status: "refused", reason: "no_user" };

  const organization = await createOrganization({
    id: payment.organizationId,
    displayName: payment.name,
    ownerUserId: payment.userId,
  });
  if (!organization.ok) return { status: "refused", reason: organization.reason };

  // The row billing finds the organization by (`subscriptions.stripeCustomerId`):
  // the webhook's subscription writes land on it. A row with no
  // `stripeSubscriptionId` grants nothing by itself.
  await db
    .insert(subscriptions)
    .values({
      id: crypto.randomUUID(),
      organizationId: organization.id,
      stripeCustomerId: payment.stripeCustomerId,
      status: "trialing",
      seatCount: 1,
    })
    .onConflictDoNothing({ target: subscriptions.organizationId });

  // Only by the call that created the organization, and only a namespace
  // that runs nowhere: where it runs after that is the person's to change,
  // and a repeat of this call must not change it back.
  let connectedNamespace: { id: string; slug: string } | null = null;
  if (organization.created) {
    const [namespace] = await db
      .select({ id: gitNamespaces.id, slug: gitNamespaces.slug })
      .from(gitNamespaces)
      .where(and(eq(gitNamespaces.userId, payment.userId), eq(gitNamespaces.kind, "user")))
      .limit(1);
    if (namespace && (await gitWorkspaceOf(payment.userId)) === null) {
      const set = await setGitWorkspace(payment.userId, organization.id);
      if (set.ok) connectedNamespace = namespace;
    }
  }

  return {
    status: "provisioned",
    first: organization.created,
    organizationId: organization.id,
    connectedNamespace,
  };
}
