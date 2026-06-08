import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, extractResourceGroup, type ListerContext } from "./shared.js";

export async function listDNSZones(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/dnsZones?api-version=2018-05-01`,
  );
  return (data.value ?? []).map((zone) => {
    const name = String(zone["name"] ?? "");
    const azureId = String(zone["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = zone["properties"] as Record<string, unknown> | undefined;
    const nameServers = props?.["nameServers"] as string[] | undefined;

    return {
      id: ctx.id(accountId, "azure-dns-zone", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-dns-zone",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        zoneType: String(props?.["zoneType"] ?? "Public"),
        numberOfRecordSets: Number(props?.["numberOfRecordSets"] ?? 0),
        maxNumberOfRecordSets: Number(props?.["maxNumberOfRecordSets"] ?? 0),
      },
      resolvedOutputs: {
        nameServers: (nameServers ?? []).join(", "),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listPrivateDNSZones(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/privateDnsZones?api-version=2020-06-01`,
  );
  return (data.value ?? []).map((zone) => {
    const name = String(zone["name"] ?? "");
    const azureId = String(zone["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = zone["properties"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "azure-private-dns-zone", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-private-dns-zone",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        numberOfRecordSets: Number(props?.["numberOfRecordSets"] ?? 0),
        maxNumberOfRecordSets: Number(props?.["maxNumberOfRecordSets"] ?? 0),
        virtualNetworkLinkCount: Number(props?.["numberOfVirtualNetworkLinks"] ?? 0),
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
