import type {
  CreateFieldConfig,
  CreateResourceConfig,
  RegionOption,
  SelectOption,
} from "@infrawrench/plugin-base";
import type { RunpodClient } from "./client.js";
import type { RpDataCenter, RpGpuType, RpTemplate } from "./types.js";

/**
 * Live create forms. Every id a user would otherwise have to know (GPU type,
 * data center, template, network volume, registry credential) is a picker
 * filled from the API, with price and stock where Runpod reports them.
 */

const NONE = "none";
const ANY = "any";

/** Runpod's CPU flavors, from the REST spec's `cpuFlavorIds` enum (2026-10). */
export const CPU_FLAVORS: SelectOption[] = [
  { id: "cpu3c", label: "Compute-optimized (3rd gen)", description: "cpu3c, 2 GB RAM per vCPU" },
  { id: "cpu3g", label: "General purpose (3rd gen)", description: "cpu3g, 4 GB RAM per vCPU" },
  { id: "cpu3m", label: "Memory-optimized (3rd gen)", description: "cpu3m, 8 GB RAM per vCPU" },
  { id: "cpu5c", label: "Compute-optimized (5th gen)", description: "cpu5c, 2 GB RAM per vCPU" },
  { id: "cpu5g", label: "General purpose (5th gen)", description: "cpu5g, 4 GB RAM per vCPU" },
  { id: "cpu5m", label: "Memory-optimized (5th gen)", description: "cpu5m, 8 GB RAM per vCPU" },
];

function money(v: number | null | undefined): string | undefined {
  return typeof v === "number" && v > 0 ? `$${v.toFixed(2)}/hr` : undefined;
}

export function gpuOption(g: RpGpuType): SelectOption {
  const parts = [
    g.memoryInGb ? `${g.memoryInGb} GB VRAM` : undefined,
    money(g.securePrice) ? `Secure ${money(g.securePrice)}` : undefined,
    money(g.communityPrice) ? `Community ${money(g.communityPrice)}` : undefined,
    money(g.communitySpotPrice ?? g.secureSpotPrice)
      ? `Spot from ${money(g.communitySpotPrice ?? g.secureSpotPrice)}`
      : undefined,
    g.lowestPrice?.stockStatus ? `Stock: ${g.lowestPrice.stockStatus}` : undefined,
  ].filter(Boolean);
  return {
    id: g.id,
    label: g.displayName && g.displayName !== g.id ? `${g.displayName} (${g.id})` : g.id,
    ...(parts.length ? { description: parts.join(" · ") } : {}),
  };
}

/** Sort GPU types: in stock first, then by secure price. */
export function sortGpuTypes(types: RpGpuType[]): RpGpuType[] {
  const rank = (g: RpGpuType) => {
    const s = (g.lowestPrice?.stockStatus ?? "").toLowerCase();
    return s === "high" ? 0 : s === "medium" ? 1 : s === "low" ? 2 : 3;
  };
  return [...types].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.securePrice ?? a.communityPrice ?? 999) - (b.securePrice ?? b.communityPrice ?? 999),
  );
}

export function regionOption(dc: RpDataCenter): RegionOption {
  const available = (dc.gpuAvailability ?? [])
    .filter((g) => g.available && g.gpuTypeId)
    .map((g) => g.gpuTypeId!);
  return {
    id: dc.id,
    label: dc.id,
    ...(dc.location ? { location: dc.location } : {}),
    // Only narrow when Runpod reported availability; an empty list would hide the DC.
    ...(available.length ? { availableFor: available } : {}),
  };
}

function text(
  key: string,
  label: string,
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return { key, label, kind: "text", required: true, ...opts };
}

function num(
  key: string,
  label: string,
  defaultValue: number,
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return {
    key,
    label,
    kind: "number",
    required: true,
    defaultValue: String(defaultValue),
    minValue: 0,
    ...opts,
  };
}

function select(
  key: string,
  label: string,
  options: SelectOption[],
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return {
    key,
    label,
    kind: "select",
    required: true,
    options,
    ...(options[0] ? { defaultValue: options[0].id } : {}),
    ...opts,
  };
}

const ENV_FIELD: CreateFieldConfig = {
  key: "env",
  label: "Environment Variables",
  kind: "text",
  required: false,
  multiline: true,
  placeholder: "KEY=value\nOTHER_KEY=value",
  description: "One KEY=value per line",
};

const PORTS_DEFAULT = "8888/http,22/tcp";

function templateOptions(templates: RpTemplate[], serverless: boolean): SelectOption[] {
  return templates
    .filter((t) => (t.isServerless ?? false) === serverless)
    .map((t) => ({
      id: t.id,
      label: t.name || t.id,
      description: [t.isRunpod ? "Runpod official" : undefined, t.imageName]
        .filter(Boolean)
        .join(" · "),
    }));
}

export async function buildCreateConfig(
  client: RunpodClient,
  typeId: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "pod": {
      const [gpus, dcs, templates, volumes, auths] = await Promise.all([
        client.gpuTypes().catch(() => []),
        client.dataCenters().catch(() => []),
        client.templatesForPicker().catch(() => []),
        client.listRaw.networkVolumes().catch(() => []),
        client.listRaw.registryAuths().catch(() => []),
      ]);
      const gpuOptions = sortGpuTypes(gpus).map(gpuOption);
      return {
        fields: [
          text("name", "Name", { placeholder: "my-pod" }),
          select("computeType", "Compute", [
            { id: "GPU", label: "GPU pod" },
            { id: "CPU", label: "CPU pod" },
          ]),
          select("gpuTypeId", "GPU Type", gpuOptions, {
            showWhen: { fieldKey: "computeType", fieldValue: "GPU" },
            description: "Hourly list prices per GPU; stock is Runpod's current availability",
          }),
          num("gpuCount", "GPUs", 1, {
            minValue: 1,
            maxValue: 8,
            showWhen: { fieldKey: "computeType", fieldValue: "GPU" },
          }),
          select("cpuFlavorId", "CPU Flavor", CPU_FLAVORS, {
            showWhen: { fieldKey: "computeType", fieldValue: "CPU" },
          }),
          num("vcpuCount", "vCPUs", 2, {
            minValue: 2,
            showWhen: { fieldKey: "computeType", fieldValue: "CPU" },
          }),
          select("cloudType", "Cloud", [
            {
              id: "SECURE",
              label: "Secure Cloud",
              description: "Runpod data centers, higher reliability",
            },
            { id: "COMMUNITY", label: "Community Cloud", description: "Vetted hosts, lower price" },
          ]),
          select("pricing", "Pricing", [
            { id: "on-demand", label: "On-demand" },
            {
              id: "spot",
              label: "Spot (interruptible)",
              description: "Cheaper, but Runpod can stop the pod at any time",
            },
          ]),
          {
            key: "dataCenterId",
            label: "Data Center",
            kind: "region-picker",
            required: false,
            description: "Leave on Any to let Runpod place the pod wherever the GPU is free",
            regions: [
              { id: ANY, label: "Any", location: "Wherever capacity is available" },
              ...dcs.filter((d) => d.listed !== false).map(regionOption),
            ],
            defaultValue: ANY,
            filterByFieldKey: "gpuTypeId",
          },
          select(
            "templateId",
            "Template",
            [{ id: NONE, label: "No template" }, ...templateOptions(templates, false)],
            { required: false },
          ),
          text("imageName", "Container Image", {
            required: false,
            placeholder: "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04",
            description: "Required unless a template is chosen",
          }),
          num("containerDiskInGb", "Container Disk (GB)", 50, { minValue: 1 }),
          num("volumeInGb", "Pod Volume (GB)", 20, {
            description: "Persistent across restarts. Set 0 when mounting a network volume",
          }),
          text("volumeMountPath", "Volume Mount Path", { defaultValue: "/workspace" }),
          text("ports", "Exposed Ports", {
            required: false,
            defaultValue: PORTS_DEFAULT,
            description: "Comma-separated port/protocol pairs; 22/tcp enables direct SSH",
          }),
          select(
            "networkVolumeId",
            "Network Volume",
            [
              { id: NONE, label: "None" },
              ...volumes.map((v) => ({
                id: v.id,
                label: v.name || v.id,
                description: `${v.size ?? 0} GB in ${v.dataCenterId ?? "?"} (the pod is placed there)`,
              })),
            ],
            { required: false },
          ),
          select(
            "containerRegistryAuthId",
            "Registry Credentials",
            [
              { id: NONE, label: "None (public image)" },
              ...auths.map((a) => ({ id: a.id, label: a.name || a.id })),
            ],
            { required: false },
          ),
          {
            key: "sshPublicKey",
            label: "SSH Public Key",
            kind: "ssh-key-picker",
            required: false,
            description: "Added as PUBLIC_KEY on top of the keys in your Runpod account settings",
          },
          ENV_FIELD,
        ],
      };
    }
    case "serverless-endpoint": {
      const [gpus, dcs, templates, volumes] = await Promise.all([
        client.gpuTypes().catch(() => []),
        client.dataCenters().catch(() => []),
        client.listRaw.templates().catch(() => []),
        client.listRaw.networkVolumes().catch(() => []),
      ]);
      return {
        fields: [
          text("name", "Name"),
          select("templateId", "Serverless Template", templateOptions(templates, true), {
            description: "Create a Serverless template first if this list is empty",
          }),
          select("computeType", "Compute", [
            { id: "GPU", label: "GPU workers" },
            { id: "CPU", label: "CPU workers" },
          ]),
          select("gpuTypeId", "GPU Type", sortGpuTypes(gpus).map(gpuOption), {
            showWhen: { fieldKey: "computeType", fieldValue: "GPU" },
          }),
          num("gpuCount", "GPUs per Worker", 1, {
            minValue: 1,
            maxValue: 8,
            showWhen: { fieldKey: "computeType", fieldValue: "GPU" },
          }),
          select(
            "cpuFlavorId",
            "CPU Flavor",
            CPU_FLAVORS.filter((c) => !c.id.endsWith("m")),
            {
              showWhen: { fieldKey: "computeType", fieldValue: "CPU" },
            },
          ),
          num("vcpuCount", "vCPUs per Worker", 2, {
            minValue: 1,
            showWhen: { fieldKey: "computeType", fieldValue: "CPU" },
          }),
          num("workersMin", "Active Workers (min)", 0, {
            description: "Always-on workers bill continuously; 0 scales to zero",
          }),
          num("workersMax", "Max Workers", 3, { minValue: 1 }),
          num("idleTimeout", "Idle Timeout (s)", 5, { minValue: 1 }),
          select("flashboot", "FlashBoot", [
            { id: "true", label: "On", description: "Faster cold starts" },
            { id: "false", label: "Off" },
          ]),
          {
            key: "dataCenterId",
            label: "Data Center",
            kind: "region-picker",
            required: false,
            regions: [
              { id: ANY, label: "Any", location: "Every data center with capacity" },
              ...dcs.filter((d) => d.listed !== false).map(regionOption),
            ],
            defaultValue: ANY,
            filterByFieldKey: "gpuTypeId",
          },
          select(
            "networkVolumeId",
            "Network Volume",
            [
              { id: NONE, label: "None" },
              ...volumes.map((v) => ({
                id: v.id,
                label: v.name || v.id,
                description: `${v.size ?? 0} GB in ${v.dataCenterId ?? "?"}`,
              })),
            ],
            { required: false },
          ),
        ],
      };
    }
    case "template": {
      const auths = await client.listRaw.registryAuths().catch(() => []);
      return {
        fields: [
          text("name", "Name", { description: "Must be unique in your account" }),
          text("imageName", "Container Image", { placeholder: "ghcr.io/acme/worker:latest" }),
          select("isServerless", "Used For", [
            { id: "false", label: "Pods" },
            { id: "true", label: "Serverless workers" },
          ]),
          select("category", "Category", [
            { id: "NVIDIA", label: "NVIDIA GPU" },
            { id: "AMD", label: "AMD GPU" },
            { id: "CPU", label: "CPU" },
          ]),
          num("containerDiskInGb", "Container Disk (GB)", 50, { minValue: 1 }),
          num("volumeInGb", "Volume (GB)", 20),
          text("volumeMountPath", "Volume Mount Path", { defaultValue: "/workspace" }),
          text("ports", "Exposed Ports", { required: false, defaultValue: PORTS_DEFAULT }),
          text("startCommand", "Start Command", {
            required: false,
            description: "Overrides the image CMD; leave empty to use the image's own",
          }),
          select(
            "containerRegistryAuthId",
            "Registry Credentials",
            [
              { id: NONE, label: "None (public image)" },
              ...auths.map((a) => ({ id: a.id, label: a.name || a.id })),
            ],
            { required: false },
          ),
          ENV_FIELD,
          text("readme", "Readme", { required: false, multiline: true }),
        ],
      };
    }
    case "network-volume": {
      const dcs = await client.dataCenters().catch(() => []);
      return {
        fields: [
          text("name", "Name"),
          {
            key: "dataCenterId",
            label: "Data Center",
            kind: "region-picker",
            required: true,
            description: "Only data centers that support network storage are listed",
            regions: dcs
              .filter((d) => d.storageSupport && d.listed !== false)
              .map((d) => ({
                id: d.id,
                label: d.id,
                ...(d.location ? { location: d.location } : {}),
              })),
          },
          num("size", "Size (GB)", 50, {
            minValue: 1,
            maxValue: 4000,
            description: "Can be grown later, never shrunk",
          }),
        ],
      };
    }
    case "container-registry-auth":
      return {
        fields: [
          text("name", "Name", { description: "Must be unique in your account" }),
          text("username", "Registry Username"),
          {
            key: "password",
            label: "Registry Password or Token",
            kind: "password",
            required: true,
          },
        ],
      };
    case "ssh-key":
      return {
        fields: [
          text("publicKey", "Public Key", {
            multiline: true,
            placeholder: "ssh-ed25519 AAAA… me@laptop",
          }),
          text("name", "Name", {
            required: false,
            description: "Stored as the key's comment when the key has none",
          }),
        ],
      };
    default:
      throw new Error(`Runpod plugin: "${typeId}" cannot be created`);
  }
}

export { ANY, NONE };
