import { eq, and, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { db } from "@/db/client";
import { apiKeys, organizationMembers } from "@/db/schema";
import { keyedHash, legacySha256Hex } from "@/services/encryption";
import { workos, clientId } from "./workos";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";
import {
  resolveAgentPrincipal,
  touchAgentRegistration,
} from "@infrawrench/server-core/trials/principal";
import { resolveAgentCredential } from "@infrawrench/server-core/trials/ceremony";

/** Domain label for HMAC sub-key derivation when hashing API keys. Must
 * match the value used in `api/routes/api-keys.ts`. */
const API_KEY_HASH_DOMAIN = "api-key";

interface ApiAuthResult {
  userId: string;
  organizationId: string;
  email?: string;
  apiKeyId?: string;
  scopes?: string[];
  /**
   * Set when the caller authenticated with an agent-auth credential. Its
   * presence is what tells a surface it is not talking to a person — the
   * `userId` beside it is the agent's own user row, not a human's.
   */
  agentRegistrationId?: string;
}

/**
 * Map deprecated scope strings onto their new equivalents.
 *
 * This is a pure rename — `sync:read`/`sync:write` become
 * `resources:read`/`resources:write` and the old strings disappear — which is
 * why the result is safe to persist back onto the row (see
 * {@link authenticateApiRequest}). Nothing else is expanded here: the one-off
 * `dashboards:*` → `workflows:*` grandfathering was applied to stored scopes by
 * migration `0055_grandfather_workflow_permissions`, so a key's stored array
 * already says everything the key grants.
 */
function migrateScopes(scopes: string[] | null | undefined): string[] {
  if (!scopes) return [];
  let changed = false;
  const out: string[] = [];
  for (const s of scopes) {
    if (s === "sync:read") {
      out.push("resources:read");
      changed = true;
    } else if (s === "sync:write") {
      out.push("resources:write");
      changed = true;
    } else {
      out.push(s);
    }
  }
  if (!changed) return out;
  // A rename can collide with a scope the key already held; deduplicate while
  // preserving order. Untouched arrays are returned as-is so a key that stores
  // duplicates is not rewritten for cosmetics.
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks) return jwks;
  const url = new URL(workos.userManagement.getJwksUrl(clientId));
  jwks = createRemoteJWKSet(url);
  return jwks;
}

export interface WorkosAccessTokenClaims extends JWTPayload {
  sub?: string;
  email?: string;
  org_id?: string;
  /** WorkOS session id the token was minted for. */
  sid?: string;
  /**
   * RFC 8693 delegation claim, present only on agent-auth tokens whose claim
   * ceremony has completed. `act.sub` names the *user behind the agent*; the
   * token's own `sub` remains the agent registration id.
   *
   * Read as a cross-check, never as the authority — see
   * `server-core/trials/principal.ts`.
   */
  act?: { sub?: string };
  /** Space-separated scopes, on agent-auth tokens. */
  scope?: string;
}

/**
 * Verification deliberately pins neither `aud` nor `iss`. Both look like
 * obvious hardening and both are wrong here:
 *
 * - **`aud`** — WorkOS AuthKit access tokens do not carry an audience claim at
 *   all (`sub`, `sid`, `iss`, `org_id`, `role`, `permissions`, `exp`, `iat`).
 *   Passing `audience` to `jwtVerify` would reject *every* token.
 * - **`iss`** — the value is not stable across configurations or SDK versions
 *   (`https://api.workos.com/`, the same without the trailing slash, or the
 *   custom AuthKit domain when one is set), so pinning it risks locking every
 *   bearer client out for no gain.
 *
 * No gain, because {@link getJwks} resolves to `/sso/jwks/<clientId>` — a
 * per-client key set. A token minted for any other WorkOS client fails the
 * signature check outright, which is the isolation an `iss`/`aud` pin would
 * have been standing in for.
 */
export async function verifyWorkosAccessToken(
  token: string,
): Promise<WorkosAccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify<WorkosAccessTokenClaims>(token, getJwks());
    return payload;
  } catch {
    return null;
  }
}

/**
 * Build the auth result for an agent registration, whichever way it proved
 * itself — an `iwa_` credential we issued or a WorkOS agent token whose `sub`
 * is the registration id. One function, so the two credential formats can never
 * end up granting different things.
 *
 * Returns null when the id is not a live registration.
 */
export async function agentAuthResult(
  registrationId: string,
  actorUserId?: string,
): Promise<ApiAuthResult | null> {
  const agent = await resolveAgentPrincipal(registrationId, { actorUserId });
  if (!agent) return null;
  void touchAgentRegistration(agent.registrationId);
  return {
    userId: agent.userId,
    organizationId: agent.organizationId,
    agentRegistrationId: agent.registrationId,
    // Already intersected with the claimer's role and the agent ceiling, so
    // `requireScope` and the tool layer both read a final answer.
    scopes: [...agent.permissions],
  };
}

/**
 * Authenticate an API request via Bearer token.
 * Supports agent credentials (`iwa_`), API keys (`iwk_`) and WorkOS access
 * tokens (a person's, or an agent's carrying a registration id in `sub`).
 */
export async function authenticateApiRequest(request: Request): Promise<ApiAuthResult | null> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const token = auth.slice(7);

  // Agent credentials. Checked before the `iwk_` branch purely because the
  // prefix test is cheaper than a hash; they are otherwise independent.
  if (token.startsWith("iwa_")) {
    const registrationId = await resolveAgentCredential(token);
    if (!registrationId) return null;
    return agentAuthResult(registrationId);
  }

  if (token.startsWith("iwk_")) {
    // HMAC hash first; legacy SHA-256 fallback for pre-migration rows. A
    // legacy hit rehashes to HMAC, unless the sunset has elapsed — past
    // sunset, a leaked SHA-256 digest must not authenticate.
    // TODO: drop the legacy lookup once all rows have been rehashed.
    const newHash = await keyedHash(token, API_KEY_HASH_DOMAIN);
    let [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.hashedKey, newHash), isNull(apiKeys.revokedAt)));

    let rehash = false;
    if (!key) {
      const legacyHash = await legacySha256Hex(token);
      [key] = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.hashedKey, legacyHash), isNull(apiKeys.revokedAt)));
      if (key) {
        // Past the sunset, the row is dead even on a hash match.
        if (key.legacyHashSunsetAt && key.legacyHashSunsetAt < new Date()) {
          return null;
        }
        rehash = true;
      }
    }

    if (!key) return null;

    if (key.expiresAt && key.expiresAt < new Date()) return null;

    // The key is only as valid as its owner's membership. Removing someone
    // from an org deletes their membership row but cannot reach into the keys
    // they minted — and once removed they can no longer see those keys in the
    // UI to revoke them. Check here so access ends with the membership.
    const [membership] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, key.userId),
          eq(organizationMembers.organizationId, key.organizationId),
        ),
      )
      .limit(1);
    if (!membership) return null;

    // Only a genuine rename ever lands back on the row: `migrateScopes` is a
    // one-for-one substitution, so persisting it cannot widen the key beyond
    // the scopes its creator ticked.
    const storedScopes = (key.scopes as string[]) ?? [];
    const migrated = migrateScopes(storedScopes);
    const scopesChanged =
      migrated.length !== storedScopes.length || migrated.some((s, i) => s !== storedScopes[i]);

    await db
      .update(apiKeys)
      .set({
        lastUsedAt: new Date(),
        ...(scopesChanged ? { scopes: migrated } : {}),
        // Legacy-hash hit → rehash to HMAC and clear the sunset.
        ...(rehash ? { hashedKey: newHash, legacyHashSunsetAt: null } : {}),
      })
      .where(eq(apiKeys.id, key.id));

    return {
      userId: key.userId,
      organizationId: key.organizationId,
      apiKeyId: key.id,
      scopes: migrated,
    };
  }

  const claims = await verifyWorkosAccessToken(token);
  if (!claims?.sub) return null;

  // Agent tokens verify against the same JWKS as a person's, so the signature
  // alone cannot tell them apart. Ask our own table before reading `sub` as a
  // user id: for an agent it is a registration id, and treating it as a user
  // would authenticate a principal that does not exist. A `user_`-prefixed sub
  // is WorkOS's user-id shape and registration ids are bare UUIDs, so the
  // lookup is skipped on the hot person-token path.
  const agentResult = claims.sub.startsWith("user_")
    ? null
    : await agentAuthResult(claims.sub, claims.act?.sub);
  if (agentResult) return agentResult;

  if (!claims.org_id) return null;

  const result: ApiAuthResult = {
    userId: claims.sub,
    organizationId: claims.org_id,
  };
  if (claims.email) result.email = claims.email;
  return result;
}

/**
 * Throws if the bearer-auth principal lacks the required permission. Uses the
 * same wildcard matcher as session auth so wildcard scopes (e.g. `*`,
 * `resources:*:read`) are honoured. WorkOS access tokens (no `scopes` field)
 * pass — they represent the full user, whose permissions are checked via
 * `permissionsMiddleware` on org-scoped routes.
 */
export function requireScope(auth: ApiAuthResult, scope: string): void {
  if (!auth.scopes) return;
  if (!hasPermission(auth.scopes, scope)) {
    // HTTPException, not a bare Error: Hono's error handler turns anything
    // else into a 500 (and echoes the message outside production), which
    // reports an authorization failure as a server fault.
    throw new HTTPException(403, { message: `Missing required scope: ${scope}` });
  }
}
