import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  RegionOption,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import type { LambdaCloudClient } from "./client.js";
import type { LImage, LInstanceTypeItem, LRegion } from "./types.js";

/**
 * Live create forms. Instance types come with price and live capacity, the
 * region list narrows to regions with capacity for the chosen type, and SSH
 * keys, images, filesystems and firewall rulesets are pickers.
 */

export const NONE = "none";
export const DEFAULT_IMAGE = "default";
const HOURS_PER_MONTH = 730;

export function sizeOption(item: LInstanceTypeItem): SizeOption {
  const t = item.instance_type;
  const specs = t.specs ?? {};
  const regions = item.regions_with_capacity_available ?? [];
  return {
    id: t.name,
    label: `${t.name}${regions.length ? "" : " (no capacity)"}`,
    vcpus: specs.vcpus ?? 0,
    memoryMb: (specs.memory_gib ?? 0) * 1024,
    ...(specs.storage_gib ? { diskGb: specs.storage_gib } : {}),
    ...(t.price_cents_per_hour
      ? { priceMonthly: Math.round((t.price_cents_per_hour / 100) * HOURS_PER_MONTH * 100) / 100 }
      : {}),
    category: t.gpu_description || t.description || "GPU",
  };
}

/** Regions, each tagged with the instance types that have capacity there. */
export function regionOptions(regions: LRegion[], types: LInstanceTypeItem[]): RegionOption[] {
  const byRegion = new Map<string, string[]>();
  for (const item of types) {
    for (const r of item.regions_with_capacity_available ?? []) {
      const list = byRegion.get(r.name) ?? [];
      list.push(item.instance_type.name);
      byRegion.set(r.name, list);
    }
  }
  return regions.map((r) => ({
    id: r.name,
    label: r.name,
    ...(r.description ? { location: r.description } : {}),
    // A region with no capacity for anything is still listed (filesystems,
    // rulesets), but the instance form hides it for every type.
    availableFor: byRegion.get(r.name) ?? [],
  }));
}

/** One option per image family (images repeat per region and version). */
export function imageOptions(images: LImage[]): ImageOption[] {
  const families = new Map<string, LImage>();
  for (const img of images) {
    if (!img.family) continue;
    const prev = families.get(img.family);
    if (!prev || (img.version ?? "") > (prev.version ?? "")) families.set(img.family, img);
  }
  return [
    {
      id: DEFAULT_IMAGE,
      label: "Lambda Stack (latest)",
      description: "Ubuntu with CUDA, PyTorch and drivers preinstalled; Lambda's default",
      family: "lambda-stack",
      category: "Lambda Stack",
    },
    ...[...families.values()].map((img) => ({
      id: img.family!,
      label: img.name || img.family!,
      ...(img.description ? { description: img.description } : {}),
      family: img.family!,
      category: img.architecture === "arm64" ? "Arm64" : "x86_64",
    })),
  ];
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

export const RULES_PLACEHOLDER = "tcp 22 0.0.0.0/0 SSH\nicmp - 0.0.0.0/0 ping";

export async function buildCreateConfig(
  client: LambdaCloudClient,
  typeId: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "instance": {
      const [types, regions, keys, images, filesystems, rulesets] = await Promise.all([
        client.instanceTypes().catch(() => []),
        client.regions().catch(() => []),
        client.raw.sshKeys().catch(() => []),
        client.raw.images().catch(() => []),
        client.raw.filesystems().catch(() => []),
        client.raw.rulesets().catch(() => []),
      ]);
      const sorted = [...types].sort(
        (a, b) =>
          Number((b.regions_with_capacity_available ?? []).length > 0) -
            Number((a.regions_with_capacity_available ?? []).length > 0) ||
          (a.instance_type.price_cents_per_hour ?? 0) - (b.instance_type.price_cents_per_hour ?? 0),
      );
      return {
        fields: [
          text("name", "Name", { required: false, placeholder: "my-gpu-box" }),
          {
            key: "instanceTypeName",
            label: "Instance Type",
            kind: "size-picker",
            required: true,
            description:
              "Prices are Lambda's on-demand list prices. Types without capacity cannot launch now",
            sizes: sorted.map(sizeOption),
          },
          {
            key: "regionName",
            label: "Region",
            kind: "region-picker",
            required: true,
            description: "Only regions with capacity for the chosen instance type are shown",
            regions: regionOptions(regions, types),
            filterByFieldKey: "instanceTypeName",
          },
          select(
            "sshKeyName",
            "SSH Key",
            keys.map((k) => ({ id: k.name ?? k.id, label: k.name ?? k.id })),
            { description: "Add one under SSH Keys first if this list is empty" },
          ),
          {
            key: "image",
            label: "Image",
            kind: "image-picker",
            required: false,
            defaultValue: DEFAULT_IMAGE,
            images: imageOptions(images),
          },
          select(
            "filesystemName",
            "Filesystem",
            [
              { id: NONE, label: "None" },
              ...filesystems.map((fs) => ({
                id: fs.name || fs.id,
                label: fs.name || fs.id,
                description: `${fs.region?.name ?? "?"}: must match the instance's region`,
              })),
            ],
            { required: false },
          ),
          select(
            "firewallRulesetId",
            "Firewall Ruleset",
            [
              { id: NONE, label: "Global rules only" },
              ...rulesets.map((r) => ({
                id: r.id,
                label: r.name || r.id,
                description: `${r.region?.name ?? "?"}: must match the instance's region`,
              })),
            ],
            { required: false },
          ),
          text("hostname", "Hostname", { required: false, placeholder: "trainer-01" }),
          text("tags", "Tags", { required: false, placeholder: "team=ml, env=dev" }),
          text("userData", "Cloud-init User Data", {
            required: false,
            multiline: true,
            placeholder: "#cloud-config\npackages:\n  - htop",
          }),
        ],
      };
    }
    case "filesystem": {
      const regions = await client.regions().catch(() => []);
      return {
        fields: [
          text("name", "Name", {
            description: "Letters, numbers and dashes; unique in your account",
          }),
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            description: "Instances can only mount filesystems in their own region",
            regions: regions.map((r) => ({
              id: r.name,
              label: r.name,
              ...(r.description ? { location: r.description } : {}),
            })),
          },
        ],
      };
    }
    case "firewall-ruleset": {
      const regions = await client.regions().catch(() => []);
      return {
        fields: [
          text("name", "Name"),
          {
            key: "region",
            label: "Region",
            kind: "region-picker",
            required: true,
            regions: regions.map((r) => ({
              id: r.name,
              label: r.name,
              ...(r.description ? { location: r.description } : {}),
            })),
          },
          text("rules", "Rules", {
            multiline: true,
            defaultValue: "tcp 22 0.0.0.0/0 SSH",
            placeholder: RULES_PLACEHOLDER,
            description:
              "One rule per line: protocol ports source description. Ports is a port, a min-max range, or - for all",
          }),
        ],
      };
    }
    case "ssh-key":
      return {
        fields: [
          text("name", "Name"),
          {
            key: "publicKey",
            label: "Public Key",
            kind: "ssh-key-picker",
            required: true,
          },
        ],
      };
    default:
      throw new Error(`Lambda Cloud plugin: "${typeId}" cannot be created`);
  }
}
