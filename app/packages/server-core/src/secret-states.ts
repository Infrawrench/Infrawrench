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
 * plugin `SecretHostServices`), and the copies had already drifted: the
 * output-ref path in the associations route left `encrypted_value` populated
 * while flipping `resolution_kind` to `output-ref`. Adding a column to the
 * table means updating the clear-list in exactly one place now.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { accounts, resources, secretFieldStates } from "./db/schema";
import { encrypt, buildAad } from "./encryption";
import { runHoldingSecretWrites, type HeldSecretWrites } from "./runtime/request-scope";

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

/**
 * A soft-deleted row for a resource a plugin stores a secret against before any sync
 * has seen it, for the foreign key: rotating a credential on a resource with no row
 * has already killed the old one, on a route that never writes a row of its own. Soft
 * deleted, so it lists nowhere until a sync or a create fills it in and revives it.
 */
async function anchorSecretRow(accountId: string, resourceId: string): Promise<void> {
  const [existing] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.id, resourceId))
    .limit(1);
  if (existing) return;
  const [account] = await db
    .select({ organizationId: accounts.organizationId, pluginId: accounts.pluginId })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  if (!account) throw new Error(`Account ${accountId} not found`);
  // `resourceId` is `${accountId}:${typeId}:${externalId}`, checked by the caller.
  const rest = resourceId.slice(accountId.length + 1);
  const colon = rest.indexOf(":");
  const externalId = colon < 0 ? rest : rest.slice(colon + 1);
  await db
    .insert(resources)
    .values({
      id: resourceId,
      organizationId: account.organizationId,
      pluginId: account.pluginId,
      resourceTypeId: colon < 0 ? "" : rest.slice(0, colon),
      accountId,
      displayName: externalId,
      externalId,
      deletedAt: new Date(),
    })
    .onConflictDoNothing();
}

/**
 * What a plugin's `setPlaintext` does for a resource of `accountId`. A database error
 * names the statement and its parameters, ciphertext included, and routes hand a
 * plugin's error to the browser, so it is logged here and replaced.
 */
export async function storeAccountSecret(
  accountId: string,
  resourceId: string,
  fieldKey: string,
  plaintext: string,
): Promise<void> {
  try {
    await anchorSecretRow(accountId, resourceId);
    await setLiteralSecretState(resourceId, fieldKey, plaintext);
  } catch (err) {
    console.error(`[secret-states] Failed to store secret ${resourceId}:${fieldKey}:`, err);
    throw new Error(`Infrawrench could not store the secret "${fieldKey}".`, { cause: err });
  }
}

export interface SecretWriteHold {
  /** Run a create, holding what it passes to `setPlaintext`. A throw from it still flushes. */
  run<T>(create: () => Promise<T>): Promise<T>;
  /** Write what was held. Call it after the resource's upsert; a failure must reach someone. */
  flush(): Promise<void>;
}

/**
 * For a flow that creates a resource and then upserts its row. A plugin knows the new
 * resource's id only once the provider has answered, so it stores a one-time secret
 * from inside `createResource`, before that row exists. Holding the write keeps a
 * failed store from turning a create the provider already did into a failed one, with
 * the secret lost and nobody told what happened. The plugin reads back what it held.
 */
export function holdSecretWrites(): SecretWriteHold {
  const held: HeldSecretWrites = new Map();
  const flush = async () => {
    const failed: unknown[] = [];
    for (const [key, { write }] of held) {
      try {
        await write();
        held.delete(key);
      } catch (err) {
        failed.push(err);
      }
    }
    if (failed.length > 0) throw failed[0];
  };
  return {
    async run(create) {
      try {
        return await runHoldingSecretWrites(held, create);
      } catch (err) {
        // The provider may have made it before this threw, and a sync will bring it in.
        await flush().catch((flushErr: unknown) => {
          console.error("[secret-states] Failed to store a failed create's secrets:", flushErr);
        });
        throw err;
      }
    },
    flush,
  };
}
