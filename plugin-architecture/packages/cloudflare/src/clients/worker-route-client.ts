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
  const results: ResourceInstance[] = [];
  for await (const zone of api.cf.zones.list()) {
    const zoneId = zone.id;
    try {
      for await (const route of api.cf.workers.routes.list({ zone_id: zoneId })) {
        results.push(
          mapWorkerRoute(route as unknown as Record<string, unknown>, accountId, zoneId),
        );
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
  const route = await api.cf.workers.routes.create({
    zone_id: zoneId,
    pattern: fields["pattern"] ?? "",
    script: fields["scriptName"] ?? "",
  });
  return mapWorkerRoute(route as unknown as Record<string, unknown>, accountId, zoneId);
}

export async function deleteWorkerRoute(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, routeId] = externalId.split("/");
  if (!zoneId || !routeId) throw new Error("Invalid worker route ID");
  await api.cf.workers.routes.delete(routeId, { zone_id: zoneId });
}
