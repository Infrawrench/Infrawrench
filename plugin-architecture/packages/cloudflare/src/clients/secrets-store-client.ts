import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";

/**
 * Cloudflare Secrets Store (`/accounts/{id}/secrets_store/stores/{store}/secrets`):
 * account-level secrets shared across Workers, AI Gateway and other services.
 * A secret's value is write-only: the API never returns it, so the edit form's
 * Value field stays blank and only rotates the value when the user types one.
 *
 * The resource id carries `${storeId}/${secretId}` so every call can address
 * the secret without a second lookup.
 */

/** Services a secret can be scoped to, per the Secrets Store API reference. */
export const SECRET_SCOPES: ReadonlyArray<{ id: string; label: string; field: string }> = [
  { id: "workers", label: "Workers", field: "scopeWorkers" },
  { id: "ai_gateway", label: "AI Gateway", field: "scopeAiGateway" },
  { id: "access", label: "Access", field: "scopeAccess" },
  { id: "containers", label: "Containers", field: "scopeContainers" },
  { id: "dex", label: "Digital Experience Monitoring", field: "scopeDex" },
  { id: "websearch", label: "Web Search", field: "scopeWebsearch" },
];

/** The name the Cloudflare dashboard gives the store it creates on first use. */
export const DEFAULT_STORE_NAME = "default_secrets_store";

/** Sentinel option id in the create form's store picker: "create the store first". */
export const NEW_STORE_OPTION = "__new__";

export interface SecretsStore {
  id: string;
  name: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function mapSecret(
  s: Record<string, unknown>,
  store: SecretsStore,
  accountId: string,
): ResourceInstance {
  const id = str(s["id"]);
  const name = str(s["name"]);
  const scopes = Array.isArray(s["scopes"]) ? (s["scopes"] as unknown[]).map(String) : [];
  const fields: Record<string, string | boolean> = {
    name,
    storeName: store.name,
    storeId: store.id,
    status: str(s["status"]),
    scopes: scopes.join(", "),
    comment: str(s["comment"]),
    value: "",
    created: str(s["created"]),
    modified: str(s["modified"]),
  };
  for (const scope of SECRET_SCOPES) fields[scope.field] = scopes.includes(scope.id);
  return {
    id: `${accountId}:secrets-store-secret:${store.id}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "secrets-store-secret",
    accountId,
    displayName: name || id,
    fields,
    resolvedOutputs: { secretName: name, storeId: store.id },
    secretStates: [],
    externalId: `${store.id}/${id}`,
    createdAt: str(s["created"]) || new Date().toISOString(),
    updatedAt: str(s["modified"]) || new Date().toISOString(),
  };
}

function splitExternalId(externalId: string): { storeId: string; secretId: string } {
  const slash = externalId.indexOf("/");
  if (slash < 0) throw new Error(`Cloudflare plugin: malformed secret id "${externalId}"`);
  return { storeId: externalId.slice(0, slash), secretId: externalId.slice(slash + 1) };
}

export async function listSecretsStores(api: CloudflareApi): Promise<SecretsStore[]> {
  const account_id = await api.getAccountId();
  const stores: SecretsStore[] = [];
  for await (const raw of api.cf.secretsStore.stores.list({ account_id })) {
    const s = asRecord(raw);
    stores.push({ id: str(s["id"]), name: str(s["name"]) });
  }
  return stores;
}

export async function listStoreSecrets(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for (const store of await listSecretsStores(api)) {
        for await (const raw of api.cf.secretsStore.stores.secrets.list(store.id, {
          account_id,
        })) {
          results.push(mapSecret(asRecord(raw), store, accountId));
        }
      }
      return results;
    },
    "Secrets Store secrets",
    "Account · Secrets Store:Read",
  );
}

/** Store picker options for the create form; offers to create one when none exist. */
export async function getStoreOptions(
  api: CloudflareApi,
): Promise<Array<{ id: string; label: string }>> {
  const stores = await listSecretsStores(api);
  if (stores.length === 0) {
    return [{ id: NEW_STORE_OPTION, label: `Create a store (${DEFAULT_STORE_NAME})` }];
  }
  return stores.map((s) => ({ id: s.id, label: s.name || s.id }));
}

/**
 * Parse the create form's scope picker (a JSON array of ids) or a
 * comma-separated list, keeping only the scopes Cloudflare documents.
 */
export function parseScopes(raw: string | undefined): string[] {
  const value = (raw ?? "").trim();
  if (!value) return [];
  let items: unknown[];
  try {
    const parsed: unknown = JSON.parse(value);
    items = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    items = value.split(",");
  }
  const known = new Set(SECRET_SCOPES.map((s) => s.id));
  return [...new Set(items.map((i) => String(i).trim()).filter((i) => known.has(i)))];
}

/** Scopes from the edit form's per-service toggles. */
function scopesFromToggles(fields: Record<string, string>): string[] {
  return SECRET_SCOPES.filter((s) => fields[s.field] === "true").map((s) => s.id);
}

async function resolveStore(api: CloudflareApi, storeId: string): Promise<SecretsStore> {
  const account_id = await api.getAccountId();
  if (storeId && storeId !== NEW_STORE_OPTION) {
    const stores = await listSecretsStores(api);
    return stores.find((s) => s.id === storeId) ?? { id: storeId, name: "" };
  }
  const created = asRecord(
    await api.cf.secretsStore.stores.create({ account_id, name: DEFAULT_STORE_NAME }),
  );
  return { id: str(created["id"]), name: str(created["name"]) || DEFAULT_STORE_NAME };
}

export async function createStoreSecret(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = (fields["name"] ?? "").trim();
  const value = fields["value"] ?? "";
  if (!name) throw new Error("A secret name is required.");
  if (!value) throw new Error("A secret value is required.");
  const scopes = parseScopes(fields["scopes"]);
  if (scopes.length === 0) throw new Error("Pick at least one service that can use the secret.");
  const account_id = await api.getAccountId();
  const store = await resolveStore(api, fields["storeId"] ?? "");
  const comment = (fields["comment"] ?? "").trim();
  let created: Record<string, unknown> | undefined;
  // The create endpoint takes (and returns) a batch; we always send one.
  for await (const raw of api.cf.secretsStore.stores.secrets.create(store.id, {
    account_id,
    body: [{ name, value, scopes, ...(comment ? { comment } : {}) }],
  })) {
    created = asRecord(raw);
    break;
  }
  if (!created) throw new Error("Cloudflare did not return the created secret.");
  return mapSecret(created, store, accountId);
}

/**
 * Update a secret's comment, scopes and (only when a new one was typed) value.
 * `fields` is the merged current+changed set; `changedKeys` says which ones the
 * user actually touched so an untouched blank Value never clears anything.
 */
export async function editStoreSecret(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
  changedKeys: string[],
): Promise<ResourceInstance> {
  const { storeId, secretId } = splitExternalId(externalId);
  const account_id = await api.getAccountId();
  const scopes = scopesFromToggles(fields);
  if (scopes.length === 0) throw new Error("A secret must stay scoped to at least one service.");
  const value = fields["value"] ?? "";
  const updated = asRecord(
    await api.cf.secretsStore.stores.secrets.edit(storeId, secretId, {
      account_id,
      scopes,
      comment: fields["comment"] ?? "",
      ...(changedKeys.includes("value") && value ? { value } : {}),
    }),
  );
  const store = { id: storeId, name: fields["storeName"] ?? "" };
  return mapSecret(updated, store, accountId);
}

export async function deleteStoreSecret(api: CloudflareApi, externalId: string): Promise<void> {
  const { storeId, secretId } = splitExternalId(externalId);
  const account_id = await api.getAccountId();
  await api.cf.secretsStore.stores.secrets.delete(storeId, secretId, { account_id });
}

/** Account-wide secret quota (`GET /secrets_store/quota`), for the detail page. */
export async function getSecretsQuota(
  api: CloudflareApi,
): Promise<{ quota: number; usage: number } | null> {
  const account_id = await api.getAccountId();
  const raw = asRecord(await api.cf.secretsStore.quota.get({ account_id }));
  const secrets = (raw["secrets"] as Record<string, unknown> | undefined) ?? raw;
  const quota = Number(secrets["quota"]);
  const usage = Number(secrets["usage"]);
  if (!Number.isFinite(quota) || !Number.isFinite(usage)) return null;
  return { quota, usage };
}
