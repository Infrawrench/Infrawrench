import type {
  CreateFieldConfig,
  CreateResourceConfig,
  RegionOption,
  SelectOption,
} from "@infrawrench/plugin-base";
import type { RunpodClient } from "./client.js";
import type { RpCpuType, RpDataCenter, RpGpuType, RpTemplate } from "./types.js";

/**
 * Live create forms. Every id a user would otherwise have to know (GPU type,
 * data center, template, network volume, registry credential) is a picker
 * filled from the API, with price and stock where Runpod reports them.
 */

const NONE = "none";
const ANY = "any";

/** Runpod's CPU flavors, for when the catalog cannot be read. */
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
    g.memory ? `${g.memory} GB VRAM` : undefined,
    money(g.price?.secure) ? `Secure ${money(g.price?.secure)}` : undefined,
    money(g.price?.community) ? `Community ${money(g.price?.community)}` : undefined,
    g.availability ? `Stock: ${g.availability}` : undefined,
  ].filter(Boolean);
  return {
    id: g.id,
    label: g.name && g.name !== g.id ? `${g.name} (${g.id})` : g.id,
    ...(parts.length ? { description: parts.join(" · ") } : {}),
  };
}

function stockRank(availability: string | undefined): number {
  const stock = (availability ?? "").toLowerCase();
  return stock === "high" ? 0 : stock === "medium" ? 1 : stock === "low" ? 2 : 3;
}

/** Sort GPU types: in stock first, then by secure price. */
export function sortGpuTypes(types: RpGpuType[]): RpGpuType[] {
  return [...types].sort(
    (a, b) =>
      stockRank(a.availability) - stockRank(b.availability) ||
      (a.price?.secure ?? a.price?.community ?? 999) -
        (b.price?.secure ?? b.price?.community ?? 999),
  );
}

/**
 * Serverless workers are placed by pool rather than by GPU type, so each pool is one
 * option naming the cards in it. Best stock first, then cheapest.
 */
export function poolOptions(types: RpGpuType[]): SelectOption[] {
  const pools = new Map<string, RpGpuType[]>();
  for (const g of types) {
    if (!g.pool) continue;
    pools.set(g.pool, [...(pools.get(g.pool) ?? []), g]);
  }
  const rank = (cards: RpGpuType[]) => Math.min(...cards.map((g) => stockRank(g.availability)));
  const price = (cards: RpGpuType[]) => cards[0]?.price?.serverless ?? 999;
  return [...pools.entries()]
    .sort(([, a], [, b]) => rank(a) - rank(b) || price(a) - price(b))
    .map(([pool, cards]) => {
      const best = [...cards].sort(
        (a, b) => stockRank(a.availability) - stockRank(b.availability),
      )[0];
      const parts = [
        cards[0]?.memory ? `${cards[0].memory} GB VRAM` : undefined,
        money(cards[0]?.price?.serverless)
          ? `${money(cards[0]?.price?.serverless)} per GPU`
          : undefined,
        best?.availability ? `Stock: ${best.availability}` : undefined,
      ].filter(Boolean);
      return {
        id: pool,
        label: `${cards.map((g) => g.name || g.id).join(", ")} (${pool})`,
        ...(parts.length ? { description: parts.join(" · ") } : {}),
      };
    });
}

export function cpuOption(c: RpCpuType): SelectOption {
  return {
    id: c.id,
    label: c.group ? `${c.name} (${c.group})` : c.name,
    description: `${c.id}, ${c.ramGbPerVcpu} GB RAM per vCPU`,
  };
}

/**
 * `toOption` turns a GPU type id into what the form's filter field holds: the id
 * itself on a pod, the type's pool on an endpoint.
 */
export function regionOption(
  dc: RpDataCenter,
  toOption: (gpuTypeId: string) => string | null | undefined = (id) => id,
): RegionOption {
  const available = (dc.gpuAvailability ?? [])
    .filter((g) => g.availability !== "NONE")
    .map((g) => toOption(g.id))
    .filter((id): id is string => !!id);
  return {
    id: dc.id,
    label: dc.id,
    ...(dc.name ? { location: dc.name } : {}),
    // Only narrow when Runpod reported availability; an empty list would hide the DC.
    ...(available.length ? { availableFor: [...new Set(available)] } : {}),
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

function templateOptions(
  templates: Array<RpTemplate & { official?: boolean }>,
  serverless: boolean,
): SelectOption[] {
  return templates
    .filter((t) => (t.serverless ?? false) === serverless)
    .map((t) => ({
      id: t.id,
      label: t.name || t.id,
      description: [t.official ? "Runpod official" : undefined, t.image]
        .filter(Boolean)
        .join(" · "),
    }));
}

const VCPU_DESCRIPTION = "A power of two, and valid for the flavor";

export async function buildCreateConfig(
  client: RunpodClient,
  typeId: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "pod": {
      const [gpus, cpus, dcs, templates, volumes, auths] = await Promise.all([
        client.gpuTypes().catch(() => []),
        client.cpuTypes().catch(() => []),
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
          select("cpuFlavorId", "CPU Flavor", cpus.length ? cpus.map(cpuOption) : CPU_FLAVORS, {
            showWhen: { fieldKey: "computeType", fieldValue: "CPU" },
          }),
          num("vcpuCount", "vCPUs", 2, {
            minValue: 2,
            description: VCPU_DESCRIPTION,
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
          {
            key: "dataCenterId",
            label: "Data Center",
            kind: "region-picker",
            required: false,
            description: "Leave on Any to let Runpod place the pod wherever the GPU is free",
            regions: [
              { id: ANY, label: "Any", location: "Wherever capacity is available" },
              ...dcs.map((d) => regionOption(d)),
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
            description:
              "Persistent across restarts. At least 10 GB, or 0 for none, in which case nothing survives a restart. Not used with a network volume",
            showWhen: { fieldKey: "computeType", fieldValue: "GPU" },
          }),
          text("volumeMountPath", "Volume Mount Path", {
            defaultValue: "/workspace",
            description: "Where the pod volume or network volume is mounted",
          }),
          text("ports", "Exposed Ports", {
            required: false,
            defaultValue: PORTS_DEFAULT,
            description:
              "Comma-separated port/protocol pairs. Runpod exposes nothing by default; 22/tcp enables direct SSH",
          }),
          select(
            "networkVolumeId",
            "Network Volume",
            [
              { id: NONE, label: "None" },
              ...volumes.map((v) => ({
                id: v.id,
                label: v.name || v.id,
                description: `${v.size ?? 0} GB in ${v.dataCenter ?? "?"} (the pod is placed there)`,
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
            description:
              "Used as PUBLIC_KEY instead of the keys in your Runpod account settings. Leave empty to use those",
          },
          ENV_FIELD,
        ],
      };
    }
    case "serverless-endpoint": {
      const [gpus, cpus, dcs, templates, volumes] = await Promise.all([
        client.serverlessGpuTypes().catch(() => []),
        client.cpuTypes().catch(() => []),
        client.dataCenters().catch(() => []),
        client.listRaw.templates().catch(() => []),
        client.listRaw.networkVolumes().catch(() => []),
      ]);
      const poolOf = new Map(gpus.map((g) => [g.id, g.pool]));
      const serverlessCpus = cpus.filter((c) => (c.price?.serverlessPerVcpu ?? 0) > 0);
      return {
        fields: [
          text("name", "Name"),
          select(
            "templateId",
            "Serverless Template",
            [{ id: NONE, label: "No template" }, ...templateOptions(templates, true)],
            {
              required: false,
              description: "Copied when the endpoint is created; later edits to it do not apply",
            },
          ),
          text("imageName", "Container Image", {
            required: false,
            placeholder: "ghcr.io/acme/worker:latest",
            description: "Required unless a template is chosen",
          }),
          select("endpointType", "Routing", [
            { id: "QUEUE", label: "Queue", description: "Submit jobs through Runpod's queue" },
            {
              id: "LOAD_BALANCER",
              label: "Load balancer",
              description: "Send requests straight to paths your workers define",
            },
          ]),
          select("computeType", "Compute", [
            { id: "GPU", label: "GPU workers" },
            { id: "CPU", label: "CPU workers" },
          ]),
          select("gpuPool", "GPU Pool", poolOptions(sortGpuTypes(gpus)), {
            showWhen: { fieldKey: "computeType", fieldValue: "GPU" },
            description: "Workers run on whichever card in the pool has capacity",
          }),
          num("gpuCount", "GPUs per Worker", 1, {
            minValue: 1,
            maxValue: 8,
            showWhen: { fieldKey: "computeType", fieldValue: "GPU" },
          }),
          select(
            "cpuFlavorId",
            "CPU Flavor",
            serverlessCpus.length
              ? serverlessCpus.map(cpuOption)
              : CPU_FLAVORS.filter((c) => !c.id.endsWith("m")),
            {
              showWhen: { fieldKey: "computeType", fieldValue: "CPU" },
            },
          ),
          num("vcpuCount", "vCPUs per Worker", 2, {
            minValue: 2,
            description: VCPU_DESCRIPTION,
            showWhen: { fieldKey: "computeType", fieldValue: "CPU" },
          }),
          num("workersMin", "Active Workers (min)", 0, {
            description: "Always-on workers bill continuously; 0 scales to zero",
          }),
          num("workersMax", "Max Workers", 3, { minValue: 1 }),
          select("scalerType", "Scaling", [
            {
              id: "QUEUE_DELAY",
              label: "Queue delay",
              description: "Add workers when jobs wait too long. Queue routing only",
            },
            {
              id: "REQUEST_COUNT",
              label: "Request count",
              description: "Add workers by requests per worker. Required for a load balancer",
            },
          ]),
          num("scalerValue", "Scaling Threshold", 4, {
            minValue: 0.5,
            description: "Seconds in queue, or requests per worker",
          }),
          num("idleTimeout", "Idle Timeout (s)", 5, {
            minValue: 1,
            maxValue: 3600,
            description: "Not used by a queue endpoint scaling on request count",
          }),
          num("executionTimeoutMs", "Execution Timeout (ms)", 300000, {
            minValue: 1,
            description: "How long one request may run before it fails",
          }),
          select("flashboot", "FlashBoot", [
            { id: "FLASHBOOT", label: "On", description: "Faster cold starts" },
            {
              id: "PRIORITY_FLASHBOOT",
              label: "On, with priority capacity",
              description: "Faster cold starts on priority capacity",
            },
            { id: "OFF", label: "Off" },
          ]),
          {
            key: "dataCenterId",
            label: "Data Center",
            kind: "region-picker",
            required: false,
            regions: [
              { id: ANY, label: "Any", location: "Every data center with capacity" },
              ...dcs.map((d) => regionOption(d, (id) => poolOf.get(id))),
            ],
            defaultValue: ANY,
            filterByFieldKey: "gpuPool",
          },
          select(
            "networkVolumeId",
            "Network Volume",
            [
              { id: NONE, label: "None" },
              ...volumes.map((v) => ({
                id: v.id,
                label: v.name || v.id,
                description: `${v.size ?? 0} GB in ${v.dataCenter ?? "?"}`,
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
          num("volumeInGb", "Volume (GB)", 20, {
            description: "At least 10 GB, or 0 for none",
            showWhen: { fieldKey: "isServerless", fieldValue: "false" },
          }),
          text("volumeMountPath", "Volume Mount Path", {
            defaultValue: "/workspace",
            showWhen: { fieldKey: "isServerless", fieldValue: "false" },
          }),
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
              .filter((d) => (d.networkVolumeTypes ?? []).length > 0)
              .map((d) => ({
                id: d.id,
                label: d.id,
                ...(d.name ? { location: d.name } : {}),
              })),
          },
          num("size", "Size (GB)", 50, {
            minValue: 10,
            maxValue: 4096,
            description: "Can be grown later, never shrunk",
          }),
          select("storageType", "Storage Tier", [
            { id: "default", label: "Data center default" },
            { id: "STANDARD", label: "Standard" },
            { id: "HIGH_PERFORMANCE", label: "High performance" },
          ]),
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
