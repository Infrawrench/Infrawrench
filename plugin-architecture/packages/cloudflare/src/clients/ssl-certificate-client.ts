import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";

export function mapSSLCertificate(
  cert: Record<string, unknown>,
  accountId: string,
  zoneId: string,
  zoneName: string,
): ResourceInstance {
  const id = String(cert["id"] ?? "");
  const hosts = Array.isArray(cert["hosts"])
    ? (cert["hosts"] as string[]).join(", ")
    : String(cert["hosts"] ?? "");
  const status = String(cert["status"] ?? "");
  const certificates = cert["certificates"] as Array<Record<string, unknown>> | undefined;
  const firstCert = certificates?.[0];
  return {
    id: `${accountId}:ssl-certificate:${zoneId}/${id}`,
    pluginId: "cloudflare",
    resourceTypeId: "ssl-certificate",
    accountId,
    displayName: hosts || `Certificate ${id.slice(0, 8)}`,
    fields: {
      hosts,
      issuer: String(firstCert?.["issuer"] ?? cert["certificate_authority"] ?? ""),
      status,
      type: String(cert["type"] ?? ""),
      expiresOn: String(firstCert?.["expires_on"] ?? ""),
      zoneName,
    },
    resolvedOutputs: {},
    secretStates: [],
    externalId: `${zoneId}/${id}`,
    parentResourceId: `${accountId}:zone:${zoneId}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export async function listAllSSLCertificates(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneId = String(zone["id"]);
    const zoneName = String(zone["name"]);
    try {
      const certs = await api.paginate<Record<string, unknown>>(
        `/zones/${zoneId}/custom_certificates`,
      );
      for (const cert of certs) {
        results.push(mapSSLCertificate(cert, accountId, zoneId, zoneName));
      }
    } catch {
      // Skip zones where we can't read certificates
    }
  }
  return results;
}

export async function createSSLCertificate(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
  parentExternalId: string,
): Promise<ResourceInstance> {
  const zoneId = fields["zoneId"] || parentExternalId;
  if (!zoneId)
    throw new Error("Cloudflare plugin: zoneId is required to create an SSL certificate");
  const cert = await api.fetch<Record<string, unknown>>(`/zones/${zoneId}/custom_certificates`, {
    method: "POST",
    body: JSON.stringify({
      certificate: fields["certificate"] ?? "",
      private_key: fields["privateKey"] ?? "",
    }),
  });
  // Map using the zone name from the zone lookup
  const zones = await api.paginate<Record<string, unknown>>("/zones");
  const zone = zones.find((z) => String(z["id"]) === zoneId);
  const zoneName = zone ? String(zone["name"]) : "";
  return mapSSLCertificate(cert, accountId, zoneId, zoneName);
}

export async function deleteSSLCertificate(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, certId] = externalId.split("/");
  if (!zoneId || !certId) throw new Error("Invalid SSL certificate ID");
  await api.fetch(`/zones/${zoneId}/custom_certificates/${certId}`, { method: "DELETE" });
}
