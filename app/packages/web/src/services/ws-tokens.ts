import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db/client";
import { wsTokens } from "../db/schema";

/**
 * Short-lived one-time WebSocket handshake tokens, stored hashed in Postgres —
 * the web deployment runs multiple replicas, so the upgrade request may land
 * on a different pod than the one that minted the token.
 */

const TTL_MS = 30_000;

export async function createWsToken(userId: string, organizationId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const hashedToken = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(wsTokens).values({
    hashedToken,
    organizationId,
    userId,
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  // Opportunistic cleanup; the table only ever holds in-flight handshakes.
  void db
    .delete(wsTokens)
    .where(lt(wsTokens.expiresAt, new Date()))
    .catch(() => undefined);
  return rawToken;
}

export async function validateWsToken(
  rawToken: string,
): Promise<{ organizationId: string; userId: string } | null> {
  const hashedToken = createHash("sha256").update(rawToken).digest("hex");
  // Delete-returning makes the token one-time-use even across replicas.
  const rows = await db
    .delete(wsTokens)
    .where(and(eq(wsTokens.hashedToken, hashedToken), gt(wsTokens.expiresAt, new Date())))
    .returning({ organizationId: wsTokens.organizationId, userId: wsTokens.userId });
  return rows[0] ?? null;
}
