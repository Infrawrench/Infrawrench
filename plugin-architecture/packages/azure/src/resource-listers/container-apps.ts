import type { ResourceInstance } from "@infrawrench/plugin-base";
import {
  ARM,
  extractName,
  extractResourceGroup,
  joinRefs,
  listAllPages,
  registryHost,
  subnetRef,
  userAssignedIdentityNames,
  type ListerContext,
} from "./shared.js";

/** Container Apps ARM api-version: the 2025-07-01 stable surface. */
const CONTAINER_APPS_API_VERSION = "2025-07-01";

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | undefined {
  return value as Bag | undefined;
}

/** Registry hosts a template's images and the app's `registries` config pull from. */
function registriesOf(template: Bag | undefined, configuration: Bag | undefined): string {
  const containers = (template?.["containers"] as Bag[] | undefined) ?? [];
  const initContainers = (template?.["initContainers"] as Bag[] | undefined) ?? [];
  const registries = (configuration?.["registries"] as Bag[] | undefined) ?? [];
  return joinRefs([
    ...registries.map((registry) => String(registry["server"] ?? "")),
    ...[...containers, ...initContainers].map((c) => registryHost(String(c["image"] ?? ""))),
  ]);
}

/**
 * `environmentId` is the current spelling; `managedEnvironmentId` is the
 * deprecated one older apps were created with. Either names the environment.
 */
function environmentName(props: Bag | undefined): string {
  return extractName(String(props?.["environmentId"] ?? props?.["managedEnvironmentId"] ?? ""));
}

export async function listContainerApps(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const apps = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.App/containerApps?api-version=${CONTAINER_APPS_API_VERSION}`,
  );
  return apps.map((app) => {
    const name = String(app["name"] ?? "");
    const azureId = String(app["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = bag(app["properties"]);
    const configuration = bag(props?.["configuration"]);
    const ingress = bag(configuration?.["ingress"]);
    const template = bag(props?.["template"]);
    const scale = bag(template?.["scale"]);
    const containers = (template?.["containers"] as Bag[] | undefined) ?? [];
    const first = containers[0];
    const resources = bag(first?.["resources"]);
    const fqdn = String(ingress?.["fqdn"] ?? "");
    const outbound = props?.["outboundIpAddresses"];

    return {
      id: ctx.id(accountId, "azure-container-app", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-container-app",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(app["location"] ?? ""),
        environment: environmentName(props),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        runningStatus: String(props?.["runningStatus"] ?? ""),
        image: String(first?.["image"] ?? ""),
        cpu: Number(resources?.["cpu"] ?? 0),
        memory: String(resources?.["memory"] ?? ""),
        // Azure's documented defaults when the scale block omits them.
        minReplicas: Number(scale?.["minReplicas"] ?? 0),
        maxReplicas: Number(scale?.["maxReplicas"] ?? 10),
        ingress: ingress ? (ingress["external"] === true ? "External" : "Internal") : "Disabled",
        targetPort: Number(ingress?.["targetPort"] ?? 0),
        activeRevisionsMode: String(configuration?.["activeRevisionsMode"] ?? "Single"),
        latestRevisionName: String(props?.["latestRevisionName"] ?? ""),
        workloadProfileName: String(props?.["workloadProfileName"] ?? ""),
        containerCount: containers.length,
        containerRegistry: registriesOf(template, configuration),
        managedIdentities: joinRefs(userAssignedIdentityNames(app)),
      },
      resolvedOutputs: {
        fqdn,
        url: fqdn ? `https://${fqdn}` : "",
        latestRevisionFqdn: String(props?.["latestRevisionFqdn"] ?? ""),
        outboundIpAddresses: Array.isArray(outbound) ? outbound.join(", ") : String(outbound ?? ""),
        resourceId: azureId,
      },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(bag(app["systemData"])?.["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listContainerAppEnvironments(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const envs = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.App/managedEnvironments?api-version=${CONTAINER_APPS_API_VERSION}`,
  );
  return envs.map((env) => {
    const name = String(env["name"] ?? "");
    const azureId = String(env["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = bag(env["properties"]);
    const vnet = bag(props?.["vnetConfiguration"]);
    const logs = bag(props?.["appLogsConfiguration"]);
    const profiles = (props?.["workloadProfiles"] as Bag[] | undefined) ?? [];
    const defaultDomain = String(props?.["defaultDomain"] ?? "");
    const staticIp = String(props?.["staticIp"] ?? "");

    return {
      id: ctx.id(accountId, "azure-container-app-environment", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-container-app-environment",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(env["location"] ?? ""),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        defaultDomain,
        staticIp,
        workloadProfiles: profiles
          .map((p) => `${String(p["name"] ?? "")}: ${String(p["workloadProfileType"] ?? "")}`)
          .join(", "),
        zoneRedundant: props?.["zoneRedundant"] === true,
        internalOnly: vnet?.["internal"] === true,
        publicNetworkAccess: String(props?.["publicNetworkAccess"] ?? ""),
        logsDestination: String(logs?.["destination"] ?? ""),
        subnetRef: subnetRef(String(vnet?.["infrastructureSubnetId"] ?? "")),
        infrastructureResourceGroup: String(props?.["infrastructureResourceGroup"] ?? ""),
      },
      resolvedOutputs: { defaultDomain, staticIp, resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(bag(env["systemData"])?.["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}

export async function listContainerAppJobs(
  ctx: ListerContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const jobs = await listAllPages(
    ctx,
    `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.App/jobs?api-version=${CONTAINER_APPS_API_VERSION}`,
  );
  return jobs.map((job) => {
    const name = String(job["name"] ?? "");
    const azureId = String(job["id"] ?? "");
    const rg = extractResourceGroup(azureId);
    const props = bag(job["properties"]);
    const configuration = bag(props?.["configuration"]);
    const template = bag(props?.["template"]);
    const first = ((template?.["containers"] as Bag[] | undefined) ?? [])[0];
    const resources = bag(first?.["resources"]);
    const trigger =
      bag(configuration?.["scheduleTriggerConfig"]) ??
      bag(configuration?.["eventTriggerConfig"]) ??
      bag(configuration?.["manualTriggerConfig"]);

    return {
      id: ctx.id(accountId, "azure-container-app-job", `${rg}/${name}`),
      pluginId: "azure",
      resourceTypeId: "azure-container-app-job",
      accountId,
      displayName: name,
      fields: {
        name,
        resourceGroup: rg,
        location: String(job["location"] ?? ""),
        environment: environmentName(props),
        provisioningState: String(props?.["provisioningState"] ?? ""),
        triggerType: String(configuration?.["triggerType"] ?? "Manual"),
        cronExpression: String(
          bag(configuration?.["scheduleTriggerConfig"])?.["cronExpression"] ?? "",
        ),
        image: String(first?.["image"] ?? ""),
        cpu: Number(resources?.["cpu"] ?? 0),
        memory: String(resources?.["memory"] ?? ""),
        parallelism: Number(trigger?.["parallelism"] ?? 1),
        replicaTimeout: Number(configuration?.["replicaTimeout"] ?? 0),
        replicaRetryLimit: Number(configuration?.["replicaRetryLimit"] ?? 0),
        workloadProfileName: String(props?.["workloadProfileName"] ?? ""),
        containerRegistry: registriesOf(template, configuration),
        managedIdentities: joinRefs(userAssignedIdentityNames(job)),
      },
      resolvedOutputs: { resourceId: azureId },
      secretStates: [],
      externalId: `${rg}/${name}`,
      createdAt: String(bag(job["systemData"])?.["createdAt"] ?? ctx.now()),
      updatedAt: ctx.now(),
    };
  });
}
