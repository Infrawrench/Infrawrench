/**
 * Personal account settings — the signed-in user's own WorkOS record.
 *
 * Everything here is user-scoped, never org-scoped: a user has one WorkOS
 * identity shared across every organization they belong to. WorkOS is the
 * source of truth; our `users` row is a denormalised mirror kept in step on
 * writes so team lists and audit entries show the current display name.
 *
 * Ownership is re-checked on every mutation. WorkOS ids are opaque but
 * guessable, and `mfa.deleteFactor` / `revokeSession` take a bare id with no
 * user binding of their own, so each handler first lists the caller's own
 * factors/sessions and refuses ids that aren't in that list.
 *
 * The routes that can convert a borrowed session into permanent control of the
 * account — password-reset links, email changes, MFA enrolment/removal, and
 * revoking every other session — additionally require a recent sign-in via
 * `requireRecentAuthentication`. See `auth/step-up.ts`.
 */

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { workos } from "../../auth/workos";
import { db } from "../../db/client";
import { users } from "../../db/schema";
import { requireRecentAuthentication } from "../../auth/step-up";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/** Issuer shown in the user's authenticator app next to the code. */
const TOTP_ISSUER = "Infrawrench";

const app = new Hono();

/** GET /api/profile — the signed-in user's WorkOS profile. */
app.get("/", async (c) => {
  const session = c.get("session");
  const user = await workos.userManagement.getUser(session.userId);

  // Connected OAuth identities are informational; a failure here shouldn't
  // take down the whole settings page.
  let identities: Array<{ provider: string }> = [];
  try {
    identities = (await workos.userManagement.getUserIdentities(session.userId)).map((i) => ({
      provider: i.provider,
    }));
  } catch (err) {
    console.error(`[profile] listing identities failed for ${session.userId}:`, err);
  }

  return c.json({
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    firstName: user.firstName,
    lastName: user.lastName,
    profilePictureUrl: user.profilePictureUrl,
    lastSignInAt: user.lastSignInAt,
    createdAt: user.createdAt,
    identities,
  });
});

/** PATCH /api/profile — update the user's name. */
app.patch("/", async (c) => {
  const session = c.get("session");
  const body = await c.req
    .json<{ firstName?: unknown; lastName?: unknown }>()
    .catch(() => ({}) as { firstName?: unknown; lastName?: unknown });

  const firstName = normalizeName(body.firstName);
  const lastName = normalizeName(body.lastName);
  if (firstName === undefined && lastName === undefined) {
    return c.json({ error: "Provide firstName and/or lastName" }, 400);
  }
  if (firstName === null || lastName === null) {
    return c.json({ error: "Names must be strings of at most 128 characters" }, 400);
  }

  const user = await workos.userManagement.updateUser({
    userId: session.userId,
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
  });

  // Keep our mirror in step so team lists don't show a stale name.
  await db
    .update(users)
    .set({ displayName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null })
    .where(eq(users.id, user.id));

  return c.json({
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    firstName: user.firstName,
    lastName: user.lastName,
    profilePictureUrl: user.profilePictureUrl,
    lastSignInAt: user.lastSignInAt,
    createdAt: user.createdAt,
  });
});

/**
 * POST /api/profile/password-reset — mint a one-time password reset link.
 *
 * The link goes to AuthKit's hosted reset page, which is the only surface that
 * handles every case correctly (no password yet, SSO-only user, password
 * policy). We hand it straight back to the caller rather than emailing it:
 * they already hold a valid session for this exact account, so the email
 * round-trip would prove nothing extra.
 */
app.post("/password-reset", async (c) => {
  await requireRecentAuthentication(c);
  const session = c.get("session");
  const user = await workos.userManagement.getUser(session.userId);
  const reset = await workos.userManagement.createPasswordReset({ email: user.email });
  return c.json({ passwordResetUrl: reset.passwordResetUrl, expiresAt: reset.expiresAt });
});

/** POST /api/profile/send-verification-email — re-send the email verification code. */
app.post("/send-verification-email", async (c) => {
  const session = c.get("session");
  const user = await workos.userManagement.getUser(session.userId);
  if (user.emailVerified) {
    return c.json({ error: "Email is already verified" }, 400);
  }
  await workos.userManagement.sendVerificationEmail({ userId: session.userId });
  return c.json({ ok: true });
});

/**
 * POST /api/profile/email-change — send a confirmation code to the NEW address.
 *
 * WorkOS holds the change pending until the code comes back, so the account
 * only moves once someone has proven they can read mail at the new address. A
 * typo or a hijacked session therefore can't strand the account on an address
 * its owner doesn't control.
 *
 * Called through `workos.post` rather than a `userManagement` helper: the
 * email-change endpoints landed after @workos-inc/node 8.11, which is what we
 * pin. Swap these two calls for the SDK helpers whenever we take the v10 bump.
 */
app.post("/email-change", async (c) => {
  await requireRecentAuthentication(c);
  const session = c.get("session");
  const body = await c.req
    .json<{ newEmail?: unknown }>()
    .catch(() => ({}) as { newEmail?: unknown });

  if (typeof body.newEmail !== "string") {
    return c.json({ error: "newEmail is required" }, 400);
  }
  const newEmail = body.newEmail.trim();
  if (!isEmail(newEmail)) {
    return c.json({ error: "That doesn't look like an email address" }, 400);
  }

  const user = await workos.userManagement.getUser(session.userId);
  if (newEmail.toLowerCase() === user.email.toLowerCase()) {
    return c.json({ error: "That's already your email address" }, 400);
  }

  try {
    const { data } = await workos.post<EmailChangeResponse>(
      `/user_management/users/${encodeURIComponent(session.userId)}/email_change/send`,
      { new_email: newEmail },
    );
    return c.json({ newEmail: data.new_email, expiresAt: data.expires_at });
  } catch (err) {
    return c.json({ error: workosMessage(err, "Couldn't start the email change") }, 400);
  }
});

/** POST /api/profile/email-change/confirm — redeem the code and switch the address. */
app.post("/email-change/confirm", async (c) => {
  await requireRecentAuthentication(c);
  const session = c.get("session");
  const body = await c.req.json<{ code?: unknown }>().catch(() => ({}) as { code?: unknown });

  if (typeof body.code !== "string" || !body.code.trim()) {
    return c.json({ error: "code is required" }, 400);
  }

  let email: string;
  try {
    const { data } = await workos.post<EmailChangeConfirmationResponse>(
      `/user_management/users/${encodeURIComponent(session.userId)}/email_change/confirm`,
      { code: body.code.trim() },
    );
    email = data.user.email;
  } catch (err) {
    return c.json({ error: workosMessage(err, "That code isn't valid or has expired") }, 400);
  }

  // Our mirror is what `/api/auth/me` reports, so it has to move in the same
  // breath — the sealed session cookie still holds the old address until it
  // next refreshes.
  await db.update(users).set({ email }).where(eq(users.id, session.userId));

  return c.json({ email });
});

/** GET /api/profile/mfa — the user's enrolled authentication factors. */
app.get("/mfa", async (c) => {
  const session = c.get("session");
  const factors = await listOwnFactors(session.userId);
  return c.json(factors.map(serializeFactor));
});

/**
 * POST /api/profile/mfa — start TOTP enrolment.
 *
 * WorkOS creates the factor immediately and returns the secret plus a first
 * challenge; the factor is only usable once that challenge is verified. If the
 * user walks away mid-flow the client is expected to DELETE the factor —
 * `listAuthFactors` cannot distinguish a pending factor from a live one.
 */
app.post("/mfa", async (c) => {
  await requireRecentAuthentication(c);
  const session = c.get("session");
  const user = await workos.userManagement.getUser(session.userId);

  const { authenticationFactor, authenticationChallenge } =
    await workos.userManagement.enrollAuthFactor({
      userId: session.userId,
      type: "totp",
      totpIssuer: TOTP_ISSUER,
      totpUser: user.email,
    });

  return c.json({
    factorId: authenticationFactor.id,
    challengeId: authenticationChallenge.id,
    qrCode: authenticationFactor.totp?.qrCode ?? null,
    secret: authenticationFactor.totp?.secret ?? null,
    uri: authenticationFactor.totp?.uri ?? null,
  });
});

/** POST /api/profile/mfa/:factorId/verify — confirm a code from the authenticator app. */
app.post("/mfa/:factorId/verify", async (c) => {
  const session = c.get("session");
  const factorId = c.req.param("factorId");
  const body = await c.req
    .json<{ challengeId?: unknown; code?: unknown }>()
    .catch(() => ({}) as { challengeId?: unknown; code?: unknown });

  if (typeof body.challengeId !== "string" || typeof body.code !== "string") {
    return c.json({ error: "challengeId and code are required" }, 400);
  }
  if (!(await ownsFactor(session.userId, factorId))) {
    return c.json({ error: "Factor not found" }, 404);
  }

  const result = await workos.mfa.verifyChallenge({
    authenticationChallengeId: body.challengeId,
    code: body.code.trim(),
  });
  if (!result.valid) {
    return c.json(
      { error: "That code isn't valid. Check your authenticator app and try again." },
      400,
    );
  }
  return c.json({ verified: true });
});

/**
 * POST /api/profile/mfa/:factorId/challenge — issue a fresh challenge.
 * Enrolment challenges expire; this lets the client retry without restarting
 * (and re-enrolling) the whole flow.
 */
app.post("/mfa/:factorId/challenge", async (c) => {
  const session = c.get("session");
  const factorId = c.req.param("factorId");
  if (!(await ownsFactor(session.userId, factorId))) {
    return c.json({ error: "Factor not found" }, 404);
  }
  const challenge = await workos.mfa.challengeFactor({ authenticationFactorId: factorId });
  return c.json({ challengeId: challenge.id });
});

/** DELETE /api/profile/mfa/:factorId — remove a factor (also the cancel path for enrolment). */
app.delete("/mfa/:factorId", async (c) => {
  await requireRecentAuthentication(c);
  const session = c.get("session");
  const factorId = c.req.param("factorId");
  if (!(await ownsFactor(session.userId, factorId))) {
    return c.json({ error: "Factor not found" }, 404);
  }
  await workos.mfa.deleteFactor(factorId);
  return c.json({ ok: true });
});

/** GET /api/profile/sessions — active sign-ins, current one flagged. */
app.get("/sessions", async (c) => {
  const session = c.get("session");
  const list = await workos.userManagement.listSessions(session.userId);
  return c.json(
    list.data
      .filter((s) => s.status === "active")
      .map((s) => ({
        id: s.id,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        authMethod: s.authMethod,
        status: s.status,
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        current: s.id === session.sessionId,
      })),
  );
});

/** DELETE /api/profile/sessions/:sessionId — sign out one other device. */
app.delete("/sessions/:sessionId", async (c) => {
  const session = c.get("session");
  const sessionId = c.req.param("sessionId");

  if (sessionId === session.sessionId) {
    return c.json({ error: "Use sign out to end the session you're using right now" }, 400);
  }
  const list = await workos.userManagement.listSessions(session.userId);
  if (!list.data.some((s) => s.id === sessionId)) {
    return c.json({ error: "Session not found" }, 404);
  }

  await workos.userManagement.revokeSession({ sessionId });
  return c.json({ ok: true });
});

/** POST /api/profile/sessions/revoke-others — sign out everywhere but here. */
app.post("/sessions/revoke-others", async (c) => {
  await requireRecentAuthentication(c);
  const session = c.get("session");
  const list = await workos.userManagement.listSessions(session.userId);
  const targets = list.data.filter((s) => s.status === "active" && s.id !== session.sessionId);

  for (const target of targets) {
    await workos.userManagement.revokeSession({ sessionId: target.id });
  }
  return c.json({ revoked: targets.length });
});

/** Shapes of the two email-change endpoints we call raw (see the routes above). */
interface EmailChangeResponse {
  object: "email_change";
  new_email: string;
  expires_at: string;
}

interface EmailChangeConfirmationResponse {
  object: "email_change_confirmation";
  user: { id: string; email: string };
}

/**
 * Deliberately loose: WorkOS returns a usable sentence for the cases a user can
 * actually hit here ("email already in use", bad or expired code), and it's more
 * helpful than anything we'd write. Anything unrecognisable falls back.
 */
function workosMessage(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message.trim() : "";
  return message.length > 0 && message.length < 200 ? message : fallback;
}

/** Good enough to catch typos; WorkOS is the real authority on deliverability. */
function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320;
}

/**
 * `undefined` — field absent, leave it alone.
 * `null` — present but not a usable name; the caller turns this into a 400.
 */
function normalizeName(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > 128) return null;
  return trimmed;
}

async function listOwnFactors(userId: string) {
  const list = await workos.userManagement.listAuthFactors({ userId });
  return list.data;
}

async function ownsFactor(userId: string, factorId: string): Promise<boolean> {
  const factors = await listOwnFactors(userId);
  return factors.some((f) => f.id === factorId);
}

function serializeFactor(factor: Awaited<ReturnType<typeof listOwnFactors>>[number]) {
  return {
    id: factor.id,
    type: factor.type,
    createdAt: factor.createdAt,
    updatedAt: factor.updatedAt,
    totpIssuer: factor.totp?.issuer ?? null,
    totpUser: factor.totp?.user ?? null,
  };
}

export { app as profileRoutes };
