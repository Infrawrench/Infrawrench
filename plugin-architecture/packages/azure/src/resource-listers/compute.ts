import type { ResourceInstance } from "@infrawrench/plugin-base";
import { mapBounded, ReadBudget, startingRow } from "../arm-list.js";
import {
  ARM,
  listAllPages,
  extractName,
  extractResourceGroup,
  joinRefs,
  propsOf,
  refId,
  registryHost,
  siteContainerImage,
  subnetRef,
  userAssignedIdentityNames,
  type ListerContext,
} from "./shared.js";

interface VmNetwork {
  fields: Record<string, string>;
  outputs: Record<string, string>;
}

/**
 * Addresses and network pointers from a VM's first NIC. A blank says the VM has none,
 * so it is only written once a read has shown that: what a failed read would have
 * supplied is left out, and the stored value stands.
 */
async function readVmNetwork(
  ctx: ListerContext,
  budget: ReadBudget,
  vmProps: Record<string, unknown> | undefined,
): Promise<VmNetwork> {
  const networkProfile = vmProps?.["networkProfile"] as Record<string, unknown> | undefined;
  const nics = networkProfile?.["networkInterfaces"] as Array<Record<string, unknown>> | undefined;
  const nicId = String(nics?.[0]?.["id"] ?? "");
  if (!nicId) {
    return {
      fields: {
        vnetName: "",
        subnetName: "",
        networkResourceGroup: "",
        networkSecurityGroup: "",
        publicIpName: "",
      },
      outputs: { publicIp: "", privateIp: "", fqdn: "" },
    };
  }

  const reader = budget.reader(ctx);
  const nic = await budget.hydrate(() =>
    reader.get<Record<string, unknown>>(`${ARM}${nicId}?api-version=2023-09-01`),
  );
  if (!nic) return { fields: {}, outputs: {} };

  const nicProps = propsOf(nic);
  const ipConfigs = nicProps?.["ipConfigurations"] as Array<Record<string, unknown>> | undefined;
  const ipConfigProps = propsOf(ipConfigs?.[0]);
  const subnetParts = subnetRef(refId(ipConfigProps, "subnet")).split("/");
  const publicIpId = refId(ipConfigProps, "publicIPAddress");
  const fields = {
    networkSecurityGroup: extractName(refId(nicProps, "networkSecurityGroup")),
    networkResourceGroup: subnetParts.length === 3 ? (subnetParts[0] ?? "") : "",
    vnetName: subnetParts.length === 3 ? (subnetParts[1] ?? "") : "",
    subnetName: subnetParts.length === 3 ? (subnetParts[2] ?? "") : "",
    publicIpName: extractName(publicIpId),
  };
  const privateIp = String(ipConfigProps?.["privateIPAddress"] ?? "");
  if (!publicIpId) return { fields, outputs: { privateIp, publicIp: "", fqdn: "" } };

  const pip = await budget.hydrate(() =>
    reader.get<Record<string, unknown>>(`${ARM}${publicIpId}?api-version=2023-09-01`),
  );
  if (!pip) return { fields, outputs: { privateIp } };
  const pipProps = propsOf(pip);
  const dnsSettings = pipProps?.["dnsSettings"] as Record<string, unknown> | undefined;
  return {
    fields,
    outputs: {
      privateIp,
      publicIp: String(pipProps?.["ipAddress"] ?? ""),
      fqdn: String(dnsSettings?.["fqdn"] ?? ""),
    },
  };
}

export async function listVMs(ctx: ListerContext, accountId: string): Promise<ResourceInstance[]> {
  // Fetch VMs with instance view (includes power state)
  const budget = new ReadBudget();
  const items = await listAllPages(
    budget.reader(ctx),
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Compute/virtualMachines?api-version=2024-03-01&$expand=instanceView`,
  );
  const networks = new Map(
    await mapBounded(
      items,
      async (vm) => [vm, await readVmNetwork(ctx, budget, propsOf(vm))] as const,
      { from: startingRow(items) },
    ),
  );
  const results: ResourceInstance[] = [];

  for (const vm of items) {
    const name = String(vm["name"] ?? "");
    const location = String(vm["location"] ?? "");
    const azureId = String(vm["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = vm["properties"] as Record<string, unknown> | undefined;
    const hardwareProfile = props?.["hardwareProfile"] as Record<string, unknown> | undefined;
    const storageProfile = props?.["storageProfile"] as Record<string, unknown> | undefined;
    const osDisk = storageProfile?.["osDisk"] as Record<string, unknown> | undefined;
    const imageRef = storageProfile?.["imageReference"] as Record<string, unknown> | undefined;

    // Extract power state from instance view statuses
    const instanceView = props?.["instanceView"] as Record<string, unknown> | undefined;
    const statuses = instanceView?.["statuses"] as Array<Record<string, unknown>> | undefined;
    const powerStatus = statuses?.find((s) => String(s["code"] ?? "").startsWith("PowerState/"));
    const powerState = powerStatus ? String(powerStatus["displayStatus"] ?? "") : "";

    const imageStr = imageRef
      ? `${imageRef["publisher"] ?? ""}/${imageRef["offer"] ?? ""}/${imageRef["sku"] ?? ""}`
      : "";

    // Managed disks come straight off the VM payload: no extra request.
    const dataDisks = storageProfile?.["dataDisks"] as Array<Record<string, unknown>> | undefined;
    const osDiskName = extractName(refId(osDisk, "managedDisk"));
    const dataDiskNames = joinRefs(
      (dataDisks ?? []).map((disk) => extractName(refId(disk, "managedDisk"))),
    );

    const network = networks.get(vm)!;

    results.push({
      id: ctx.id(accountId, "azure-vm", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-vm",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location,
        vmSize: String(hardwareProfile?.["vmSize"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        powerState,
        osType: String(osDisk?.["osType"] ?? ""),
        imageReference: imageStr,
        osDiskSizeGb: Number(osDisk?.["diskSizeGB"] ?? 0),
        ...network.fields,
        osDiskName,
        dataDiskNames,
        managedIdentities: joinRefs(userAssignedIdentityNames(vm)),
        sshUsername: String(
          (props?.["osProfile"] as Record<string, unknown> | undefined)?.["adminUsername"] ?? "",
        ),
      },
      resolvedOutputs: network.outputs,
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["timeCreated"] ?? ctx.now()),
      updatedAt: ctx.now(),
    });
  }

  return results;
}

export async function listDisks(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const items = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Compute/disks?api-version=2023-10-02`,
  );
  return items.map((disk) => {
    const name = String(disk["name"] ?? "");
    const azureId = String(disk["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = disk["properties"] as Record<string, unknown> | undefined;
    const sku = disk["sku"] as Record<string, unknown> | undefined;
    return {
      id: ctx.id(accountId, "azure-disk", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-disk",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(disk["location"] ?? ""),
        diskSizeGb: Number(props?.["diskSizeGB"] ?? 0),
        diskState: String(props?.["diskState"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        osType: String(props?.["osType"] ?? ""),
        managedBy: extractName(String(props?.["managedBy"] ?? "")),
        encryption: String(
          (props?.["encryption"] as Record<string, unknown> | undefined)?.["type"] ?? "None",
        ),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["timeCreated"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAKSClusters(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const items = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ContainerService/managedClusters?api-version=2024-01-01`,
  );
  return items.map((cluster) => {
    const name = String(cluster["name"] ?? "");
    const azureId = String(cluster["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = cluster["properties"] as Record<string, unknown> | undefined;
    const agentPools = props?.["agentPoolProfiles"] as Array<Record<string, unknown>> | undefined;
    const totalNodes = agentPools?.reduce((sum, p) => sum + Number(p["count"] ?? 0), 0) ?? 0;
    const firstPool = agentPools?.[0];
    const networkProfile = props?.["networkProfile"] as Record<string, unknown> | undefined;
    const powerState = props?.["powerState"] as Record<string, unknown> | undefined;
    const addonProfiles = props?.["addonProfiles"] as Record<string, unknown> | undefined;
    const omsConfig = (addonProfiles?.["omsagent"] as Record<string, unknown> | undefined)?.[
      "config"
    ] as Record<string, unknown> | undefined;
    const kubeletIdentity = (props?.["identityProfile"] as Record<string, unknown> | undefined)?.[
      "kubeletidentity"
    ] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-aks-cluster", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-aks-cluster",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(cluster["location"] ?? ""),
        kubernetesVersion: String(props?.["kubernetesVersion"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        powerState: String(powerState?.["code"] ?? "Running"),
        nodeCount: totalNodes,
        nodePoolCount: agentPools?.length ?? 0,
        vmSize: String(firstPool?.["vmSize"] ?? ""),
        // Every pool's VM size, so a GPU user pool is priced as well as the
        // system pool. Read by the Kubernetes peer's node-rate lookup.
        vmSizes: [
          ...new Set(
            (agentPools ?? []).map((pool) => String(pool["vmSize"] ?? "")).filter(Boolean),
          ),
        ].join(","),
        osDiskSizeGb: Number(firstPool?.["osDiskSizeGB"] ?? 0),
        networkPlugin: String(networkProfile?.["networkPlugin"] ?? ""),
        tier: String((cluster["sku"] as Record<string, unknown> | undefined)?.["tier"] ?? "Free"),
        supportPlan: String(props?.["supportPlan"] ?? "KubernetesOfficial"),
        nodeResourceGroup: String(props?.["nodeResourceGroup"] ?? ""),
        subnetRefs: joinRefs(
          (agentPools ?? []).map((pool) => subnetRef(String(pool["vnetSubnetID"] ?? ""))),
        ),
        logAnalyticsWorkspace: extractName(
          String(omsConfig?.["logAnalyticsWorkspaceResourceID"] ?? ""),
        ),
        managedIdentities: joinRefs([
          ...userAssignedIdentityNames(cluster),
          extractName(String(kubeletIdentity?.["resourceId"] ?? "")),
        ]),
      },
      resolvedOutputs: {
        fqdn: String(props?.["fqdn"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listFunctionApps(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const items = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Web/sites?api-version=2023-01-01`,
  );
  const functionApps = items.filter((site) => {
    const kind = String(site["kind"] ?? "");
    return kind.toLowerCase().includes("functionapp");
  });

  return functionApps.map((fa) => {
    const name = String(fa["name"] ?? "");
    const azureId = String(fa["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = fa["properties"] as Record<string, unknown> | undefined;
    const siteConfig = props?.["siteConfig"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-function-app", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-function-app",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(fa["location"] ?? ""),
        state: String(props?.["state"] ?? ""),
        kind: String(fa["kind"] ?? ""),
        runtime: String(siteConfig?.["linuxFxVersion"] ?? siteConfig?.["windowsFxVersion"] ?? ""),
        runtimeVersion: String(siteConfig?.["netFrameworkVersion"] ?? ""),
        appServicePlan: extractName(String(props?.["serverFarmId"] ?? "")),
        httpsOnly: (props?.["httpsOnly"] as boolean) ?? false,
        subnetRef: subnetRef(String(props?.["virtualNetworkSubnetId"] ?? "")),
        containerRegistry: registryHost(String(siteConfig?.["linuxFxVersion"] ?? "")),
        containerImage: siteContainerImage(fa),
        managedIdentities: joinRefs(userAssignedIdentityNames(fa)),
      },
      resolvedOutputs: {
        defaultHostName: String(props?.["defaultHostName"] ?? ""),
        outboundIpAddresses: String(props?.["outboundIpAddresses"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listAppServices(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const items = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Web/sites?api-version=2023-01-01`,
  );
  const webApps = items.filter((site) => {
    const kind = String(site["kind"] ?? "");
    return !kind.toLowerCase().includes("functionapp");
  });

  return webApps.map((app) => {
    const name = String(app["name"] ?? "");
    const azureId = String(app["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = app["properties"] as Record<string, unknown> | undefined;
    const siteConfig = props?.["siteConfig"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-app-service", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-app-service",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(app["location"] ?? ""),
        state: String(props?.["state"] ?? ""),
        kind: String(app["kind"] ?? ""),
        appServicePlan: extractName(String(props?.["serverFarmId"] ?? "")),
        httpsOnly: (props?.["httpsOnly"] as boolean) ?? false,
        linuxFxVersion: String(siteConfig?.["linuxFxVersion"] ?? ""),
        subnetRef: subnetRef(String(props?.["virtualNetworkSubnetId"] ?? "")),
        containerRegistry: registryHost(String(siteConfig?.["linuxFxVersion"] ?? "")),
        containerImage: siteContainerImage(app),
        managedIdentities: joinRefs(userAssignedIdentityNames(app)),
      },
      resolvedOutputs: {
        defaultHostName: String(props?.["defaultHostName"] ?? ""),
        outboundIpAddresses: String(props?.["outboundIpAddresses"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

/**
 * App Service plans (`Microsoft.Web/serverfarms`) at subscription scope.
 *
 * The subscription-scope list returns a subset of the plan properties unless
 * `detailed=true` is passed; everything surfaced here (sku, status, worker and
 * site counts, `reserved`) is in that default subset, so the type costs exactly
 * one request and no extra latency.
 */
export async function listAppServicePlans(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const items = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.Web/serverfarms?api-version=2023-01-01`,
  );
  return items.map((plan) => {
    const name = String(plan["name"] ?? "");
    const azureId = String(plan["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = plan["properties"] as Record<string, unknown> | undefined;
    const sku = plan["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-app-service-plan", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-app-service-plan",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(plan["location"] ?? ""),
        kind: String(plan["kind"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        tier: String(sku?.["tier"] ?? ""),
        size: String(sku?.["size"] ?? ""),
        capacity: Number(sku?.["capacity"] ?? 0),
        workerCount: Number(props?.["numberOfWorkers"] ?? 0),
        maximumWorkers: Number(props?.["maximumNumberOfWorkers"] ?? 0),
        // `reserved` is ARM's Linux flag on a server farm: true means Linux
        // workers, false (the default) means Windows.
        operatingSystem: props?.["reserved"] === true ? "Linux" : "Windows",
        siteCount: Number(props?.["numberOfSites"] ?? 0),
        status: String(props?.["status"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listContainerInstances(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const items = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ContainerInstance/containerGroups?api-version=2023-05-01`,
  );
  return items.map((cg) => {
    const name = String(cg["name"] ?? "");
    const azureId = String(cg["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = cg["properties"] as Record<string, unknown> | undefined;
    const containers = props?.["containers"] as Array<Record<string, unknown>> | undefined;
    const ipAddr = props?.["ipAddress"] as Record<string, unknown> | undefined;
    const registryCreds = props?.["imageRegistryCredentials"] as
      Array<Record<string, unknown>> | undefined;
    const subnetIds = props?.["subnetIds"] as Array<Record<string, unknown>> | undefined;

    return {
      id: ctx.id(accountId, "azure-container-instance", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-container-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(cg["location"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        osType: String(props?.["osType"] ?? ""),
        restartPolicy: String(props?.["restartPolicy"] ?? ""),
        containers: containers?.length ?? 0,
        ipAddress: String(ipAddr?.["ip"] ?? ""),
        fqdn: String(ipAddr?.["fqdn"] ?? ""),
        imageRegistries: joinRefs([
          ...(registryCreds ?? []).map((cred) => String(cred["server"] ?? "")),
          ...(containers ?? []).map((container) =>
            registryHost(String(propsOf(container)?.["image"] ?? "")),
          ),
        ]),
        subnetRefs: joinRefs(
          (subnetIds ?? []).map((subnet) => subnetRef(String(subnet["id"] ?? ""))),
        ),
        // Every image the group runs, init containers included; the list
        // response carries them, so this costs no extra request.
        images: joinRefs(
          [
            ...(containers ?? []),
            ...((props?.["initContainers"] as Array<Record<string, unknown>> | undefined) ?? []),
          ].map((container) => String(propsOf(container)?.["image"] ?? "")),
        ),
      },
      resolvedOutputs: {
        ipAddress: String(ipAddr?.["ip"] ?? ""),
        fqdn: String(ipAddr?.["fqdn"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    };
  });
}

export async function listContainerRegistries(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const items = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ContainerRegistry/registries?api-version=2023-07-01`,
  );
  return items.map((reg) => {
    const name = String(reg["name"] ?? "");
    const azureId = String(reg["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = reg["properties"] as Record<string, unknown> | undefined;
    const sku = reg["sku"] as Record<string, unknown> | undefined;

    return {
      id: ctx.id(accountId, "azure-container-registry", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-container-registry",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(reg["location"] ?? ""),
        sku: String(sku?.["name"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        adminEnabled: (props?.["adminUserEnabled"] as boolean) ?? false,
        publicNetworkAccess: String(props?.["publicNetworkAccess"] ?? "Enabled"),
      },
      resolvedOutputs: {
        loginServer: String(props?.["loginServer"] ?? ""),
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(props?.["creationDate"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
