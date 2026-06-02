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
  detailResourceCapabilities,
  clientSupportsImportYaml,
  mergeCapabilities,
  type WorkflowCreateFieldInfo,
  type WorkflowPluginInfo,
} from "@infrawrench/workflow-runtime";
import type { PluginClient } from "@infrawrench/plugin-base";

const TTL_MS = 10 * 60 * 1000;
/** Cap a single `getCreateConfig` so one slow provider can't stall the editor's typings. */
const CONFIG_TIMEOUT_MS = 8_000;

interface CacheEntry {
  at: number;
  /** null = getCreateConfig failed/unsupported; don't retype, don't keep retrying hard. */
  value: WorkflowCreateFieldInfo[] | null;
}

const cache = new Map<string, CacheEntry>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("getCreateConfig timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Distilled create fields for a single resource type, from cache or a fresh
 * `getCreateConfig`. Returns null when the plugin can't produce a config (e.g.
 * child types needing a parentResourceId, or a slow/erroring provider). Never
 * throws — failures resolve to null so callers (codegen) fall back to generic.
 */
export async function getCreateFieldsForType(
  pluginId: string,
  typeId: string,
  getClient: () => Promise<PluginClient>,
): Promise<WorkflowCreateFieldInfo[] | null> {
  const key = `${pluginId}:${typeId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at <= TTL_MS) return hit.value;

  let value: WorkflowCreateFieldInfo[] | null = null;
  try {
    const client = await getClient();
    if (client.getCreateConfig) {
      value = createFieldsFromConfig(
        await withTimeout(client.getCreateConfig(typeId), CONFIG_TIMEOUT_MS),
      );
    }
  } catch {
    value = null;
  }
  cache.set(key, { at: now, value });
  return value;
}

/**
 * Enrich a plugin entry in place for typings: merge the plugin client's
 * capability flags onto every resource type (so the dts only types supported
 * methods), record `supportsImportYaml`, and fill `createFields` on createable
 * types. One client is opened (memoized). Never throws.
 */
export async function enrichPlugin(
  entry: WorkflowPluginInfo,
  accountId: string,
  getClient: () => Promise<PluginClient>,
): Promise<void> {
  let clientPromise: Promise<PluginClient> | null = null;
  const getClientOnce = () => (clientPromise ??= getClient());

  // Per-type capability flags, read from each type's DetailViewSchema (one
  // client, renderDetail is synchronous and needs no API call).
  try {
    const client = await getClientOnce();
    for (const rt of entry.resourceTypes) {
      const caps = detailResourceCapabilities(client, entry.pluginId, rt.id, accountId);
      rt.capabilities = mergeCapabilities(rt.capabilities, caps);
    }
    entry.supportsImportYaml = clientSupportsImportYaml(client);
  } catch {
    // Best-effort: leave the static capabilities computed in the base mapping.
  }

  await Promise.all(
    entry.resourceTypes
      .filter((rt) => rt.supportsCreate)
      .map(async (rt) => {
        const value = await getCreateFieldsForType(entry.pluginId, rt.id, getClientOnce);
        if (value && value.length > 0) rt.createFields = value;
      }),
  );
}
