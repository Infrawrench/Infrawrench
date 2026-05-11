import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { toFile } from "cloudflare";

export async function listWorkers(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const out: ResourceInstance[] = [];
  for await (const s of api.cf.workers.scripts.list({ account_id })) {
    const raw = s as unknown as Record<string, unknown>;
    const name = String(raw["id"] ?? raw["script_name"] ?? "");
    out.push({
      id: `${accountId}:worker:${name}`,
      pluginId: "cloudflare",
      resourceTypeId: "worker",
      accountId,
      displayName: name,
      fields: {
        name,
        createdOn: String(raw["created_on"] ?? ""),
        modifiedOn: String(raw["modified_on"] ?? ""),
        compatibilityDate: String(raw["compatibility_date"] ?? ""),
        routes: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: String(raw["created_on"] ?? new Date().toISOString()),
      updatedAt: String(raw["modified_on"] ?? new Date().toISOString()),
    });
  }
  return out;
}

export async function createWorker(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const name = fields["name"] ?? "";
  const script =
    fields["script"] ?? 'export default { async fetch() { return new Response("Hello"); } };';
  const compatibilityDate =
    fields["compatibilityDate"] ?? new Date().toISOString().split("T")[0] ?? "";

  const file = await toFile(Buffer.from(script), "worker.js", {
    type: "application/javascript+module",
  });
  await api.cf.workers.scripts.update(name, {
    account_id,
    metadata: {
      main_module: "worker.js",
      compatibility_date: compatibilityDate,
    },
    files: [file],
  });

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
  const account_id = await api.getAccountId();
  await api.cf.workers.scripts.delete(externalId, { account_id });
}

export async function getWorkerManifest(api: CloudflareApi, externalId: string): Promise<string> {
  const account_id = await api.getAccountId();
  const settings = await api.cf.workers.scripts.settings.get(externalId, { account_id });
  return JSON.stringify(settings, null, 2);
}
