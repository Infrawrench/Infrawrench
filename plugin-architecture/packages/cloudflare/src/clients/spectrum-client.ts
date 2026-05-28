import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { collectPerZone } from "./shared.js";
import type { AppCreateParams } from "cloudflare/resources/spectrum/apps";

function mapSpectrumApplication(
  app: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(app["id"] ?? "");
  const protocol = String(app["protocol"] ?? "");
  const dns = app["dns"] as Record<string, unknown> | undefined;
  const dnsName = String(dns?.["name"] ?? "");
  const originDirect = Array.isArray(app["origin_direct"])
    ? (app["origin_direct"] as string[]).join(", ")
    : "";
  const originDns = app["origin_dns"] as Record<string, unknown> | undefined;
  return {
    id: `${accountId}:spectrum-application:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "spectrum-application",
    accountId,
    displayName: dnsName || `${protocol} ${id.slice(0, 8)}`,
    fields: {
      protocol,
      dns: dnsName,
      originDirect,
      originDns: String(originDns?.["name"] ?? ""),
      originPort: String(app["origin_port"] ?? ""),
      ipFirewall: Boolean(app["ip_firewall"]),
      proxyProtocol: String(app["proxy_protocol"] ?? "off"),
      tls: String(app["tls"] ?? ""),
      createdOn: String(app["created_on"] ?? ""),
      modifiedOn: String(app["modified_on"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(app["created_on"] ?? new Date().toISOString()),
    updatedAt: String(app["modified_on"] ?? new Date().toISOString()),
  };
}

export async function listAllSpectrumApplications(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      for await (const app of api.cf.spectrum.apps.list({ zone_id: zoneId })) {
        part.push(
          mapSpectrumApplication(app as unknown as Record<string, unknown>, accountId, zoneId),
        );
      }
      return part;
    },
    "Spectrum applications",
    "Zone · Spectrum:Read",
  );
}

export async function createSpectrumApplication(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId)
    throw new Error("Cloudflare plugin: zoneId is required to create a spectrum application");
  const protocol = fields["protocol"] ?? "tcp/22";
  const dns = fields["dns"] ?? "";
  const originDirect = fields["originDirect"] ?? "";
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    protocol,
    dns: { type: "CNAME", name: dns },
    origin_direct: [originDirect],
    ip_firewall: fields["ipFirewall"] === "true",
  };
  const app = await api.cf.spectrum.apps.create(body as unknown as AppCreateParams);
  return mapSpectrumApplication(app as unknown as Record<string, unknown>, accountId, zoneId);
}

export async function deleteSpectrumApplication(
  api: CloudflareApi,
  externalId: string,
): Promise<void> {
  const [zoneId, appId] = externalId.split("/");
  if (!zoneId || !appId) throw new Error("Invalid spectrum application ID");
  await api.cf.spectrum.apps.delete(appId, { zone_id: zoneId });
}
