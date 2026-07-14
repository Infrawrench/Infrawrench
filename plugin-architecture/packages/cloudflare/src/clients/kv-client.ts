import type { KvKeyEntry, KvListResult, ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord } from "./shared.js";
import type { Namespace } from "cloudflare/resources/kv/namespaces/namespaces";

function mapKVNamespace(ns: Namespace, accountId: string): ResourceInstance {
  const raw = asRecord(ns);
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

// --- KV key/value operations ---
//
// The SDK's `kv.namespaces.keys.list` auto-paginates with `for await`, which
// hides the cursor we need for the UI's "Load more" button. The KV REST API
// returns it as `result_info.cursor`, so we drop down to `api.fetch` for
// listing. Get/put/delete are simple enough that going through `api.fetch`
// keeps the read/write paths symmetrical and avoids juggling the SDK's
// streaming Response type.

interface KvKeysListResponse {
  result_info?: { cursor?: string };
  // Cloudflare returns each entry as { name, expiration?, metadata? }. The
  // SDK's Key type matches but result_info isn't exposed there, so we just
  // type the raw payload here.
}

export async function listKVKeys(
  api: CloudflareApi,
  namespaceId: string,
  params: { prefix?: string; cursor?: string; limit?: number },
): Promise<KvListResult> {
  const cfAccountId = await api.getAccountId();
  const qs = new URLSearchParams();
  if (params.prefix) qs.set("prefix", params.prefix);
  if (params.cursor) qs.set("cursor", params.cursor);
  if (params.limit) qs.set("limit", String(params.limit));
  // `api.fetch` returns the unwrapped `result`. We still need `result_info`
  // for the cursor, so issue a raw fetch and read both fields.
  const url = `${api.baseUrl}/accounts/${cfAccountId}/storage/kv/namespaces/${encodeURIComponent(
    namespaceId,
  )}/keys${qs.toString() ? `?${qs.toString()}` : ""}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${api.apiToken}` },
  });
  if (!res.ok) {
    throw new Error(`KV list keys error ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    success: boolean;
    result: Array<{ name: string; expiration?: number; metadata?: unknown }>;
    result_info?: KvKeysListResponse["result_info"];
    errors?: Array<{ message: string }>;
  };
  if (!json.success) {
    const msgs = json.errors?.map((e) => e.message).join(", ") ?? "unknown error";
    throw new Error(`KV list keys error: ${msgs}`);
  }
  const items: KvKeyEntry[] = (json.result ?? []).map((k) => ({
    name: k.name,
    ...(k.expiration != null ? { expiration: k.expiration } : {}),
    ...(k.metadata != null ? { metadata: k.metadata } : {}),
  }));
  const nextCursor = json.result_info?.cursor;
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

export async function getKVValue(
  api: CloudflareApi,
  namespaceId: string,
  key: string,
): Promise<string> {
  const cfAccountId = await api.getAccountId();
  // Use raw fetch — the SDK's values.get() returns a streaming Response that
  // we'd just immediately consume as text, so direct fetch is simpler.
  const res = await fetch(
    `${api.baseUrl}/accounts/${cfAccountId}/storage/kv/namespaces/${encodeURIComponent(
      namespaceId,
    )}/values/${encodeURIComponent(key)}`,
    { headers: { Authorization: `Bearer ${api.apiToken}` } },
  );
  if (!res.ok) {
    throw new Error(`KV get value error ${res.status}: ${await res.text()}`);
  }
  return res.text();
}

export async function putKVValue(
  api: CloudflareApi,
  namespaceId: string,
  key: string,
  value: string,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  const res = await fetch(
    `${api.baseUrl}/accounts/${cfAccountId}/storage/kv/namespaces/${encodeURIComponent(
      namespaceId,
    )}/values/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "text/plain",
      },
      body: value,
    },
  );
  if (!res.ok) {
    throw new Error(`KV put value error ${res.status}: ${await res.text()}`);
  }
}

export async function deleteKVKey(
  api: CloudflareApi,
  namespaceId: string,
  key: string,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(
    `/accounts/${cfAccountId}/storage/kv/namespaces/${encodeURIComponent(
      namespaceId,
    )}/values/${encodeURIComponent(key)}`,
    { method: "DELETE" },
  );
}
