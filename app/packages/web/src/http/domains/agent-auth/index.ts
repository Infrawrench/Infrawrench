/**
 * Agent registration and the claim ceremony, the handlers.
 *
 * Each one answers in the words and order the Hono routes did: who is asking
 * first (the agent's credential, or the session middleware on the claim
 * group), then the per-user attempt throttle, then the body, then the
 * ceremony, whose refusals carry their own status (`ClaimCeremonyError`,
 * `TrialClaimError`, `PlanRequiredError`); anything else is the defect the
 * API renders as a 500.
 */
import { Effect, Layer, Predicate } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { eq } from "drizzle-orm";
import {
  AgentAuthApi,
  AgentClaimLookup,
  AgentClaimResult,
  AgentClaimStarted,
  AgentIdentity,
  RegisteredAgent,
} from "@infrawrench/api-contract";
import { db } from "../../../db/client";
import { organizations, organizationMembers } from "../../../db/schema";
import {
  ClaimCeremonyError,
  RegistrationRateLimitedError,
  formatClaimCode,
  getClaimStatus,
  registerAnonymousAgent,
  resolveAgentCredential,
  resolveClaimCode,
  startClaimCeremony,
} from "@infrawrench/server-core/trials/ceremony";
import { claimTrialOrg, TrialClaimError } from "@infrawrench/server-core/trials/claim";
import { PlanRequiredError } from "@infrawrench/server-core/entitlements";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import { logAudit } from "../../../services/audit";
import { effectivePermissions } from "../../../auth/effective-permissions";
import { rawRequest } from "../../caller-auth";
import { makeDomain } from "../../domain";
import { HttpFailure } from "../../errors";
import { fieldsOf, readJson, readJsonOr } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { failureResponse, json } from "../../middleware";
import { guardSessionPrefixes } from "../../prefix-guard";
import { SessionPrincipal } from "../../principal";
import { respond } from "../../response";
import { answeringFailures, requestHeader } from "../raw-responses";
import { clientIp, publicBaseUrl } from "./request-origin";

/** Pull the agent's own credential off the request, or null. */
async function agentFromRequest(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return resolveAgentCredential(authHeader.slice(7));
}

type RegisterOutcome =
  { readonly body: typeof RegisteredAgent.Type } | { readonly failure: HttpFailure };

const unauthorized = () => json({ error: "Unauthorized" }, 401);

/** A ceremony refusal, sent with the status it carries. */
const ceremonyRefusal = (e: unknown): HttpFailure | undefined =>
  e instanceof ClaimCeremonyError ? new HttpFailure(e.status, { error: e.message }) : undefined;

/**
 * The `code` a claim body carries, which the route handed straight to
 * `resolveClaimCode`: absent or falsy is the handler's 400, and a truthy
 * non-string reached `normalizeClaimCode`'s `toUpperCase`, the `TypeError`
 * (a 500) it still is.
 */
const claimCode = (value: unknown): Effect.Effect<string | undefined> =>
  !value || typeof value === "string"
    ? Effect.succeed(typeof value === "string" ? value : undefined)
    : Effect.die(new TypeError("input.toUpperCase is not a function"));

const AgentIdentityHandlers = HttpApiBuilder.group(AgentAuthApi, "agentIdentity", (handlers) =>
  handlers
    /**
     * Open an anonymous registration. Returns the credential exactly once.
     * There is no route that can show it again: the row stores an HMAC, and an
     * agent that loses its token registers anew (or, if the workspace is
     * already claimed, asks its human for an API key).
     */
    .handleRaw("register", ({ request }) =>
      Effect.gen(function* () {
        const raw = yield* rawRequest;
        const body = yield* readJsonOr(request, {});
        // A refusal is answered as `failure`, the route's own `c.json(body, status)`.
        const outcome = yield* legacy(async (): Promise<RegisterOutcome> => {
          try {
            // Read inside the `try`, as the route did: a JSON `null` body is the
            // failure sentence below, not a parse error.
            if (body === null)
              throw new TypeError("Cannot read properties of null (reading 'label')");
            const label = Predicate.hasProperty(body, "label") ? body.label : undefined;
            const registered = await registerAnonymousAgent({
              ...(typeof label === "string" ? { label: label.slice(0, 80) } : {}),
              ip: clientIp(requestHeader(request, "x-forwarded-for")),
            });
            return {
              body: {
                registration_id: registered.registrationId,
                credential: registered.credential,
                organization_id: registered.organizationId,
                trial_expires_at: registered.trialExpiresAt.toISOString(),
                claim_url: `${publicBaseUrl(raw.url, requestHeader(request, "x-forwarded-proto"))}/claim`,
                // Said plainly and up front, because the alternative is an agent that
                // builds someone a workspace and never mentions it is on a clock.
                notice:
                  "This workspace is a trial and will be deleted 24 hours after it was created " +
                  "unless a person claims it. Start the claim ceremony with POST /api/agent/identity/claim.",
              },
            };
          } catch (e) {
            if (e instanceof RegistrationRateLimitedError) {
              return { failure: new HttpFailure(429, { error: e.message, code: "rate_limited" }) };
            }
            console.error("[agent-auth] registration failed:", e);
            return {
              failure: new HttpFailure(500, { error: "Could not open a trial workspace." }),
            };
          }
        });
        if ("failure" in outcome) return failureResponse(outcome.failure);
        return yield* respond(RegisteredAgent)(outcome.body);
      }),
    )
    /**
     * What the agent polls. Carries `trial_expires_in_ms` on every response,
     * not just near the end, so an agent can decide for itself when to start
     * nagging its user. An agent that can only discover the deadline by
     * hitting it will always tell the user too late.
     */
    .handleRaw("status", ({ request }) =>
      Effect.gen(function* () {
        const registrationId = yield* legacy(() =>
          agentFromRequest(requestHeader(request, "authorization")),
        );
        if (!registrationId) return unauthorized();

        const status = yield* legacy(() => getClaimStatus(registrationId));
        if (!status) return json({ error: "Unknown registration" }, 404);

        return yield* respond(AgentIdentity)({
          registration_id: registrationId,
          organization_id: status.organizationId,
          claimed: status.claimed,
          claim_pending: status.claimPending,
          trial_expires_in_ms: status.trialExpiresInMs,
        });
      }),
    )
    /**
     * Ask to be claimed. The agent shows `user_code` and `verification_uri` to
     * its user in one message. We never email the code: an anonymous
     * registration has no verified address, and mailing one the *agent*
     * supplied would let an agent push a claim prompt into a stranger's inbox.
     */
    .handleRaw("startClaim", ({ request }) =>
      answeringFailures(
        Effect.gen(function* () {
          const raw = yield* rawRequest;
          const registrationId = yield* legacy(() =>
            agentFromRequest(requestHeader(request, "authorization")),
          );
          if (!registrationId) return unauthorized();

          const started = yield* legacyTry(
            () => startClaimCeremony(registrationId),
            ceremonyRefusal,
          );
          const base = publicBaseUrl(raw.url, requestHeader(request, "x-forwarded-proto"));
          return yield* respond(AgentClaimStarted)({
            user_code: formatClaimCode(started.userCode),
            verification_uri: `${base}/claim`,
            verification_uri_complete: `${base}/claim?code=${started.userCode}`,
            expires_at: started.expiresAt.toISOString(),
            // RFC 8628's polling hint, in seconds.
            interval: 5,
          });
        }),
      ),
    ),
);

/**
 * Wrong-code submissions per user, and the window they are counted over.
 *
 * In-memory on purpose: this is a throttle on interactive typing, not a
 * security boundary that has to survive a restart, and a table would make every
 * claim page load a write. The code's own size (32^8) is what makes blind
 * search hopeless; this stops one signed-in person grinding at it.
 *
 * Per-replica, so the effective limit is this times the replica count, which
 * is why it is set well below what a human could ever need rather than at the
 * true threshold. The claim routes are pinned to the session gateway
 * (`edge/gateway-routes.ts`), so the map is per pod rather than per isolate.
 */
const CLAIM_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const CLAIM_ATTEMPTS_PER_USER = 10;
const claimAttempts = new Map<string, { count: number; resetAt: number }>();

function tooManyClaimAttempts(userId: string): boolean {
  const now = Date.now();
  const entry = claimAttempts.get(userId);
  if (!entry || entry.resetAt < now) {
    claimAttempts.set(userId, { count: 1, resetAt: now + CLAIM_ATTEMPT_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > CLAIM_ATTEMPTS_PER_USER;
}

/** Test hook. */
export function resetClaimAttemptsForTests(): void {
  claimAttempts.clear();
}

const tooManyAttempts = () =>
  json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);

const AgentClaimHandlers = HttpApiBuilder.group(AgentAuthApi, "agentClaim", (handlers) =>
  handlers
    /**
     * Resolve a code so the page can show what is about to be claimed.
     *
     * Deliberately a POST rather than a GET with the code in the path: a code in a
     * URL lands in browser history, in the Referer header of anything the page
     * loads, and in access logs. It is a live bearer secret for fifteen minutes.
     */
    .handleRaw("lookup", ({ request }) =>
      answeringFailures(
        Effect.gen(function* () {
          const session = yield* SessionPrincipal;
          if (tooManyClaimAttempts(session.userId)) return tooManyAttempts();

          const body = yield* fieldsOf(yield* readJsonOr(request, {}));
          const code = yield* claimCode(body["code"]);
          if (!code) return json({ error: "Enter the code your agent gave you." }, 400);

          const lookup = yield* legacyTry(async () => {
            const registrationId = await resolveClaimCode(code);
            const status = await getClaimStatus(registrationId);
            if (!status) return null;

            const [org] = await db
              .select({ displayName: organizations.displayName })
              .from(organizations)
              .where(eq(organizations.id, status.organizationId))
              .limit(1);

            // The orgs this person could merge into. Only orgs they already belong to:
            // the claim ceremony must never be a way to push cloud credentials into
            // an organization the claimer cannot already reach.
            const targets = await db
              .select({ id: organizations.id, displayName: organizations.displayName })
              .from(organizationMembers)
              .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
              .where(eq(organizationMembers.userId, session.userId));

            // …and only those they may actually write accounts into. `claimTrialOrg`
            // enforces this itself: this is the same answer computed early, so the
            // page never offers a destination that would 403 on submit.
            const candidates = targets.filter((t) => t.id !== status.organizationId);
            const mergeTargets: typeof candidates = [];
            for (const candidate of candidates) {
              const permissions = await effectivePermissions({
                userId: session.userId,
                organizationId: candidate.id,
              });
              if (hasPermission(permissions, "accounts:write")) mergeTargets.push(candidate);
            }

            return {
              registrationId,
              workspaceName: org?.displayName ?? "Trial workspace",
              trialExpiresInMs: status.trialExpiresInMs,
              mergeTargets,
            };
          }, ceremonyRefusal);
          if (!lookup) return json({ error: "That workspace no longer exists." }, 404);
          return yield* respond(AgentClaimLookup)(lookup);
        }),
      ),
    )
    /**
     * Confirm, binding the registration to this person.
     *
     * The code is re-resolved here rather than trusting a `registrationId` from the
     * lookup response: otherwise the lookup would be an oracle and this route would
     * accept any id the caller cared to name.
     */
    .handleRaw("confirm", ({ request }) =>
      answeringFailures(
        Effect.gen(function* () {
          const session = yield* SessionPrincipal;
          if (tooManyClaimAttempts(session.userId)) return tooManyAttempts();

          const body = yield* fieldsOf(yield* readJson(request));
          const code = yield* claimCode(body["code"]);
          if (!code) return json({ error: "Enter the code your agent gave you." }, 400);
          const mode = body["mode"] === "merge" ? "merge" : "adopt";
          const target = body["targetOrganizationId"];

          const result = yield* legacyTry(
            async () => {
              const registrationId = await resolveClaimCode(code);
              const claimed = await claimTrialOrg({
                registrationId,
                userId: session.userId,
                mode,
                // A truthy non-string id finds no membership row, as it never did.
                ...(target
                  ? {
                      targetOrganizationId:
                        typeof target === "string" ? target : JSON.stringify(target),
                    }
                  : {}),
                ...(body["moveHistory"] ? { moveHistory: true } : {}),
              });
              return { registrationId, claimed };
            },
            (e) => {
              const ceremony = ceremonyRefusal(e);
              if (ceremony) return ceremony;
              // `status`, not a flat 400: a merge refused for want of a permission in the
              // target org is a 403, and reporting it as a bad request tells the user to
              // fix their input when the answer is "ask an administrator".
              if (e instanceof TrialClaimError) {
                return new HttpFailure(e.status, { error: e.message });
              }
              if (e instanceof PlanRequiredError) return new HttpFailure(402, { error: e.message });
              return undefined;
            },
          );
          const { registrationId, claimed } = result;

          yield* fireAndForget(() =>
            logAudit({
              organizationId: claimed.organizationId,
              userId: session.userId,
              action: "agent.claim",
              entityType: "agent_registration",
              entityId: registrationId,
              metadata: {
                mode: claimed.mode,
                accountsMoved: claimed.accountsMoved,
                historyMoved: claimed.historyMoved,
              },
            }),
          );

          return yield* respond(AgentClaimResult)({
            organizationId: claimed.organizationId,
            mode: claimed.mode,
            accountsMoved: claimed.accountsMoved,
            historyMoved: claimed.historyMoved,
          });
        }),
      ),
    ),
);

/**
 * Every other path under `/api/agent/claim` needs a person's session first,
 * as the Hono router's `use("*", sessionMiddleware)` did: a 401 without one,
 * the 404 with one.
 */
export const agentAuthDomain = guardSessionPrefixes(
  makeDomain("agentAuth", AgentAuthApi, Layer.mergeAll(AgentIdentityHandlers, AgentClaimHandlers)),
  ["/api/agent/claim"],
);
