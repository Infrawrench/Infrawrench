"use server";

import { createHash, randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { apiKeys } from "@/db/schema";
import { requireAuth } from "@/auth/session";
import { logAudit } from "@/services/audit";

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export async function createApiKey(input: {
  name: string;
  scopes: string[];
  expiresAt?: string;
}): Promise<{ id: string; key: string }> {
  const session = await requireAuth();

  // Generate key: iwk_ prefix + 32 random bytes as base64url
  const raw = randomBytes(32);
  const key = `iwk_${raw.toString("base64url")}`;
  const hashedKey = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 12); // "iwk_XXXXXXXX"

  const id = uuid();
  await db.insert(apiKeys).values({
    id,
    organizationId: session.organizationId,
    userId: session.userId,
    name: input.name,
    hashedKey,
    prefix,
    scopes: input.scopes,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
  });

  void logAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    action: "api_key.create",
    entityType: "api_key",
    entityId: id,
    metadata: { name: input.name, scopes: input.scopes },
  });

  return { id, key };
}

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const session = await requireAuth();
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, session.organizationId));
  return rows.map((r) => ({
    ...r,
    scopes: (r.scopes as string[]) ?? [],
  }));
}

export async function revokeApiKey(keyId: string): Promise<void> {
  const session = await requireAuth();
  await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.organizationId, session.organizationId),
        isNull(apiKeys.revokedAt),
      ),
    );

  void logAudit({
    organizationId: session.organizationId,
    userId: session.userId,
    action: "api_key.revoke",
    entityType: "api_key",
    entityId: keyId,
  });
}

export async function rotateApiKey(keyId: string): Promise<{ id: string; key: string }> {
  const session = await requireAuth();

  // Get the old key's config
  const [old] = await db
    .select({ name: apiKeys.name, scopes: apiKeys.scopes })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, session.organizationId)),
    );
  if (!old) throw new Error("API key not found");

  // Revoke the old key
  await revokeApiKey(keyId);

  // Create a new one with the same config
  return createApiKey({
    name: old.name,
    scopes: (old.scopes as string[]) ?? [],
  });
}
