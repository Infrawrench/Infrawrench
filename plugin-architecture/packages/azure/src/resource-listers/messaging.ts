import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, extractResourceGroup, type ListerContext } from "./shared.js";

export async function listServiceBusNamespaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ServiceBus/namespaces?api-version=2024-01-01`,
  );
  return (data.value ?? []).map((ns) => {
    const name = String(ns["name"] ?? "");
    const azureId = String(ns["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = ns["properties"] as Record<string, unknown> | undefined;
    const sku = ns["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-service-bus", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-service-bus",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(ns["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        status: String(props?.["status"] ?? ""),
        createdAt: String(props?.["createdAt"] ?? ""),
      },
      resolvedOutputs: {
        serviceBusEndpoint: String(props?.["serviceBusEndpoint"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listEventHubNamespaces(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.EventHub/namespaces?api-version=2024-01-01`,
  );
  return (data.value ?? []).map((ns) => {
    const name = String(ns["name"] ?? "");
    const azureId = String(ns["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = ns["properties"] as Record<string, unknown> | undefined;
    const sku = ns["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-event-hub", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-event-hub",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(ns["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        status: String(props?.["status"] ?? ""),
        isAutoInflateEnabled: (props?.["isAutoInflateEnabled"] as boolean) ?? false,
        maximumThroughputUnits: Number(props?.["maximumThroughputUnits"] ?? 0),
      },
      resolvedOutputs: {
        serviceBusEndpoint: String(props?.["serviceBusEndpoint"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
