import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone } from "./shared.js";
import type { CustomHostnameCreateParams } from "cloudflare/resources/custom-hostnames/custom-hostnames";

function mapCustomHostname(
  h: Record<string, unknown>,
  accountId: string,
  zoneId: string,
): ResourceInstance {
  const id = String(h["id"] ?? "");
  const hostname = String(h["hostname"] ?? "");
  const ssl = h["ssl"] as Record<string, unknown> | undefined;
  return {
    id: `${accountId}:custom-hostname:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "custom-hostname",
    accountId,
    displayName: hostname || id,
    fields: {
      hostname,
      status: String(h["status"] ?? ""),
      sslStatus: String(ssl?.["status"] ?? ""),
      sslMethod: String(ssl?.["method"] ?? ""),
      sslType: String(ssl?.["type"] ?? ""),
      createdAt: String(h["created_at"] ?? ""),
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: String(h["created_at"] ?? new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

export async function listAllCustomHostnames(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  return collectPerZone(
    api,
    async (zoneId) => {
      const part: ResourceInstance[] = [];
      for await (const h of api.cf.customHostnames.list({ zone_id: zoneId })) {
        part.push(mapCustomHostname(asRecord(h), accountId, zoneId));
      }
      return part;
    },
    "custom hostnames",
    "Zone · SSL and Certificates:Read",
  );
}

export async function createCustomHostname(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId) throw new Error("Cloudflare plugin: zoneId is required to create a custom hostname");
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    hostname: fields["hostname"] ?? "",
    ssl: {
      method: fields["sslMethod"] ?? "http",
      type: "dv",
    },
  };
  const ch = await api.cf.customHostnames.create(body as unknown as CustomHostnameCreateParams);
  return mapCustomHostname(asRecord(ch), accountId, zoneId);
}

export async function editCustomHostname(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const [zoneId, hostnameId] = externalId.split("/");
  if (!zoneId || !hostnameId) throw new Error("Invalid custom hostname ID");
  // The hostname itself is immutable; the editable surface is the SSL
  // validation method (and we always re-assert a DV certificate).
  const body: Record<string, unknown> = {
    zone_id: zoneId,
    ssl: { method: fields["sslMethod"] || "http", type: "dv" },
  };
  const ch = await api.cf.customHostnames.edit(
    hostnameId,
    body as unknown as Parameters<typeof api.cf.customHostnames.edit>[1],
  );
  return mapCustomHostname(asRecord(ch), accountId, zoneId);
}

export async function deleteCustomHostname(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, hostnameId] = externalId.split("/");
  if (!zoneId || !hostnameId) throw new Error("Invalid custom hostname ID");
  await api.cf.customHostnames.delete(hostnameId, { zone_id: zoneId });
}
