import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapWorkerRoute(
  route: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(route["id"] ?? "");
  const pattern = String(route["pattern"] ?? "");
  const script = String(route["script"] ?? route["script_name"] ?? "");
  return {
    id: `${accountId}:worker-route:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "worker-route",
    accountId,
    displayName: pattern || `Route ${id.slice(0, 8)}`,
    fields: {
      pattern,
      script,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listAllWorkerRoutes(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    try {
      const routes = await api.fetch<Array<Record<string, unknown>>>(
        `/zones/${zoneId}/workers/routes`,
      );
      for (const route of routes ?? []) {
        results.push(mapWorkerRoute(route, accountId, zoneId));
      }
    } catch {
      // Skip zones where we can't read worker routes
    }
  }
  return results;
}

export async function createWorkerRoute(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a worker route");
  const route = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({
      pattern: fields["pattern"] ?? "",
      script: fields["scriptName"] ?? "",
    }),
  });
  return mapWorkerRoute(route, accountId, zoneId);
}

export async function deleteWorkerRoute(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, routeId] = externalId.split("/");
  if (!zoneId || !routeId) throw new Error("Invalid worker route ID");
  await api.fetch(`/zones/${zoneId}/workers/routes/${routeId}`, { method: "DELETE" });
}
