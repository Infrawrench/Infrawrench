import type {
  CreateFieldConfig,
  CreateResourceConfig,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import type { VastClient } from "./client.js";
import type { VOffer, VTemplate, VVolumeOffer } from "./types.js";

/**
 * Live create forms. The instance form's machine picker is a live offer
 * search (verified, rentable hosts, best-scored first), grouped by GPU model
 * with each offer's price, location and reliability; templates, volumes,
 * endpoints and volume offers are pickers too.
 */

export const NONE = "none";
const HOURS_PER_MONTH = 730;

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

export function offerOption(o: VOffer): SizeOption {
  const gpus = o.num_gpus ?? 1;
  const where = o.geolocation ? ` · ${o.geolocation}` : "";
  const rel = o.reliability2 ?? o.reliability;
  return {
    id: String(o.id),
    label: `${gpus}x ${o.gpu_name ?? "GPU"}${where}${rel ? ` · ${round(rel * 100, 1)}% reliable` : ""} · $${(o.dph_total ?? 0).toFixed(3)}/hr`,
    vcpus: Math.round(o.cpu_cores_effective ?? 0),
    memoryMb: Math.round(o.cpu_ram ?? 0),
    ...(o.disk_space ? { diskGb: Math.round(o.disk_space) } : {}),
    ...(o.dph_total ? { priceMonthly: round(o.dph_total * HOURS_PER_MONTH) } : {}),
    category: o.gpu_name ?? "GPU",
  };
}

export function volumeOfferOption(o: VVolumeOffer): SelectOption {
  return {
    id: String(o.id),
    label: `${o.geolocation || "Unknown location"} · machine ${o.machine_id ?? "?"}`,
    description: [
      o.disk_space ? `${Math.round(o.disk_space)} GB free` : undefined,
      o.storage_cost ? `$${o.storage_cost.toFixed(2)}/GB-month` : undefined,
      o.reliability2 ? `${round(o.reliability2 * 100, 1)}% reliable` : undefined,
      o.disk_name?.trim(),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

function templateOptions(templates: VTemplate[]): SelectOption[] {
  return templates
    .filter((t) => t.hash_id)
    .map((t) => ({
      id: t.hash_id!,
      label: t.name || t.image || String(t.id),
      description: [t.recommended ? "Recommended by Vast" : "Yours", t.image]
        .filter(Boolean)
        .join(" · "),
    }));
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
  placeholder: "HF_TOKEN=hf_…\nMODEL_ID=meta-llama/Llama-3.1-8B",
  description: "One KEY=value per line",
};

const PORTS_FIELD: CreateFieldConfig = {
  key: "ports",
  label: "Open Ports",
  kind: "text",
  required: false,
  placeholder: "8000, 8080/udp",
  description: "Container ports to publish; the host maps each to a public port",
};

const RUNTYPES: SelectOption[] = [
  { id: "ssh_direct", label: "SSH (direct)", description: "SSH straight to the host's public IP" },
  {
    id: "ssh_proxy",
    label: "SSH (proxy)",
    description: "SSH through Vast's proxy; works on every host",
  },
  { id: "jupyter_direct", label: "Jupyter (direct)" },
  { id: "args", label: "Entrypoint only", description: "Run the image's own command, no SSH" },
];

export async function buildCreateConfig(
  client: VastClient,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "instance": {
      const [offers, templates, volumes] = await Promise.all([
        client.searchOffers().catch(() => [] as VOffer[]),
        client.templatesForPicker().catch(() => [] as VTemplate[]),
        client.raw.volumes().catch(() => []),
      ]);
      return {
        fields: [
          text("label", "Label", { required: false, placeholder: "my-training-job" }),
          {
            key: "offerId",
            label: "Machine Offer",
            kind: "size-picker",
            required: true,
            description:
              "Live offers from verified hosts, best first. Prices are per hour for the whole offer, including storage",
            sizes: offers.map(offerOption),
          },
          select("pricing", "Pricing", [
            { id: "on-demand", label: "On-demand", description: "Runs until you stop it" },
            {
              id: "interruptible",
              label: "Interruptible (bid)",
              description: "Cheaper, but a higher bid can pause it",
            },
          ]),
          num("bidPrice", "Bid ($/hr)", 0, {
            required: false,
            stepValue: 0.01,
            description: "Leave at 0 to bid the offer's minimum",
            showWhen: { fieldKey: "pricing", fieldValue: "interruptible" },
          }),
          select(
            "templateHash",
            "Template",
            [{ id: NONE, label: "No template" }, ...templateOptions(templates)],
            { required: false },
          ),
          text("image", "Image", {
            required: false,
            placeholder: "pytorch/pytorch:latest",
            description: "Required unless a template is chosen; overrides the template's image",
          }),
          num("disk", "Disk (GB)", 32, { minValue: 8 }),
          select("runtype", "Launch Mode", RUNTYPES),
          ENV_FIELD,
          PORTS_FIELD,
          text("onstart", "On-start Script", {
            required: false,
            multiline: true,
            description: "Runs when the container starts (at most 4048 characters)",
          }),
          select(
            "volumeId",
            "Volume",
            [
              { id: NONE, label: "None" },
              ...volumes.map((v) => ({
                id: String(v.id),
                label: v.label || `Volume ${v.id}`,
                description: `${Math.round(v.disk_space ?? 0)} GB on machine ${v.machine_id ?? "?"}: the offer must be on the same machine`,
              })),
            ],
            { required: false },
          ),
          text("volumeMountPath", "Volume Mount Path", {
            required: false,
            defaultValue: "/workspace",
            showWhen: { fieldKey: "volumeId", fieldValuesNot: [NONE] },
          }),
        ],
      };
    }
    case "template":
      return {
        fields: [
          text("name", "Name"),
          text("image", "Image", { placeholder: "vllm/vllm-openai" }),
          text("tag", "Tag", { required: false, defaultValue: "latest" }),
          text("description", "Description", { required: false }),
          select("runtype", "Launch Mode", RUNTYPES),
          num("diskGb", "Recommended Disk (GB)", 32, { minValue: 8 }),
          ENV_FIELD,
          PORTS_FIELD,
          text("onstart", "On-start Script", { required: false, multiline: true }),
          select("private", "Visibility", [
            { id: "true", label: "Private" },
            { id: "false", label: "Public", description: "Anyone on Vast can find and use it" },
          ]),
          text("readme", "Readme", { required: false, multiline: true }),
        ],
      };
    case "volume": {
      const offers = await client.searchVolumeOffers().catch(() => [] as VVolumeOffer[]);
      return {
        fields: [
          text("name", "Name", { required: false }),
          select("offerId", "Host", offers.map(volumeOfferOption), {
            description:
              "A local volume lives on one machine; instances that use it must run on that machine",
          }),
          num("size", "Size (GB)", 15, { minValue: 1 }),
        ],
      };
    }
    case "ssh-key":
      return {
        fields: [{ key: "publicKey", label: "Public Key", kind: "ssh-key-picker", required: true }],
      };
    case "serverless-endpoint":
      return {
        fields: [
          text("name", "Name"),
          num("maxWorkers", "Max Workers", 20, { minValue: 1 }),
          num("coldWorkers", "Cold Workers", 5),
          num("minLoad", "Minimum Load", 10, {
            description: "Perf units per second (tokens/s for LLMs)",
          }),
          num("targetUtil", "Target Utilization", 0.9, { stepValue: 0.05, maxValue: 1 }),
          num("coldMult", "Cold Capacity Multiplier", 2.5, { stepValue: 0.5 }),
        ],
      };
    case "workergroup": {
      const underEndpoint = parentResourceId?.includes(":serverless-endpoint:") === true;
      const [endpoints, templates] = await Promise.all([
        underEndpoint ? Promise.resolve([]) : client.raw.endpoints().catch(() => []),
        client.templatesForPicker().catch(() => [] as VTemplate[]),
      ]);
      const fields: CreateFieldConfig[] = [];
      if (!underEndpoint) {
        fields.push(
          select(
            "endpointId",
            "Endpoint",
            endpoints.map((e) => ({ id: String(e.id), label: e.endpoint_name || String(e.id) })),
          ),
        );
      }
      fields.push(
        select("templateHash", "Template", templateOptions(templates)),
        text("searchQuery", "Offer Filter", {
          required: false,
          placeholder: "gpu_name=RTX_4090 num_gpus=1 verified=true",
          description: "Vast search query for the machines workers run on",
        }),
        num("gpuRamGb", "Minimum VRAM (GB)", 24),
        num("testWorkers", "Test Workers", 3),
      );
      return { fields };
    }
    case "env-var":
      return {
        fields: [
          text("key", "Key", { placeholder: "HF_TOKEN", description: "Vast upper-cases it" }),
          { key: "value", label: "Value", kind: "password", required: true },
        ],
      };
    default:
      throw new Error(`Vast.ai plugin: "${typeId}" cannot be created`);
  }
}
