import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapAccessApplication(
  app: Record<string, unknown>,
  accountId: string,
): ResourceInstance {
  const id = String(app["id"] ?? "");
  const name = String(app["name"] ?? "");
  const domain = String(app["domain"] ?? "");
  return {
    id: `${accountId}:access-application:${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "access-application",
    accountId,
    displayName: name || domain || id,
    fields: {
      name,
      domain,
      type: String(app["type"] ?? ""),
      sessionDuration: String(app["session_duration"] ?? ""),
      createdAt: String(app["created_at"] ?? ""),
      updatedAt: String(app["updated_at"] ?? ""),
    },
    resolvedOutputs: {
      aud: String(app["aud"] ?? ""),
    },
    secretStates: [],
    externalId: id,
    createdAt: String(app["created_at"] ?? new Date().toISOString()),
    updatedAt: String(app["updated_at"] ?? new Date().toISOString()),
  };
}

export async function listAccessApplications(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const cfAccountId = await api.getAccountId();
  const apps = await api.paginate<Record<string, unknown>>(`/accounts/${cfAccountId}/access/apps`);
  return apps.map((app) => mapAccessApplication(app, accountId));
}

export async function createAccessApplication(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const cfAccountId = await api.getAccountId();
  const app = await api.fetch<Record<string, unknown>>(`/accounts/${cfAccountId}/access/apps`, {
    method: "POST",
    body: JSON.stringify({
      name: fields["name"] ?? "",
      domain: fields["domain"] ?? "",
      type: fields["type"] ?? "self_hosted",
    }),
  });
  return mapAccessApplication(app, accountId);
}

export async function deleteAccessApplication(
  api: CloudflareApi,
  externalId: string,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  await api.fetch(`/accounts/${cfAccountId}/access/apps/${externalId}`, {
    method: "DELETE",
  });
}
