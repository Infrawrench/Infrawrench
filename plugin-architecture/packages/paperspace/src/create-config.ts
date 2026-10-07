import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  RegionOption,
  SelectOption,
} from "@infrawrench/plugin-base";
import type { PaperspaceClient } from "./client.js";
import type { POsTemplate } from "./types.js";

/**
 * Live create forms. Machine types come from what the OS and custom
 * templates say they run on; templates, networks, startup scripts and
 * machines are pickers.
 */

export const NONE = "none";

/** The regions the API's `region` enum names (2026-10). */
export const REGIONS: RegionOption[] = [
  { id: "ny2", label: "NY2", location: "New York, USA" },
  { id: "ca1", label: "CA1", location: "Santa Clara, USA" },
  { id: "ams1", label: "AMS1", location: "Amsterdam, Netherlands" },
];

/** Disk sizes the API accepts, in GB. */
export const DISK_SIZES = [50, 100, 250, 500, 1000, 2000, 4000, 8000, 12000, 16000];

export function imageOption(t: POsTemplate, custom: boolean): ImageOption {
  return {
    id: t.id,
    label: t.name || t.id,
    ...(t.operatingSystemLabel ? { description: t.operatingSystemLabel } : {}),
    family: (t.operatingSystemLabel || t.name || "").toLowerCase().split(/\s+/)[0] ?? "",
    category: custom ? "My Templates" : t.agentType === "WindowsDesktop" ? "Windows" : "Linux",
    ...(custom ? { isOwned: true } : {}),
  };
}

/** Machine types any template can run on, each described with the templates it supports. */
export function machineTypeOptions(templates: POsTemplate[]): SelectOption[] {
  const types = new Map<string, number>();
  for (const t of templates) {
    for (const m of t.availableMachineTypes ?? []) {
      if (m.isAvailable === false) continue;
      types.set(m.machineTypeLabel, (types.get(m.machineTypeLabel) ?? 0) + 1);
    }
  }
  return [...types.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([id, n]) => ({ id, label: id, description: `${n} template${n === 1 ? "" : "s"}` }));
}

function text(
  key: string,
  label: string,
  opts: Partial<CreateFieldConfig> = {},
): CreateFieldConfig {
  return { key, label, kind: "text", required: true, ...opts };
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

const YES_NO: SelectOption[] = [
  { id: "true", label: "Yes" },
  { id: "false", label: "No" },
];

export async function buildCreateConfig(
  client: PaperspaceClient,
  typeId: string,
): Promise<CreateResourceConfig> {
  const region: CreateFieldConfig = {
    key: "region",
    label: "Region",
    kind: "region-picker",
    required: true,
    regions: REGIONS,
  };
  switch (typeId) {
    case "project":
      return { fields: [text("name", "Name")] };
    case "machine": {
      const [os, custom, networks, scripts] = await Promise.all([
        client.raw.osTemplates().catch(() => []),
        client.raw.customTemplates().catch(() => []),
        client.raw.networks().catch(() => []),
        client.raw.startupScripts().catch(() => []),
      ]);
      return {
        fields: [
          text("name", "Name"),
          region,
          {
            key: "templateId",
            label: "Template",
            kind: "image-picker",
            required: true,
            images: [
              ...custom.map((t) => imageOption(t, true)),
              ...os.map((t) => imageOption(t, false)),
            ],
          },
          select("machineType", "Machine Type", machineTypeOptions([...os, ...custom]), {
            description: "The template must support it; Paperspace also checks regional capacity",
          }),
          select(
            "diskSize",
            "Disk (GB)",
            DISK_SIZES.map((s) => ({
              id: String(s),
              label: s >= 1000 ? `${s / 1000} TB` : `${s} GB`,
            })),
            { defaultValue: "100" },
          ),
          select("publicIpType", "Public IP", [
            { id: "dynamic", label: "Dynamic", description: "Changes when the machine restarts" },
            {
              id: "static",
              label: "Static",
              description: "Claimed for this machine; billed monthly",
            },
            { id: "none", label: "None" },
          ]),
          select(
            "networkId",
            "Private Network",
            [
              { id: NONE, label: "Default network" },
              ...networks.map((n) => ({
                id: n.id,
                label: n.name || n.id,
                description: `${n.region ?? "?"}: must match the machine's region`,
              })),
            ],
            { required: false },
          ),
          select(
            "startupScriptId",
            "Startup Script",
            [
              { id: NONE, label: "None" },
              ...scripts.map((s) => ({ id: s.id, label: s.name || s.id })),
            ],
            { required: false },
          ),
          select("autoShutdownEnabled", "Auto Shutdown", YES_NO),
          {
            key: "autoShutdownTimeout",
            label: "Auto Shutdown After (hours)",
            kind: "number",
            required: false,
            defaultValue: "8",
            minValue: 1,
            showWhen: { fieldKey: "autoShutdownEnabled", fieldValue: "true" },
          },
          select("startOnCreate", "Start After Creating", YES_NO),
        ],
      };
    }
    case "shared-drive": {
      const networks = await client.raw.networks().catch(() => []);
      return {
        fields: [
          text("name", "Name"),
          select(
            "networkId",
            "Private Network",
            networks.map((n) => ({ id: n.id, label: n.name || n.id, description: n.region ?? "" })),
            {
              description:
                "Shared drives live on a private network; create one first if this is empty",
            },
          ),
          select(
            "size",
            "Size",
            [100, 250, 500, 1000, 2000, 5000, 10000].map((s) => ({
              id: String(s),
              label: s >= 1000 ? `${s / 1000} TB` : `${s} GB`,
            })),
          ),
        ],
      };
    }
    case "snapshot":
    case "custom-template": {
      const machines = await client.raw.machines().catch(() => []);
      return {
        fields: [
          select(
            "machineId",
            "Machine",
            machines.map((m) => ({
              id: m.id,
              label: m.name || m.id,
              description: `${m.machineType ?? ""} · ${m.region ?? ""}`,
            })),
            typeId === "custom-template"
              ? { description: "Paperspace needs the machine to be off to make a template" }
              : {},
          ),
          text("name", "Name"),
        ],
      };
    }
    case "private-network":
      return {
        fields: [
          text("name", "Name"),
          region,
          select("migrateMachines", "Move Existing Machines Into It", [
            { id: "false", label: "No" },
            {
              id: "true",
              label: "Yes",
              description: "Every machine in the region not on a private network",
            },
          ]),
        ],
      };
    case "public-ip":
      return { fields: [region] };
    case "startup-script":
      return {
        fields: [
          text("name", "Name"),
          text("script", "Script", { multiline: true, placeholder: "#!/bin/bash\napt-get update" }),
          select("runOnce", "Run", [
            { id: "false", label: "On every boot" },
            { id: "true", label: "Only on first boot" },
          ]),
        ],
      };
    case "container-registry":
      return {
        fields: [
          text("name", "Name"),
          select("kind", "Registry", [
            { id: "dockerhub", label: "Docker Hub" },
            { id: "ghcr", label: "GitHub Container Registry" },
            { id: "gcr", label: "Google Container Registry" },
            { id: "digitalocean", label: "DigitalOcean Container Registry" },
            { id: "azure", label: "Azure Container Registry" },
            { id: "other", label: "Other" },
          ]),
          text("url", "URL", { placeholder: "https://index.docker.io/v1/" }),
          text("namespace", "Namespace", { placeholder: "my-org" }),
          text("username", "Username"),
          { key: "password", label: "Password or Token", kind: "password", required: true },
        ],
      };
    default:
      throw new Error(`Paperspace plugin: "${typeId}" cannot be created`);
  }
}
