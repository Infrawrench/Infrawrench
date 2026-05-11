import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapKVNamespace(ns: Record<string, unknown>, accountId: string): ResourceInstance {
  const id = String(ns["id"] ?? "");
  const title = String(ns["title"] ?? "");
  return {
    id: `${accountId}:kv-namespace:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "kv-namespace",
    accountId,
    displayName: title || id,
    fields: {
      title,
      supportsUrlEncoding: Boolean(ns["supports_url_encoding"]),
    },
    resolvedOutputs: { namespaceId: id },
    secretStates: [],
    externalId: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listKVNamespaces(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const cfAccountId = await api.getAccountId();
  const namespaces = await api.paginate<Record<string, unknown>>(
    `/accounts/${cfAccountId}/storage/kv/namespaces`,
  );
  return namespaces.map((ns) => mapKVNamespace(ns, accountId));
}

export async function createKVNamespace(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const ns = await api.fetch<Record<string, unknown>>(
    `/accounts/${cfAccountId}/storage/kv/namespaces`,
    {
      method: "POST",
      body: JSON.stringify({ title: fields["title"] }),
    },
  );
  return mapKVNamespace(ns, accountId);
}

export async function deleteKVNamespace(api: CloudflareApi, externalId: string): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(`/accounts/${cfAccountId}/storage/kv/namespaces/${externalId}`, {
    method: "DELETE",
  });
}
