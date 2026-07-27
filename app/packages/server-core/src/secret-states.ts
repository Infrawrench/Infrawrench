/**
 * The two ways a `secret_field_states` row is written.
 *
 * A row is either a *literal* (an encrypted value we hold) or an *output-ref*
 * (a pointer at another resource's output, optionally with a decryptable
 * cache). The two are mutually exclusive: writing one kind must clear the
 * other kind's columns, or a later read can resurrect a stale value that the
 * user believes they replaced.
 *
 * That invariant is the whole reason this module exists. The upsert used to be
 * written out at each call site (create flows, the associations routes, the
 * plugin `SecretHostServices`), and the copies had already drifted — the
 * output-ref path in the associations route left `encrypted_value` populated
 * while flipping `resolution_kind` to `output-ref`. Adding a column to the
 * table means updating the clear-list in exactly one place now.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db/client";
import { secretFieldStates } from "./db/schema";
import { encrypt, buildAad } from "./encryption";

/** Identifies the resource output a secret field points at. */
export interface SecretOutputRefSource {
  pluginId: string;
  resourceTypeId: string;
  resourceId: string;
  accountId: string;
  outputKey: string;
}

/**
 * Store `plaintext` as the literal value of `resourceId`.`fieldKey`,
 * discarding any output reference the field previously held.
 */
export async function setLiteralSecretState(
  resourceId: string,
  fieldKey: string,
  plaintext: string,
): Promise<void> {
  const { ciphertext, iv } = await encrypt(
    plaintext,
    buildAad("secretField", `${resourceId}:${fieldKey}`, "value"),
  );
  await db
    .insert(secretFieldStates)
    .values({
      id: randomUUID(),
      resourceId,
      fieldKey,
      resolutionKind: "literal",
      encryptedValue: ciphertext,
      valueIv: iv,
    })
    .onConflictDoUpdate({
      target: [secretFieldStates.resourceId, secretFieldStates.fieldKey],
      set: {
        resolutionKind: "literal",
        encryptedValue: ciphertext,
        valueIv: iv,
        sourcePluginId: null,
        sourceResourceTypeId: null,
        sourceResourceId: null,
        sourceAccountId: null,
        sourceOutputKey: null,
        cachedEncryptedValue: null,
        cachedValueIv: null,
        cachedAt: null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Point `resourceId`.`fieldKey` at another resource's output, discarding any
 * literal value the field previously held.
 *
 * `cachedPlaintext` is the value as resolved right now. Pass it when the caller
 * already has it (create flows do) so the reconciler has something to serve
 * before its first run; omit it when the reference is being set blind and the
 * cache must be filled in later.
 */
export async function setOutputRefSecretState(
  resourceId: string,
  fieldKey: string,
  source: SecretOutputRefSource,
  cachedPlaintext?: string,
): Promise<void> {
  const cache =
    cachedPlaintext === undefined
      ? null
      : await encrypt(
          cachedPlaintext,
          buildAad("secretField", `${resourceId}:${fieldKey}`, "cache"),
        );
  const now = new Date();
  await db
    .insert(secretFieldStates)
    .values({
      id: randomUUID(),
      resourceId,
      fieldKey,
      resolutionKind: "output-ref",
      sourcePluginId: source.pluginId,
      sourceResourceTypeId: source.resourceTypeId,
      sourceResourceId: source.resourceId,
      sourceAccountId: source.accountId,
      sourceOutputKey: source.outputKey,
      cachedEncryptedValue: cache?.ciphertext ?? null,
      cachedValueIv: cache?.iv ?? null,
      cachedAt: cache ? now : null,
    })
    .onConflictDoUpdate({
      target: [secretFieldStates.resourceId, secretFieldStates.fieldKey],
      set: {
        resolutionKind: "output-ref",
        encryptedValue: null,
        valueIv: null,
        sourcePluginId: source.pluginId,
        sourceResourceTypeId: source.resourceTypeId,
        sourceResourceId: source.resourceId,
        sourceAccountId: source.accountId,
        sourceOutputKey: source.outputKey,
        cachedEncryptedValue: cache?.ciphertext ?? null,
        cachedValueIv: cache?.iv ?? null,
        cachedAt: cache ? now : null,
        updatedAt: now,
      },
    });
}
