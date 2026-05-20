import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import type { ApplicationCreateParams } from "cloudflare/resources/zero-trust/access/applications/applications";

function mapAccessApplication(app: Record<string, unknown>, accountId: string): ResourceInstance {
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
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const app of api.cf.zeroTrust.access.applications.list({ account_id })) {
    results.push(mapAccessApplication(app as unknown as Record<string, unknown>, accountId));
  }
  return results;
}

export async function createAccessApplication(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  // ApplicationCreateParams is a large discriminated union (per app type). Build
  // a generic payload and cast through unknown to satisfy the SDK signature.
  const body: Record<string, unknown> = {
    account_id,
    name: fields["name"] ?? "",
    domain: fields["domain"] ?? "",
    type: fields["type"] ?? "self_hosted",
  };
  const app = await api.cf.zeroTrust.access.applications.create(
    body as unknown as ApplicationCreateParams,
  );
  return mapAccessApplication(app as unknown as Record<string, unknown>, accountId);
}

export async function deleteAccessApplication(
  api: CloudflareApi,
  externalId: string,
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.zeroTrust.access.applications.delete(externalId, { account_id });
}
