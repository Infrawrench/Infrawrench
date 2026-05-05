import type { ResourceInstance } from "@infrawrench/plugin-base";
import { type ListerContext } from "./shared.js";

export async function listCloudDnsZones(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const zones = await ctx.paginate<Record<string, unknown>>(
    `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones`,
    "managedZones",
  );
  return zones.map((z) => {
    const name = String(z["name"]);
    const dnsName = String(z["dnsName"] ?? "");
    const nameservers = Array.isArray(z["nameServers"])
      ? (z["nameServers"] as string[]).join(", ")
      : "";
    const dnssecConfig = z["dnssecConfig"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "cloud-dns-zone", name),
      pluginId: "gcp",
      resourceTypeId: "cloud-dns-zone",
      accountId,
      displayName: dnsName.replace(/\.$/, "") || name,
      fields: {
        name,
        dnsName,
        description: String(z["description"] ?? ""),
        visibility: String(z["visibility"] ?? "public"),
        nameservers,
        dnssecState: String(dnssecConfig?.["state"] ?? "off"),
      },
      resolvedOutputs: { nameservers },
      secretStates: [],
      externalId: name,
      createdAt: String(z["creationTime"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listCloudDnsRecordSets(
  ctx: ListerContext,
  accountId: string,
  p: string,
): Promise<ResourceInstance[]> {
  const zones = await ctx.paginate<Record<string, unknown>>(
    `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones`,
    "managedZones",
  );
  const results: ResourceInstance[] = [];
  for (const zone of zones) {
    const zoneName = String(zone["name"]);
    const dnsName = String(zone["dnsName"] ?? "");
    const displayZone = dnsName.replace(/\.$/, "") || zoneName;
    try {
      const rrsets = await ctx.paginate<Record<string, unknown>>(
        `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${zoneName}/rrsets`,
        "rrsets",
      );
      for (const rr of rrsets) {
        const type = String(rr["type"] ?? "");
        const name = String(rr["name"] ?? "");
        const rrdatas = Array.isArray(rr["rrdatas"]) ? (rr["rrdatas"] as string[]).join(", ") : "";
        const ttl = Number(rr["ttl"] ?? 300);
        // Use type+name as a composite ID since Cloud DNS doesn't expose record IDs
        const recordKey = `${type}:${name}`;
        const shortName = name.replace(/\.$/, "");
        results.push({
          id: ctx.id(accountId, "cloud-dns-record-set", `${zoneName}/${recordKey}`),
          pluginId: "gcp",
          resourceTypeId: "cloud-dns-record-set",
          accountId,
          displayName: `${type} ${shortName}`,
          fields: {
            type,
            name: shortName,
            rrdatas,
            ttl,
            zoneName: displayZone,
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: `${zoneName}/${recordKey}`,
          parentResourceId: ctx.id(accountId, "cloud-dns-zone", zoneName),
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        });
      }
    } catch {
      // Skip zones we can't read records for
    }
  }
  return results;
}
