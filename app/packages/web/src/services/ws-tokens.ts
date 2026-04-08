import { randomBytes, createHash } from "node:crypto";

/**
 * In-memory store for short-lived WebSocket tokens.
 * Tokens expire after 30 seconds — just long enough for the WS handshake.
 */
const tokenStore = new Map<string, { organizationId: string; userId: string; expiresAt: number }>();

// Periodically clean up expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of tokenStore) {
    if (value.expiresAt < now) tokenStore.delete(key);
  }
}, 30_000);

export function createWsToken(userId: string, organizationId: string): string {
  const rawToken = randomBytes(32).toString("hex");
  const hashedToken = createHash("sha256").update(rawToken).digest("hex");
  tokenStore.set(hashedToken, {
    organizationId,
    userId,
    expiresAt: Date.now() + 30_000, // 30 seconds
  });
  return rawToken;
}

export function validateWsToken(rawToken: string): { organizationId: string; userId: string } | null {
  const hashedToken = createHash("sha256").update(rawToken).digest("hex");
  const entry = tokenStore.get(hashedToken);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    tokenStore.delete(hashedToken);
    return null;
  }
  tokenStore.delete(hashedToken); // one-time use
  return { organizationId: entry.organizationId, userId: entry.userId };
}
