import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone } from "./shared.js";
import type { HealthcheckCreateParams } from "cloudflare/resources/healthchecks/healthchecks";

/**
 * Cloudflare standalone Health Checks (`/zones/{id}/healthchecks`) — active
 * origin monitors that probe an address on an interval and report
 * healthy/unhealthy, independent of load-balancer pools. Each check's
 * externalId is `<zoneId>/<checkId>` so writes can address it directly.
 */
function mapHealthcheck(
  hc: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(hc["id"] ?? "");
  const name = String(hc["name"] ?? "");
  return {
    id: `${accountId}:healthcheck:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "healthcheck",
    accountId,
    displayName: name || String(hc["address"] ?? id),
    fields: {
      name,
      address: String(hc["address"] ?? ""),
      type: String(hc["type"] ?? ""),
      status: String(hc["status"] ?? ""),
      description: String(hc["description"] ?? ""),
      suspended: Boolean(hc["suspended"]),
      interval: Number(hc["interval"] ?? 0),
      timeout: Number(hc["timeout"] ?? 0),
      retries: Number(hc["retries"] ?? 0),
      consecutiveFails: Number(hc["consecutive_fails"] ?? 0),
      consecutiveSuccesses: Number(hc["consecutive_successes"] ?? 0),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(hc["created_on"] ?? new Date().toISOString()),
    updatedAt: String(hc["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listAllHealthchecks(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      for await (const hc of api.cf.healthchecks.list({ zone_id: zoneId })) {
        part.push(mapHealthcheck(asRecord(hc), accountId, zoneId));
      }
      return part;
    },
    "health checks",
    "Zone · Health Checks:Read",
  );
}

export async function createHealthcheck(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a health check");
  const type = (fields["type"] || "HTTPS").toUpperCase();
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    name: fields["name"] ?? "",
    address: fields["address"] ?? "",
    type,
    ...(fields["description"] ? { description: fields["description"] } : {}),
  };
  if (type === "HTTP" || type === "HTTPS") {
    body["http_config"] = {
      method: "GET",
      path: fields["path"] || "/",
      ...(fields["expectedCodes"]
        ? { expected_codes: fields["expectedCodes"].split(",").map((s) => s.trim()) }
        : {}),
    };
  }
  const hc = await api.cf.healthchecks.create(body as unknown as HealthcheckCreateParams);
  return mapHealthcheck(asRecord(hc), accountId, zoneId);
}

export async function editHealthcheck(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, checkId] = externalId.split("/");
  if (!zoneId || !checkId) throw new Error("Invalid health check ID");
  // `edit` is a PATCH — send only the editable settings.
  const body: Record<string, unknown> = { zone_id: zoneId };
  if (fields["name"] !== undefined) body["name"] = fields["name"];
  if (fields["address"] !== undefined) body["address"] = fields["address"];
  if (fields["description"] !== undefined) body["description"] = fields["description"];
  if (fields["suspended"] !== undefined) body["suspended"] = fields["suspended"] === "true";
  if (fields["interval"] && Number.isFinite(Number(fields["interval"])))
    body["interval"] = Number(fields["interval"]);
  if (fields["timeout"] && Number.isFinite(Number(fields["timeout"])))
    body["timeout"] = Number(fields["timeout"]);
  if (fields["retries"] && Number.isFinite(Number(fields["retries"])))
    body["retries"] = Number(fields["retries"]);
  const hc = await api.cf.healthchecks.edit(
    checkId,
    body as unknown as Parameters<typeof api.cf.healthchecks.edit>[1],
  );
  return mapHealthcheck(asRecord(hc), accountId, zoneId);
}

export async function deleteHealthcheck(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, checkId] = externalId.split("/");
  if (!zoneId || !checkId) throw new Error("Invalid health check ID");
  await api.cf.healthchecks.delete(checkId, { zone_id: zoneId });
}
