import type { SecretResolution } from "@infrawrench/plugin-base";
import { decrypt, encrypt } from "./encryption";
import { db } from "@/db/client";
import { secretFieldStates, accounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getPlugin } from "@/plugins/loader";

/** How long a cached output-ref value is considered fresh (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve a SecretResolution to a plaintext string.
 *
 * - literal: decrypt the stored encrypted value
 * - output-ref: check cache freshness → if stale, call the provider plugin's
 *   resolveOutput() → encrypt and cache the result → return plaintext
 */
export async function resolveSecret(resolution: SecretResolution): Promise<string> {
  if (resolution.kind === "literal") {
    return decrypt(resolution.encryptedValue, resolution.iv);
  }

  // output-ref: check cache
  if (resolution.cachedEncryptedValue && resolution.cachedIv && resolution.cachedAt) {
    const age = Date.now() - new Date(resolution.cachedAt).getTime();
    if (age < CACHE_TTL_MS) {
      return decrypt(resolution.cachedEncryptedValue, resolution.cachedIv);
    }
  }

  // Cache is stale or missing — resolve from provider plugin
  const providerPlugin = await getPlugin(resolution.sourcePluginId);
  if (!providerPlugin) {
    throw new Error(
      `SecretResolver: provider plugin "${resolution.sourcePluginId}" is not loaded`,
    );
  }

  // Load the provider account credentials
  const [account] = await db
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.id, resolution.sourceAccountId),
        eq(accounts.pluginId, resolution.sourcePluginId),
      ),
    )
    .limit(1);

  if (!account) {
    throw new Error(
      `SecretResolver: account "${resolution.sourceAccountId}" not found`,
    );
  }

  const credentials = JSON.parse(
    await decrypt(account.encryptedCredentials, account.credentialsIv),
  ) as Record<string, string>;

  const client = providerPlugin.plugin.createClient(credentials);
  const plaintext = await client.resolveOutput(
    resolution.sourceResourceTypeId,
    resolution.sourceResourceId,
    resolution.outputKey,
    resolution.sourceAccountId,
  );

  // Cache the result
  const { ciphertext, iv } = await encrypt(plaintext);
  await db
    .update(secretFieldStates)
    .set({
      cachedEncryptedValue: ciphertext,
      cachedValueIv: iv,
      cachedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(secretFieldStates.sourceResourceId, resolution.sourceResourceId),
        eq(secretFieldStates.sourceOutputKey, resolution.outputKey),
      ),
    );

  return plaintext;
}
