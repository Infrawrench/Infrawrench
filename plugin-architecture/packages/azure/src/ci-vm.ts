/**
 * CI jobs on Azure virtual machines: one resource group per job holding a
 * virtual network, a public IP, a network interface, the VM and its
 * auto-shutdown schedule, made by one ARM deployment and deleted with the
 * group when the job ends.
 *
 * **Wire shapes verified against the Azure REST reference and swagger,
 * November 2026:**
 * - Deployments - Create Or Update (2025-04-01) at resource group scope,
 *   `properties.{mode: Incremental, template}`; `provisioningState`
 *   (Accepted, Running, Succeeded, Failed, Canceled, ...).
 * - Virtual Machines (2024-07-01 in the template): `hardwareProfile.vmSize`,
 *   `storageProfile.imageReference` (Ubuntu 24.04 is
 *   `Canonical:ubuntu-24_04-lts:server` and `server-arm64`), `osDisk.{
 *   createOption: FromImage, deleteOption: Delete}`, `osProfile.{
 *   computerName, adminUsername, adminPassword, customData}` (base64, run by
 *   cloud-init as a script when it starts with `#!`), no `identity`.
 *   Instance View: `statuses[].code` `PowerState/<state>`.
 * - Public IP (Standard SKU): the VM's way to the internet, closed to
 *   inbound traffic unless a security group allows it, and none does.
 * - `Microsoft.DevTestLab/schedules` (2018-09-15), `shutdown-computevm-<vm>`:
 *   `taskType: ComputeVmShutdownTask`, `dailyRecurrence.time` (`HHmm`),
 *   `timeZoneId`, `targetResourceId`. A deployment registers the provider.
 *
 * The VM has no managed identity, so the job holds no Azure credentials. Its
 * admin password is random and never kept: nothing can reach the VM to use
 * it. The backstop is the auto-shutdown schedule, set to the job's deadline
 * (Azure has no maximum lifetime for a VM, and a shutdown from inside the
 * guest leaves it allocated and billed); the reaper deletes the group after.
 */
import {
  ciComputeKey,
  type CiComputeStatus,
  type CiHandle,
  type CiMissingPermission,
  type CiPreflightResult,
  type CiStartSpec,
} from "@infrawrench/plugin-base";

import {
  GROUP_PERMISSIONS,
  RESOURCES_API,
  groupName,
  groupPath,
  missingRoleActions,
  nowOf,
  ok,
  putGroup,
  randomPassword,
  unregisteredProviders,
  azureTags,
  base64,
  type AzureCiCalls,
} from "./ci-shared.js";

export const VM_DEFAULT_MACHINE = "Standard_D2s_v5";
export const VM_DEFAULT_IMAGE = "Ubuntu 24.04";
const DEPLOYMENT = "infrawrench-ci";
const VM_NAME = "iwci-vm";
const COMPUTE_API = "2024-07-01";

export const VM_PERMISSIONS = {
  ...GROUP_PERMISSIONS,
  deploy: {
    permission: "Microsoft.Resources/deployments/write",
    label: "Deploy the job's machine and its network",
  },
  deployRead: {
    permission: "Microsoft.Resources/deployments/read",
    label: "Follow the deployment",
  },
  vnet: { permission: "Microsoft.Network/virtualNetworks/write", label: "Give it a network" },
  join: {
    permission: "Microsoft.Network/virtualNetworks/subnets/join/action",
    label: "Put it on that network",
  },
  ip: {
    permission: "Microsoft.Network/publicIPAddresses/write",
    label: "Give it a public address",
  },
  ipJoin: {
    permission: "Microsoft.Network/publicIPAddresses/join/action",
    label: "Attach the address",
  },
  nic: { permission: "Microsoft.Network/networkInterfaces/write", label: "Give it a network card" },
  nicJoin: {
    permission: "Microsoft.Network/networkInterfaces/join/action",
    label: "Attach the card",
  },
  vm: { permission: "Microsoft.Compute/virtualMachines/write", label: "Start the job's VM" },
  vmRead: { permission: "Microsoft.Compute/virtualMachines/read", label: "Follow it" },
  schedule: {
    permission: "Microsoft.DevTestLab/schedules/write",
    label: "Set its auto-shutdown to the job's deadline",
  },
} as const satisfies Record<string, CiMissingPermission>;

/** Arm64 sizes have a `p` after the size number (`Standard_D2ps_v5`). */
function isArm(size: string): boolean {
  return /^Standard_[A-Z]+\d+[a-oq-z]*p[a-z]*_v\d/i.test(size);
}

export function imageReference(size: string, image?: string): Record<string, string> {
  if (image && image !== VM_DEFAULT_IMAGE) {
    // `publisher:offer:sku[:version]`, as the portal and the CLI write it.
    const [publisher, offer, sku, version = "latest"] = image.split(":");
    if (!publisher || !offer || !sku) {
      throw new Error(
        `An Azure image is \`publisher:offer:sku[:version]\`, e.g. Canonical:ubuntu-24_04-lts:server, not \`${image}\`.`,
      );
    }
    return { publisher, offer, sku, version };
  }
  return {
    publisher: "Canonical",
    offer: "ubuntu-24_04-lts",
    sku: isArm(size) ? "server-arm64" : "server",
    version: "latest",
  };
}

/** `HHmm` in UTC, `seconds` from `now`; null when it is a day or more away. */
export function shutdownTime(now: number, seconds: number): string | null {
  // A daily schedule cannot say "in 30 hours"; set past a day, it would fire early.
  if (seconds >= 23 * 3600) return null;
  const at = new Date(now + Math.ceil(seconds / 60) * 60_000);
  return `${String(at.getUTCHours()).padStart(2, "0")}${String(at.getUTCMinutes()).padStart(2, "0")}`;
}

/** The ARM template for a job's machine. */
export function vmTemplate(
  spec: CiStartSpec,
  location: string,
  now: number,
): Record<string, unknown> {
  const size = spec.machine ?? VM_DEFAULT_MACHINE;
  const tags = azureTags(spec.tags);
  const time = shutdownTime(now, spec.maxSeconds);
  const id = (type: string, name: string) => `[resourceId('${type}', '${name}')]`;
  const resources: Array<Record<string, unknown>> = [
    {
      type: "Microsoft.Network/virtualNetworks",
      apiVersion: "2023-09-01",
      name: "iwci-net",
      location,
      tags,
      properties: {
        addressSpace: { addressPrefixes: ["10.80.0.0/24"] },
        subnets: [{ name: "job", properties: { addressPrefix: "10.80.0.0/26" } }],
      },
    },
    {
      type: "Microsoft.Network/publicIPAddresses",
      apiVersion: "2023-09-01",
      name: "iwci-ip",
      location,
      tags,
      sku: { name: "Standard" },
      properties: { publicIPAllocationMethod: "Static" },
    },
    {
      type: "Microsoft.Network/networkInterfaces",
      apiVersion: "2023-09-01",
      name: "iwci-nic",
      location,
      tags,
      dependsOn: [
        id("Microsoft.Network/virtualNetworks", "iwci-net"),
        id("Microsoft.Network/publicIPAddresses", "iwci-ip"),
      ],
      properties: {
        ipConfigurations: [
          {
            name: "ip",
            properties: {
              subnet: {
                id: `[resourceId('Microsoft.Network/virtualNetworks/subnets', 'iwci-net', 'job')]`,
              },
              publicIPAddress: { id: id("Microsoft.Network/publicIPAddresses", "iwci-ip") },
            },
          },
        ],
      },
    },
    {
      type: "Microsoft.Compute/virtualMachines",
      apiVersion: COMPUTE_API,
      name: VM_NAME,
      location,
      tags,
      dependsOn: [id("Microsoft.Network/networkInterfaces", "iwci-nic")],
      properties: {
        hardwareProfile: { vmSize: size },
        storageProfile: {
          imageReference: imageReference(size, spec.image),
          osDisk: {
            createOption: "FromImage",
            deleteOption: "Delete",
            diskSizeGB: 64,
            managedDisk: { storageAccountType: "StandardSSD_LRS" },
          },
        },
        osProfile: {
          computerName: VM_NAME,
          adminUsername: "iwci",
          // Random and never kept: no security group lets anything in to use it.
          adminPassword: randomPassword(),
          customData: base64(spec.bootstrap),
        },
        networkProfile: {
          networkInterfaces: [
            {
              id: id("Microsoft.Network/networkInterfaces", "iwci-nic"),
              properties: { deleteOption: "Delete" },
            },
          ],
        },
      },
    },
  ];
  if (time) {
    resources.push({
      type: "Microsoft.DevTestLab/schedules",
      apiVersion: "2018-09-15",
      name: `shutdown-computevm-${VM_NAME}`,
      location,
      tags,
      dependsOn: [id("Microsoft.Compute/virtualMachines", VM_NAME)],
      properties: {
        status: "Enabled",
        taskType: "ComputeVmShutdownTask",
        dailyRecurrence: { time },
        timeZoneId: "UTC",
        targetResourceId: id("Microsoft.Compute/virtualMachines", VM_NAME),
        notificationSettings: { status: "Disabled" },
      },
    });
  }
  return {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    resources,
  };
}

export function vmHandle(group: string, location: string): CiHandle {
  return {
    id: group,
    region: location,
    label: `azure vm ${group} (${location})`,
    data: { kind: "vm" },
  };
}

export async function vmPreflight(
  calls: AzureCiCalls,
  location: string,
): Promise<CiPreflightResult> {
  const missing = await missingRoleActions(calls, Object.values(VM_PERMISSIONS));
  const problems = await unregisteredProviders(calls, ["Microsoft.Compute", "Microsoft.Network"]);
  return { ok: missing.length === 0 && problems.length === 0, missing, problems, region: location };
}

export async function vmStart(
  calls: AzureCiCalls,
  location: string,
  spec: CiStartSpec,
): Promise<CiHandle> {
  if (spec.gpu && !spec.machine) {
    throw new Error(
      "On Azure a GPU comes with the VM size: name one in `cloud.machine`, e.g. Standard_NC4as_T4_v3.",
    );
  }
  const group = groupName("vm", ciComputeKey(spec));
  await putGroup(calls, group, location, spec.tags);
  // The deployment's name is fixed within the group, so a retry updates the
  // same deployment rather than making a second machine.
  ok(
    await calls.arm(
      "PUT",
      `${groupPath(calls.subscriptionId, group)}/providers/Microsoft.Resources/deployments/${DEPLOYMENT}?api-version=${RESOURCES_API}`,
      { properties: { mode: "Incremental", template: vmTemplate(spec, location, nowOf(calls)) } },
    ),
    "Azure did not start the deployment",
  );
  return vmHandle(group, location);
}

export async function vmStatus(calls: AzureCiCalls, handle: CiHandle): Promise<CiComputeStatus> {
  const base = groupPath(calls.subscriptionId, handle.id);
  const deployment = await calls.arm(
    "GET",
    `${base}/providers/Microsoft.Resources/deployments/${DEPLOYMENT}?api-version=${RESOURCES_API}`,
  );
  if (deployment.status === 404) {
    const group = await calls.arm("GET", `${base}?api-version=${RESOURCES_API}`);
    return group.status === 404 ? { state: "gone" } : { state: "starting" };
  }
  const state = ok<{ properties?: { provisioningState?: string; error?: { message?: string } } }>(
    deployment,
    "Azure did not answer the deployment",
  ).properties;
  if (state?.provisioningState === "Failed" || state?.provisioningState === "Canceled") {
    return { state: "stopped", detail: state.error?.message ?? state.provisioningState };
  }
  if (state?.provisioningState !== "Succeeded") return { state: "starting" };
  const view = await calls.arm(
    "GET",
    `${base}/providers/Microsoft.Compute/virtualMachines/${VM_NAME}/instanceView?api-version=${COMPUTE_API}`,
  );
  if (view.status === 404) return { state: "gone" };
  const statuses =
    ok<{ statuses?: Array<{ code?: string }> }>(view, "Azure did not answer the VM").statuses ?? [];
  const power = statuses.find((s) => s.code?.startsWith("PowerState/"))?.code?.slice(11) ?? "";
  if (power === "running") return { state: "running", detail: power };
  if (power === "starting" || power === "") {
    return power ? { state: "starting", detail: power } : { state: "starting" };
  }
  return { state: "stopped", detail: power };
}
