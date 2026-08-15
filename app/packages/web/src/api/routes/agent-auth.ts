/**
 * The agent registration and claim-ceremony endpoints.
 *
 * Three audiences, three auth models, which is why they are one file:
 *
 * - **`POST /api/agent/identity`** is unauthenticated by definition — it is how
 *   an agent with no credentials gets one. It is also the only route in the
 *   product that creates an organization without a person, so the rate limit in
 *   `trials/ceremony.ts` is the whole of its protection.
 * - **`/api/agent/identity/claim*`** authenticate with the agent's own
 *   credential.
 * - **`/api/agent/claim`** is the human half: session-authed, because the point
 *   of the ceremony is binding the registration to a person we have actually
 *   signed in.
 */
import { isIP } from "node:net";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";

import { db } from "../../db/client";
import { organizations, organizationMembers } from "../../db/schema";
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
import { logAudit } from "../../services/audit";
import { sessionMiddleware } from "../auth-middleware";

const app = new Hono();

/**
 * The client's address, for the per-IP registration limit.
 *
 * Behind our ingress (ingress-nginx with its default `use-forwarded-headers:
 * false`) the controller *overwrites* `x-forwarded-for` with the socket
 * address, so the first hop is trustworthy there. In any deployment where the
 * header passes through raw it is client-controlled, which is why the value is
 * validated as an actual IP address rather than taken as an opaque bucket key:
 * un-validated, every request could invent a fresh "address" and mint itself a
 * fresh per-IP allowance. A value that is not an IP counts as "unknown", and
 * unknown callers are governed by the global hourly ceiling instead.
 */
function clientIp(header: string | undefined): string | null {
  const first = header?.split(",")[0]?.trim();
  if (!first) return null;
  return isIP(first) !== 0 ? first : null;
}

function publicBaseUrl(reqUrl: string, forwardedProto?: string): string {
  const fromEnv = process.env["PUBLIC_BASE_URL"] ?? process.env["APP_URL"];
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const u = new URL(reqUrl);
  const proto = forwardedProto?.split(",")[0]?.trim();
  return `${proto ? `${proto}:` : u.protocol}//${u.host}`;
}

/** Pull the agent's own credential off the request, or null. */
async function agentFromRequest(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return resolveAgentCredential(authHeader.slice(7));
}

/**
 * POST /api/agent/identity — open an anonymous registration.
 *
 * Returns the credential exactly once. There is no route that can show it
 * again: the row stores an HMAC, and an agent that loses its token registers
 * anew (or, if the workspace is already claimed, asks its human for an API key).
 */
app.post("/identity", async (c) => {
  const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });

  try {
    const registered = await registerAnonymousAgent({
      ...(typeof body.label === "string" ? { label: body.label.slice(0, 80) } : {}),
      ip: clientIp(c.req.header("x-forwarded-for")),
    });

    return c.json({
      registration_id: registered.registrationId,
      credential: registered.credential,
      organization_id: registered.organizationId,
      trial_expires_at: registered.trialExpiresAt.toISOString(),
      claim_url: `${publicBaseUrl(c.req.url, c.req.header("x-forwarded-proto"))}/claim`,
      // Said plainly and up front, because the alternative is an agent that
      // builds someone a workspace and never mentions it is on a clock.
      notice:
        "This workspace is a trial and will be deleted 24 hours after it was created " +
        "unless a person claims it. Start the claim ceremony with POST /api/agent/identity/claim.",
    });
  } catch (e) {
    if (e instanceof RegistrationRateLimitedError) {
      return c.json({ error: e.message, code: "rate_limited" }, 429);
    }
    console.error("[agent-auth] registration failed:", e);
    return c.json({ error: "Could not open a trial workspace." }, 500);
  }
});

/**
 * POST /api/agent/identity/claim — ask to be claimed.
 *
 * The agent shows `user_code` and `verification_uri` to its user in one
 * message. We never email the code: an anonymous registration has no verified
 * address, and mailing one the *agent* supplied would let an agent push a claim
 * prompt into a stranger's inbox.
 */
app.post("/identity/claim", async (c) => {
  const registrationId = await agentFromRequest(c.req.header("authorization"));
  if (!registrationId) return c.json({ error: "Unauthorized" }, 401);

  try {
    const started = await startClaimCeremony(registrationId);
    const base = publicBaseUrl(c.req.url, c.req.header("x-forwarded-proto"));
    return c.json({
      user_code: formatClaimCode(started.userCode),
      verification_uri: `${base}/claim`,
      verification_uri_complete: `${base}/claim?code=${started.userCode}`,
      expires_at: started.expiresAt.toISOString(),
      // RFC 8628's polling hint, in seconds.
      interval: 5,
    });
  } catch (e) {
    if (e instanceof ClaimCeremonyError) return c.json({ error: e.message }, e.status as 400);
    throw e;
  }
});

/**
 * GET /api/agent/identity — what the agent polls.
 *
 * Carries `trial_expires_in_ms` on every response, not just near the end, so an
 * agent can decide for itself when to start nagging its user. An agent that can
 * only discover the deadline by hitting it will always tell the user too late.
 */
app.get("/identity", async (c) => {
  const registrationId = await agentFromRequest(c.req.header("authorization"));
  if (!registrationId) return c.json({ error: "Unauthorized" }, 401);

  const status = await getClaimStatus(registrationId);
  if (!status) return c.json({ error: "Unknown registration" }, 404);

  return c.json({
    registration_id: registrationId,
    organization_id: status.organizationId,
    claimed: status.claimed,
    claim_pending: status.claimPending,
    trial_expires_in_ms: status.trialExpiresInMs,
  });
});

export { app as agentAuthRoutes };

/**
 * The human half of the ceremony. Mounted separately because it needs a
 * session, and mounting it under the same unauthenticated group would be one
 * `app.use` away from an accident.
 */
const claimApp = new Hono();
claimApp.use("*", sessionMiddleware);

/**
 * Wrong-code submissions per user, and the window they are counted over.
 *
 * In-memory on purpose: this is a throttle on interactive typing, not a
 * security boundary that has to survive a restart, and a table would make every
 * claim page load a write. The code's own size (32^8) is what makes blind
 * search hopeless; this stops one signed-in person grinding at it.
 *
 * Per-replica, so the effective limit is this times the replica count — which
 * is why it is set well below what a human could ever need rather than at the
 * true threshold.
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

/**
 * POST /api/agent/claim/lookup — resolve a code so the page can show what is
 * about to be claimed.
 *
 * Deliberately a POST rather than a GET with the code in the path: a code in a
 * URL lands in browser history, in the Referer header of anything the page
 * loads, and in access logs. It is a live bearer secret for fifteen minutes.
 */
claimApp.post("/lookup", async (c) => {
  const session = c.get("session");
  if (tooManyClaimAttempts(session.userId)) {
    return c.json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
  }

  const { code } = await c.req.json<{ code?: string }>().catch(() => ({}) as { code?: string });
  if (!code) return c.json({ error: "Enter the code your agent gave you." }, 400);

  try {
    const registrationId = await resolveClaimCode(code);
    const status = await getClaimStatus(registrationId);
    if (!status) return c.json({ error: "That workspace no longer exists." }, 404);

    const [org] = await db
      .select({ displayName: organizations.displayName })
      .from(organizations)
      .where(eq(organizations.id, status.organizationId))
      .limit(1);

    // The orgs this person could merge into. Only orgs they already belong to
    // — the claim ceremony must never be a way to push cloud credentials into
    // an organization the claimer cannot already reach.
    const targets = await db
      .select({ id: organizations.id, displayName: organizations.displayName })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, session.userId));

    return c.json({
      registrationId,
      workspaceName: org?.displayName ?? "Trial workspace",
      trialExpiresInMs: status.trialExpiresInMs,
      mergeTargets: targets.filter((t) => t.id !== status.organizationId),
    });
  } catch (e) {
    if (e instanceof ClaimCeremonyError) return c.json({ error: e.message }, e.status as 400);
    throw e;
  }
});

/**
 * POST /api/agent/claim — confirm, binding the registration to this person.
 *
 * The code is re-resolved here rather than trusting a `registrationId` from the
 * lookup response: otherwise the lookup would be an oracle and this route would
 * accept any id the caller cared to name.
 */
claimApp.post("/", async (c) => {
  const session = c.get("session");
  if (tooManyClaimAttempts(session.userId)) {
    return c.json({ error: "Too many attempts. Wait a few minutes and try again." }, 429);
  }

  const body = await c.req.json<{
    code?: string;
    mode?: "adopt" | "merge";
    targetOrganizationId?: string;
    moveHistory?: boolean;
  }>();

  if (!body.code) return c.json({ error: "Enter the code your agent gave you." }, 400);
  const mode = body.mode === "merge" ? "merge" : "adopt";

  try {
    const registrationId = await resolveClaimCode(body.code);
    const result = await claimTrialOrg({
      registrationId,
      userId: session.userId,
      mode,
      ...(body.targetOrganizationId ? { targetOrganizationId: body.targetOrganizationId } : {}),
      ...(body.moveHistory ? { moveHistory: true } : {}),
    });

    void logAudit({
      organizationId: result.organizationId,
      userId: session.userId,
      action: "agent.claim",
      entityType: "agent_registration",
      entityId: registrationId,
      metadata: {
        mode: result.mode,
        accountsMoved: result.accountsMoved,
        historyMoved: result.historyMoved,
      },
    });

    return c.json({
      organizationId: result.organizationId,
      mode: result.mode,
      accountsMoved: result.accountsMoved,
      historyMoved: result.historyMoved,
    });
  } catch (e) {
    if (e instanceof ClaimCeremonyError) return c.json({ error: e.message }, e.status as 400);
    if (e instanceof TrialClaimError) return c.json({ error: e.message }, 400);
    if (e instanceof PlanRequiredError) return c.json({ error: e.message }, 402);
    throw e;
  }
});

export { claimApp as agentClaimRoutes };
