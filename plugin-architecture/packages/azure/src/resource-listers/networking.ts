import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, extractName, extractResourceGroup, type ListerContext } from "./shared.js";

export async function listVNets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((vnet) => {
    const name = String(vnet["name"] ?? "");
    const azureId = String(vnet["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = vnet["properties"] as Record<string, unknown> | undefined;
    const addrSpace = props?.["addressSpace"] as Record<string, unknown> | undefined;
    const prefixes = addrSpace?.["addressPrefixes"] as string[] | undefined;
    const subnets = props?.["subnets"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "azure-vnet", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-vnet",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(vnet["location"] ?? ""),
        addressPrefixes: (prefixes ?? []).join(", "),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        subnetCount: subnets?.length ?? 0,
        enableDdosProtection: (props?.["enableDdosProtection"] as boolean) ?? false,
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listSubnets(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01`,
  );
  const resources: ResourceInstance[] = [];
  for (const vnet of data.value ?? []) {
    const vnetName = String(vnet["name"] ?? "");
    const vnetId = String(vnet["id"] ?? "");
    const rg = extractResourceGroup(vnetId);
    const location = String(vnet["location"] ?? "");
    const props = vnet["properties"] as Record<string, unknown> | undefined;
    const subnets = Array.isArray(props?.["subnets"])
      ? (props["subnets"] as Array<Record<string, unknown>>)
      : [];
    for (const subnet of subnets) {
      const name = String(subnet["name"] ?? "");
      const azureId = String(subnet["id"] ?? `${vnetId}/subnets/${name}`);
      const subnetProps = (subnet["properties"] ?? {}) as Record<string, unknown>;
      const nsg = subnetProps["networkSecurityGroup"] as Record<string, unknown> | undefined;
      const routeTable = subnetProps["routeTable"] as Record<string, unknown> | undefined;
      const natGateway = subnetProps["natGateway"] as Record<string, unknown> | undefined;
      resources.push({
        id: ctx.id(accountId, "azure-subnet", `${rg}/${vnetName}/${name}`),
        pluginId: "azure",
        resourceTypeId: "azure-subnet",
        accountId,
        displayName: `${vnetName}/${name}`,
        fields: {
          name,
          resourceGroup: rg,
          location,
          vnetName,
          addressPrefix: String(subnetProps["addressPrefix"] ?? ""),
          provisioningState: String(subnetProps["provisioningState"] ?? ""),
          networkSecurityGroup: extractName(String(nsg?.["id"] ?? "")),
          routeTable: extractName(String(routeTable?.["id"] ?? "")),
          natGateway: extractName(String(natGateway?.["id"] ?? "")),
        },
        resolvedOutputs: { resourceId: azureId },
        secretStates: [],
        externalId: `${rg}/${vnetName}/${name}`,
        createdAt: ctx.now(),
        updatedAt: ctx.now(),
      });
    }
  }
  return resources;
}

export async function listRouteTables(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/routeTables?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((routeTable) => {
    const name = String(routeTable["name"] ?? "");
    const azureId = String(routeTable["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = routeTable["properties"] as Record<string, unknown> | undefined;
    const routes = props?.["routes"] as unknown[] | undefined;
    const subnets = props?.["subnets"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "azure-route-table", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-route-table",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(routeTable["location"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        routeCount: routes?.length ?? 0,
        subnetCount: subnets?.length ?? 0,
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listNatGateways(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/natGateways?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((natGateway) => {
    const name = String(natGateway["name"] ?? "");
    const azureId = String(natGateway["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = natGateway["properties"] as Record<string, unknown> | undefined;
    const sku = natGateway["sku"] as Record<string, unknown> | undefined;
    const publicIps = props?.["publicIpAddresses"] as unknown[] | undefined;
    const subnets = props?.["subnets"] as unknown[] | undefined;
    return {
      id: ctx.id(accountId, "azure-nat-gateway", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-nat-gateway",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(natGateway["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        idleTimeout: Number(props?.["idleTimeoutInMinutes"] ?? 0),
        publicIpCount: publicIps?.length ?? 0,
        subnetCount: subnets?.length ?? 0,
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listLoadBalancers(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/loadBalancers?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((lb) => {
    const name = String(lb["name"] ?? "");
    const azureId = String(lb["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = lb["properties"] as Record<string, unknown> | undefined;
    const sku = lb["sku"] as Record<string, unknown> | undefined;
    const frontendIps = props?.["frontendIPConfigurations"] as unknown[] | undefined;
    const backendPools = props?.["backendAddressPools"] as unknown[] | undefined;
    const rules = props?.["loadBalancingRules"] as unknown[] | undefined;

    // Try to get the first frontend IP
    const firstFrontend = (frontendIps as Array<Record<string, unknown>> | undefined)?.[0];
    const frontendProps = firstFrontend?.["properties"] as Record<string, unknown> | undefined;
    const frontendIp = String(frontendProps?.["privateIPAddress"] ?? "");

    return {
      id: ctx.id(accountId, "azure-load-balancer", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-load-balancer",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(lb["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        frontendIpCount: frontendIps?.length ?? 0,
        backendPoolCount: backendPools?.length ?? 0,
        ruleCount: rules?.length ?? 0,
      },
      resolvedOutputs: {
        frontendIp,
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listNSGs(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/networkSecurityGroups?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((nsg) => {
    const name = String(nsg["name"] ?? "");
    const azureId = String(nsg["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = nsg["properties"] as Record<string, unknown> | undefined;
    const secRules = props?.["securityRules"] as unknown[] | undefined;
    const subnets = props?.["subnets"] as unknown[] | undefined;
    const nics = props?.["networkInterfaces"] as unknown[] | undefined;

    return {
      id: ctx.id(accountId, "azure-nsg", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-nsg",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(nsg["location"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        securityRuleCount: secRules?.length ?? 0,
        subnetCount: subnets?.length ?? 0,
        nicCount: nics?.length ?? 0,
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listPublicIPs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/publicIPAddresses?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((pip) => {
    const name = String(pip["name"] ?? "");
    const azureId = String(pip["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = pip["properties"] as Record<string, unknown> | undefined;
    const sku = pip["sku"] as Record<string, unknown> | undefined;
    const dnsSettings = props?.["dnsSettings"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-public-ip", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-public-ip",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(pip["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        allocationMethod: String(props?.["publicIPAllocationMethod"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        ipVersion: String(props?.["publicIPAddressVersion"] ?? ""),
      },
      resolvedOutputs: {
        ipAddress: String(props?.["ipAddress"] ?? ""),
        fqdn: String(dnsSettings?.["fqdn"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAppGateways(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{ value: Record<string, unknown>[] }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/applicationGateways?api-version=2023-09-01`,
  );
  return (data.value ?? []).map((gw) => {
    const name = String(gw["name"] ?? "");
    const azureId = String(gw["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = gw["properties"] as Record<string, unknown> | undefined;
    const sku = props?.["sku"] as Record<string, unknown> | undefined;
    const backendPools = props?.["backendAddressPools"] as unknown[] | undefined;
    const httpListeners = props?.["httpListeners"] as unknown[] | undefined;
    const frontendIps = props?.["frontendIPConfigurations"] as
      | Array<Record<string, unknown>>
      | undefined;
    const firstFrontend = frontendIps?.[0];
    const frontendProps = firstFrontend?.["properties"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-app-gateway", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-app-gateway",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(gw["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        tier: String(sku?.["tier"] ?? ""),
        capacity: Number(sku?.["capacity"] ?? 0),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        operationalState: String(props?.["operationalState"] ?? ""),
        backendPoolCount: backendPools?.length ?? 0,
        httpListenerCount: httpListeners?.length ?? 0,
      },
      resolvedOutputs: {
        frontendIp: String(frontendProps?.["privateIPAddress"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listFirewalls(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const data = await ctx.get<{
    value: Array<{
      id: string;
      name: string;
      location: string;
      properties?: {
        sku?: { name?: string; tier?: string };
        provisioningState?: string;
        threatIntelMode?: string;
        ipConfigurations?: Array<{
          properties?: { privateIPAddress?: string };
        }>;
      };
    }>;
  }>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Network/azureFirewalls?api-version=2023-09-01`,
  );

  return (data.value ?? []).map((fw) => {
    const rg = extractResourceGroup(fw.id);
    const name = fw.name;
    const props = fw.properties;
    const firstIpConfig = props?.ipConfigurations?.[0];
    return {
      id: ctx.id(accountId, "azure-firewall", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-firewall",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: fw.location,
        sku: String(props?.sku?.name ?? ""),
        tier: String(props?.sku?.tier ?? ""),
        provisioningState: String(props?.provisioningState ?? ""),
        threatIntelMode: String(props?.threatIntelMode ?? ""),
      },
      resolvedOutputs: {
        privateIp: String(firstIpConfig?.properties?.privateIPAddress ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}
