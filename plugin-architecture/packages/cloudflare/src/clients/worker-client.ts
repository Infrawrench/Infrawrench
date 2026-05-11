import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export async function listWorkers(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const cfAccountId = await api.getAccountId();
  const scripts = await api.fetch<Array<Record<string, unknown>>>(
    `/accounts/${cfAccountId}/workers/scripts`,
  );
  return (scripts ?? []).map((s) => ({
    id: `${accountId}:worker:${String(s["id"] ?? s["script_name"] ?? "")}`,
    pluginId: "cloudflare",
    resourceTypeId: "worker",
    accountId,
    displayName: String(s["id"] ?? s["script_name"] ?? ""),
    fields: {
      name: String(s["id"] ?? s["script_name"] ?? ""),
      createdOn: String(s["created_on"] ?? ""),
      modifiedOn: String(s["modified_on"] ?? ""),
      compatibilityDate: String(s["compatibility_date"] ?? ""),
      routes: "",
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: String(s["id"] ?? s["script_name"] ?? ""),
    createdAt: String(s["created_on"] ?? new Date().toISOString()),
    updatedAt: String(s["modified_on"] ?? new Date().toISOString()),
  }));
}

export async function createWorker(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const name = fields["name"] ?? "";
  const script =
    fields["script"] ?? 'export default { async fetch() { return new Response("Hello"); } };';
  const compatibilityDate =
    fields["compatibilityDate"] ?? new Date().toISOString().split("T")[0] ?? "";
  // Workers API requires multipart form data for module workers
  const formData = new FormData();
  formData.append(
    "metadata",
    JSON.stringify({
      main_module: "worker.js",
      compatibility_date: compatibilityDate,
    }),
  );
  formData.append(
    "worker.js",
    new Blob([script], { type: "application/javascript+module" }),
    "worker.js",
  );
  const res = await fetch(`${api.baseUrl}/accounts/${cfAccountId}/workers/scripts/${name}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${api.apiToken}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`Worker create failed: ${res.status}: ${await res.text()}`);
  const now = new Date().toISOString();
  return {
    id: `${accountId}:worker:${name}`,
    pluginId: "cloudflare",
    resourceTypeId: "worker",
    accountId,
    displayName: name,
    fields: {
      name,
      createdOn: now,
      modifiedOn: now,
      compatibilityDate,
      routes: "",
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: name,
    createdAt: now,
    updatedAt: now,
  };
}

export async function deleteWorker(api: CloudflareApi, externalId: string): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(`/accounts/${cfAccountId}/workers/scripts/${externalId}`, { method: "DELETE" });
}

export async function getWorkerManifest(api: CloudflareApi, externalId: string): Promise<string> {
  const cfAccountId = await api.getAccountId();
  const settings = await api.fetch<Record<string, unknown>>(
    `/accounts/${cfAccountId}/workers/scripts/${externalId}/settings`,
  );
  return JSON.stringify(settings, null, 2);
}
