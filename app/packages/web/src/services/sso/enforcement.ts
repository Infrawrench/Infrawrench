/**
 * The SSO enforcement gate: when an org requires single sign-on, a member
 * whose email sits in one of its verified domains may only reach the org with
 * a session established through that org's SSO connection.
 *
 * Why this is checked here rather than left to WorkOS. AuthKit does apply a
 * domain policy at sign-in, but it is configured in the WorkOS dashboard (not
 * by the customer), it has no notion of a break-glass owner, and it decides
 * how someone signs in, not what an existing session may reach: a password
 * session from before enforcement was switched on would otherwise keep
 * working for its whole ~13-month life. The gate decides per request, from
 * how the *current* session was established.
 *
 * How the session was established comes from WorkOS (`authMethod` and
 * `organizationId` on the session object), looked up once per session id and
 * cached, since neither ever changes for a given session. That covers every
 * client: web cookies, and the desktop, mobile and CLI bearer tokens, which
 * all carry the same `sid`.
 *
 * Exemptions, each audit-logged on the first request of the session:
 *  - a **break-glass owner**: an owner the org listed in advance, for when
 *    the IdP itself is down. Must still hold the owner role.
 *  - a live **break-glass grant** containing `sso:bypass`, approved through
 *    the normal access-request queue by someone who holds it (owners).
 *
 * API keys and agent credentials never reach this gate (it is wrapped in
 * `unlessApiKey`): enforcement governs how a person signs in, and a key has no
 * sign-in. Deprovisioning revokes the keys of the person who left.
 */
import { createMiddleware } from "hono/factory";
import { and, eq } from "drizzle-orm";
import { hasPermission, resolveEffectivePermissions } from "@infrawrench/server-core/permissions";
import type { SsoSessionState } from "@infrawrench/client-core";
import { db } from "../../db/client";
import { organizationMembers, roles, users } from "../../db/schema";
import { logAudit } from "../audit";
import { isOwnerRole } from "../org-roles";
import { applyRolesOnLogin } from "./directory-sync";
import { isInVerifiedDomains } from "./group-roles";
import { cachedSsoSettings, type SsoSettingsRow } from "./settings";
import { getSessionAuth, type WorkosSessionAuth } from "./workos-api";

export const SSO_REQUIRED = "sso_required" as const;

export type SsoDecision =
  | { allow: true; reason: "not_enforced" | "outside_domains" | "sso" }
  | { allow: true; reason: "break_glass_owner" | "break_glass_grant"; audit: true }
  | { allow: false; reason: "not_sso" | "session_unknown" };

/**
 * The decision, as a pure function of what the middleware gathered. Tested
 * directly: every branch here is a way into an org.
 */
export function decideSsoAccess(input: {
  settings: Pick<
    SsoSettingsRow,
    "enforceSso" | "verifiedDomains" | "breakGlassUserIds" | "workosOrganizationId"
  > | null;
  userId: string;
  email: string;
  isOwner: boolean;
  elevationPermissions: readonly string[];
  session: WorkosSessionAuth | null;
}): SsoDecision {
  const s = input.settings;
  if (!s || !s.enforceSso) return { allow: true, reason: "not_enforced" };
  if (!isInVerifiedDomains(input.email, s.verifiedDomains)) {
    return { allow: true, reason: "outside_domains" };
  }
  if (isSsoSession(input.session, s.workosOrganizationId)) return { allow: true, reason: "sso" };
  if (input.isOwner && s.breakGlassUserIds.includes(input.userId)) {
    return { allow: true, reason: "break_glass_owner", audit: true };
  }
  // Read from the elevations alone, never from the role: `*` (owners) would
  // otherwise exempt every owner and turn enforcement into a suggestion.
  if (hasPermission(input.elevationPermissions, "sso:bypass")) {
    return { allow: true, reason: "break_glass_grant", audit: true };
  }
  return { allow: false, reason: input.session ? "not_sso" : "session_unknown" };
}

/**
 * Whether a session was established through *this* org's SSO connection. The
 * organization must match: an SSO session from some other WorkOS organization
 * proves the person controls an IdP, not that it is this org's IdP.
 */
export function isSsoSession(
  session: WorkosSessionAuth | null,
  workosOrganizationId: string,
): boolean {
  return (
    !!session &&
    session.status === "active" &&
    session.authMethod === "sso" &&
    session.organizationId === workosOrganizationId
  );
}

// ---------------------------------------------------------------------------
// Session lookups
// ---------------------------------------------------------------------------

const SESSION_CACHE_MAX = 20_000;
/** A session WorkOS did not list is retried after this long (it may be brand new). */
const NEGATIVE_TTL_MS = 30_000;
/** A positive answer is re-checked after this long, so a revoked session stops passing. */
const POSITIVE_TTL_MS = 10 * 60_000;

const sessionCache = new Map<string, { auth: WorkosSessionAuth | null; at: number }>();
/** Session ids already audited (and role-synced) as they first reached an org on this replica. */
const firstSeen = new Set<string>();

async function sessionAuth(userId: string, sessionId: string): Promise<WorkosSessionAuth | null> {
  const hit = sessionCache.get(sessionId);
  const ttl = hit?.auth ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.auth;
  let auth: WorkosSessionAuth | null = null;
  try {
    auth = await getSessionAuth(userId, sessionId);
  } catch (err) {
    // Fails closed for enforcement (null is "unknown", which is denied), but
    // is not cached, so a WorkOS blip costs one request rather than 30 s.
    console.error(`[sso] session lookup for ${userId} failed:`, err);
    return null;
  }
  sessionCache.set(sessionId, { auth, at: Date.now() });
  if (sessionCache.size > SESSION_CACHE_MAX) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
  return auth;
}

/** Test seam. */
export function __resetSsoSessionCache(): void {
  sessionCache.clear();
  firstSeen.clear();
}

function markFirstSeen(key: string): boolean {
  if (firstSeen.has(key)) return false;
  firstSeen.add(key);
  if (firstSeen.size > SESSION_CACHE_MAX) {
    const oldest = firstSeen.values().next().value;
    if (oldest !== undefined) firstSeen.delete(oldest);
  }
  return true;
}

async function isOwnerMember(organizationId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ legacyRole: organizationMembers.role, systemKey: roles.systemKey })
    .from(organizationMembers)
    .leftJoin(roles, eq(organizationMembers.roleId, roles.id))
    .where(
      and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    )
    .limit(1);
  return !!row && isOwnerRole(row.systemKey, row.legacyRole);
}

/**
 * The caller's own session as the enforcement gate would see it, for the
 * settings page ("you are signed in with SSO") and the enable-time lockout
 * check.
 */
export async function currentSessionState(input: {
  settings: SsoSettingsRow;
  userId: string;
  email: string;
  sessionId: string | undefined;
}): Promise<SsoSessionState> {
  const { settings } = input;
  // An API key (Terraform, scripts) has no session: it can still turn
  // enforcement on when its owner is a break-glass owner or sits outside the
  // enforced domains, both of which keep a way back in.
  const auth = input.sessionId ? await sessionAuth(input.userId, input.sessionId) : null;
  if (isSsoSession(auth, settings.workosOrganizationId)) return "sso";
  if (
    settings.breakGlassUserIds.includes(input.userId) &&
    (await isOwnerMember(settings.organizationId, input.userId))
  ) {
    return "break_glass_owner";
  }
  if (!isInVerifiedDomains(input.email, settings.verifiedDomains)) return "outside_domains";
  return auth ? "not_sso" : "unknown";
}

/**
 * The same decision as {@link ssoEnforcementMiddleware}, for the surfaces
 * that authenticate a person outside the org tree's middleware stack: chat,
 * cost ingest and paging (`auth/org-request-auth.ts`), MCP, and a WebSocket
 * upgrade presenting a WorkOS token directly. Without it each would be a
 * way into an SSO-enforcing org on a password session.
 *
 * Returns the structured 403 body when the person may not proceed, else null.
 * Only for people: never call it for API keys or agents.
 */
export async function ssoDenialForPerson(input: {
  organizationId: string;
  userId: string;
  email: string | undefined;
  sessionId: string | undefined;
}): Promise<{
  error: string;
  code: typeof SSO_REQUIRED;
  signInPath: string;
  workosOrganizationId: string;
} | null> {
  const settings = await cachedSsoSettings(input.organizationId);
  if (!settings?.enforceSso) return null;
  let email = input.email;
  if (!email) {
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    email = row?.email;
  }
  if (!email || !isInVerifiedDomains(email, settings.verifiedDomains)) return null;
  const auth = input.sessionId ? await sessionAuth(input.userId, input.sessionId) : null;
  const access = await resolveEffectivePermissions(input.organizationId, {
    kind: "user",
    userId: input.userId,
  });
  const decision = decideSsoAccess({
    settings,
    userId: input.userId,
    email,
    isOwner: access.role?.systemKey === "owner",
    elevationPermissions: access.elevations.flatMap((e) => e.permissions),
    session: auth,
  });
  if (decision.allow) {
    if (
      "audit" in decision &&
      markFirstSeen(`bypass:${input.organizationId}:${input.sessionId ?? input.userId}`)
    ) {
      void logAudit({
        organizationId: input.organizationId,
        userId: input.userId,
        action: "sso.bypass",
        entityType: "sso",
        entityId: input.organizationId,
        metadata: { reason: decision.reason, sessionId: input.sessionId ?? null },
      });
    }
    return null;
  }
  return ssoRequiredBody(input.organizationId, settings.workosOrganizationId);
}

function ssoRequiredBody(organizationId: string, workosOrganizationId: string) {
  return {
    error:
      "This organization requires single sign-on for your email domain. Sign in again through your identity provider.",
    code: SSO_REQUIRED,
    signInPath: ssoSignInPath(organizationId),
    workosOrganizationId,
  };
}

/**
 * Paths a member blocked by enforcement may still reach, relative to the org:
 * asking for `sso:bypass` through break-glass, and seeing their own request.
 * Deciding requests is deliberately not here: approving someone else's access
 * from a session the org does not accept would be the bypass bypassing itself.
 */
function isExemptPath(method: string, orgRelativePath: string): boolean {
  if (method === "GET" && orgRelativePath === "/team/me") return true;
  if (method === "GET" && orgRelativePath.startsWith("/access-requests")) return true;
  if (method === "POST" && orgRelativePath === "/access-requests") return true;
  return false;
}

/** Same-origin path that starts sign-in at the org's IdP, then returns to the app. */
export function ssoSignInPath(organizationId: string): string {
  return `/api/auth/sign-in?organization=${encodeURIComponent(organizationId)}`;
}

/**
 * Hono middleware for the org tree. Runs after `permissionsMiddleware` (it
 * needs the live elevations) and only for session principals.
 */
export const ssoEnforcementMiddleware = createMiddleware(async (c, next) => {
  const organizationId = c.get("organizationId");
  const session = c.get("session");
  if (!organizationId || !session) return next();

  let settings: SsoSettingsRow | null;
  try {
    settings = await cachedSsoSettings(organizationId);
  } catch (err) {
    console.error(`[sso] loading settings for ${organizationId} failed:`, err);
    return c.json({ error: "Could not check this organization's sign-in policy" }, 503);
  }
  if (!settings) return next();

  // Sign-in role sync: the first time this session reaches this org on this
  // replica, re-apply the group mappings, then re-resolve permissions so this
  // very request sees the new role.
  const seenKey = `${organizationId}:${session.sessionId ?? session.userId}`;
  if (session.sessionId && markFirstSeen(seenKey)) {
    const changed = await applyRolesOnLogin(settings, session.userId);
    if (changed) {
      const access = await resolveEffectivePermissions(organizationId, {
        kind: "user",
        userId: session.userId,
      });
      c.set("permissions", access.permissions);
      c.set("role", access.role);
      c.set("elevations", access.elevations);
    }
  }

  if (!settings.enforceSso) return next();
  if (!isInVerifiedDomains(session.email, settings.verifiedDomains)) return next();

  const auth = session.sessionId ? await sessionAuth(session.userId, session.sessionId) : null;
  const elevationPermissions = (c.get("elevations") ?? []).flatMap((e) => e.permissions);
  const decision = decideSsoAccess({
    settings,
    userId: session.userId,
    email: session.email,
    isOwner: c.get("role")?.systemKey === "owner",
    elevationPermissions,
    session: auth,
  });

  if (decision.allow) {
    if ("audit" in decision && markFirstSeen(`bypass:${seenKey}`)) {
      void logAudit({
        organizationId,
        userId: session.userId,
        action: "sso.bypass",
        entityType: "sso",
        entityId: organizationId,
        metadata: {
          reason: decision.reason,
          sessionId: session.sessionId ?? null,
          authMethod: auth?.authMethod ?? null,
        },
      });
    }
    return next();
  }

  const path = new URL(c.req.url).pathname;
  const prefix = `/api/org/${organizationId}`;
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) || "/" : path;
  if (isExemptPath(c.req.method, rel)) return next();

  return c.json(ssoRequiredBody(organizationId, settings.workosOrganizationId), 403);
});
