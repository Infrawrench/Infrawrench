/**
 * Fingerprints of the secrets Infrawrench holds, for attributing a leak.
 *
 * A fingerprint is `keyedHash(value, "leaked-secret:<orgId>")`: HMAC-SHA256
 * under a sub-key of the master key, separated per org so the same token in
 * two orgs never yields comparable digests. It cannot be reversed or checked
 * offline without the master key. Values are decrypted in memory only for as
 * long as it takes to hash them; nothing decrypted leaves this module and
 * nothing is sent anywhere.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { accounts, resources, secretFieldStates } from "../db/schema";
import { buildAad, decrypt, keyedHash } from "../encryption";
import type { LoadedPlugin } from "../plugin-loader";
import { fingerprintableFields, type StoredSecretIndex, type StoredSecretRef } from "./match";

/** Values shorter than this are not credentials worth attributing (a region, a port). */
const MIN_SECRET_LENGTH = 8;

export function fingerprintSecret(organizationId: string, value: string): Promise<string> {
  return keyedHash(value.trim(), `leaked-secret:${organizationId}`);
}

function add(index: StoredSecretIndex, fp: string, ref: StoredSecretRef) {
  const list = index.get(fp);
  if (list) list.push(ref);
  else index.set(fp, [ref]);
}

async function decryptCredentials(row: {
  id: string;
  encryptedCredentials: string;
  credentialsIv: string;
}): Promise<Record<string, string> | null> {
  try {
    const plain = await decrypt(
      row.encryptedCredentials,
      row.credentialsIv,
      buildAad("account", row.id, "credentials"),
    );
    return JSON.parse(plain) as Record<string, string>;
  } catch {
    return null;
  }
}

async function decryptField(
  ciphertext: string | null,
  iv: string | null,
  resourceId: string,
  fieldKey: string,
  part: "value" | "cache",
): Promise<string | null> {
  if (!ciphertext || !iv) return null;
  try {
    return await decrypt(
      ciphertext,
      iv,
      buildAad("secretField", `${resourceId}:${fieldKey}`, part),
    );
  } catch {
    return null;
  }
}

/**
 * Every fingerprint of a secret the org stores: sensitive account credential
 * fields (plus any a token format names), literal resource secrets, and the
 * cached value of every output reference (attributed to the *source*
 * resource, which is the thing that can be reissued).
 */
export async function buildStoredSecretIndex(
  organizationId: string,
  plugins: readonly LoadedPlugin[],
): Promise<StoredSecretIndex> {
  const index: StoredSecretIndex = new Map();
  const byId = new Map(plugins.map((p) => [p.plugin.manifest.id, p.plugin.manifest]));

  const accountRows = await db
    .select({
      id: accounts.id,
      pluginId: accounts.pluginId,
      encryptedCredentials: accounts.encryptedCredentials,
      credentialsIv: accounts.credentialsIv,
    })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), isNull(accounts.deletedAt)));
  for (const row of accountRows) {
    const manifest = byId.get(row.pluginId);
    if (!manifest) continue;
    const creds = await decryptCredentials(row);
    if (!creds) continue;
    for (const fieldKey of fingerprintableFields(manifest)) {
      const value = creds[fieldKey]?.trim();
      if (!value || value.length < MIN_SECRET_LENGTH) continue;
      add(index, await fingerprintSecret(organizationId, value), {
        kind: "account",
        accountId: row.id,
        pluginId: row.pluginId,
        fieldKey,
      });
    }
  }

  const fieldRows = await db
    .select({
      resourceId: secretFieldStates.resourceId,
      fieldKey: secretFieldStates.fieldKey,
      kind: secretFieldStates.resolutionKind,
      encryptedValue: secretFieldStates.encryptedValue,
      valueIv: secretFieldStates.valueIv,
      cachedEncryptedValue: secretFieldStates.cachedEncryptedValue,
      cachedValueIv: secretFieldStates.cachedValueIv,
      sourcePluginId: secretFieldStates.sourcePluginId,
      sourceResourceTypeId: secretFieldStates.sourceResourceTypeId,
      sourceResourceId: secretFieldStates.sourceResourceId,
      sourceAccountId: secretFieldStates.sourceAccountId,
      sourceOutputKey: secretFieldStates.sourceOutputKey,
      accountId: resources.accountId,
      pluginId: resources.pluginId,
      resourceTypeId: resources.resourceTypeId,
    })
    .from(secretFieldStates)
    .innerJoin(resources, eq(secretFieldStates.resourceId, resources.id))
    .where(and(eq(resources.organizationId, organizationId), isNull(resources.deletedAt)));
  for (const row of fieldRows) {
    if (row.kind === "literal") {
      const value = await decryptField(
        row.encryptedValue,
        row.valueIv,
        row.resourceId,
        row.fieldKey,
        "value",
      );
      if (!value || value.trim().length < MIN_SECRET_LENGTH) continue;
      add(index, await fingerprintSecret(organizationId, value), {
        kind: "secret-field",
        accountId: row.accountId,
        pluginId: row.pluginId,
        resourceId: row.resourceId,
        resourceTypeId: row.resourceTypeId,
        fieldKey: row.fieldKey,
      });
    } else if (
      row.sourceResourceId &&
      row.sourceAccountId &&
      row.sourcePluginId &&
      row.sourceResourceTypeId &&
      row.sourceOutputKey
    ) {
      const value = await decryptField(
        row.cachedEncryptedValue,
        row.cachedValueIv,
        row.resourceId,
        row.fieldKey,
        "cache",
      );
      if (!value || value.trim().length < MIN_SECRET_LENGTH) continue;
      add(index, await fingerprintSecret(organizationId, value), {
        kind: "output",
        accountId: row.sourceAccountId,
        pluginId: row.sourcePluginId,
        resourceId: row.sourceResourceId,
        resourceTypeId: row.sourceResourceTypeId,
        fieldKey: row.sourceOutputKey,
      });
    }
  }
  return index;
}

/**
 * The fingerprint of whatever a leak matched, as stored right now, or null
 * when it no longer exists. A value different from the leak's own
 * fingerprint means the secret was replaced: that is how a rotation done
 * outside the leak screen (editing the account, the existing reroll dialog)
 * is detected and recorded.
 */
export async function currentTargetFingerprint(
  organizationId: string,
  target: {
    matchKind: string;
    matchedAccountId: string | null;
    matchedResourceId: string | null;
    matchedFieldKey: string | null;
  },
): Promise<string | null> {
  const { matchKind, matchedAccountId, matchedResourceId, matchedFieldKey } = target;
  if (!matchedFieldKey) return null;
  if (matchKind === "account" && matchedAccountId) {
    const [row] = await db
      .select({
        id: accounts.id,
        encryptedCredentials: accounts.encryptedCredentials,
        credentialsIv: accounts.credentialsIv,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, matchedAccountId),
          eq(accounts.organizationId, organizationId),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    const value = (await decryptCredentials(row))?.[matchedFieldKey]?.trim();
    return value ? fingerprintSecret(organizationId, value) : null;
  }
  if (matchKind === "secret-field" && matchedResourceId) {
    const [row] = await db
      .select({
        encryptedValue: secretFieldStates.encryptedValue,
        valueIv: secretFieldStates.valueIv,
      })
      .from(secretFieldStates)
      .innerJoin(resources, eq(secretFieldStates.resourceId, resources.id))
      .where(
        and(
          eq(secretFieldStates.resourceId, matchedResourceId),
          eq(secretFieldStates.fieldKey, matchedFieldKey),
          eq(secretFieldStates.resolutionKind, "literal"),
          eq(resources.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!row) return null;
    const value = await decryptField(
      row.encryptedValue,
      row.valueIv,
      matchedResourceId,
      matchedFieldKey,
      "value",
    );
    return value ? fingerprintSecret(organizationId, value) : null;
  }
  if (matchKind === "output" && matchedResourceId) {
    // Any consumer's cache will do: they all cache the same source output.
    const rows = await db
      .select({
        resourceId: secretFieldStates.resourceId,
        fieldKey: secretFieldStates.fieldKey,
        cachedEncryptedValue: secretFieldStates.cachedEncryptedValue,
        cachedValueIv: secretFieldStates.cachedValueIv,
      })
      .from(secretFieldStates)
      .innerJoin(resources, eq(secretFieldStates.resourceId, resources.id))
      .where(
        and(
          eq(secretFieldStates.sourceResourceId, matchedResourceId),
          eq(secretFieldStates.sourceOutputKey, matchedFieldKey),
          eq(secretFieldStates.resolutionKind, "output-ref"),
          eq(resources.organizationId, organizationId),
          isNull(resources.deletedAt),
        ),
      )
      .limit(5);
    for (const row of rows) {
      const value = await decryptField(
        row.cachedEncryptedValue,
        row.cachedValueIv,
        row.resourceId,
        row.fieldKey,
        "cache",
      );
      if (value) return fingerprintSecret(organizationId, value);
    }
    return null;
  }
  return null;
}

/** Consumer accounts holding a reference to one source output, to reconcile after a reissue. */
export async function consumerAccountsOf(
  organizationId: string,
  sourceResourceId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ accountId: resources.accountId })
    .from(secretFieldStates)
    .innerJoin(resources, eq(secretFieldStates.resourceId, resources.id))
    .where(
      and(
        eq(secretFieldStates.sourceResourceId, sourceResourceId),
        eq(resources.organizationId, organizationId),
        isNull(resources.deletedAt),
      ),
    );
  return rows.map((r) => r.accountId);
}

/** The org's live accounts grouped by plugin, for token-type candidates. */
export async function accountsByPlugin(
  organizationId: string,
  pluginIds?: readonly string[],
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ id: accounts.id, pluginId: accounts.pluginId })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        isNull(accounts.deletedAt),
        ...(pluginIds && pluginIds.length > 0 ? [inArray(accounts.pluginId, [...pluginIds])] : []),
      ),
    );
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.pluginId);
    if (list) list.push(r.id);
    else out.set(r.pluginId, [r.id]);
  }
  return out;
}
