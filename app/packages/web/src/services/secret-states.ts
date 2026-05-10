import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { secretFieldStates } from "../db/schema";
import { decrypt } from "./encryption";
import type { SecretFieldState, SecretResolution } from "@infrawrench/plugin-base";

/**
 * Loads any persisted secretStates for a resource and decrypts each literal
 * row into a `plaintext` resolution. Plugins receive plaintext or output-ref
 * shapes — they never see ciphertext or master-key-derived values.
 */
export async function loadSecretStatesForResource(resourceId: string): Promise<SecretFieldState[]> {
  const rows = await db
    .select()
    .from(secretFieldStates)
    .where(eq(secretFieldStates.resourceId, resourceId));
  const result: SecretFieldState[] = [];
  for (const s of rows) {
    if (s.resolutionKind === "literal") {
      let value = "";
      if (s.encryptedValue && s.valueIv) {
        try {
          value = await decrypt(s.encryptedValue, s.valueIv);
        } catch {
          // Surface empty plaintext rather than throwing on decryption failure.
        }
      }
      result.push({
        fieldKey: s.fieldKey,
        resolution: { kind: "plaintext", value },
      });
    } else {
      result.push({
        fieldKey: s.fieldKey,
        resolution: {
          kind: "output-ref",
          sourcePluginId: s.sourcePluginId ?? "",
          sourceResourceTypeId: s.sourceResourceTypeId ?? "",
          sourceResourceId: s.sourceResourceId ?? "",
          sourceAccountId: s.sourceAccountId ?? "",
          outputKey: s.sourceOutputKey ?? "",
          ...(s.cachedEncryptedValue != null && {
            cachedEncryptedValue: s.cachedEncryptedValue,
          }),
          ...(s.cachedValueIv != null && { cachedIv: s.cachedValueIv }),
          ...(s.cachedAt != null && { cachedAt: s.cachedAt.toISOString() }),
        } satisfies SecretResolution,
      });
    }
  }
  return result;
}
