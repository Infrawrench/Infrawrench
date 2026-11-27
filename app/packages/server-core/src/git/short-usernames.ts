/**
 * Short usernames on git.infrawrench.com, which a person pays for once
 * (client-core `git-forge.ts`, `GIT_SHORT_USERNAME_MAX_LENGTH`).
 *
 * The forge and the app each do half, over the tables they share:
 *
 * - **The forge holds the name** ({@link holdGitUsername}) for the person
 *   who is about to pay, so nobody takes it while they are at Checkout, and
 *   sends their browser to the app. It has no Stripe key.
 * - **The app takes the payment** and, when Stripe says it settled, gives
 *   the person the name ({@link completeGitUsernamePurchase}): exactly the
 *   rows the forge's own claim writes ({@link insertGitUserNamespace}, which
 *   the forge calls too), or a rename when they already have a username.
 *
 * Three things to know before changing it:
 *
 * - **A hold is computed, not swept.** It counts until `expiresAt`; an
 *   expired row is not a hold, and the next hold on the name or by the
 *   person deletes it.
 * - **Completing never depends on the hold.** The payment names the person
 *   and the name itself, so a payment that settles after its hold expired
 *   still gets the name when it is free. When it is not (someone claimed it,
 *   or holds it now), the purchase is recorded `refund_due` and the caller
 *   refunds it.
 * - **One row per Checkout session** (`git_username_purchases`, a unique
 *   index) is what makes a redelivered webhook, and the browser's return
 *   racing it, do the work once.
 *
 * Organisations never pay: nothing here is called for their names, except
 * {@link gitUsernameHeld}, which keeps one from taking a name mid-payment.
 *
 * Postgres only, and imported by the forge's Worker: nothing here may reach
 * plugin code, a socket driver or Stripe.
 */
import { and, desc, eq, gt, lte, ne, or } from "drizzle-orm";
import { GIT_USERNAME_HOLD_MINUTES } from "@infrawrench/client-core";

import { db } from "../db/client.js";
import { users } from "../db/core-schema.js";
import {
  gitNamespaces,
  gitUsernameHolds,
  gitUsernamePurchases,
  gitUsers,
  type GitUsernamePurchaseStatus,
} from "../db/schema.js";
import { setGitWorkspace } from "./workspace.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type NamespaceRow = typeof gitNamespaces.$inferSelect;
export type GitUsernameHoldRow = typeof gitUsernameHolds.$inferSelect;
export type GitUsernamePurchaseRow = typeof gitUsernamePurchases.$inferSelect;

/** Postgres's unique violation, as the driver or drizzle's wrapper reports it. */
function isUniqueViolation(error: unknown): boolean {
  for (let e = error, depth = 0; e !== null && typeof e === "object" && depth < 5; depth++) {
    if ("code" in e && e.code === "23505") return true;
    e = "cause" in e ? e.cause : null;
  }
  return false;
}

/**
 * A person's first username: the namespace row, and `onboardedAt` on their
 * `git_users` row. Null when the slug is taken or the person already has a
 * namespace: the unique indexes decide, and nothing is written.
 */
export async function insertGitUserNamespace(
  tx: Tx,
  input: {
    readonly userId: string;
    readonly slug: string;
    readonly displayName?: string | null;
  },
): Promise<NamespaceRow | null> {
  const [row] = await tx
    .insert(gitNamespaces)
    .values({
      id: crypto.randomUUID(),
      slug: input.slug,
      slugLower: input.slug.toLowerCase(),
      kind: "user",
      userId: input.userId,
      displayName: input.displayName ?? null,
      claimedByUserId: input.userId,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  const now = new Date();
  await tx
    .insert(gitUsers)
    .values({ userId: input.userId, onboardedAt: now })
    .onConflictDoUpdate({
      target: gitUsers.userId,
      set: { onboardedAt: now, suggestedSlug: null, updatedAt: now },
    });
  return row;
}

/**
 * Whether someone is paying for `slug` right now: a live hold, other than
 * `exceptUserId`'s own. A held name reads as taken to everyone else,
 * organisations included.
 */
export async function gitUsernameHeld(
  slug: string,
  exceptUserId: string | null = null,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: gitUsernameHolds.id })
    .from(gitUsernameHolds)
    .where(
      and(
        eq(gitUsernameHolds.slugLower, slug.toLowerCase()),
        gt(gitUsernameHolds.expiresAt, now),
        exceptUserId === null ? undefined : ne(gitUsernameHolds.userId, exceptUserId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The person's hold, while it lasts. */
export async function liveGitUsernameHold(
  userId: string,
  now: Date = new Date(),
): Promise<GitUsernameHoldRow | null> {
  const [row] = await db
    .select()
    .from(gitUsernameHolds)
    .where(and(eq(gitUsernameHolds.userId, userId), gt(gitUsernameHolds.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

/** A hold by its id, for the person a checkout token names. Null once it has expired. */
export async function gitUsernameHoldFor(
  holdId: string,
  userId: string,
  now: Date = new Date(),
): Promise<GitUsernameHoldRow | null> {
  const [row] = await db
    .select()
    .from(gitUsernameHolds)
    .where(
      and(
        eq(gitUsernameHolds.id, holdId),
        eq(gitUsernameHolds.userId, userId),
        gt(gitUsernameHolds.expiresAt, now),
      ),
    )
    .limit(1);
  return row ?? null;
}

export type HoldGitUsernameResult =
  | { readonly ok: true; readonly hold: GitUsernameHoldRow }
  /** Someone has the name, or is paying for it. */
  | { readonly ok: false; readonly reason: "taken" };

/**
 * Keep `slug` for the person for {@link GIT_USERNAME_HOLD_MINUTES}. Replaces
 * whatever they held before (they changed their mind) and any expired hold
 * on the name. The caller has checked the name's shape and that it is one
 * that is paid for.
 */
export async function holdGitUsername(input: {
  readonly userId: string;
  readonly slug: string;
  readonly workspaceOrganizationId: string | null;
  readonly returnPath: string;
  readonly now?: Date;
}): Promise<HoldGitUsernameResult> {
  const now = input.now ?? new Date();
  const slugLower = input.slug.toLowerCase();
  try {
    return await db.transaction(async (tx): Promise<HoldGitUsernameResult> => {
      await tx
        .delete(gitUsernameHolds)
        .where(
          or(
            eq(gitUsernameHolds.userId, input.userId),
            and(eq(gitUsernameHolds.slugLower, slugLower), lte(gitUsernameHolds.expiresAt, now)),
          ),
        );
      const [taken] = await tx
        .select({ id: gitNamespaces.id })
        .from(gitNamespaces)
        .where(eq(gitNamespaces.slugLower, slugLower))
        .limit(1);
      if (taken) return { ok: false, reason: "taken" };
      const [hold] = await tx
        .insert(gitUsernameHolds)
        .values({
          id: crypto.randomUUID(),
          slug: input.slug,
          slugLower,
          userId: input.userId,
          workspaceOrganizationId: input.workspaceOrganizationId,
          returnPath: input.returnPath,
          expiresAt: new Date(now.getTime() + GIT_USERNAME_HOLD_MINUTES * 60_000),
        })
        .returning();
      return { ok: true, hold: hold! };
    });
  } catch (error) {
    // The name's own index: someone else's hold on it is still live.
    if (!isUniqueViolation(error)) throw error;
    return { ok: false, reason: "taken" };
  }
}

/** Give a hold up: the person cancelled, or chose a name that is free. */
export async function releaseGitUsernameHold(userId: string): Promise<void> {
  await db.delete(gitUsernameHolds).where(eq(gitUsernameHolds.userId, userId));
}

/**
 * Note the Checkout session opened for a hold, and keep the hold until that
 * session can no longer be paid. False when the hold is gone.
 */
export async function attachGitUsernameCheckout(
  holdId: string,
  stripeCheckoutSessionId: string,
  expiresAt: Date,
): Promise<boolean> {
  const [row] = await db
    .update(gitUsernameHolds)
    .set({ stripeCheckoutSessionId, expiresAt })
    .where(eq(gitUsernameHolds.id, holdId))
    .returning({ id: gitUsernameHolds.id });
  return row !== undefined;
}

export interface GitUsernamePayment {
  /** Who paid, from the session's metadata. */
  readonly userId: string;
  /** The name they paid for, as spelled, from the session's metadata. */
  readonly slug: string;
  /** The hold the session was opened for, when it is still there. */
  readonly holdId: string | null;
  readonly stripeCheckoutSessionId: string;
  readonly stripePaymentIntentId: string | null;
  readonly amountPaidCents: number | null;
  readonly currency: string | null;
  readonly now?: Date;
}

export interface GitUsernamePurchaseOutcome {
  /** `refund_due`: the caller refunds the payment, then {@link markGitUsernamePurchaseRefunded}. */
  readonly status: GitUsernamePurchaseStatus;
  /** False when an earlier call had already settled this session: nothing was written. */
  readonly first: boolean;
  readonly slug: string;
  /** The organisation the new namespace was connected to, for the audit log. */
  readonly connectedOrganizationId: string | null;
  readonly namespaceId: string | null;
  /** Where on the forge the person goes back to; null when the hold is gone. */
  readonly returnPath: string | null;
}

/**
 * A payment for a short username settled: give the person the name, once.
 *
 * Idempotent by Checkout session: the purchase row is inserted first, inside
 * the transaction that claims, and a second call for the same session finds
 * it and reports what the first one did. When the name cannot be given (it
 * was claimed meanwhile, someone else is paying for it, the person already
 * has it, or their account is gone) the row says `refund_due` and nothing
 * else is written.
 */
export async function completeGitUsernamePurchase(
  payment: GitUsernamePayment,
): Promise<GitUsernamePurchaseOutcome> {
  const now = payment.now ?? new Date();
  const slugLower = payment.slug.toLowerCase();

  const settled = await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, payment.userId))
      .limit(1);
    const [current] = await tx
      .select()
      .from(gitNamespaces)
      .where(eq(gitNamespaces.userId, payment.userId))
      .limit(1);
    const [purchase] = await tx
      .insert(gitUsernamePurchases)
      .values({
        id: crypto.randomUUID(),
        userId: user ? user.id : null,
        slug: payment.slug,
        kind: current ? "rename" : "claim",
        status: "refund_due",
        stripeCheckoutSessionId: payment.stripeCheckoutSessionId,
        stripePaymentIntentId: payment.stripePaymentIntentId,
        amountPaidCents: payment.amountPaidCents,
        currency: payment.currency,
      })
      .onConflictDoNothing({ target: gitUsernamePurchases.stripeCheckoutSessionId })
      .returning();
    if (!purchase) return null;

    const [hold] =
      payment.holdId === null
        ? []
        : await tx
            .select()
            .from(gitUsernameHolds)
            .where(
              and(
                eq(gitUsernameHolds.id, payment.holdId),
                eq(gitUsernameHolds.userId, payment.userId),
              ),
            )
            .limit(1);
    const refundDue = {
      status: "refund_due" as const,
      namespace: null,
      hold: hold ?? null,
      kind: purchase.kind,
    };
    if (!user) return refundDue;

    const [heldByAnother] = await tx
      .select({ id: gitUsernameHolds.id })
      .from(gitUsernameHolds)
      .where(
        and(
          eq(gitUsernameHolds.slugLower, slugLower),
          ne(gitUsernameHolds.userId, payment.userId),
          gt(gitUsernameHolds.expiresAt, now),
        ),
      )
      .limit(1);
    if (heldByAnother) return refundDue;

    let namespace: NamespaceRow | null = null;
    if (current) {
      // Theirs already (a second payment for the same name), or someone's.
      const [taken] = await tx
        .select({ id: gitNamespaces.id })
        .from(gitNamespaces)
        .where(eq(gitNamespaces.slugLower, slugLower))
        .limit(1);
      if (taken) return refundDue;
      // A claim that lands between the read and this fails the transaction on
      // the slug's index; the redelivery then finds the name taken.
      const [renamed] = await tx
        .update(gitNamespaces)
        .set({ slug: payment.slug, slugLower, renamedAt: now, updatedAt: now })
        .where(eq(gitNamespaces.id, current.id))
        .returning();
      namespace = renamed ?? null;
    } else {
      namespace = await insertGitUserNamespace(tx, {
        userId: payment.userId,
        slug: payment.slug,
        displayName: user.displayName,
      });
    }
    if (!namespace) return refundDue;

    await tx
      .update(gitUsernamePurchases)
      .set({ status: "claimed", updatedAt: now })
      .where(eq(gitUsernamePurchases.id, purchase.id));
    await tx.delete(gitUsernameHolds).where(eq(gitUsernameHolds.userId, payment.userId));
    return { status: "claimed" as const, namespace, hold: hold ?? null, kind: purchase.kind };
  });

  if (settled === null) {
    const existing = await gitUsernamePurchaseBySession(payment.stripeCheckoutSessionId);
    return {
      status: existing?.status ?? "refund_due",
      first: false,
      slug: existing?.slug ?? payment.slug,
      connectedOrganizationId: null,
      namespaceId: null,
      returnPath: null,
    };
  }

  // The organisation chosen on the username page, as the forge's own claim connects it.
  let connectedOrganizationId: string | null = null;
  const workspace = settled.hold?.workspaceOrganizationId ?? null;
  if (settled.status === "claimed" && settled.kind === "claim" && workspace !== null) {
    const set = await setGitWorkspace(payment.userId, workspace);
    if (set.ok) connectedOrganizationId = set.organizationId;
  }
  return {
    status: settled.status,
    first: true,
    slug: payment.slug,
    connectedOrganizationId,
    namespaceId: settled.namespace?.id ?? null,
    returnPath: settled.hold?.returnPath ?? null,
  };
}

/** The purchase a Checkout session made, if one settled. */
export async function gitUsernamePurchaseBySession(
  stripeCheckoutSessionId: string,
): Promise<GitUsernamePurchaseRow | null> {
  const [row] = await db
    .select()
    .from(gitUsernamePurchases)
    .where(eq(gitUsernamePurchases.stripeCheckoutSessionId, stripeCheckoutSessionId))
    .limit(1);
  return row ?? null;
}

/** The refund of a `refund_due` purchase went through. */
export async function markGitUsernamePurchaseRefunded(
  stripeCheckoutSessionId: string,
): Promise<void> {
  await db
    .update(gitUsernamePurchases)
    .set({ status: "refunded", updatedAt: new Date() })
    .where(
      and(
        eq(gitUsernamePurchases.stripeCheckoutSessionId, stripeCheckoutSessionId),
        eq(gitUsernamePurchases.status, "refund_due"),
      ),
    );
}

/** The person's most recent purchase, for the page they come back to. */
export async function latestGitUsernamePurchase(
  userId: string,
): Promise<GitUsernamePurchaseRow | null> {
  const [row] = await db
    .select()
    .from(gitUsernamePurchases)
    .where(eq(gitUsernamePurchases.userId, userId))
    .orderBy(desc(gitUsernamePurchases.createdAt))
    .limit(1);
  return row ?? null;
}
