/**
 * Cross-resource attachment handlers.
 *
 * - `azure-disk` → `azure-vm`: appends the managed disk to the VM's
 *   `storageProfile.dataDisks` with the next available LUN.
 * - `azure-nsg`  → `azure-vm`: sets the NSG on the VM's primary NIC.
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
  throw new Error(
    `Azure plugin: attachResource not supported for ${sourceTypeId} → ${targetTypeId}`,
  );
}
