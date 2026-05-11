import { createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { workos, clientId } from "./workos";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";

export interface ApiAuthResult {
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
}

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
    const hashedKey = createHash("sha256").update(token).digest("hex");
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.hashedKey, hashedKey), isNull(apiKeys.revokedAt)));

    if (!key) return null;

    if (key.expiresAt && key.expiresAt < new Date()) return null;

    const storedScopes = (key.scopes as string[]) ?? [];
    const migrated = migrateScopes(storedScopes);
    const scopesChanged =
      migrated.length !== storedScopes.length || migrated.some((s, i) => s !== storedScopes[i]);

    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date(), ...(scopesChanged ? { scopes: migrated } : {}) })
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
    throw new Error(`Missing required scope: ${scope}`);
  }
}
