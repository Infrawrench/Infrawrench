import { createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { workos, clientId } from "./workos";

interface ApiAuthResult {
  userId: string;
  organizationId: string;
  email?: string;
  apiKeyId?: string;
  scopes?: string[];
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

    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));

    return {
      userId: key.userId,
      organizationId: key.organizationId,
      apiKeyId: key.id,
      scopes: (key.scopes as string[]) ?? [],
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

export function requireScope(auth: ApiAuthResult, scope: string): void {
  if (auth.scopes && !auth.scopes.includes(scope)) {
    throw new Error(`Missing required scope: ${scope}`);
  }
}
