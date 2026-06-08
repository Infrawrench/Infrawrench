/**
 * Cross-resource attachment handlers.
 *
 * - `azure-disk` → `azure-vm`: appends the managed disk to the VM's
 *   `storageProfile.dataDisks` with the next available LUN.
 * - `azure-nsg`  → `azure-vm`: sets the NSG on the VM's primary NIC.
 * - `azure-public-ip` → `azure-vm`: sets the public IP on the primary NIC IP
 *   configuration.
 * - `azure-load-balancer` / `azure-app-gateway` → `azure-vm`: appends the
 *   VM's primary NIC IP configuration to the first backend pool.
 *
 * Both paths read the live ARM representation first, then PATCH a delta — Azure
 * doesn't have a separate "attach" verb for these.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, type AzureHttpContext } from "./shared.js";

interface AttachContext extends AzureHttpContext {
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
}

export async function attachAzureResource(
  ctx: AttachContext,
  sourceTypeId: string,
  sourceResourceId: string,
  targetTypeId: string,
  targetResourceId: string,
  accountId: string,
): Promise<void> {
  if (sourceTypeId === "azure-disk" && targetTypeId === "azure-vm") {
    const [disk, vm] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const diskLocation = String(disk.fields["location"] ?? "");
    const vmLocation = String(vm.fields["location"] ?? "");
    if (diskLocation && vmLocation && diskLocation !== vmLocation) {
      throw new Error(
        `Disk location ${diskLocation} does not match VM location ${vmLocation} — Azure managed disks must be in the same region as the VM.`,
      );
    }
    const vmRg = String(vm.fields["resourceGroup"] ?? "");
    const vmName = String(vm.fields["name"] ?? "");
    const diskRg = String(disk.fields["resourceGroup"] ?? "");
    const diskName = String(disk.fields["name"] ?? "");
    if (!vmRg || !vmName || !diskRg || !diskName) {
      throw new Error("Cannot determine VM or disk identity for attachment");
    }
    const diskResourceId = `/subscriptions/${ctx.subscriptionId}/resourceGroups/${diskRg}/providers/Microsoft.Compute/disks/${diskName}`;
    // Fetch VM to read existing data disks, then PATCH to append the new one
    const vmUrl = `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${vmRg}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=2024-03-01`;
    const current = await ctx.get<Record<string, unknown>>(vmUrl);
    const props = (current["properties"] ?? {}) as Record<string, unknown>;
    const storage = (props["storageProfile"] ?? {}) as Record<string, unknown>;
    const existing = Array.isArray(storage["dataDisks"])
      ? (storage["dataDisks"] as Array<Record<string, unknown>>)
      : [];
    const usedLuns = new Set(existing.map((d) => Number(d["lun"] ?? 0)));
    let lun = 0;
    while (usedLuns.has(lun)) lun++;
    const updated = [
      ...existing,
      {
        lun,
        name: diskName,
        createOption: "Attach",
        managedDisk: { id: diskResourceId },
      },
    ];
    await ctx.patch(vmUrl, { properties: { storageProfile: { dataDisks: updated } } });
    return;
  }
  if (sourceTypeId === "azure-nsg" && targetTypeId === "azure-vm") {
    const [nsg, vm] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const nsgRg = String(nsg.fields["resourceGroup"] ?? "");
    const nsgName = String(nsg.fields["name"] ?? "");
    const nsgLocation = String(nsg.fields["location"] ?? "");
    const vmRg = String(vm.fields["resourceGroup"] ?? "");
    const vmName = String(vm.fields["name"] ?? "");
    const vmLocation = String(vm.fields["location"] ?? "");
    if (!nsgRg || !nsgName || !vmRg || !vmName) {
      throw new Error("Cannot determine NSG or VM identity for attachment");
    }
    if (nsgLocation && vmLocation && nsgLocation !== vmLocation) {
      throw new Error(
        `NSG region ${nsgLocation} does not match VM region ${vmLocation} — Azure NSGs must be in the same region as the NIC.`,
      );
    }
    const nsgId = `/subscriptions/${ctx.subscriptionId}/resourceGroups/${nsgRg}/providers/Microsoft.Network/networkSecurityGroups/${nsgName}`;
    // Fetch the VM to find its primary NIC reference.
    const vmUrl = `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${vmRg}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=2024-03-01`;
    const vmData = await ctx.get<Record<string, unknown>>(vmUrl);
    const props = (vmData["properties"] ?? {}) as Record<string, unknown>;
    const netProfile = (props["networkProfile"] ?? {}) as Record<string, unknown>;
    const nics = Array.isArray(netProfile["networkInterfaces"])
      ? (netProfile["networkInterfaces"] as Array<Record<string, unknown>>)
      : [];
    if (nics.length === 0) throw new Error("VM has no network interfaces");
    const primaryNic =
      nics.find((n) => (n["properties"] as Record<string, unknown> | undefined)?.["primary"]) ??
      nics[0];
    const nicArmId = String(primaryNic?.["id"] ?? "");
    if (!nicArmId) throw new Error("Cannot determine primary NIC of VM");
    // Fetch the NIC and PATCH with the NSG reference.
    const nicUrl = `${ARM}${nicArmId}?api-version=2023-09-01`;
    const nicData = await ctx.get<Record<string, unknown>>(nicUrl);
    const nicProps = (nicData["properties"] ?? {}) as Record<string, unknown>;
    await ctx.patch(nicUrl, {
      properties: { ...nicProps, networkSecurityGroup: { id: nsgId } },
    });
    return;
  }
  if (sourceTypeId === "azure-public-ip" && targetTypeId === "azure-vm") {
    const [publicIp, vm] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    assertSameLocation(publicIp, vm, "Public IP", "VM");
    const pipRg = String(publicIp.fields["resourceGroup"] ?? "");
    const pipName = String(publicIp.fields["name"] ?? "");
    if (!pipRg || !pipName) throw new Error("Cannot determine public IP identity for attachment");
    const pipId = `/subscriptions/${ctx.subscriptionId}/resourceGroups/${pipRg}/providers/Microsoft.Network/publicIPAddresses/${pipName}`;
    await patchPrimaryNicIpConfig(ctx, vm, (ipConfigProps) => ({
      ...ipConfigProps,
      publicIPAddress: { id: pipId },
    }));
    return;
  }
  if (sourceTypeId === "azure-load-balancer" && targetTypeId === "azure-vm") {
    const [loadBalancer, vm] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    assertSameLocation(loadBalancer, vm, "Load balancer", "VM");
    const poolId = await firstBackendPoolId(ctx, loadBalancer, "Microsoft.Network/loadBalancers");
    await patchPrimaryNicIpConfig(ctx, vm, (ipConfigProps) => ({
      ...ipConfigProps,
      loadBalancerBackendAddressPools: appendIdRef(
        ipConfigProps["loadBalancerBackendAddressPools"],
        poolId,
      ),
    }));
    return;
  }
  if (sourceTypeId === "azure-app-gateway" && targetTypeId === "azure-vm") {
    const [gateway, vm] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    assertSameLocation(gateway, vm, "Application gateway", "VM");
    const poolId = await firstBackendPoolId(ctx, gateway, "Microsoft.Network/applicationGateways");
    await patchPrimaryNicIpConfig(ctx, vm, (ipConfigProps) => ({
      ...ipConfigProps,
      applicationGatewayBackendAddressPools: appendIdRef(
        ipConfigProps["applicationGatewayBackendAddressPools"],
        poolId,
      ),
    }));
    return;
  }
  if (sourceTypeId === "azure-route-table" && targetTypeId === "azure-subnet") {
    const [routeTable, subnet] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    assertSameLocation(routeTable, subnet, "Route table", "Subnet");
    await updateSubnetProperties(ctx, subnet, (subnetProps) => ({
      ...subnetProps,
      routeTable: { id: azureResourceId(ctx, routeTable, "Microsoft.Network/routeTables") },
    }));
    return;
  }
  if (sourceTypeId === "azure-nat-gateway" && targetTypeId === "azure-subnet") {
    const [natGateway, subnet] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    assertSameLocation(natGateway, subnet, "NAT gateway", "Subnet");
    await updateSubnetProperties(ctx, subnet, (subnetProps) => ({
      ...subnetProps,
      natGateway: { id: azureResourceId(ctx, natGateway, "Microsoft.Network/natGateways") },
    }));
    return;
  }
  if (sourceTypeId === "azure-private-dns-zone" && targetTypeId === "azure-vnet") {
    const [zone, vnet] = await Promise.all([
      ctx.getResource(sourceTypeId, sourceResourceId, accountId),
      ctx.getResource(targetTypeId, targetResourceId, accountId),
    ]);
    const zoneRg = String(zone.fields["resourceGroup"] ?? "");
    const zoneName = String(zone.fields["name"] ?? "");
    if (!zoneRg || !zoneName) throw new Error("Cannot determine private DNS zone identity");
    const linkName = virtualNetworkLinkName(vnet);
    const url = `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${zoneRg}/providers/Microsoft.Network/privateDnsZones/${zoneName}/virtualNetworkLinks/${linkName}?api-version=2020-06-01`;
    await ctx.put(url, {
      location: "global",
      properties: {
        registrationEnabled: false,
        virtualNetwork: {
          id: azureResourceId(ctx, vnet, "Microsoft.Network/virtualNetworks"),
        },
      },
    });
    return;
  }
  throw new Error(
    `Azure plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
  );
}

function assertSameLocation(
  source: ResourceInstance,
  target: ResourceInstance,
  sourceLabel: string,
  targetLabel: string,
): void {
  const sourceLocation = String(source.fields["location"] ?? "");
  const targetLocation = String(target.fields["location"] ?? "");
  if (sourceLocation && targetLocation && sourceLocation !== targetLocation) {
    throw new Error(
      `${sourceLabel} location ${sourceLocation} does not match ${targetLabel} location ${targetLocation}.`,
    );
  }
}

async function primaryNicUrl(ctx: AttachContext, vm: ResourceInstance): Promise<string> {
  const vmRg = String(vm.fields["resourceGroup"] ?? "");
  const vmName = String(vm.fields["name"] ?? "");
  if (!vmRg || !vmName) throw new Error("Cannot determine VM identity for attachment");

  const vmUrl = `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${vmRg}/providers/Microsoft.Compute/virtualMachines/${vmName}?api-version=2024-03-01`;
  const vmData = await ctx.get<Record<string, unknown>>(vmUrl);
  const props = (vmData["properties"] ?? {}) as Record<string, unknown>;
  const netProfile = (props["networkProfile"] ?? {}) as Record<string, unknown>;
  const nics = Array.isArray(netProfile["networkInterfaces"])
    ? (netProfile["networkInterfaces"] as Array<Record<string, unknown>>)
    : [];
  if (nics.length === 0) throw new Error("VM has no network interfaces");
  const primaryNic =
    nics.find((n) => (n["properties"] as Record<string, unknown> | undefined)?.["primary"]) ??
    nics[0];
  const nicArmId = String(primaryNic?.["id"] ?? "");
  if (!nicArmId) throw new Error("Cannot determine primary NIC of VM");
  return `${ARM}${nicArmId}?api-version=2023-09-01`;
}

async function patchPrimaryNicIpConfig(
  ctx: AttachContext,
  vm: ResourceInstance,
  update: (ipConfigProps: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const nicUrl = await primaryNicUrl(ctx, vm);
  const nicData = await ctx.get<Record<string, unknown>>(nicUrl);
  const nicProps = (nicData["properties"] ?? {}) as Record<string, unknown>;
  const ipConfigs = Array.isArray(nicProps["ipConfigurations"])
    ? ([...(nicProps["ipConfigurations"] as Array<Record<string, unknown>>)] as Array<
        Record<string, unknown>
      >)
    : [];
  if (ipConfigs.length === 0) throw new Error("Primary NIC has no IP configurations");
  const primaryIndex = Math.max(
    0,
    ipConfigs.findIndex((ipConfig) => {
      const props = ipConfig["properties"] as Record<string, unknown> | undefined;
      return props?.["primary"] === true;
    }),
  );
  const ipConfig = { ...ipConfigs[primaryIndex]! };
  const ipConfigProps = (ipConfig["properties"] ?? {}) as Record<string, unknown>;
  ipConfig["properties"] = update(ipConfigProps);
  ipConfigs[primaryIndex] = ipConfig;
  await ctx.patch(nicUrl, {
    properties: { ...nicProps, ipConfigurations: ipConfigs },
  });
}

async function firstBackendPoolId(
  ctx: AttachContext,
  resource: ResourceInstance,
  provider: string,
): Promise<string> {
  const rg = String(resource.fields["resourceGroup"] ?? "");
  const name = String(resource.fields["name"] ?? "");
  if (!rg || !name) throw new Error("Cannot determine backend resource identity for attachment");
  const url = `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${provider}/${name}?api-version=2023-09-01`;
  const data = await ctx.get<Record<string, unknown>>(url);
  const props = (data["properties"] ?? {}) as Record<string, unknown>;
  const pools = Array.isArray(props["backendAddressPools"])
    ? (props["backendAddressPools"] as Array<Record<string, unknown>>)
    : [];
  const poolId = String(pools[0]?.["id"] ?? "");
  if (!poolId) throw new Error(`${resource.displayName} has no backend address pools`);
  return poolId;
}

function appendIdRef(value: unknown, id: string): Array<{ id: string }> {
  const refs = Array.isArray(value)
    ? (value as Array<Record<string, unknown>>)
        .map((ref) => String(ref["id"] ?? ""))
        .filter(Boolean)
        .map((refId) => ({ id: refId }))
    : [];
  return refs.some((ref) => ref.id === id) ? refs : [...refs, { id }];
}

async function updateSubnetProperties(
  ctx: AttachContext,
  subnet: ResourceInstance,
  update: (subnetProps: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const rg = String(subnet.fields["resourceGroup"] ?? "");
  const vnetName = String(subnet.fields["vnetName"] ?? "");
  const subnetName = String(subnet.fields["name"] ?? "");
  if (!rg || !vnetName || !subnetName) throw new Error("Cannot determine subnet identity");
  const url = `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${vnetName}/subnets/${subnetName}?api-version=2023-09-01`;
  const current = await ctx.get<Record<string, unknown>>(url);
  const subnetProps = (current["properties"] ?? {}) as Record<string, unknown>;
  await ctx.put(url, {
    ...current,
    properties: update(subnetProps),
  });
}

function azureResourceId(ctx: AttachContext, resource: ResourceInstance, provider: string): string {
  const fromOutput = String(resource.resolvedOutputs["resourceId"] ?? "");
  if (fromOutput) return fromOutput;
  const rg = String(resource.fields["resourceGroup"] ?? "");
  const name = String(resource.fields["name"] ?? "");
  if (!rg || !name) throw new Error(`Cannot determine ${resource.displayName} identity`);
  return `/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${provider}/${name}`;
}

function virtualNetworkLinkName(vnet: ResourceInstance): string {
  const name = String(vnet.fields["name"] ?? vnet.displayName ?? "vnet");
  return `${name.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64)}-link`;
}
