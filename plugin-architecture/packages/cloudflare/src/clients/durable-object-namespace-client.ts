import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { withAuthErrorHint } from "./shared.js";

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
        results.push(mapNamespace(ns as unknown as Record<string, unknown>, accountId));
      }
      return results;
    },
    "Durable Object namespaces",
    "Account · Workers Scripts:Read",
  );
}
