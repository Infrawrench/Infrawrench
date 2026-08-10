import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone, resolveZoneName } from "./shared.js";
import type {
  LoadBalancerCreateParams,
  LoadBalancerEditParams,
  SteeringPolicyParam,
} from "cloudflare/resources/load-balancers/load-balancers";

/**
 * Steering policies the API accepts (`SteeringPolicyParam`), minus the empty
 * string. `""` is a legal API value meaning "infer from the configured pools",
 * but the edit form uses a blank box to mean "leave unchanged", so a blank —
 * or an unrecognised — policy is dropped from the PATCH rather than sent.
 */
const STEERING_POLICIES = [
  "off",
  "geo",
  "random",
  "dynamic_latency",
  "proximity",
  "least_outstanding_requests",
  "least_connections",
] as const satisfies readonly SteeringPolicyParam[];
type SteeringPolicy = (typeof STEERING_POLICIES)[number];

function isSteeringPolicy(value: string): value is SteeringPolicy {
  return (STEERING_POLICIES as readonly string[]).includes(value);
}

function mapLoadBalancer(
  lb: Record<string, unknown>,
  accountId: string,
  zoneId: string,
  zoneName: string,
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
      zoneName,
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
  return collectPerZone(
    api,
    async (zoneId, zoneName) => {
      const part: ResourceInstance[] = [];
      for await (const lb of api.cf.loadBalancers.list({ zone_id: zoneId })) {
        part.push(mapLoadBalancer(asRecord(lb), accountId, zoneId, zoneName));
      }
      return part;
    },
    "load balancers",
    "Zone · Load Balancers:Read",
  );
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
  const params: LoadBalancerCreateParams = {
    zone_id: zoneId,
    name: fields["name"] ?? "",
    fallback_pool: fields["fallbackPool"] ?? "",
    default_pools: defaultPoolIds,
  };
  const lb = await api.cf.loadBalancers.create(params);
  return mapLoadBalancer(asRecord(lb), accountId, zoneId, await resolveZoneName(api, zoneId));
}

export async function editLoadBalancer(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, lbId] = externalId.split("/");
  if (!zoneId || !lbId) throw new Error("Invalid load balancer ID");
  const defaultPools = fields["defaultPools"];
  const ttl = fields["ttl"];
  const steeringPolicy = fields["steeringPolicy"] ?? "";
  const params: LoadBalancerEditParams = {
    zone_id: zoneId,
    ...(fields["name"] !== undefined ? { name: fields["name"] } : {}),
    ...(fields["fallbackPool"] !== undefined ? { fallback_pool: fields["fallbackPool"] } : {}),
    ...(defaultPools !== undefined
      ? {
          default_pools: defaultPools
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }
      : {}),
    ...(fields["enabled"] !== undefined ? { enabled: fields["enabled"] === "true" } : {}),
    ...(fields["proxied"] !== undefined ? { proxied: fields["proxied"] === "true" } : {}),
    ...(ttl !== undefined && ttl !== "" ? { ttl: Number(ttl) } : {}),
    ...(isSteeringPolicy(steeringPolicy) ? { steering_policy: steeringPolicy } : {}),
  };
  const lb = await api.cf.loadBalancers.edit(lbId, params);
  return mapLoadBalancer(asRecord(lb), accountId, zoneId, await resolveZoneName(api, zoneId));
}

export async function deleteLoadBalancer(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, lbId] = externalId.split("/");
  if (!zoneId || !lbId) throw new Error("Invalid load balancer ID");
  await api.cf.loadBalancers.delete(lbId, { zone_id: zoneId });
}
