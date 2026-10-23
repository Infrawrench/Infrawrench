/**
 * Agent links: a platform that a person approved to mint scoped agents.
 *
 * Two halves, mirroring the trial ceremony in `trials/ceremony.ts`:
 *
 *  1. **The device flow.** A platform (Nibblets) asks for a link and gets a
 *     device code (its secret for polling) and a user code (what its user
 *     types on `/link-agents`). A signed-in person approves it into one of
 *     their organizations with a ceiling of permissions; the platform's next
 *     poll collects an `iwl_` credential, exactly once.
 *  2. **The link's own surface.** With that credential the platform creates,
 *     edits, rotates and revokes **platform agents**: ordinary
 *     `agent_auth_registrations` rows (`kind: "platform"`) with their own
 *     `iwa_` credential, user row and membership, which then act through the
 *     same MCP server and org route tree every agent uses.
 *
 * The link never acts itself. Its credential reaches nothing but the
 * `/api/agent-link` routes, so leaking it lets someone mint agents bounded by
 * the ceiling (and the approver's role), never more, and revoking the link
 * ends every agent it made in the same transaction.
 *
 * Authority is computed, never stored: an agent's permissions are its scopes
 * ∩ the link ceiling ∩ the approver's *current* role − the agent denials, then
 * narrowed to its providers, recomputed per request in `resolveAgentPrincipal`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";

import { db } from "../db/client.js";
import {
  agentAuthRegistrations,
  agentLinkRequests,
  agentLinks,
  organizationMembers,
  organizations,
  users,
} from "../db/schema.js";
import { isUniqueViolation } from "../db/errors.js";
import { keyedHash } from "../encryption.js";
import { ALL_PERMISSIONS, intersectPermissions } from "../permissions/catalog.js";
import {
  ensureSystemRoles,
  getSystemRole,
  resolveEffectivePermissions,
} from "../permissions/resolver.js";
import { AGENT_DENIED_PERMISSIONS } from "../trials/principal.js";
import {
  formatClaimCode,
  mintAgentCredential,
  mintClaimCode,
  normalizeClaimCode,
  revokeAgentRegistration,
} from "../trials/ceremony.js";
import { agentUserEmail, agentUserId } from "../trials/identity.js";
import { isProviderScoped, isValidPluginId } from "./scopes.js";

const DEVICE_CODE_HASH_DOMAIN = "agent-link-device-code";
const USER_CODE_HASH_DOMAIN = "agent-link-user-code";
const LINK_CREDENTIAL_HASH_DOMAIN = "agent-link-credential";

/** How long a request waits for a person. RFC 8628's usual 15 minutes. */
export const LINK_REQUEST_TTL_MS = 15 * 60 * 1000;
/** Seconds between polls the platform is told to keep to. */
export const LINK_POLL_INTERVAL_S = 5;
/**
 * How long after the request's own expiry an approved link can still be
 * collected. A platform polls every few seconds, so this only matters for one
 * that was offline at the moment of approval; it is bounded so an approval
 * nobody collected cannot be picked up days later.
 */
export const LINK_COLLECT_GRACE_MS = 15 * 60 * 1000;
/**
 * Link requests one address may open per hour. Unlike a trial registration a
 * request creates nothing a person did not approve, so this is about table
 * growth and code-space noise rather than free resources, and is set well
 * above what a real platform needs.
 */
export const LINK_REQUESTS_PER_IP_PER_HOUR = 20;
export const LINK_REQUESTS_GLOBAL_PER_HOUR = 2000;

export const PLATFORM_SLUG = /^[a-z0-9-]{1,40}$/;
export const EXTERNAL_ID_MAX = 120;
/**
 * Live agents one link may hold. Each is a user row and a membership, so a
 * leaked `iwl_` must not be a way to mint them without end; a Nibblets server
 * makes one per nibblet, far below this.
 */
export const MAX_LIVE_AGENTS_PER_LINK = 200;
/** How long a decided or expired link request is kept before it is pruned. */
export const LINK_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
export const LABEL_MAX = 80;

export class AgentLinkError extends Error {
  status: number;
  code: string | undefined;
  details: Record<string, unknown> | undefined;
  constructor(message: string, status = 400, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentLinkError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** `iwl_` + 32 random bytes. Shown once, stored only as an HMAC. */
async function mintLinkCredential(): Promise<{ token: string; prefix: string; hashed: string }> {
  const token = `iwl_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    prefix: token.slice(0, 8),
    hashed: await keyedHash(token, LINK_CREDENTIAL_HASH_DOMAIN),
  };
}

// ─── The device flow ────────────────────────────────────────────────────────

export interface CreateLinkRequestOptions {
  platform: string;
  label: string;
  requestedScopes: string[];
  ip: string | null;
  now?: Date;
}

export interface StartedLinkRequest {
  deviceCode: string;
  /** Formatted `XXXX-XXXX`. */
  userCode: string;
  expiresAt: Date;
}

/**
 * Open a link request. Rate limited inside an advisory-locked transaction, the
 * same count-then-insert shape as trial registration, so concurrent requests
 * from one address cannot all pass the same count.
 */
export async function createLinkRequest(
  options: CreateLinkRequestOptions,
): Promise<StartedLinkRequest> {
  const now = options.now ?? new Date();
  const deviceCode = randomBytes(32).toString("base64url");
  const userCode = mintClaimCode();
  const expiresAt = new Date(now.getTime() + LINK_REQUEST_TTL_MS);
  const [hashedDeviceCode, hashedUserCode] = await Promise.all([
    keyedHash(deviceCode, DEVICE_CODE_HASH_DOMAIN),
    keyedHash(userCode, USER_CODE_HASH_DOMAIN),
  ]);

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('infrawrench:agent-link-request'::text, 0))`,
    );
    // Requests are only ever looked up while live (or briefly after, to be
    // collected), so anything a day past its expiry is dead weight in the
    // count below. Pruned here, under the same lock, rather than by a pass.
    await tx
      .delete(agentLinkRequests)
      .where(lt(agentLinkRequests.expiresAt, new Date(now.getTime() - LINK_REQUEST_RETENTION_MS)));
    const since = new Date(now.getTime() - 60 * 60 * 1000);
    const [global] = await tx
      .select({ n: count() })
      .from(agentLinkRequests)
      .where(gte(agentLinkRequests.createdAt, since));
    if ((global?.n ?? 0) >= LINK_REQUESTS_GLOBAL_PER_HOUR) {
      throw new AgentLinkError("Link requests are temporarily paused. Try again later.", 429);
    }
    if (options.ip) {
      const [perIp] = await tx
        .select({ n: count() })
        .from(agentLinkRequests)
        .where(
          and(
            eq(agentLinkRequests.createdFromIp, options.ip),
            gte(agentLinkRequests.createdAt, since),
          ),
        );
      if ((perIp?.n ?? 0) >= LINK_REQUESTS_PER_IP_PER_HOUR) {
        throw new AgentLinkError(
          `A maximum of ${LINK_REQUESTS_PER_IP_PER_HOUR} link requests can be opened per hour ` +
            "from one address.",
          429,
          "rate_limited",
        );
      }
    }
    await tx.insert(agentLinkRequests).values({
      id: randomUUID(),
      platform: options.platform,
      label: options.label,
      requestedScopes: options.requestedScopes,
      hashedDeviceCode,
      hashedUserCode,
      expiresAt,
      createdFromIp: options.ip,
      createdAt: now,
    });
  });

  return { deviceCode, userCode: formatClaimCode(userCode), expiresAt };
}

export type LinkPoll =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "slow_down" }
  | { status: "approved"; credential: string; linkId: string };

/**
 * What the platform polls. `approved` is answered exactly once: the request
 * flips to `consumed` in a conditional update, and only the poll that wins it
 * creates the link and mints the credential. Every later poll reads `expired`.
 */
export async function pollLinkRequest(deviceCode: string, now = new Date()): Promise<LinkPoll> {
  if (!deviceCode) return { status: "expired" };
  const hashed = await keyedHash(deviceCode, DEVICE_CODE_HASH_DOMAIN);
  const [row] = await db
    .select({
      id: agentLinkRequests.id,
      status: agentLinkRequests.status,
      expiresAt: agentLinkRequests.expiresAt,
      lastPolledAt: agentLinkRequests.lastPolledAt,
    })
    .from(agentLinkRequests)
    .where(eq(agentLinkRequests.hashedDeviceCode, hashed))
    .limit(1);
  if (!row) return { status: "expired" };

  if (row.status === "consumed") return { status: "expired" };
  if (row.status === "denied") return { status: "denied" };

  if (row.status === "approved") {
    if (row.expiresAt.getTime() + LINK_COLLECT_GRACE_MS < now.getTime()) {
      return { status: "expired" };
    }
    return await collectApprovedLink(row.id, now);
  }

  if (row.expiresAt < now) return { status: "expired" };

  // RFC 8628 §3.5: a client polling faster than `interval` is told to slow
  // down. A second's slack absorbs ordinary timer jitter.
  if (
    row.lastPolledAt &&
    now.getTime() - row.lastPolledAt.getTime() < LINK_POLL_INTERVAL_S * 1000 - 1000
  ) {
    return { status: "slow_down" };
  }
  await db
    .update(agentLinkRequests)
    .set({ lastPolledAt: now })
    .where(eq(agentLinkRequests.id, row.id));
  return { status: "pending" };
}

async function collectApprovedLink(requestId: string, now: Date): Promise<LinkPoll> {
  const credential = await mintLinkCredential();
  const linkId = randomUUID();

  const created = await db.transaction(async (tx) => {
    // The exactly-once gate. Two concurrent polls both read `approved`; only
    // one of them gets a row back from this update.
    const [won] = await tx
      .update(agentLinkRequests)
      .set({ status: "consumed" })
      .where(and(eq(agentLinkRequests.id, requestId), eq(agentLinkRequests.status, "approved")))
      .returning({
        platform: agentLinkRequests.platform,
        label: agentLinkRequests.label,
        organizationId: agentLinkRequests.organizationId,
        approvedScopes: agentLinkRequests.approvedScopes,
        decidedByUserId: agentLinkRequests.decidedByUserId,
      });
    if (!won || !won.organizationId || !won.decidedByUserId) return null;

    await tx.insert(agentLinks).values({
      id: linkId,
      organizationId: won.organizationId,
      platform: won.platform,
      label: won.label,
      scopes: won.approvedScopes ?? [],
      approvedByUserId: won.decidedByUserId,
      hashedCredential: credential.hashed,
      credentialPrefix: credential.prefix,
      createdAt: now,
    });
    await tx.update(agentLinkRequests).set({ linkId }).where(eq(agentLinkRequests.id, requestId));
    return won;
  });

  if (!created) return { status: "expired" };
  return { status: "approved", credential: credential.token, linkId };
}

export interface PendingLinkRequest {
  id: string;
  platform: string;
  label: string;
  requestedScopes: string[];
  expiresAt: Date;
}

/**
 * Find the pending request a user code belongs to, for the approval page.
 * Session-only and behind the route's per-user attempt limit: the lookup is
 * global, exactly like a claim code's.
 */
export async function lookupLinkRequest(
  userCode: string,
  now = new Date(),
): Promise<PendingLinkRequest> {
  const normalized = normalizeClaimCode(userCode);
  if (!normalized) {
    throw new AgentLinkError("That code doesn't look right. Check it and try again.");
  }
  const hashed = await keyedHash(normalized, USER_CODE_HASH_DOMAIN);
  const [row] = await db
    .select({
      id: agentLinkRequests.id,
      platform: agentLinkRequests.platform,
      label: agentLinkRequests.label,
      requestedScopes: agentLinkRequests.requestedScopes,
      expiresAt: agentLinkRequests.expiresAt,
      status: agentLinkRequests.status,
    })
    .from(agentLinkRequests)
    .where(eq(agentLinkRequests.hashedUserCode, hashed))
    .limit(1);
  if (!row || row.status !== "pending") {
    throw new AgentLinkError("That code is not valid. Start linking again to get a new one.");
  }
  if (row.expiresAt < now) {
    throw new AgentLinkError("That code has expired. Start linking again to get a new one.");
  }
  return {
    id: row.id,
    platform: row.platform,
    label: row.label,
    requestedScopes: row.requestedScopes,
    expiresAt: row.expiresAt,
  };
}

/**
 * Record a person's approval. The caller has already checked `team:invite` in
 * the org and that `scopes` is within what the approver holds; the conditional
 * update is what stops a code being decided twice.
 */
export async function approveLinkRequest(options: {
  requestId: string;
  organizationId: string;
  userId: string;
  scopes: string[];
  now?: Date;
}): Promise<void> {
  const now = options.now ?? new Date();
  const rows = await db
    .update(agentLinkRequests)
    .set({
      status: "approved",
      organizationId: options.organizationId,
      approvedScopes: options.scopes,
      decidedByUserId: options.userId,
    })
    .where(
      and(
        eq(agentLinkRequests.id, options.requestId),
        eq(agentLinkRequests.status, "pending"),
        gte(agentLinkRequests.expiresAt, now),
      ),
    )
    .returning({ id: agentLinkRequests.id });
  if (rows.length === 0) {
    throw new AgentLinkError("That request was already decided or has expired.", 409);
  }
}

export async function denyLinkRequest(requestId: string, userId: string): Promise<void> {
  await db
    .update(agentLinkRequests)
    .set({ status: "denied", decidedByUserId: userId })
    .where(and(eq(agentLinkRequests.id, requestId), eq(agentLinkRequests.status, "pending")));
}

// ─── Links ──────────────────────────────────────────────────────────────────

export interface AgentLinkRow {
  id: string;
  organizationId: string;
  platform: string;
  label: string;
  scopes: string[];
  approvedByUserId: string | null;
  credentialPrefix: string | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const linkColumns = {
  id: agentLinks.id,
  organizationId: agentLinks.organizationId,
  platform: agentLinks.platform,
  label: agentLinks.label,
  scopes: agentLinks.scopes,
  approvedByUserId: agentLinks.approvedByUserId,
  credentialPrefix: agentLinks.credentialPrefix,
  lastSeenAt: agentLinks.lastSeenAt,
  revokedAt: agentLinks.revokedAt,
  createdAt: agentLinks.createdAt,
};

/**
 * Create a link directly, as if a device-flow request had been approved: the
 * path Infrawrench itself takes when it sets up a platform's server (a
 * Nibblets agent session). The caller has already checked what the approver
 * may grant. No credential yet; {@link issueLinkCredential} mints it when the
 * server is ready to receive it.
 */
export async function createApprovedLink(options: {
  organizationId: string;
  platform: string;
  label: string;
  scopes: string[];
  approvedByUserId: string;
  now?: Date;
}): Promise<AgentLinkRow> {
  const id = randomUUID();
  const createdAt = options.now ?? new Date();
  await db.insert(agentLinks).values({
    id,
    organizationId: options.organizationId,
    platform: options.platform,
    label: options.label,
    scopes: options.scopes,
    approvedByUserId: options.approvedByUserId,
    createdAt,
  });
  return {
    id,
    organizationId: options.organizationId,
    platform: options.platform,
    label: options.label,
    scopes: options.scopes,
    approvedByUserId: options.approvedByUserId,
    credentialPrefix: null,
    lastSeenAt: null,
    revokedAt: null,
    createdAt,
  };
}

/**
 * Mint (or re-mint) a link's `iwl_` credential, for delivery to a server
 * Infrawrench is setting up. Only while the platform has **never used** the
 * link: a setup retry may need a fresh secret (the previous one never arrived,
 * or arrived and was discarded with a failed install), but once the platform
 * has called in with it, re-minting would cut a working server off. Null when
 * the link is revoked or already in use.
 */
export async function issueLinkCredential(linkId: string): Promise<string | null> {
  const credential = await mintLinkCredential();
  const rows = await db
    .update(agentLinks)
    .set({ hashedCredential: credential.hashed, credentialPrefix: credential.prefix })
    .where(
      and(eq(agentLinks.id, linkId), isNull(agentLinks.revokedAt), isNull(agentLinks.lastSeenAt)),
    )
    .returning({ id: agentLinks.id });
  return rows.length > 0 ? credential.token : null;
}

/** Resolve an `iwl_` credential to its live link, or null. */
export async function resolveLinkCredential(token: string): Promise<AgentLinkRow | null> {
  if (!token.startsWith("iwl_")) return null;
  const hashed = await keyedHash(token, LINK_CREDENTIAL_HASH_DOMAIN);
  const [row] = await db
    .select(linkColumns)
    .from(agentLinks)
    .where(and(eq(agentLinks.hashedCredential, hashed), isNull(agentLinks.revokedAt)))
    .limit(1);
  return row ?? null;
}

export async function getLink(
  organizationId: string,
  linkId: string,
): Promise<AgentLinkRow | null> {
  const [row] = await db
    .select(linkColumns)
    .from(agentLinks)
    .where(and(eq(agentLinks.id, linkId), eq(agentLinks.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function listOrgLinks(organizationId: string): Promise<AgentLinkRow[]> {
  return await db
    .select(linkColumns)
    .from(agentLinks)
    .where(eq(agentLinks.organizationId, organizationId))
    .orderBy(desc(agentLinks.createdAt));
}

const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

/** "Last seen" for a link. Throttled and never throws, like the agent touch. */
export async function touchLink(linkId: string, now = new Date()): Promise<void> {
  const previous = lastTouched.get(linkId);
  if (previous !== undefined && now.getTime() - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(linkId, now.getTime());
  if (lastTouched.size > 10_000) lastTouched.clear();
  try {
    await db.update(agentLinks).set({ lastSeenAt: now }).where(eq(agentLinks.id, linkId));
  } catch (e) {
    console.warn(`[agent-links] could not record lastSeenAt for ${linkId}:`, e);
  }
}

/**
 * What a person may hand to an agent: the catalog minus the agent denials,
 * intersected with their own current role (no break-glass elevation).
 */
export async function grantablePermissions(
  organizationId: string,
  userId: string,
): Promise<string[]> {
  const access = await resolveEffectivePermissions(
    organizationId,
    { kind: "user", userId },
    { includeElevation: false },
  );
  return intersectPermissions(
    access.permissions,
    ALL_PERMISSIONS.filter((p) => !AGENT_DENIED_PERMISSIONS.includes(p)),
  );
}

/**
 * The link's ceiling as it stands now: what was approved ∩ what the approver
 * still holds − the agent denials. An approver who is demoted or leaves
 * narrows (or empties) every link they approved on the next call.
 */
export async function linkEffectiveScopes(link: AgentLinkRow): Promise<string[]> {
  if (!link.approvedByUserId || link.revokedAt) return [];
  const grantable = await grantablePermissions(link.organizationId, link.approvedByUserId);
  return intersectPermissions(grantable, link.scopes);
}

/**
 * Revoke a link and every live agent it made, in one transaction, so there is
 * no moment where the link is gone and its agents still answer.
 */
export async function revokeLink(linkId: string, now = new Date()): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .update(agentLinks)
      .set({ revokedAt: now })
      .where(and(eq(agentLinks.id, linkId), isNull(agentLinks.revokedAt)))
      .returning({ id: agentLinks.id });
    await tx
      .update(agentAuthRegistrations)
      .set({ revokedAt: now })
      .where(
        and(eq(agentAuthRegistrations.linkId, linkId), isNull(agentAuthRegistrations.revokedAt)),
      );
    return rows.length > 0;
  });
}

/** The approver's email, for `LinkInfo.approvedBy`. */
export async function userEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.email ?? null;
}

export async function organizationName(organizationId: string): Promise<string | null> {
  const [row] = await db
    .select({ displayName: organizations.displayName })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return row?.displayName ?? null;
}

// ─── Platform agents ────────────────────────────────────────────────────────

export interface PlatformAgentRow {
  id: string;
  externalId: string | null;
  label: string | null;
  scopes: string[] | null;
  providers: string[] | null;
  credentialPrefix: string | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const agentColumns = {
  id: agentAuthRegistrations.id,
  externalId: agentAuthRegistrations.externalId,
  label: agentAuthRegistrations.label,
  scopes: agentAuthRegistrations.scopes,
  providers: agentAuthRegistrations.providers,
  credentialPrefix: agentAuthRegistrations.credentialPrefix,
  lastSeenAt: agentAuthRegistrations.lastSeenAt,
  revokedAt: agentAuthRegistrations.revokedAt,
  createdAt: agentAuthRegistrations.createdAt,
};

export async function listLinkAgents(linkId: string): Promise<PlatformAgentRow[]> {
  return await db
    .select(agentColumns)
    .from(agentAuthRegistrations)
    .where(eq(agentAuthRegistrations.linkId, linkId))
    .orderBy(desc(agentAuthRegistrations.createdAt));
}

export async function getLinkAgent(
  linkId: string,
  agentId: string,
): Promise<PlatformAgentRow | null> {
  const [row] = await db
    .select(agentColumns)
    .from(agentAuthRegistrations)
    .where(and(eq(agentAuthRegistrations.id, agentId), eq(agentAuthRegistrations.linkId, linkId)))
    .limit(1);
  return row ?? null;
}

/**
 * Check a requested grant against the link's current ceiling.
 *
 * Scopes must be plain catalog strings inside `effective`; providers must be
 * plugin-id shaped (the caller checks they name real plugins). Throws the
 * contract's `400 scope_not_allowed` naming exactly the offending scopes.
 */
export function validateAgentGrant(
  effective: readonly string[],
  scopes: unknown,
  providers: unknown,
): { scopes: string[]; providers: string[] } {
  if (!Array.isArray(scopes) || scopes.some((s) => typeof s !== "string")) {
    throw new AgentLinkError("`scopes` must be an array of permission strings.");
  }
  const unique = [...new Set(scopes as string[])];
  const notAllowed = unique.filter((s) => !effective.includes(s));
  if (notAllowed.length > 0) {
    throw new AgentLinkError(
      `These scopes are outside what this link may grant: ${notAllowed.join(", ")}`,
      400,
      "scope_not_allowed",
      { scopes: notAllowed },
    );
  }
  let providerList: string[] = [];
  if (providers !== undefined && providers !== null) {
    if (!Array.isArray(providers) || providers.some((p) => typeof p !== "string")) {
      throw new AgentLinkError("`providers` must be an array of plugin ids.");
    }
    providerList = [...new Set(providers as string[])];
    const bad = providerList.filter((p) => !isValidPluginId(p));
    if (bad.length > 0) {
      throw new AgentLinkError(`Not plugin ids: ${bad.join(", ")}`, 400, "invalid_provider");
    }
  }
  // Narrowing only rewrites the provider-scoped families (resources, secrets,
  // storage). Anything else would stay org-wide under a grant that reads as
  // "only these providers": an AWS-only agent holding `accounts:delete` could
  // delete a GCP account. So with providers chosen, those are refused.
  if (providerList.length > 0) {
    const notNarrowable = unique.filter((s) => !isProviderScoped(s));
    if (notNarrowable.length > 0) {
      throw new AgentLinkError(
        `These scopes cannot be limited to providers, so they cannot be combined with ` +
          `\`providers\`: ${notNarrowable.join(", ")}`,
        400,
        "scope_not_allowed",
        { scopes: notNarrowable },
      );
    }
  }
  return { scopes: unique, providers: providerList };
}

export interface CreatePlatformAgentOptions {
  link: AgentLinkRow;
  externalId: string;
  label: string;
  scopes: string[];
  providers: string[];
  now?: Date;
}

/**
 * Create a platform agent: the registration row, its own user and a `member`
 * membership, as `trials/create.ts` builds them for a trial, minus the org and
 * the dashboard. Accountable to the link's approver from birth.
 */
export async function createPlatformAgent(
  options: CreatePlatformAgentOptions,
): Promise<{ agent: PlatformAgentRow; credential: string }> {
  const { link } = options;
  if (!link.approvedByUserId) {
    throw new AgentLinkError("The person who approved this link no longer exists.", 403);
  }
  const now = options.now ?? new Date();
  const id = randomUUID();
  const credential = await mintAgentCredential();

  const existing = await liveAgentByExternalId(link.id, options.externalId);
  if (existing) {
    throw new AgentLinkError("An agent with that externalId already exists.", 409, "exists", {
      agentId: existing,
    });
  }

  // Idempotent per org, and outside the transaction because they run on the
  // shared handle.
  await ensureSystemRoles(link.organizationId);
  const memberRole = await getSystemRole(link.organizationId, "member");
  const userId = agentUserId(id);

  try {
    // One transaction for the registration, its user and its membership: a
    // failure part-way must not leave a registration that holds the
    // externalId (a 409 forever) with no identity to act as.
    await db.transaction(async (tx) => {
      // Serialises creates on one link, which is what makes the cap below a
      // count nobody can race past.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`infrawrench:agent-link:${link.id}`}::text, 0))`,
      );
      const [live] = await tx
        .select({ n: count() })
        .from(agentAuthRegistrations)
        .where(
          and(eq(agentAuthRegistrations.linkId, link.id), isNull(agentAuthRegistrations.revokedAt)),
        );
      if ((live?.n ?? 0) >= MAX_LIVE_AGENTS_PER_LINK) {
        throw new AgentLinkError(
          `This link already has ${MAX_LIVE_AGENTS_PER_LINK} live agents. Revoke some first.`,
          409,
          "too_many_agents",
        );
      }
      await tx.insert(agentAuthRegistrations).values({
        id,
        organizationId: link.organizationId,
        kind: "platform",
        label: options.label,
        hashedCredential: credential.hashed,
        credentialPrefix: credential.prefix,
        claimedByUserId: link.approvedByUserId,
        claimedAt: now,
        linkId: link.id,
        externalId: options.externalId,
        scopes: options.scopes,
        providers: options.providers,
        createdAt: now,
      });
      await tx
        .insert(users)
        .values({ id: userId, email: agentUserEmail(id), displayName: options.label })
        .onConflictDoNothing();
      await tx
        .insert(organizationMembers)
        .values({
          id: randomUUID(),
          userId,
          organizationId: link.organizationId,
          role: "member",
          roleId: memberRole.id,
        })
        .onConflictDoNothing();
    });
  } catch (e) {
    // The partial unique index on (link_id, external_id) closes the race the
    // read above cannot: two concurrent creates for the same nibblet.
    if (isUniqueViolation(e)) {
      const winner = await liveAgentByExternalId(link.id, options.externalId);
      throw new AgentLinkError("An agent with that externalId already exists.", 409, "exists", {
        agentId: winner,
      });
    }
    throw e;
  }

  return {
    agent: {
      id,
      externalId: options.externalId,
      label: options.label,
      scopes: options.scopes,
      providers: options.providers,
      credentialPrefix: credential.prefix,
      lastSeenAt: null,
      revokedAt: null,
      createdAt: now,
    },
    credential: credential.token,
  };
}

async function liveAgentByExternalId(linkId: string, externalId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: agentAuthRegistrations.id })
    .from(agentAuthRegistrations)
    .where(
      and(
        eq(agentAuthRegistrations.linkId, linkId),
        eq(agentAuthRegistrations.externalId, externalId),
        isNull(agentAuthRegistrations.revokedAt),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** Edit a live platform agent's label, scopes and providers. */
export async function updatePlatformAgent(
  agentId: string,
  patch: { label?: string; scopes?: string[]; providers?: string[] },
): Promise<void> {
  const set: Partial<typeof agentAuthRegistrations.$inferInsert> = {};
  if (patch.label !== undefined) set.label = patch.label;
  if (patch.scopes !== undefined) set.scopes = patch.scopes;
  if (patch.providers !== undefined) set.providers = patch.providers;
  if (Object.keys(set).length === 0) return;
  await db
    .update(agentAuthRegistrations)
    .set(set)
    .where(and(eq(agentAuthRegistrations.id, agentId), isNull(agentAuthRegistrations.revokedAt)));
  if (patch.label !== undefined) {
    // The agent's user row is what the audit log and the team list name.
    await db
      .update(users)
      .set({ displayName: patch.label })
      .where(eq(users.id, agentUserId(agentId)));
  }
}

/**
 * Replace a platform agent's credential. The old hash is overwritten in the
 * same statement, so the old token stops resolving on its next request.
 */
export async function rotatePlatformAgent(
  agentId: string,
): Promise<{ credential: string; prefix: string } | null> {
  const credential = await mintAgentCredential();
  const rows = await db
    .update(agentAuthRegistrations)
    .set({ hashedCredential: credential.hashed, credentialPrefix: credential.prefix })
    .where(and(eq(agentAuthRegistrations.id, agentId), isNull(agentAuthRegistrations.revokedAt)))
    .returning({ id: agentAuthRegistrations.id });
  if (rows.length === 0) return null;
  return { credential: credential.token, prefix: credential.prefix };
}

export { revokeAgentRegistration as revokePlatformAgent };
