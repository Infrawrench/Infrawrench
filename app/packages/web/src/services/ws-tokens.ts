import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db/client";
import { wsTokens } from "../db/schema";

/**
 * Short-lived one-time WebSocket handshake tokens, stored hashed in Postgres:
 * the web deployment runs multiple replicas, so the upgrade request may land
 * on a different pod than the one that minted the token.
 */

const TTL_MS = 30_000;

/**
 * What a token stands for. `scopes` and `agentRegistrationId` mirror
 * `PrincipalRef` in `auth/effective-permissions.ts`: absent for a person,
 * present when an API key or an agent minted the token, so the socket it opens
 * is held to the minter's ceiling rather than to the owning user's full role.
 */
export interface WsTokenPrincipal {
  organizationId: string;
  userId: string;
  scopes?: readonly string[];
  agentRegistrationId?: string;
}

export async function createWsToken(
  userId: string,
  organizationId: string,
  machine?: { scopes: readonly string[]; agentRegistrationId?: string },
): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const hashedToken = createHash("sha256").update(rawToken).digest("hex");
  await db.insert(wsTokens).values({
    hashedToken,
    organizationId,
    userId,
    ...(machine
      ? {
          scopes: [...machine.scopes],
          ...(machine.agentRegistrationId
            ? { agentRegistrationId: machine.agentRegistrationId }
            : {}),
        }
      : {}),
    expiresAt: new Date(Date.now() + TTL_MS),
  });
  // Opportunistic cleanup; the table only ever holds in-flight handshakes.
  void db
    .delete(wsTokens)
    .where(lt(wsTokens.expiresAt, new Date()))
    .catch(() => undefined);
  return rawToken;
}

export async function validateWsToken(rawToken: string): Promise<WsTokenPrincipal | null> {
  const hashedToken = createHash("sha256").update(rawToken).digest("hex");
  // Delete-returning makes the token one-time-use even across replicas.
  const rows = await db
    .delete(wsTokens)
    .where(and(eq(wsTokens.hashedToken, hashedToken), gt(wsTokens.expiresAt, new Date())))
    .returning({
      organizationId: wsTokens.organizationId,
      userId: wsTokens.userId,
      scopes: wsTokens.scopes,
      agentRegistrationId: wsTokens.agentRegistrationId,
    });
  const row = rows[0];
  if (!row) return null;
  return {
    organizationId: row.organizationId,
    userId: row.userId,
    // `[]` is kept as `[]`: a key with no scopes, not a person.
    ...(row.scopes ? { scopes: row.scopes } : {}),
    ...(row.agentRegistrationId ? { agentRegistrationId: row.agentRegistrationId } : {}),
  };
}
