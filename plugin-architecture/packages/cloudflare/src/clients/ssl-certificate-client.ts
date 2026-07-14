import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord, collectPerZone } from "./shared.js";

function mapSSLCertificate(
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
  return collectPerZone(
    api,
    async (zoneId, zoneName) => {
      const part: ResourceInstance[] = [];
      for await (const cert of api.cf.customCertificates.list({ zone_id: zoneId })) {
        part.push(mapSSLCertificate(asRecord(cert), accountId, zoneId, zoneName));
      }
      return part;
    },
    "SSL certificates",
    "Zone · SSL and Certificates:Read",
  );
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
  const cert = await api.cf.customCertificates.create({
    zone_id: zoneId,
    certificate: fields["certificate"] ?? "",
    private_key: fields["privateKey"] ?? "",
  });
  // Look up the zone name for display purposes.
  let zoneName = "";
  for (const z of await api.listZones()) {
    if (z.id === zoneId) {
      zoneName = z.name;
      break;
    }
  }
  return mapSSLCertificate(asRecord(cert), accountId, zoneId, zoneName);
}

export async function deleteSSLCertificate(api: CloudflareApi, externalId: string): Promise<void> {
  const [zoneId, certId] = externalId.split("/");
  if (!zoneId || !certId) throw new Error("Invalid SSL certificate ID");
  await api.cf.customCertificates.delete(certId, { zone_id: zoneId });
}
