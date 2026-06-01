/**
 * Eagerly distills each createable resource type's form schema (via the plugin's
 * `getCreateConfig`) into {@link WorkflowResourceTypeInfo.createFields}, so the
 * generated `infra.d.ts` can type `create({...})` with real keys and option
 * unions instead of `Record<string, string>`.
 *
 * `getCreateConfig` hits the provider's live API (regions/sizes/images), so
 * results are cached per `${pluginId}:${typeId}` with a short TTL to avoid
 * re-fetching every time the editor (re)opens. Best-effort: any failure leaves
 * `createFields` undefined and codegen falls back to the generic signature.
 *
 * Shared by the cloud web host and the poller (both build the accounts tree).
 */
import {
  createFieldsFromConfig,
  type WorkflowCreateFieldInfo,
  type WorkflowResourceTypeInfo,
} from "@infrawrench/workflow-runtime";
import type { PluginClient } from "@infrawrench/plugin-base";

const TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  at: number;
  /** null = getCreateConfig failed/unsupported; don't retype, don't keep retrying hard. */
  value: WorkflowCreateFieldInfo[] | null;
}

const cache = new Map<string, CacheEntry>();

/**
 * Fill `createFields` on every createable resource type, in place. `getClient`
 * lazily opens one plugin client for the account group (only called if at least
 * one createable type needs a fresh fetch).
 */
export async function enrichCreateFields(
  pluginId: string,
  resourceTypes: WorkflowResourceTypeInfo[],
  getClient: () => Promise<PluginClient>,
): Promise<void> {
  const createable = resourceTypes.filter((rt) => rt.supportsCreate);
  if (createable.length === 0) return;

  const now = Date.now();
  const stale = createable.filter((rt) => {
    const hit = cache.get(`${pluginId}:${rt.id}`);
    return !hit || now - hit.at > TTL_MS;
  });

  let client: PluginClient | null = null;
  if (stale.length > 0) {
    try {
      client = await getClient();
    } catch {
      client = null;
    }
  }

  for (const rt of createable) {
    const key = `${pluginId}:${rt.id}`;
    let entry = cache.get(key);
    if (!entry || now - entry.at > TTL_MS) {
      let value: WorkflowCreateFieldInfo[] | null = null;
      if (client?.getCreateConfig) {
        try {
          const config = await client.getCreateConfig(rt.id);
          value = createFieldsFromConfig(config);
        } catch {
          // Child types needing a parentResourceId, slow/erroring APIs, etc.
          value = null;
        }
      }
      entry = { at: now, value };
      cache.set(key, entry);
    }
    if (entry.value && entry.value.length > 0) rt.createFields = entry.value;
  }
}
