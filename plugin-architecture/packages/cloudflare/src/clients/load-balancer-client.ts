import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapLoadBalancer(
  lb: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(lb["id"] ?? "");
  const name = String(lb["name"] ?? "");
  const defaultPools = Array.isArray(lb["default_pools"])
    ? (lb["default_pools"] as string[]).join(", ")
    : "";
  return {
    id: `${accountId}:load-balancer:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "load-balancer",
    accountId,
    displayName: name || id,
    fields: {
      name,
      fallbackPool: String(lb["fallback_pool"] ?? ""),
      defaultPools,
      enabled: Boolean(lb["enabled"] ?? true),
      proxied: Boolean(lb["proxied"]),
      ttl: Number(lb["ttl"] ?? 0),
      steeringPolicy: String(lb["steering_policy"] ?? ""),
      createdOn: String(lb["created_on"] ?? ""),
      modifiedOn: String(lb["modified_on"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(lb["created_on"] ?? new Date().toISOString()),
    updatedAt: String(lb["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listAllLoadBalancers(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    try {
      const lbs = await api.paginate<Record<string, unknown>>(`/zones/${zoneId}/load_balancers`);
      for (const lb of lbs) {
        results.push(mapLoadBalancer(lb, accountId, zoneId));
      }
    } catch {
      // Skip zones where we can't read load balancers
    }
  }
  return results;
}

export async function createLoadBalancer(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a load balancer");
  const defaultPoolIds = (fields["defaultPools"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lb = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/load_balancers`, {
    method: "POST",
    body: JSON.stringify({
      name: fields["name"] ?? "",
      fallback_pool: fields["fallbackPool"] ?? "",
      default_pools: defaultPoolIds,
    }),
  });
  return mapLoadBalancer(lb, accountId, zoneId);
}

export async function deleteLoadBalancer(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, lbId] = externalId.split("/");
  if (!zoneId || !lbId) throw new Error("Invalid load balancer ID");
  await api.fetch(`/zones/${zoneId}/load_balancers/${lbId}`, { method: "DELETE" });
}
