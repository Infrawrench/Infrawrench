import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  RegionOption,
  ResourceInstance,
  SelectOption,
  SizeOption,
} from "@infrawrench/plugin-base";
import { mapLimit } from "./api.js";
import {
  getInstance,
  makeResource,
  mapApp,
  mapProject,
  resourceGroups,
  resourceInstances,
  vpcGet,
  vpcList,
  type CeApp,
  type ListContext,
  type VpcKey,
} from "./listers.js";
import {
  CODE_ENGINE_REGIONS,
  RESOURCE_CONTROLLER,
  VPC_API_VERSION,
  codeEngineBase,
  cosEndpoint,
  crnService,
  regionInfo,
  vpcBase,
} from "./regions.js";

/**
 * Create forms and handlers. Regions come from the VPC region list, zones
 * from each region's zone list (narrowed by the chosen region), profiles and
 * images from the VPC API, resource groups from Resource Manager, and VPCs,
 * subnets and Code Engine projects through pickers.
 */

const PID = "ibm-cloud";

const nameField = (label = "Name", description?: string): CreateFieldConfig => ({
  key: "name",
  label,
  kind: "text",
  required: true,
  ...(description ? { description } : {}),
});

function regionOption(id: string): RegionOption {
  const info = regionInfo(id);
  return {
    id,
    label: info?.label ?? id,
    ...(info ? { location: info.location, flag: info.flag } : {}),
  };
}

async function regionField(
  ctx: ListContext,
  filter: (r: string) => boolean = () => true,
): Promise<CreateFieldConfig> {
  const regions = (await ctx.inventory.regions().catch(() => [ctx.inventory.homeRegion])).filter(
    filter,
  );
  const home = regions.includes(ctx.inventory.homeRegion) ? ctx.inventory.homeRegion : regions[0];
  return {
    key: "region",
    label: "Region",
    kind: "region-picker",
    required: true,
    regions: regions.map(regionOption),
    ...(home ? { defaultValue: home } : {}),
  };
}

async function zoneField(ctx: ListContext): Promise<CreateFieldConfig> {
  const regions = await ctx.inventory.regions().catch(() => [ctx.inventory.homeRegion]);
  const zones = await mapLimit(
    regions,
    6,
    async (region) =>
      (
        await ctx.api
          .get<{ zones?: Array<{ name: string }> }>(`${vpcBase(region)}/regions/${region}/zones`, {
            version: VPC_API_VERSION,
            generation: 2,
          })
          .catch(() => ({ zones: [] as Array<{ name: string }> }))
      ).zones?.map((z) => ({ id: z.name, label: z.name, availableFor: [region] })) ?? [],
  );
  return {
    key: "zone",
    label: "Zone",
    kind: "region-picker",
    required: true,
    filterByFieldKey: "region",
    regions: zones.flat(),
  };
}

async function resourceGroupField(ctx: ListContext): Promise<CreateFieldConfig> {
  const groups = await resourceGroups(ctx.api).catch(() => []);
  const def = groups.find((g) => g.default) ?? groups[0];
  return {
    key: "resourceGroupId",
    label: "Resource Group",
    kind: "select",
    required: false,
    options: groups.map((g) => ({ id: g.id, label: g.name })),
    ...(def ? { defaultValue: def.id } : {}),
  };
}

const picker = (
  key: string,
  label: string,
  typeId: string,
  required: boolean,
  description?: string,
): CreateFieldConfig => ({
  key,
  label,
  kind: "resource-picker",
  required,
  associationSources: [{ pluginId: PID, resourceTypeId: typeId, outputKey: "id" }],
  scopeFromFieldKey: "region",
  ...(description ? { description } : {}),
});

interface Profile {
  name: string;
  family?: string;
  vcpu_count?: { value?: number };
  memory?: { value?: number };
  os_architecture?: { default?: string };
}

export async function listProfiles(ctx: ListContext): Promise<Profile[]> {
  const res = await ctx.api.get<{ profiles?: Profile[] }>(
    `${vpcBase(ctx.inventory.homeRegion)}/instance/profiles`,
    {
      version: VPC_API_VERSION,
      generation: 2,
    },
  );
  return res.profiles ?? [];
}

function profileSizes(profiles: Profile[]): SizeOption[] {
  return profiles
    .filter((p) => p.vcpu_count?.value && p.memory?.value)
    .filter((p) => (p.vcpu_count?.value ?? 0) <= 64)
    .sort(
      (a, b) =>
        (a.family ?? "").localeCompare(b.family ?? "") ||
        (a.vcpu_count?.value ?? 0) - (b.vcpu_count?.value ?? 0) ||
        (a.memory?.value ?? 0) - (b.memory?.value ?? 0),
    )
    .map((p) => ({
      id: p.name,
      label: p.name,
      vcpus: p.vcpu_count?.value ?? 0,
      memoryMb: (p.memory?.value ?? 0) * 1024,
      category: p.family ? p.family[0]!.toUpperCase() + p.family.slice(1) : "Other",
    }));
}

interface Image {
  id: string;
  name: string;
  status?: string;
  created_at?: string;
  operating_system?: {
    name?: string;
    display_name?: string;
    family?: string;
    architecture?: string;
  };
}

async function publicImages(ctx: ListContext, region: string): Promise<Image[]> {
  return vpcList<Image>(ctx.api, region, "/images", "images", {
    visibility: "public",
    status: "available",
  });
}

/** Image picker options: one per public operating system (images are regional and get patched). */
async function imageOptions(ctx: ListContext): Promise<ImageOption[]> {
  const images = await publicImages(ctx, ctx.inventory.homeRegion);
  const seen = new Set<string>();
  const out: ImageOption[] = [];
  for (const i of images) {
    const os = i.operating_system;
    if (!os?.name || seen.has(os.name)) continue;
    seen.add(os.name);
    out.push({
      id: os.name,
      label: os.display_name ?? os.name,
      ...(os.family ? { category: os.family } : {}),
    });
  }
  return out.sort(
    (a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.label.localeCompare(b.label),
  );
}

export async function resolveImage(
  ctx: ListContext,
  region: string,
  osName: string,
): Promise<string> {
  if (/^r\d{3}-/.test(osName)) return osName;
  const match = (await publicImages(ctx, region))
    .filter((i) => i.operating_system?.name === osName)
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0];
  if (!match) {
    throw Object.assign(new Error(`No public ${osName} image is available in ${region}.`), {
      status: 400,
    });
  }
  return match.id;
}

const CE_RESOURCES: SelectOption[] = [
  { id: "0.25|0.5G", label: "0.25 vCPU, 0.5 GB" },
  { id: "0.5|1G", label: "0.5 vCPU, 1 GB" },
  { id: "1|4G", label: "1 vCPU, 4 GB" },
  { id: "2|4G", label: "2 vCPU, 4 GB" },
  { id: "2|8G", label: "2 vCPU, 8 GB" },
  { id: "4|16G", label: "4 vCPU, 16 GB" },
];

const COS_LOCATIONS: SelectOption[] = [
  { id: "us", label: "US cross-region" },
  { id: "eu", label: "EU cross-region" },
  { id: "ap", label: "AP cross-region" },
  ...[
    "us-south",
    "us-east",
    "ca-tor",
    "br-sao",
    "eu-gb",
    "eu-de",
    "eu-es",
    "jp-tok",
    "jp-osa",
    "au-syd",
  ].map((r) => ({ id: r, label: regionInfo(r)?.label ?? r, description: r })),
];

export async function getCreateConfig(
  ctx: ListContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "resource-group":
      return { fields: [nameField()] };
    case "instance": {
      const [region, profiles, images, rg] = await Promise.all([
        regionField(ctx),
        listProfiles(ctx).catch(() => [] as Profile[]),
        imageOptions(ctx).catch(() => [] as ImageOption[]),
        resourceGroupField(ctx),
      ]);
      const sizes = profileSizes(profiles);
      const defaultImage =
        images.find((i) => /ubuntu-24-04-amd64/.test(i.id))?.id ??
        images.find((i) => /ubuntu/.test(i.id))?.id ??
        images[0]?.id;
      return {
        fields: [
          nameField("Name", "Lower-case letters, digits and hyphens"),
          region,
          picker(
            "subnetId",
            "Subnet",
            "subnet",
            true,
            "The server's zone and VPC are the subnet's",
          ),
          {
            key: "profile",
            label: "Profile",
            kind: "size-picker",
            required: true,
            sizes,
            ...(sizes.find((s) => s.id === "bx2-2x8") ? { defaultValue: "bx2-2x8" } : {}),
          },
          {
            key: "image",
            label: "Image",
            kind: "image-picker",
            required: true,
            images,
            ...(defaultImage ? { defaultValue: defaultImage } : {}),
          },
          {
            key: "bootVolumeGb",
            label: "Boot Volume",
            kind: "disk-slider",
            required: false,
            minGb: 100,
            maxGb: 250,
            defaultGb: 100,
            stepGb: 10,
          },
          {
            key: "floatingIp",
            label: "Public IP",
            kind: "select",
            required: false,
            defaultValue: "true",
            options: [
              { id: "true", label: "Reserve and bind a floating IP" },
              { id: "false", label: "Private only" },
            ],
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: true },
          rg,
        ],
      };
    }
    case "volume":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          await zoneField(ctx),
          {
            key: "capacityGb",
            label: "Capacity",
            kind: "disk-slider",
            required: true,
            minGb: 10,
            maxGb: 16000,
            defaultGb: 100,
            stepGb: 10,
          },
          {
            key: "profile",
            label: "Performance",
            kind: "select",
            required: true,
            defaultValue: "general-purpose",
            options: [
              { id: "general-purpose", label: "3 IOPS/GB (general purpose)" },
              { id: "5iops-tier", label: "5 IOPS/GB" },
              { id: "10iops-tier", label: "10 IOPS/GB" },
              { id: "sdp", label: "Second generation (sdp)" },
            ],
          },
          await resourceGroupField(ctx),
        ],
      };
    case "vpc":
      return { fields: [nameField(), await regionField(ctx), await resourceGroupField(ctx)] };
    case "subnet":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          picker("vpcId", "VPC", "vpc", true),
          await zoneField(ctx),
          {
            key: "ipCount",
            label: "Addresses",
            kind: "select",
            required: true,
            defaultValue: "256",
            options: ["64", "128", "256", "512", "1024", "2048"].map((n) => ({
              id: n,
              label: `${n} addresses`,
            })),
            description: "IBM Cloud picks a free block in the VPC's address prefix for the zone",
          },
          await resourceGroupField(ctx),
        ],
      };
    case "security-group":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          picker("vpcId", "VPC", "vpc", true),
          {
            key: "rules",
            label: "Inbound Rules",
            kind: "select",
            required: true,
            defaultValue: "ssh",
            options: [
              { id: "ssh", label: "SSH (22) from anywhere" },
              { id: "web", label: "SSH, HTTP and HTTPS from anywhere" },
              { id: "none", label: "No inbound rules" },
            ],
            description: "All outbound traffic is allowed",
          },
          await resourceGroupField(ctx),
        ],
      };
    case "floating-ip":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          await zoneField(ctx),
          await resourceGroupField(ctx),
        ],
      };
    case "ssh-key":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          { key: "publicKey", label: "Public Key", kind: "ssh-key-picker", required: true },
          await resourceGroupField(ctx),
        ],
      };
    case "code-engine-project":
      return {
        fields: [
          nameField(),
          await regionField(ctx, (r) => CODE_ENGINE_REGIONS.has(r)),
          await resourceGroupField(ctx),
        ],
      };
    case "code-engine-app": {
      const fields: CreateFieldConfig[] = [
        nameField("Name", "Lower-case letters, digits and hyphens"),
      ];
      if (!parentResourceId) {
        fields.push(
          await regionField(ctx, (r) => CODE_ENGINE_REGIONS.has(r)),
          picker("projectId", "Project", "code-engine-project", true),
        );
      }
      fields.push(
        {
          key: "image",
          label: "Image",
          kind: "text",
          required: true,
          defaultValue: "icr.io/codeengine/helloworld",
          description: "A public container image, or one in IBM Cloud Container Registry",
        },
        { key: "port", label: "Port", kind: "number", required: false, defaultValue: "8080" },
        {
          key: "resources",
          label: "Resources per Instance",
          kind: "select",
          required: true,
          defaultValue: "1|4G",
          options: CE_RESOURCES,
        },
        {
          key: "minInstances",
          label: "Minimum Instances",
          kind: "number",
          required: false,
          defaultValue: "0",
          minValue: 0,
        },
        {
          key: "maxInstances",
          label: "Maximum Instances",
          kind: "number",
          required: false,
          defaultValue: "10",
          minValue: 1,
        },
      );
      return { fields };
    }
    case "cos-bucket": {
      const instances = (await resourceInstances(ctx.api).catch(() => [])).filter(
        (r) => crnService(r.crn ?? r.id) === "cloud-object-storage" && r.guid,
      );
      return {
        fields: [
          nameField(
            "Bucket Name",
            "3 to 63 lower-case letters, digits, dots and hyphens; unique across all of COS",
          ),
          {
            key: "serviceInstanceId",
            label: "Object Storage Instance",
            kind: "select",
            required: true,
            options: instances.map((i) => ({ id: i.guid!, label: i.name })),
            ...(instances[0]?.guid ? { defaultValue: instances[0].guid } : {}),
          },
          {
            key: "location",
            label: "Location",
            kind: "select",
            required: true,
            defaultValue: "us-south",
            options: COS_LOCATIONS,
          },
          {
            key: "storageClass",
            label: "Storage Class",
            kind: "select",
            required: true,
            defaultValue: "smart",
            options: [
              {
                id: "smart",
                label: "Smart Tier",
                description: "Priced by how often objects are read",
              },
              { id: "standard", label: "Standard" },
              { id: "vault", label: "Vault", description: "Read about once a month" },
              { id: "cold", label: "Cold Vault", description: "Read rarely" },
            ],
          },
        ],
      };
    }
    default:
      throw Object.assign(new Error(`IBM Cloud plugin: "${typeId}" cannot be created`), {
        status: 400,
      });
  }
}

// ---------------------------------------------------------------------------
// Handlers

function required(fields: Record<string, string>, key: string, label = key): string {
  const v = (fields[key] ?? "").trim();
  if (!v) throw Object.assign(new Error(`${label} is required`), { status: 400 });
  return v;
}

const rgRef = (fields: Record<string, string>) =>
  fields["resourceGroupId"] ? { resource_group: { id: fields["resourceGroupId"] } } : {};

function vpcUrl(region: string, path: string): string {
  return `${vpcBase(region)}${path}?version=${VPC_API_VERSION}&generation=2`;
}

async function vpcPost<T>(
  ctx: ListContext,
  region: string,
  path: string,
  body: unknown,
): Promise<T> {
  return (await ctx.api.request<T>({ url: vpcUrl(region, path), method: "POST", body })).data;
}

/** The first two space-separated parts of an OpenSSH key: type and base64 body. */
export function normaliseKey(key: string): string {
  return key.trim().split(/\s+/).slice(0, 2).join(" ");
}

async function ensureKey(
  ctx: ListContext,
  region: string,
  publicKey: string,
  name: string,
  fields: Record<string, string>,
): Promise<string> {
  const wanted = normaliseKey(publicKey);
  const keys = await vpcList<VpcKey>(ctx.api, region, "/keys", "keys");
  const found = keys.find((k) => k.public_key && normaliseKey(k.public_key) === wanted);
  if (found) return found.id;
  const created = await vpcPost<VpcKey>(ctx, region, "/keys", {
    name: `${name}-key`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .slice(0, 63),
    public_key: wanted,
    ...rgRef(fields),
  });
  return created.id;
}

async function eventually<T>(fn: () => Promise<T>, attempts = 5, delayMs = 2000): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

export async function createResource(
  ctx: ListContext,
  typeId: string,
  fields: Record<string, string>,
  parentResourceId: string | undefined,
  get: (typeId: string, externalId: string) => Promise<ResourceInstance>,
): Promise<ResourceInstance> {
  const region = fields["region"] ?? "";
  switch (typeId) {
    case "resource-group": {
      const accountId = await ctx.api.accountId();
      const res = (
        await ctx.api.request<{ id: string }>({
          url: `${RESOURCE_CONTROLLER}/v2/resource_groups`,
          method: "POST",
          body: { name: required(fields, "name", "Name"), account_id: accountId },
        })
      ).data;
      return eventually(() => get("resource-group", res.id));
    }
    case "instance": {
      const name = required(fields, "name", "Name");
      const subnet = await vpcGet<{ id: string; zone?: { name?: string }; vpc?: { id?: string } }>(
        ctx.api,
        region,
        `/subnets/${required(fields, "subnetId", "Subnet")}`,
      );
      const keyId = await ensureKey(
        ctx,
        region,
        required(fields, "sshPublicKey", "SSH key"),
        name,
        fields,
      );
      const imageId = await resolveImage(ctx, region, required(fields, "image", "Image"));
      const instance = await vpcPost<{ id: string; primary_network_interface?: { id?: string } }>(
        ctx,
        region,
        "/instances",
        {
          name,
          profile: { name: required(fields, "profile", "Profile") },
          image: { id: imageId },
          zone: { name: subnet.zone?.name },
          vpc: { id: subnet.vpc?.id },
          keys: [{ id: keyId }],
          primary_network_interface: { subnet: { id: subnet.id } },
          boot_volume_attachment: {
            delete_volume_on_instance_delete: true,
            volume: {
              capacity: Number(fields["bootVolumeGb"] || 100),
              profile: { name: "general-purpose" },
            },
          },
          ...rgRef(fields),
        },
      );
      const nicId = instance.primary_network_interface?.id;
      if (fields["floatingIp"] !== "false" && nicId) {
        await vpcPost(ctx, region, "/floating_ips", {
          name: `${name}-ip`.slice(0, 63),
          target: { id: nicId },
          ...rgRef(fields),
        });
      }
      return eventually(() => getInstance(ctx, region, instance.id));
    }
    case "volume": {
      const res = await vpcPost<{ id: string }>(ctx, region, "/volumes", {
        name: required(fields, "name", "Name"),
        capacity: Number(required(fields, "capacityGb", "Capacity")),
        profile: { name: fields["profile"] || "general-purpose" },
        zone: { name: required(fields, "zone", "Zone") },
        ...rgRef(fields),
      });
      return eventually(() => get("volume", `${region}/${res.id}`));
    }
    case "vpc": {
      const res = await vpcPost<{ id: string }>(ctx, region, "/vpcs", {
        name: required(fields, "name", "Name"),
        ...rgRef(fields),
      });
      return eventually(() => get("vpc", `${region}/${res.id}`));
    }
    case "subnet": {
      const res = await vpcPost<{ id: string }>(ctx, region, "/subnets", {
        name: required(fields, "name", "Name"),
        vpc: { id: required(fields, "vpcId", "VPC") },
        zone: { name: required(fields, "zone", "Zone") },
        total_ipv4_address_count: Number(fields["ipCount"] || 256),
        ...rgRef(fields),
      });
      return eventually(() => get("subnet", `${region}/${res.id}`));
    }
    case "security-group": {
      const ports: Record<string, number[]> = { ssh: [22], web: [22, 80, 443], none: [] };
      const rules = [
        { direction: "outbound", protocol: "any", remote: { cidr_block: "0.0.0.0/0" } },
        ...(ports[fields["rules"] ?? "ssh"] ?? []).map((p) => ({
          direction: "inbound",
          protocol: "tcp",
          port_min: p,
          port_max: p,
          remote: { cidr_block: "0.0.0.0/0" },
        })),
      ];
      const res = await vpcPost<{ id: string }>(ctx, region, "/security_groups", {
        name: required(fields, "name", "Name"),
        vpc: { id: required(fields, "vpcId", "VPC") },
        rules,
        ...rgRef(fields),
      });
      return eventually(() => get("security-group", `${region}/${res.id}`));
    }
    case "floating-ip": {
      const res = await vpcPost<{ id: string }>(ctx, region, "/floating_ips", {
        name: required(fields, "name", "Name"),
        zone: { name: required(fields, "zone", "Zone") },
        ...rgRef(fields),
      });
      return eventually(() => get("floating-ip", `${region}/${res.id}`));
    }
    case "ssh-key": {
      const res = await vpcPost<{ id: string }>(ctx, region, "/keys", {
        name: required(fields, "name", "Name"),
        public_key: normaliseKey(required(fields, "publicKey", "Public key")),
        ...rgRef(fields),
      });
      return eventually(() => get("ssh-key", `${region}/${res.id}`));
    }
    case "code-engine-project": {
      const res = (
        await ctx.api.request<{ id: string; name: string; status?: string; created_at?: string }>({
          url: `${codeEngineBase(region)}/projects`,
          method: "POST",
          body: {
            name: required(fields, "name", "Name"),
            ...(fields["resourceGroupId"] ? { resource_group_id: fields["resourceGroupId"] } : {}),
          },
        })
      ).data;
      return mapProject(ctx.accountId, region, {
        ...res,
        resource_group_id: fields["resourceGroupId"] ?? "",
      });
    }
    case "code-engine-app": {
      let appRegion = region;
      let projectId = fields["projectId"] ?? "";
      if (parentResourceId) {
        const ext = parentResourceId.split(":").slice(2).join(":");
        [appRegion, projectId] = ext.split("/") as [string, string];
      }
      if (!appRegion || !projectId)
        throw Object.assign(new Error("Pick a project"), { status: 400 });
      const [cpu, memory] = (fields["resources"] || "1|4G").split("|");
      const app = (
        await ctx.api.request<CeApp>({
          url: `${codeEngineBase(appRegion)}/projects/${projectId}/apps`,
          method: "POST",
          body: {
            name: required(fields, "name", "Name"),
            image_reference: required(fields, "image", "Image"),
            image_port: Number(fields["port"] || 8080),
            scale_cpu_limit: cpu,
            scale_memory_limit: memory,
            scale_min_instances: Number(fields["minInstances"] || 0),
            scale_max_instances: Number(fields["maxInstances"] || 10),
          },
        })
      ).data;
      return mapApp(ctx.accountId, appRegion, projectId, app);
    }
    case "cos-bucket": {
      const name = required(fields, "name", "Bucket name").toLowerCase();
      const location = required(fields, "location", "Location");
      const storageClass = fields["storageClass"] || "smart";
      await ctx.api.request<string>({
        url: `https://${cosEndpoint(location)}/${encodeURIComponent(name)}`,
        method: "PUT",
        headers: {
          "ibm-service-instance-id": required(
            fields,
            "serviceInstanceId",
            "Object Storage instance",
          ),
          "content-type": "text/plain",
        },
        rawBody: `<CreateBucketConfiguration><LocationConstraint>${location}-${storageClass}</LocationConstraint></CreateBucketConfiguration>`,
        text: true,
      });
      return makeResource(
        ctx.accountId,
        "cos-bucket",
        `${location}/${name}`,
        name,
        {
          name,
          location,
          storageClass,
          serviceInstanceId: fields["serviceInstanceId"] ?? "",
          createdAt: new Date().toISOString(),
        },
        { name, endpoint: cosEndpoint(location) },
      );
    }
    default:
      throw Object.assign(new Error(`IBM Cloud plugin: "${typeId}" cannot be created`), {
        status: 400,
      });
  }
}
