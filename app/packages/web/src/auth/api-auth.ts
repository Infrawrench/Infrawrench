import { eq, and, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { db } from "@/db/client";
import { apiKeys, organizationMembers } from "@/db/schema";
import { keyedHash, legacySha256Hex } from "@/services/encryption";
import { workos, clientId } from "./workos";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";

/** Domain label for HMAC sub-key derivation when hashing API keys. Must
 * match the value used in `api/routes/api-keys.ts`. */
const API_KEY_HASH_DOMAIN = "api-key";

interface ApiAuthResult {
  userId: string;
  organizationId: string;
  email?: string;
  apiKeyId?: string;
  scopes?: string[];
}

/** Map deprecated scope strings onto their new equivalents. */
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
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const deduped = out.filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
  return changed ? deduped : out;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (jwks) return jwks;
  const url = new URL(workos.userManagement.getJwksUrl(clientId));
  jwks = createRemoteJWKSet(url);
  return jwks;
}

interface WorkosAccessTokenClaims extends JWTPayload {
  sub?: string;
  email?: string;
  org_id?: string;
  /** WorkOS session id the token was minted for. */
  sid?: string;
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
 * Authenticate an API request via Bearer token.
 * Supports API keys (iwk_ prefix) and WorkOS access tokens.
 */
export async function authenticateApiRequest(request: Request): Promise<ApiAuthResult | null> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const token = auth.slice(7);

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
  if (!claims?.sub || !claims.org_id) return null;

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
