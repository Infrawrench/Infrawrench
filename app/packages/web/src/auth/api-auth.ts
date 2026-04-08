import { createHash } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";

export interface ApiAuthResult {
  userId: string;
  organizationId: string;
  apiKeyId?: string;
  scopes?: string[];
}

/**
 * Authenticate an API request via Bearer token.
 * Supports API keys (iwk_ prefix) and WorkOS access tokens.
 */
export async function authenticateApiRequest(
  request: Request,
): Promise<ApiAuthResult | null> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return null;

  const token = auth.slice(7);

  // API key auth
  if (token.startsWith("iwk_")) {
    const hashedKey = createHash("sha256").update(token).digest("hex");
    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.hashedKey, hashedKey), isNull(apiKeys.revokedAt)));

    if (!key) return null;

    // Check expiration
    if (key.expiresAt && key.expiresAt < new Date()) return null;

    // Update last used
    await db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, key.id));

    return {
      userId: key.userId,
      organizationId: key.organizationId,
      apiKeyId: key.id,
      scopes: (key.scopes as string[]) ?? [],
    };
  }

  // TODO: WorkOS access token (JWT) verification for desktop OAuth
  // For now, only API key auth is supported
  return null;
}

export function requireScope(auth: ApiAuthResult, scope: string): void {
  if (auth.scopes && !auth.scopes.includes(scope)) {
    throw new Error(`Missing required scope: ${scope}`);
  }
}
