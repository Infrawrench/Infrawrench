import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { ListerContext } from "../resource-listers.js";
import { ensureArray } from "../xml.js";

/**
 * Route 53 is a REST-**XML** API — every response here is XML, so these
 * listers must use `xmlGet`. They used `jsonGet` (`res.json()`), which threw a
 * SyntaxError on the `<?xml` prefix every poll, meaning hosted zones, record
 * sets and health checks never listed at all. Same bug CloudFront had.
 *
 * `parseXml` strips the single root element (`ListHostedZonesResponse` and
 * friends), so the shape that arrives here is the response *body*: a
 * `<HostedZones>` container wrapping repeated `<HostedZone>` entries, which
 * collapse to a bare object when there is only one — hence `ensureArray`.
 */
export async function listRoute53HostedZones(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.xmlGet<{
    HostedZones?: { HostedZone?: Record<string, unknown> | Array<Record<string, unknown>> };
  }>("route53", "/2013-04-01/hostedzone");
  const zones = ensureArray(data.HostedZones?.HostedZone);
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
      const data = await ctx.xmlGet<{
        ResourceRecordSets?: {
          ResourceRecordSet?: Record<string, unknown> | Array<Record<string, unknown>>;
        };
      }>("route53", `/2013-04-01/hostedzone/${zoneId}/rrset`);
      const records = ensureArray(data.ResourceRecordSets?.ResourceRecordSet);
      for (const record of records) {
        const name = String(record["Name"] ?? "");
        const type = String(record["Type"] ?? "");
        const recordId = `${zoneId}:${name}:${type}`;
        // `<ResourceRecords><ResourceRecord><Value>…` — one more container to
        // unwrap, and a single record parses as a bare object.
        const resourceRecords = ensureArray(
          (record["ResourceRecords"] as Record<string, unknown> | undefined)?.["ResourceRecord"] as
            | Record<string, unknown>
            | Array<Record<string, unknown>>
            | undefined,
        );
        const values = resourceRecords.map((r) => String(r["Value"] ?? "")).join(", ");

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
  const data = await ctx.xmlGet<{
    HealthChecks?: { HealthCheck?: Record<string, unknown> | Array<Record<string, unknown>> };
  }>("route53", "/2013-04-01/healthcheck");
  const checks = ensureArray(data.HealthChecks?.HealthCheck);
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
