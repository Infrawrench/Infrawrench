import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, withAuthErrorHint } from "./shared.js";

/**
 * Cloudflare Durable Object namespaces (`/accounts/{id}/workers/durable_objects/namespaces`).
 * These are declared by deploying a Worker that exports a Durable Object class;
 * the API is read-only here (you create/remove them by redeploying the Worker),
 * so the resource type lists them with no create/update/delete.
 */
function mapNamespace(ns: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(ns["id"] ?? "");
  const name = String(ns["name"] ?? "");
  return {
    id: `${accountId}:durable-object-namespace:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "durable-object-namespace",
    accountId,
    displayName: name || id,
    fields: {
      name,
      class: String(ns["class"] ?? ""),
      script: String(ns["script"] ?? ""),
      useSqlite: Boolean(ns["use_sqlite"]),
    },
    resolvedOutputs: { namespaceId: id },
    secretStates: [],
    externalId: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listDurableObjectNamespaces(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const results: ResourceInstance[] = [];
      for await (const ns of api.cf.durableObjects.namespaces.list({ account_id })) {
        results.push(mapNamespace(asRecord(ns), accountId));
      }
      return results;
    },
    "Durable Object namespaces",
    "Account · Workers Scripts:Read",
  );
}

/** A single live Durable Object instance within a namespace. */
interface DurableObjectInstance {
  id: string;
  hasStoredData: boolean;
}

/** Result of {@link listDurableObjectInstances} — instances plus a truncation flag. */
interface DurableObjectInstanceList {
  instances: DurableObjectInstance[];
  /** True when there were more instances than {@link INSTANCE_FETCH_CAP}. */
  truncated: boolean;
}

/**
 * Hard cap on how many instances we page through for the detail-view browser.
 * A namespace can hold millions of objects; the dashboard paginates, but for an
 * at-a-glance browser we bound the fetch and surface a "truncated" note rather
 * than silently dropping the tail.
 */
const INSTANCE_FETCH_CAP = 500;

/**
 * List the live Durable Object instances inside a namespace via
 * `/accounts/{id}/workers/durable_objects/namespaces/{id}/objects`. This is the
 * only public surface Cloudflare exposes for instances — it returns each
 * object's id and whether it has stored data, but NOT its storage contents
 * (there is no public API to read/write a DO's storage from outside a Worker).
 */
export async function listDurableObjectInstances(
  api: CloudflareApi,
  namespaceId: string,
): Promise<DurableObjectInstanceList> {
  return withAuthErrorHint(
    async () => {
      const account_id = await api.getAccountId();
      const instances: DurableObjectInstance[] = [];
      let truncated = false;
      for await (const obj of api.cf.durableObjects.namespaces.objects.list(namespaceId, {
        account_id,
        limit: 1000,
      })) {
        if (instances.length >= INSTANCE_FETCH_CAP) {
          truncated = true;
          break;
        }
        const o = asRecord(obj);
        instances.push({
          id: String(o["id"] ?? ""),
          hasStoredData: Boolean(o["hasStoredData"]),
        });
      }
      return { instances, truncated };
    },
    "Durable Object instances",
    "Account · Workers Scripts:Read",
  );
}
