import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import type { Namespace } from "cloudflare/resources/kv/namespaces/namespaces";

function mapKVNamespace(ns: Namespace, accountId: string): ResourceInstance {
  const raw = ns as unknown as Record<string, unknown>;
  const id = String(raw["id"] ?? "");
  const title = String(raw["title"] ?? "");
  return {
    id: `${accountId}:kv-namespace:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "kv-namespace",
    accountId,
    displayName: title || id,
    fields: {
      title,
      supportsUrlEncoding: Boolean(raw["supports_url_encoding"]),
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
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const ns of api.cf.kv.namespaces.list({ account_id })) {
    results.push(mapKVNamespace(ns, accountId));
  }
  return results;
}

export async function createKVNamespace(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const ns = await api.cf.kv.namespaces.create({
    account_id,
    title: fields["title"] ?? "",
  });
  return mapKVNamespace(ns, accountId);
}

export async function deleteKVNamespace(api: CloudflareApi, externalId: string): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.kv.namespaces.delete(externalId, { account_id });
}
