/**
 * Container Apps: create (PUT) and edit (PATCH) for `azure-container-app`.
 *
 * Create needs an existing Container Apps environment, picked from the
 * subscription's environments rather than typed as an ARM id. Images from an
 * Azure Container Registry in the same subscription are pulled with the
 * registry's admin credentials, stored as an app secret, so the user picks a
 * registry instead of wiring a secret by hand.
 */
import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, fetchResourceGroups, type AzureCreateContext } from "./create-handlers-shared.js";
import type { AzureHttpContext } from "./shared.js";

const API = "2025-07-01";

/**
 * Consumption-plan CPU/memory pairs: Azure accepts only these combinations
 * (1 vCPU : 2 GiB) for apps on the Consumption profile.
 */
const CONTAINER_APP_SIZES: Array<{ cpu: number; memory: string }> = [
  { cpu: 0.25, memory: "0.5Gi" },
  { cpu: 0.5, memory: "1Gi" },
  { cpu: 0.75, memory: "1.5Gi" },
  { cpu: 1, memory: "2Gi" },
  { cpu: 1.25, memory: "2.5Gi" },
  { cpu: 1.5, memory: "3Gi" },
  { cpu: 1.75, memory: "3.5Gi" },
  { cpu: 2, memory: "4Gi" },
  { cpu: 2.5, memory: "5Gi" },
  { cpu: 3, memory: "6Gi" },
  { cpu: 3.5, memory: "7Gi" },
  { cpu: 4, memory: "8Gi" },
];

type Bag = Record<string, unknown>;

export async function getContainerAppCreateConfig(
  ctx: AzureCreateContext,
): Promise<CreateResourceConfig> {
  const [rgOptions, envs, registries] = await Promise.all([
    fetchResourceGroups(ctx),
    ctx.get<{ value?: Bag[] }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.App/managedEnvironments?api-version=${API}`,
    ),
    ctx
      .get<{ value?: Bag[] }>(
        `${ARM}/subscriptions/${ctx.subscriptionId}/providers/Microsoft.ContainerRegistry/registries?api-version=2023-07-01`,
      )
      .catch(() => ({ value: [] as Bag[] })),
  ]);
  const envOptions = (envs.value ?? []).map((env) => ({
    id: String(env["id"] ?? ""),
    label: String(env["name"] ?? ""),
    description: String(env["location"] ?? ""),
  }));
  const registryOptions = (registries.value ?? []).map((registry) => {
    const props = registry["properties"] as Bag | undefined;
    return {
      id: String(registry["id"] ?? ""),
      label: String(props?.["loginServer"] ?? registry["name"] ?? ""),
      description:
        props?.["adminUserEnabled"] === true ? "Admin user enabled" : "Admin user disabled",
    };
  });

  return {
    fields: [
      {
        key: "name",
        label: "App Name",
        kind: "text",
        required: true,
        description: "2-32 lowercase letters, numbers and hyphens",
      },
      {
        key: "resourceGroup",
        label: "Resource Group",
        kind: "select",
        required: true,
        options: rgOptions,
      },
      {
        key: "environmentId",
        label: "Container Apps Environment",
        kind: "select",
        required: true,
        options: envOptions,
        description:
          envOptions.length > 0
            ? "The app is created in the environment's region and network"
            : "No Container Apps environments found in this subscription: create one in the Azure portal first",
      },
      {
        key: "image",
        label: "Container Image",
        kind: "text",
        required: true,
        defaultValue: "mcr.microsoft.com/k8se/quickstart:latest",
        description: "Image reference, e.g. myregistry.azurecr.io/api:1.0",
      },
      {
        key: "registryId",
        label: "Azure Container Registry",
        kind: "select",
        required: false,
        options: registryOptions,
        description:
          "Registry to authenticate against for a private image. Needs the registry's admin user enabled",
      },
      {
        key: "size",
        label: "CPU and Memory",
        kind: "select",
        required: true,
        defaultValue: "0.5|1Gi",
        options: CONTAINER_APP_SIZES.map(({ cpu, memory }) => ({
          id: `${cpu}|${memory}`,
          label: `${cpu} vCPU, ${memory.replace("Gi", " GiB")}`,
        })),
      },
      {
        key: "ingress",
        label: "Ingress",
        kind: "select",
        required: true,
        defaultValue: "external",
        options: [
          { id: "external", label: "External", description: "Reachable from the internet" },
          { id: "internal", label: "Internal", description: "Only inside the environment" },
          { id: "none", label: "None", description: "Background worker, no HTTP endpoint" },
        ],
      },
      {
        key: "targetPort",
        label: "Target Port",
        kind: "number",
        required: false,
        defaultValue: "80",
        description: "Port the container listens on",
        showWhen: { fieldKey: "ingress", fieldValuesNot: ["none"] },
      },
      {
        key: "minReplicas",
        label: "Min Replicas",
        kind: "number",
        required: false,
        defaultValue: "0",
        description: "0 lets the app scale to zero when idle",
      },
      {
        key: "maxReplicas",
        label: "Max Replicas",
        kind: "number",
        required: false,
        defaultValue: "10",
      },
    ],
  };
}

/** `registryId` ARM id → `registries[]` entry plus the secret holding its password. */
async function registryAuth(
  ctx: AzureCreateContext,
  registryId: string,
): Promise<{ registries: Bag[]; secrets: Bag[] }> {
  const registry = await ctx.get<Bag>(`${ARM}${registryId}?api-version=2023-07-01`);
  const loginServer = String((registry["properties"] as Bag | undefined)?.["loginServer"] ?? "");
  const creds = await ctx.post<{ username?: string; passwords?: Array<{ value?: string }> }>(
    `${ARM}${registryId}/listCredentials?api-version=2023-07-01`,
    {},
  );
  const password = creds.passwords?.[0]?.value ?? "";
  if (!creds.username || !password) {
    throw new Error(
      `The admin user is disabled on registry "${loginServer}", so the app cannot pull from it with credentials. ` +
        `Enable the admin user on the registry, or leave the registry empty and grant the app's managed identity AcrPull.`,
    );
  }
  // Secret names: lowercase alphanumerics and hyphens.
  const secretName = `acr-${loginServer
    .split(".")[0]!
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")}`;
  return {
    registries: [{ server: loginServer, username: creds.username, passwordSecretRef: secretName }],
    secrets: [{ name: secretName, value: password }],
  };
}

export async function createContainerApp(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const name = fields["name"]!;
  const rg = fields["resourceGroup"]!;
  const environmentId = fields["environmentId"]!;
  const image = fields["image"]!;
  const [cpuText, memory] = (fields["size"] || "0.5|1Gi").split("|");
  const cpu = Number(cpuText);
  const ingressMode = fields["ingress"] || "external";
  const targetPort = Number(fields["targetPort"] || "80");
  const minReplicas = Number(fields["minReplicas"] || "0");
  const maxReplicas = Number(fields["maxReplicas"] || "10");

  // The app has to live in its environment's region.
  const environment = await ctx.get<Bag>(`${ARM}${environmentId}?api-version=${API}`);
  const location = String(environment["location"] ?? "");
  const auth = fields["registryId"]
    ? await registryAuth(ctx, fields["registryId"])
    : { registries: [], secrets: [] };

  const result = await ctx.put<Bag>(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${name}?api-version=${API}`,
    {
      location,
      properties: {
        environmentId,
        configuration: {
          activeRevisionsMode: "Single",
          ...(ingressMode === "none"
            ? {}
            : {
                ingress: {
                  external: ingressMode === "external",
                  targetPort,
                  transport: "auto",
                },
              }),
          ...(auth.registries.length > 0 ? { registries: auth.registries } : {}),
          ...(auth.secrets.length > 0 ? { secrets: auth.secrets } : {}),
        },
        template: {
          containers: [{ name, image, resources: { cpu, memory } }],
          scale: { minReplicas, maxReplicas },
        },
      },
    },
  );
  const props = result["properties"] as Bag | undefined;
  const ingress = (props?.["configuration"] as Bag | undefined)?.["ingress"] as Bag | undefined;
  const fqdn = String(ingress?.["fqdn"] ?? "");
  const now = new Date().toISOString();
  return {
    id: ctx.makeId(accountId, "azure-container-app", `${rg}/${name}`),
    pluginId: "azure",
    resourceTypeId: "azure-container-app",
    accountId,
    displayName: name,
    fields: {
      name,
      resourceGroup: rg,
      location,
      environment: environmentId.split("/").pop() ?? "",
      provisioningState: String(props?.["provisioningState"] ?? "InProgress"),
      runningStatus: String(props?.["runningStatus"] ?? ""),
      image,
      cpu,
      memory: memory ?? "",
      minReplicas,
      maxReplicas,
      ingress:
        ingressMode === "none" ? "Disabled" : ingressMode === "external" ? "External" : "Internal",
      targetPort: ingressMode === "none" ? 0 : targetPort,
      activeRevisionsMode: "Single",
      containerCount: 1,
    },
    resolvedOutputs: {
      fqdn,
      url: fqdn ? `https://${fqdn}` : "",
      resourceId: String(result["id"] ?? ""),
    },
    secretStates: [],
    externalId: `${rg}/${name}`,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Edit a container app: image, CPU/memory of the first container, and the
 * replica bounds. All of them live in `properties.template`, and the PATCH is
 * a JSON merge patch, which replaces arrays wholesale: so the current template
 * is read back and only the changed values are swapped in, keeping every other
 * container, probe, volume and scale rule. Azure rolls the change out as a
 * new revision.
 */
export async function updateContainerApp(
  ctx: AzureHttpContext,
  resource: ResourceInstance,
  fields: Record<string, string>,
): Promise<void> {
  const [rg, name] = String(resource.externalId ?? "").split("/");
  if (!rg || !name) throw new Error("Cannot determine resource group/name for container app");
  const url = `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${name}?api-version=${API}`;
  const current = await ctx.get<Bag>(url);
  const template = structuredClone(
    ((current["properties"] as Bag | undefined)?.["template"] as Bag | undefined) ?? {},
  );
  const containers = (template["containers"] as Bag[] | undefined) ?? [];
  const first = containers[0];
  if (!first) throw new Error(`Container app "${name}" has no containers to edit`);

  if (fields["image"]) first["image"] = fields["image"];
  if (fields["cpu"] || fields["memory"]) {
    const resources = { ...((first["resources"] as Bag | undefined) ?? {}) };
    if (fields["cpu"]) resources["cpu"] = Number(fields["cpu"]);
    if (fields["memory"]) resources["memory"] = fields["memory"];
    first["resources"] = resources;
  }
  if (fields["minReplicas"] !== undefined || fields["maxReplicas"] !== undefined) {
    const scale = { ...((template["scale"] as Bag | undefined) ?? {}) };
    if (fields["minReplicas"] !== undefined && fields["minReplicas"] !== "") {
      scale["minReplicas"] = Number(fields["minReplicas"]);
    }
    if (fields["maxReplicas"] !== undefined && fields["maxReplicas"] !== "") {
      scale["maxReplicas"] = Number(fields["maxReplicas"]);
    }
    const min = Number(scale["minReplicas"] ?? 0);
    const max = Number(scale["maxReplicas"] ?? 10);
    if (min > max) throw new Error("Min replicas cannot exceed max replicas");
    template["scale"] = scale;
  }
  template["containers"] = containers;
  await ctx.patch(url, { properties: { template } });
}
