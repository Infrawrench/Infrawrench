import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import type { PolicyCreateParams } from "cloudflare/resources/zero-trust/access/applications/policies";

export function mapAccessPolicy(
  policy: Record<string, unknown>,
  accountId: string,
  appId: string,
): ResourceInstance {
  const id = String(policy["id"] ?? "");
  const name = String(policy["name"] ?? "");
  const decision = String(policy["decision"] ?? "");
  const formatRules = (rules: unknown): string => {
    if (!Array.isArray(rules)) return "";
    return (rules as Array<Record<string, unknown>>)
      .map((r) => {
        const entries = Object.entries(r).map(([k, v]) => {
          if (typeof v === "object" && v !== null) {
            const inner = v as Record<string, unknown>;
            return `${k}:${Object.values(inner).join(",")}`;
          }
          return `${k}:${String(v)}`;
        });
        return entries.join("+");
      })
      .join("; ");
  };
  return {
    id: `${accountId}:access-policy:${appId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "access-policy",
    accountId,
    displayName: name || `Policy ${id.slice(0, 8)}`,
    fields: {
      name,
      decision,
      precedence: Number(policy["precedence"] ?? 0),
      includeRules: formatRules(policy["include"]),
      excludeRules: formatRules(policy["exclude"]),
      requireRules: formatRules(policy["require"]),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${appId}/${id}`,
    parentResourceId: `${accountId}:access-application:${appId}`,
    createdAt: String(policy["created_at"] ?? new Date().toISOString()),
    updatedAt: String(policy["updated_at"] ?? new Date().toISOString()),
  };
}

export async function listAllAccessPolicies(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const results: ResourceInstance[] = [];
  for await (const app of api.cf.zeroTrust.access.applications.list({ account_id })) {
    const appId = String((app as unknown as { id: string }).id ?? "");
    try {
      for await (const policy of api.cf.zeroTrust.access.applications.policies.list(appId, {
        account_id,
      })) {
        results.push(
          mapAccessPolicy(policy as unknown as Record<string, unknown>, accountId, appId),
        );
      }
    } catch {
      // Skip apps where we can't read policies
    }
  }
  return results;
}

export async function createAccessPolicy(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const appId = fields["appId"] || parentExternalId;
  if (!appId) throw new Error("Cloudflare plugin: appId is required to create an access policy");
  const includeEmail = fields["includeEmail"] ?? "";
  const includeRule: Record<string, unknown> = includeEmail.startsWith("@")
    ? { email_domain: { domain: includeEmail.slice(1) } }
    : { email: { email: includeEmail } };
  const body: Record<string, unknown> = {
    account_id,
    name: fields["name"] ?? "",
    decision: fields["decision"] ?? "allow",
    include: [includeRule],
  };
  const policy = await api.cf.zeroTrust.access.applications.policies.create(
    appId,
    body as unknown as PolicyCreateParams,
  );
  return mapAccessPolicy(policy as unknown as Record<string, unknown>, accountId, appId);
}
