import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { ListerContext } from "../resource-listers.js";

export async function listRoute53HostedZones(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    HostedZones?: Array<Record<string, unknown>>;
  }>("route53", "/2013-04-01/hostedzone");
  const zones = data.HostedZones ?? [];
  return zones.map((zone) => {
    const id = String(zone["Id"] ?? "").replace("/hostedzone/", "");
    const name = String(zone["Name"] ?? "");
    const config = zone["Config"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "route53-hosted-zone", id),
      pluginId: "aws",
      resourceTypeId: "route53-hosted-zone",
      accountId,
      displayName: name,
      fields: {
        name,
        hostedZoneId: id,
        recordCount: Number(zone["ResourceRecordSetCount"] ?? 0),
        isPrivate: config?.["PrivateZone"] === true || config?.["PrivateZone"] === "true",
        comment: String(config?.["Comment"] ?? ""),
      },
      resolvedOutputs: {
        hostedZoneId: id,
        nameServers: "",
      },
      secretStates: [],
      externalId: id,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listRoute53RecordSets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  // First list hosted zones, then records in each
  const zones = await listRoute53HostedZones(ctx, accountId);
  const results: ResourceInstance[] = [];

  for (const zone of zones) {
    const zoneId = zone.externalId ?? "";
    try {
      const data = await ctx.jsonGet<{
        ResourceRecordSets?: Array<Record<string, unknown>>;
      }>("route53", `/2013-04-01/hostedzone/${zoneId}/rrset`);
      const records = data.ResourceRecordSets ?? [];
      for (const record of records) {
        const name = String(record["Name"] ?? "");
        const type = String(record["Type"] ?? "");
        const recordId = `${zoneId}:${name}:${type}`;
        const resourceRecords = record["ResourceRecords"] as
          | Array<Record<string, string>>
          | undefined;
        const values = resourceRecords?.map((r) => String(r["Value"] ?? "")).join(", ") ?? "";

        results.push({
          id: ctx.id(accountId, "route53-record-set", recordId),
          pluginId: "aws",
          resourceTypeId: "route53-record-set",
          accountId,
          displayName: `${name} (${type})`,
          fields: {
            name,
            type,
            ttl: Number(record["TTL"] ?? 0),
            values,
            hostedZoneId: zoneId,
          },
          resolvedOutputs: {},
          secretStates: [],
          externalId: recordId,
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        });
      }
    } catch {
      // Skip zones we can't list records for
    }
  }
  return results;
}

export async function listRoute53HealthChecks(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.jsonGet<{
    HealthChecks?: Array<Record<string, unknown>>;
  }>("route53", "/2013-04-01/healthcheck");
  const checks = data.HealthChecks ?? [];
  return checks.map((hc) => {
    const id = String(hc["Id"] ?? "");
    const config = hc["HealthCheckConfig"] as Record<string, unknown> | undefined;
    const type = String(config?.["Type"] ?? "");
    return {
      id: ctx.id(accountId, "route53-health-check", id),
      pluginId: "aws",
      resourceTypeId: "route53-health-check",
      accountId,
      displayName: String(config?.["FullyQualifiedDomainName"] ?? config?.["IPAddress"] ?? id),
      fields: {
        healthCheckId: id,
        type,
        ipAddress: String(config?.["IPAddress"] ?? ""),
        port: config?.["Port"] !== undefined ? Number(config["Port"]) : 0,
        resourcePath: String(config?.["ResourcePath"] ?? ""),
        fqdn: String(config?.["FullyQualifiedDomainName"] ?? ""),
        requestInterval:
          config?.["RequestInterval"] !== undefined ? Number(config["RequestInterval"]) : 0,
        failureThreshold:
          config?.["FailureThreshold"] !== undefined ? Number(config["FailureThreshold"]) : 0,
        disabled: config?.["Disabled"] === true || config?.["Disabled"] === "true",
      },
      resolvedOutputs: {
        healthCheckId: id,
      },
      secretStates: [],
      externalId: id,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
