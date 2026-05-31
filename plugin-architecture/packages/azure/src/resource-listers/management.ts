import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, extractResourceGroup, type ListerContext } from "./shared.js";

export async function listResourceGroups(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourcegroups?api-version=2022-09-01`,
  );
  return (data.value ?? []).map((rg) => {
    const name = String(rg["name"] ?? "");
    const props = rg["properties"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "azure-resource-group", name),
      pluginId: "azure",
      resourceTypeId: "azure-resource-group",
      accountId,
      displayName: name,
      fields: {
        name,
        location: String(rg["location"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
      },
      resolvedOutputs: {
        resourceId: String(rg["id"] ?? ""),
      },
      secretStates: [],
      externalId: name,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listLogAnalyticsWorkspaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{
    value: Array<{
      id: string;
      name: string;
      location: string;
      properties?: {
        sku?: { name?: string };
        provisioningState?: string;
        retentionInDays?: number;
        workspaceCapping?: { dailyQuotaGb?: number };
        customerId?: string;
      };
    }>;
  }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.OperationalInsights/workspaces?api-version=2022-10-01`,
  );

  return (data.value ?? []).map((ws) => {
    const rg = extractResourceGroup(ws.id);
    const name = ws.name;
    const props = ws.properties;
    return {
      id: ctx.id(accountId, "azure-log-analytics", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-log-analytics",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: ws.location,
        sku: String(props?.sku?.name ?? ""),
        provisioningState: String(props?.provisioningState ?? ""),
        retentionInDays: props?.retentionInDays ?? 30,
        dailyQuotaGb: props?.workspaceCapping?.dailyQuotaGb ?? -1,
      },
      resolvedOutputs: {
        customerId: String(props?.customerId ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listManagedIdentities(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{
    value: Array<{
      id: string;
      name: string;
      location: string;
      properties?: {
        clientId?: string;
        principalId?: string;
        tenantId?: string;
      };
    }>;
  }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ManagedIdentity/userAssignedIdentities?api-version=2023-01-31`,
  );

  return (data.value ?? []).map((mi) => {
    const rg = extractResourceGroup(mi.id);
    const name = mi.name;
    const props = mi.properties;
    return {
      id: ctx.id(accountId, "azure-managed-identity", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-managed-identity",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: mi.location,
      },
      resolvedOutputs: {
        clientId: String(props?.clientId ?? ""),
        principalId: String(props?.principalId ?? ""),
        tenantId: String(props?.tenantId ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
