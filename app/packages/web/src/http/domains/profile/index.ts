/**
 * Personal account settings: `/api/profile`, the handlers. The signed-in
 * user's own WorkOS record.
 *
 * WorkOS is the source of truth; our `users` row is a denormalised mirror kept
 * in step on writes so team lists and audit entries show the current display
 * name.
 *
 * Ownership is re-checked on every mutation. WorkOS ids are opaque but
 * guessable, and `mfa.deleteFactor` / `revokeSession` take a bare id with no
 * user binding of their own, so each handler first lists the caller's own
 * factors/sessions and refuses ids that aren't in that list.
 *
 * The routes that can convert a borrowed session into permanent control of the
 * account: password-reset links, email changes, MFA enrolment/removal,
 * revoking every other session, and deleting the account; additionally require
 * a recent sign-in via `requireRecentAuthentication`. See `auth/step-up.ts`.
 */
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { eq, inArray } from "drizzle-orm";
import type { workos as WorkosClient } from "../../../auth/workos";
import { db } from "../../../db/client";
import { organizations, users } from "../../../db/schema";
import { ReauthenticationRequiredError, requireRecentAuthentication } from "../../../auth/step-up";
import type { AuthSession } from "../../../api/auth-middleware";
import { makeDomain } from "../../domain";
import { badRequest, notFound } from "../../errors";
import { fieldsOf, readJsonOr } from "../../json-body";
import { legacy, legacyTry } from "../../legacy";
import { guardSessionPrefixes } from "../../prefix-guard";
import { SessionPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok, Ok } from "../../schemas/common";
import { expireSessionCookie } from "../../session-cookie";
import { workosClient } from "../../workos";
import {
  AccountDeleted,
  AccountDeletionPreview,
  AuthFactor,
  Challenge,
  EmailChanged,
  EmailChangeStarted,
  PasswordResetLink,
  Profile,
  ProfileApi,
  ProfileSummary,
  ReauthenticationRequired,
  Revoked,
  TotpEnrollment,
  UserSession,
  Verified,
} from "./api";

/** Issuer shown in the user's authenticator app next to the code. */
const TOTP_ISSUER = "Infrawrench";

/** The step-up check, refusing with the 403 the client re-authenticates on. */
const requireRecentSignIn = (session: AuthSession) =>
  legacyTry(
    () => requireRecentAuthentication(session),
    (error) =>
      error instanceof ReauthenticationRequiredError
        ? new ReauthenticationRequired({ error: error.message, code: error.code })
        : undefined,
  );

/** Shapes of the two email-change endpoints we call raw (see the handlers below). */
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
 * `undefined`: field absent, leave it alone.
 * `null`: present but not a usable name; the caller turns this into a 400.
 */
function normalizeName(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length > 128) return null;
  return trimmed;
}

async function listOwnFactors(workos: typeof WorkosClient, userId: string) {
  const list = await workos.userManagement.listAuthFactors({ userId });
  return list.data;
}

async function ownsFactor(
  workos: typeof WorkosClient,
  userId: string,
  factorId: string,
): Promise<boolean> {
  const factors = await listOwnFactors(workos, userId);
  return factors.some((f) => f.id === factorId);
}

/**
 * Account deletion, loaded on first use: it holds the WorkOS and Stripe
 * clients, which the spec build must not need (see `../../workos.ts`).
 */
const accountDeletion = legacy(() => import("../../../services/account-deletion"));

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

/** Display names for a set of organization ids, for the deletion preview. */
async function organizationNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: organizations.id, name: organizations.displayName })
    .from(organizations)
    .where(inArray(organizations.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** A WorkOS call whose failure is answered as a 400 carrying WorkOS's own sentence. */
const workosCall = <A>(fn: () => Promise<A>, fallback: string) =>
  legacyTry(fn, (err) => badRequest(workosMessage(err, fallback)));

const ProfileHandlers = HttpApiBuilder.group(ProfileApi, "profile", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        const user = yield* legacy(() => workos.userManagement.getUser(session.userId));
        // Connected OAuth identities are informational; a failure here shouldn't
        // take down the whole settings page.
        const identities = yield* legacy(async () => {
          try {
            return (await workos.userManagement.getUserIdentities(session.userId)).map((i) => ({
              provider: i.provider,
            }));
          } catch (err) {
            console.error(`[profile] listing identities failed for ${session.userId}:`, err);
            return [];
          }
        });
        return yield* respond(Profile)({
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
      }),
    )
    .handleRaw("update", ({ request }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        const body = yield* readJsonOr(request, {}).pipe(Effect.flatMap(fieldsOf));
        const firstName = normalizeName(body["firstName"]);
        const lastName = normalizeName(body["lastName"]);
        if (firstName === undefined && lastName === undefined) {
          return yield* badRequest("Provide firstName and/or lastName");
        }
        if (firstName === null || lastName === null) {
          return yield* badRequest("Names must be strings of at most 128 characters");
        }

        const user = yield* legacy(() =>
          workos.userManagement.updateUser({
            userId: session.userId,
            ...(firstName !== undefined ? { firstName } : {}),
            ...(lastName !== undefined ? { lastName } : {}),
          }),
        );

        // Keep our mirror in step so team lists don't show a stale name.
        yield* legacy(() =>
          db
            .update(users)
            .set({
              displayName: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null,
            })
            .where(eq(users.id, user.id)),
        );

        return yield* respond(ProfileSummary)({
          id: user.id,
          email: user.email,
          emailVerified: user.emailVerified,
          firstName: user.firstName,
          lastName: user.lastName,
          profilePictureUrl: user.profilePictureUrl,
          lastSignInAt: user.lastSignInAt,
          createdAt: user.createdAt,
        });
      }),
    )
    /**
     * What deleting this account would do. Lets the confirmation screen say
     * "this also deletes Acme" up front, and name the organizations that have
     * to be handed over first, instead of the user discovering either by
     * pressing the irreversible button.
     */
    .handle("deletionPreview", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { planAccountDeletion } = yield* accountDeletion;
        const plan = yield* legacy(() => planAccountDeletion(session.userId));
        const named = yield* legacy(() =>
          organizationNames([...plan.organizationIdsToDelete, ...plan.organizationIdsToLeave]),
        );
        return yield* respond(AccountDeletionPreview)({
          organizationsToDelete: plan.organizationIdsToDelete.map((id) => ({
            id,
            name: named.get(id) ?? id,
          })),
          organizationsToLeave: plan.organizationIdsToLeave.map((id) => ({
            id,
            name: named.get(id) ?? id,
          })),
          blockers: plan.blockers,
        });
      }),
    )
    /**
     * Delete the account and everything personal to it. Step-up guarded like
     * the other account-takeover-adjacent routes: a borrowed session must not
     * be able to destroy the account it borrowed.
     *
     * Refuses with 409 `transfer_ownership_required` while the caller is the
     * only owner of an organization other people are in. See
     * `services/account-deletion.ts` for what each membership resolves to and
     * why the steps run in the order they do.
     */
    .handle("delete", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        yield* requireRecentSignIn(session);
        const { AccountDeletionError, deleteAccount } = yield* accountDeletion;
        const deleted = yield* Effect.result(
          legacyTry(
            () => deleteAccount(session.userId),
            (err) => (err instanceof AccountDeletionError ? err : undefined),
          ),
        );
        if (deleted._tag === "Failure") {
          // Sent as built, details included (the blockers, the organization
          // whose subscription would not cancel).
          const err = deleted.failure;
          return HttpServerResponse.jsonUnsafe(
            { error: err.message, code: err.code, ...(err.details ?? {}) },
            { status: err.status },
          );
        }
        // The browser's cookie now points at a user that no longer exists; clearing
        // it means the next request is cleanly anonymous rather than a 401 loop.
        const response = yield* respond(AccountDeleted)({ ok: true, ...deleted.success });
        return expireSessionCookie(response);
      }),
    )
    /**
     * Mint a one-time password reset link. The link goes to AuthKit's hosted
     * reset page, which is the only surface that handles every case correctly
     * (no password yet, SSO-only user, password policy). It is handed straight
     * back rather than emailed: the caller already holds a valid session for
     * this exact account, so the email round-trip would prove nothing extra.
     */
    .handle("passwordReset", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        yield* requireRecentSignIn(session);
        const user = yield* legacy(() => workos.userManagement.getUser(session.userId));
        const reset = yield* legacy(() =>
          workos.userManagement.createPasswordReset({ email: user.email }),
        );
        return yield* respond(PasswordResetLink)({
          passwordResetUrl: reset.passwordResetUrl,
          expiresAt: reset.expiresAt,
        });
      }),
    )
    /**
     * Send a confirmation code to the NEW address. WorkOS holds the change
     * pending until the code comes back, so the account only moves once
     * someone has proven they can read mail at the new address. A typo or a
     * hijacked session therefore can't strand the account on an address its
     * owner doesn't control.
     *
     * Called through `workos.post` rather than a `userManagement` helper: the
     * email-change endpoints landed after @workos-inc/node 8.11, which is what
     * we pin. Swap these two calls for the SDK helpers whenever we take the
     * v10 bump.
     */
    .handleRaw("emailChange", ({ request }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        yield* requireRecentSignIn(session);
        const body = yield* readJsonOr(request, {}).pipe(Effect.flatMap(fieldsOf));
        const requested = body["newEmail"];
        if (typeof requested !== "string") return yield* badRequest("newEmail is required");
        const newEmail = requested.trim();
        if (!isEmail(newEmail)) {
          return yield* badRequest("That doesn't look like an email address");
        }

        const user = yield* legacy(() => workos.userManagement.getUser(session.userId));
        if (newEmail.toLowerCase() === user.email.toLowerCase()) {
          return yield* badRequest("That's already your email address");
        }

        const { data } = yield* workosCall(
          () =>
            workos.post<EmailChangeResponse>(
              `/user_management/users/${encodeURIComponent(session.userId)}/email_change/send`,
              { new_email: newEmail },
            ),
          "Couldn't start the email change",
        );
        return yield* respond(EmailChangeStarted)({
          newEmail: data.new_email,
          expiresAt: data.expires_at,
        });
      }),
    )
    /** Redeem the code and switch the address. */
    .handleRaw("emailChangeConfirm", ({ request }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        yield* requireRecentSignIn(session);
        const body = yield* readJsonOr(request, {}).pipe(Effect.flatMap(fieldsOf));
        const code = body["code"];
        if (typeof code !== "string" || !code.trim()) return yield* badRequest("code is required");

        const { data } = yield* workosCall(
          () =>
            workos.post<EmailChangeConfirmationResponse>(
              `/user_management/users/${encodeURIComponent(session.userId)}/email_change/confirm`,
              { code: code.trim() },
            ),
          "That code isn't valid or has expired",
        );
        const email = data.user.email;

        // Our mirror is what `/api/auth/me` reports, so it has to move in the same
        // breath: the sealed session cookie still holds the old address until it
        // next refreshes.
        yield* legacy(() => db.update(users).set({ email }).where(eq(users.id, session.userId)));
        return yield* respond(EmailChanged)({ email });
      }),
    )
    .handle("sendVerificationEmail", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        const user = yield* legacy(() => workos.userManagement.getUser(session.userId));
        if (user.emailVerified) return yield* badRequest("Email is already verified");
        yield* legacy(() =>
          workos.userManagement.sendVerificationEmail({ userId: session.userId }),
        );
        return yield* respond(Ok)(ok);
      }),
    )
    .handle("listFactors", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        const factors = yield* legacy(() => listOwnFactors(workos, session.userId));
        return yield* respond(Schema.Array(AuthFactor))(factors.map(serializeFactor));
      }),
    )
    /**
     * Start TOTP enrolment. WorkOS creates the factor immediately and returns
     * the secret plus a first challenge; the factor is only usable once that
     * challenge is verified. If the user walks away mid-flow the client is
     * expected to DELETE the factor: `listAuthFactors` cannot distinguish a
     * pending factor from a live one.
     */
    .handle("enrollFactor", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        yield* requireRecentSignIn(session);
        const user = yield* legacy(() => workos.userManagement.getUser(session.userId));
        const { authenticationFactor, authenticationChallenge } = yield* legacy(() =>
          workos.userManagement.enrollAuthFactor({
            userId: session.userId,
            type: "totp",
            totpIssuer: TOTP_ISSUER,
            totpUser: user.email,
          }),
        );
        return yield* respond(TotpEnrollment)({
          factorId: authenticationFactor.id,
          challengeId: authenticationChallenge.id,
          qrCode: authenticationFactor.totp?.qrCode ?? null,
          secret: authenticationFactor.totp?.secret ?? null,
          uri: authenticationFactor.totp?.uri ?? null,
        });
      }),
    )
    /** Confirm a code from the authenticator app. */
    .handleRaw("verifyFactor", ({ params, request }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        const body = yield* readJsonOr(request, {}).pipe(Effect.flatMap(fieldsOf));
        const challengeId = body["challengeId"];
        const code = body["code"];
        if (typeof challengeId !== "string" || typeof code !== "string") {
          return yield* badRequest("challengeId and code are required");
        }
        if (!(yield* legacy(() => ownsFactor(workos, session.userId, params.factorId)))) {
          return yield* notFound("Factor not found");
        }
        const result = yield* legacy(() =>
          workos.mfa.verifyChallenge({
            authenticationChallengeId: challengeId,
            code: code.trim(),
          }),
        );
        if (!result.valid) {
          return yield* badRequest(
            "That code isn't valid. Check your authenticator app and try again.",
          );
        }
        return yield* respond(Verified)({ verified: true });
      }),
    )
    /**
     * Issue a fresh challenge. Enrolment challenges expire; this lets the
     * client retry without restarting (and re-enrolling) the whole flow.
     */
    .handle("challengeFactor", ({ params }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        if (!(yield* legacy(() => ownsFactor(workos, session.userId, params.factorId)))) {
          return yield* notFound("Factor not found");
        }
        const challenge = yield* legacy(() =>
          workos.mfa.challengeFactor({ authenticationFactorId: params.factorId }),
        );
        return yield* respond(Challenge)({ challengeId: challenge.id });
      }),
    )
    /** Remove a factor (also the cancel path for enrolment). */
    .handle("deleteFactor", ({ params }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        yield* requireRecentSignIn(session);
        if (!(yield* legacy(() => ownsFactor(workos, session.userId, params.factorId)))) {
          return yield* notFound("Factor not found");
        }
        yield* legacy(() => workos.mfa.deleteFactor(params.factorId));
        return yield* respond(Ok)(ok);
      }),
    )
    /** Active sign-ins, the one making this request flagged `current`. */
    .handle("listSessions", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        const list = yield* legacy(() => workos.userManagement.listSessions(session.userId));
        return yield* respond(Schema.Array(UserSession))(
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
      }),
    )
    /** Sign out one other device. */
    .handle("revokeSession", ({ params }) =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        const sessionId = params.sessionId;
        if (sessionId === session.sessionId) {
          return yield* badRequest("Use sign out to end the session you're using right now");
        }
        const list = yield* legacy(() => workos.userManagement.listSessions(session.userId));
        if (!list.data.some((s) => s.id === sessionId)) {
          return yield* notFound("Session not found");
        }
        yield* legacy(() => workos.userManagement.revokeSession({ sessionId }));
        return yield* respond(Ok)(ok);
      }),
    )
    /** Sign out everywhere but here. */
    .handle("revokeOtherSessions", () =>
      Effect.gen(function* () {
        const session = yield* SessionPrincipal;
        const { workos } = yield* workosClient;
        yield* requireRecentSignIn(session);
        const list = yield* legacy(() => workos.userManagement.listSessions(session.userId));
        const targets = list.data.filter(
          (s) => s.status === "active" && s.id !== session.sessionId,
        );
        for (const target of targets) {
          yield* legacy(() => workos.userManagement.revokeSession({ sessionId: target.id }));
        }
        return yield* respond(Revoked)({ revoked: targets.length });
      }),
    ),
);

/**
 * Every other path under `/api/profile` needs a person's session first, as the
 * Hono mount's `use("/profile/*", sessionMiddleware)` did.
 */
export const profileDomain = guardSessionPrefixes(
  makeDomain("profile", ProfileApi, ProfileHandlers),
  ["/api/profile"],
);
