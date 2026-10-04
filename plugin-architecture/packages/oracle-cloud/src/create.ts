import type {
  CreateFieldConfig,
  CreateResourceConfig,
  ImageOption,
  RegionOption,
  ResourceInstance,
  SelectOption,
} from "@infrawrench/plugin-base";
import {
  bucketExternalId,
  getBucket,
  getInstance,
  makeResource,
  mapAlertRule,
  mapAutonomousDatabase,
  mapBudget,
  mapVolume,
  parseSizeId,
  type ListContext,
  type OciAlertRule,
  type OciAutonomousDatabase,
  type OciBudget,
  type OciInstance,
  objectStorageNamespace,
} from "./listers.js";
import { priceRates, sizeOptionsFromShapes, type OciShape } from "./pricing.js";
import { regionInfo } from "./regions.js";
import type { HttpHostServices } from "@infrawrench/plugin-base";

/**
 * Create forms and create handlers. Nothing here asks the user for an OCID:
 * regions come from the tenancy's subscriptions, compartments from Identity
 * (labelled by path), subnets and VCNs through resource pickers, shapes and
 * images from Compute, tags from the tenancy's cost-tracking tags. The one
 * thing a form cannot list is an availability domain per region before the
 * region is chosen, so the form asks for "AD 1/2/3" and the handler resolves
 * it in the chosen region.
 */

export interface CreateContext extends ListContext {
  http?: HttpHostServices;
}

async function regionField(ctx: CreateContext): Promise<CreateFieldConfig> {
  const regions = await ctx.inventory.regions().catch(() => [ctx.inventory.homeRegion]);
  const options: RegionOption[] = regions.map((id) => {
    const info = regionInfo(id);
    return {
      id,
      label: info?.label ?? id,
      ...(info ? { location: info.location, flag: info.flag } : {}),
    };
  });
  return {
    key: "region",
    label: "Region",
    kind: "region-picker",
    required: true,
    regions: options,
    defaultValue: regions[0] ?? ctx.inventory.homeRegion,
  };
}

async function compartmentOptions(ctx: CreateContext): Promise<SelectOption[]> {
  const all = await ctx.inventory.compartments();
  return all.map((c) => ({
    id: c.id,
    label: c.path,
    ...(c.description ? { description: c.description } : {}),
  }));
}

async function compartmentField(
  ctx: CreateContext,
  key = "compartmentId",
  label = "Compartment",
): Promise<CreateFieldConfig> {
  return {
    key,
    label,
    kind: "select",
    required: true,
    options: await compartmentOptions(ctx),
    defaultValue: ctx.api.tenancyOcid,
  };
}

const AD_FIELD: CreateFieldConfig = {
  key: "availabilityDomain",
  label: "Availability Domain",
  kind: "select",
  required: true,
  defaultValue: "1",
  description: "Single-AD regions only have AD 1",
  options: [
    { id: "1", label: "AD 1" },
    { id: "2", label: "AD 2" },
    { id: "3", label: "AD 3" },
  ],
};

const nameField = (label = "Name"): CreateFieldConfig => ({
  key: "name",
  label,
  kind: "text",
  required: true,
});

async function resolveAd(ctx: CreateContext, region: string, value: string): Promise<string> {
  const ads = await ctx.inventory.availabilityDomains(region);
  if (value && !/^\d$/.test(value) && ads.includes(value)) return value;
  const index = Math.max(1, Number(value) || 1) - 1;
  const ad = ads[index];
  if (!ad) {
    throw new Error(
      `${region} has ${ads.length} availability domain${ads.length === 1 ? "" : "s"}; pick AD ${ads.length === 1 ? "1" : `1 to ${ads.length}`}.`,
    );
  }
  return ad;
}

const VPU_OPTIONS: SelectOption[] = [
  { id: "0", label: "Lower Cost (0 VPU/GB)" },
  { id: "10", label: "Balanced (10 VPU/GB)" },
  { id: "20", label: "Higher Performance (20 VPU/GB)" },
  { id: "30", label: "Ultra High Performance (30 VPU/GB)" },
  { id: "60", label: "Ultra High Performance (60 VPU/GB)" },
  { id: "120", label: "Ultra High Performance (120 VPU/GB)" },
];

async function instanceImages(ctx: CreateContext): Promise<ImageOption[]> {
  const images = await ctx.api.listAll<{
    operatingSystem?: string;
    operatingSystemVersion?: string;
    displayName?: string;
  }>(
    {
      service: "iaas",
      region: ctx.inventory.homeRegion,
      path: "/20160918/images",
      query: {
        compartmentId: ctx.api.tenancyOcid,
        lifecycleState: "AVAILABLE",
        sortBy: "TIMECREATED",
        sortOrder: "DESC",
        limit: 1000,
      },
    },
    5,
  );
  // Image OCIDs are regional, so the option is the OS and version; the
  // handler picks the newest matching image in the chosen region.
  const seen = new Set<string>();
  const out: ImageOption[] = [];
  for (const img of images) {
    if (!img.operatingSystem || !img.operatingSystemVersion) continue;
    if (/GPU|aarch64/i.test(img.displayName ?? "")) continue;
    const id = `${img.operatingSystem}|${img.operatingSystemVersion}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: `${img.operatingSystem} ${img.operatingSystemVersion}`,
      category: img.operatingSystem,
    });
  }
  return out;
}

export async function listShapes(ctx: CreateContext): Promise<OciShape[]> {
  return ctx.api.listAll<OciShape>({
    service: "iaas",
    region: ctx.inventory.homeRegion,
    path: "/20160918/shapes",
    query: { compartmentId: ctx.api.tenancyOcid, limit: 1000 },
  });
}

async function costTrackingTagOptions(ctx: CreateContext): Promise<SelectOption[]> {
  const tags = await ctx.api
    .listAll<{ tagNamespaceName?: string; name?: string; description?: string }>({
      service: "identity",
      region: ctx.inventory.homeRegion,
      path: "/20160918/tagNamespaces/actions/listCostTrackingTags",
      query: { compartmentId: ctx.api.tenancyOcid, limit: 1000 },
    })
    .catch(() => []);
  return tags
    .filter((t) => t.tagNamespaceName && t.name)
    .map((t) => ({
      id: `${t.tagNamespaceName}.${t.name}`,
      label: `${t.tagNamespaceName}.${t.name}`,
      ...(t.description ? { description: t.description } : {}),
    }));
}

export async function getCreateConfig(
  ctx: CreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  switch (typeId) {
    case "compartment":
      return {
        fields: [
          nameField(),
          { key: "description", label: "Description", kind: "text", required: true },
          await compartmentField(ctx, "parentId", "Parent Compartment"),
        ],
      };
    case "instance": {
      const [region, compartment, shapes, images, rates] = await Promise.all([
        regionField(ctx),
        compartmentField(ctx),
        listShapes(ctx),
        instanceImages(ctx).catch(() => [] as ImageOption[]),
        priceRates(ctx.http),
      ]);
      const sizes = sizeOptionsFromShapes(shapes, rates);
      const defaultSize =
        sizes.find((s) => s.id === "VM.Standard.E4.Flex/1/16")?.id ?? sizes[0]?.id;
      const defaultImage =
        images.find((i) => i.id === "Canonical Ubuntu|24.04")?.id ??
        images.find((i) => i.category === "Oracle Linux")?.id ??
        images[0]?.id;
      return {
        fields: [
          nameField(),
          region,
          compartment,
          AD_FIELD,
          {
            key: "size",
            label: "Shape",
            kind: "size-picker",
            required: true,
            sizes,
            ...(defaultSize ? { defaultValue: defaultSize } : {}),
            description:
              "Flexible shapes are shown at common OCPU counts with OCI's default memory per OCPU. 1 OCPU is 2 vCPUs on x86 and 1 vCPU on Ampere A1.",
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
            key: "bootVolumeSizeGb",
            label: "Boot Volume",
            kind: "disk-slider",
            required: false,
            minGb: 50,
            maxGb: 32768,
            defaultGb: 50,
            stepGb: 10,
          },
          {
            key: "subnetId",
            label: "Subnet",
            kind: "resource-picker",
            required: false,
            description:
              "Leave empty to use the first public subnet in the region (the Create VCN wizard's default network)",
            associationSources: [
              { pluginId: "oracle-cloud", resourceTypeId: "subnet", outputKey: "id" },
            ],
            scopeFromFieldKey: "region",
          },
          {
            key: "assignPublicIp",
            label: "Public IP",
            kind: "select",
            required: false,
            defaultValue: "true",
            options: [
              { id: "true", label: "Assign a public IPv4 address" },
              { id: "false", label: "Private only" },
            ],
          },
          { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
        ],
      };
    }
    case "block-volume":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          await compartmentField(ctx),
          AD_FIELD,
          {
            key: "sizeGb",
            label: "Size",
            kind: "disk-slider",
            required: true,
            minGb: 50,
            maxGb: 32768,
            defaultGb: 50,
            stepGb: 50,
          },
          {
            key: "vpusPerGb",
            label: "Performance",
            kind: "select",
            required: true,
            defaultValue: "10",
            options: VPU_OPTIONS,
          },
        ],
      };
    case "vcn":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          await compartmentField(ctx),
          {
            key: "cidrBlock",
            label: "IPv4 CIDR Block",
            kind: "text",
            required: true,
            defaultValue: "10.0.0.0/16",
            placeholder: "10.0.0.0/16",
          },
          {
            key: "dnsLabel",
            label: "DNS Label",
            kind: "text",
            required: false,
            description: "Letters and numbers, starting with a letter, up to 15 characters",
          },
        ],
      };
    case "subnet":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          {
            key: "vcnId",
            label: "VCN",
            kind: "resource-picker",
            required: true,
            associationSources: [
              { pluginId: "oracle-cloud", resourceTypeId: "vcn", outputKey: "id" },
            ],
            scopeFromFieldKey: "region",
          },
          await compartmentField(ctx),
          {
            key: "cidrBlock",
            label: "IPv4 CIDR Block",
            kind: "text",
            required: true,
            defaultValue: "10.0.0.0/24",
            placeholder: "10.0.0.0/24",
          },
          {
            key: "access",
            label: "Access",
            kind: "select",
            required: true,
            defaultValue: "public",
            options: [
              { id: "public", label: "Public (VNICs may have public IPs)" },
              { id: "private", label: "Private (no public IPs)" },
            ],
          },
          { key: "dnsLabel", label: "DNS Label", kind: "text", required: false },
        ],
      };
    case "reserved-ip":
      return {
        fields: [nameField(), await regionField(ctx), await compartmentField(ctx)],
      };
    case "load-balancer":
      return {
        fields: [
          nameField(),
          await regionField(ctx),
          await compartmentField(ctx),
          {
            key: "subnetId",
            label: "Subnet",
            kind: "resource-picker",
            required: true,
            description: "A regional subnet; public load balancers need a public subnet",
            associationSources: [
              { pluginId: "oracle-cloud", resourceTypeId: "subnet", outputKey: "id" },
            ],
            scopeFromFieldKey: "region",
          },
          {
            key: "isPrivate",
            label: "Visibility",
            kind: "select",
            required: true,
            defaultValue: "false",
            options: [
              { id: "false", label: "Public" },
              { id: "true", label: "Private" },
            ],
          },
          {
            key: "minBandwidthMbps",
            label: "Minimum Bandwidth (Mbps)",
            kind: "number",
            required: true,
            defaultValue: "10",
            minValue: 10,
            maxValue: 8000,
          },
          {
            key: "maxBandwidthMbps",
            label: "Maximum Bandwidth (Mbps)",
            kind: "number",
            required: true,
            defaultValue: "100",
            minValue: 10,
            maxValue: 8000,
          },
        ],
      };
    case "bucket":
      return {
        fields: [
          nameField("Bucket Name"),
          await regionField(ctx),
          await compartmentField(ctx),
          {
            key: "storageTier",
            label: "Storage Tier",
            kind: "select",
            required: true,
            defaultValue: "Standard",
            options: [
              { id: "Standard", label: "Standard" },
              { id: "Archive", label: "Archive (cannot be changed later)" },
            ],
          },
          {
            key: "autoTiering",
            label: "Auto-Tiering",
            kind: "select",
            required: false,
            defaultValue: "Disabled",
            options: [
              { id: "Disabled", label: "Off" },
              { id: "InfrequentAccess", label: "Move cold objects to Infrequent Access" },
            ],
          },
          {
            key: "publicAccessType",
            label: "Public Access",
            kind: "select",
            required: true,
            defaultValue: "NoPublicAccess",
            options: [
              { id: "NoPublicAccess", label: "Private" },
              { id: "ObjectReadWithoutList", label: "Public read, no listing" },
              { id: "ObjectRead", label: "Public read and list" },
            ],
          },
          {
            key: "versioning",
            label: "Versioning",
            kind: "select",
            required: false,
            defaultValue: "Disabled",
            options: [
              { id: "Disabled", label: "Off" },
              { id: "Enabled", label: "On" },
            ],
          },
        ],
      };
    case "autonomous-database":
      return {
        fields: [
          nameField("Display Name"),
          {
            key: "dbName",
            label: "Database Name",
            kind: "text",
            required: true,
            description: "Letters and numbers only, starting with a letter, up to 30 characters",
          },
          await regionField(ctx),
          await compartmentField(ctx),
          {
            key: "workload",
            label: "Workload",
            kind: "select",
            required: true,
            defaultValue: "OLTP",
            options: [
              { id: "OLTP", label: "Transaction Processing" },
              { id: "DW", label: "Lakehouse (Data Warehouse)" },
              { id: "AJD", label: "JSON Database" },
              { id: "APEX", label: "APEX" },
            ],
          },
          {
            key: "freeTier",
            label: "Always Free",
            kind: "select",
            required: false,
            defaultValue: "false",
            options: [
              { id: "false", label: "Paid" },
              { id: "true", label: "Always Free (fixed size, two per tenancy)" },
            ],
          },
          {
            key: "computeCount",
            label: "ECPUs",
            kind: "number",
            required: false,
            defaultValue: "2",
            minValue: 2,
            showWhen: { fieldKey: "freeTier", fieldValue: "false" },
          },
          {
            key: "storageTb",
            label: "Storage (TB)",
            kind: "number",
            required: false,
            defaultValue: "1",
            minValue: 1,
            showWhen: { fieldKey: "freeTier", fieldValue: "false" },
          },
          {
            key: "autoScaling",
            label: "Compute Auto Scaling",
            kind: "select",
            required: false,
            defaultValue: "true",
            options: [
              { id: "true", label: "On" },
              { id: "false", label: "Off" },
            ],
            showWhen: { fieldKey: "freeTier", fieldValue: "false" },
          },
          {
            key: "licenseModel",
            label: "License",
            kind: "select",
            required: false,
            defaultValue: "LICENSE_INCLUDED",
            options: [
              { id: "LICENSE_INCLUDED", label: "License included" },
              { id: "BRING_YOUR_OWN_LICENSE", label: "Bring your own license" },
            ],
            showWhen: { fieldKey: "freeTier", fieldValue: "false" },
          },
          {
            key: "adminPassword",
            label: "ADMIN Password",
            kind: "password",
            required: true,
            description:
              "12 to 30 characters with an uppercase letter, a lowercase letter and a number; no double quotes and not the word admin",
          },
        ],
      };
    case "budget": {
      const [compartments, tags] = await Promise.all([
        compartmentOptions(ctx),
        costTrackingTagOptions(ctx),
      ]);
      return {
        fields: [
          nameField(),
          { key: "description", label: "Description", kind: "text", required: false },
          {
            key: "amount",
            label: "Monthly Amount",
            kind: "number",
            required: true,
            minValue: 1,
            description: "Whole number, in the tenancy's billing currency",
          },
          {
            key: "targetType",
            label: "Track",
            kind: "select",
            required: true,
            defaultValue: "COMPARTMENT",
            options: [
              { id: "COMPARTMENT", label: "A compartment (and everything under it)" },
              ...(tags.length ? [{ id: "TAG", label: "A cost-tracking tag value" }] : []),
            ],
          },
          {
            key: "targetCompartmentId",
            label: "Compartment",
            kind: "select",
            required: false,
            options: compartments,
            defaultValue: ctx.api.tenancyOcid,
            showWhen: { fieldKey: "targetType", fieldValue: "COMPARTMENT" },
          },
          {
            key: "targetTagKey",
            label: "Cost-Tracking Tag",
            kind: "select",
            required: false,
            options: tags,
            showWhen: { fieldKey: "targetType", fieldValue: "TAG" },
          },
          {
            key: "targetTagValue",
            label: "Tag Value",
            kind: "text",
            required: false,
            showWhen: { fieldKey: "targetType", fieldValue: "TAG" },
          },
          {
            key: "processingPeriodType",
            label: "Budget Period",
            kind: "select",
            required: false,
            defaultValue: "MONTH",
            options: [
              { id: "MONTH", label: "Calendar month" },
              { id: "INVOICE", label: "Invoice period" },
            ],
          },
          {
            key: "alertThresholdPercent",
            label: "Alert At (% of budget)",
            kind: "number",
            required: false,
            minValue: 1,
            maxValue: 10000,
            description: "Optional: also create an alert rule on actual spend at this percentage",
          },
          {
            key: "alertRecipients",
            label: "Alert Recipients",
            kind: "string-list",
            required: false,
            addLabel: "Add email",
          },
        ],
      };
    }
    case "budget-alert-rule":
      return {
        fields: [
          nameField(),
          ...(parentResourceId
            ? []
            : [
                {
                  key: "budgetId",
                  label: "Budget",
                  kind: "resource-picker" as const,
                  required: true,
                  associationSources: [
                    { pluginId: "oracle-cloud", resourceTypeId: "budget", outputKey: "id" },
                  ],
                },
              ]),
          {
            key: "type",
            label: "Spend Type",
            kind: "select",
            required: true,
            defaultValue: "ACTUAL",
            options: [
              { id: "ACTUAL", label: "Actual spend" },
              { id: "FORECAST", label: "Forecast spend" },
            ],
          },
          {
            key: "thresholdType",
            label: "Threshold Type",
            kind: "select",
            required: true,
            defaultValue: "PERCENTAGE",
            options: [
              { id: "PERCENTAGE", label: "Percent of budget" },
              { id: "ABSOLUTE", label: "Absolute amount" },
            ],
          },
          {
            key: "threshold",
            label: "Threshold",
            kind: "number",
            required: true,
            defaultValue: "80",
          },
          {
            key: "recipients",
            label: "Recipients",
            kind: "string-list",
            required: false,
            addLabel: "Add email",
          },
          { key: "message", label: "Message", kind: "text", required: false, multiline: true },
        ],
      };
    default:
      return { fields: [] };
  }
}

function externalOf(id: string): string {
  return id.split(":").slice(2).join(":");
}

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return v === "true";
}

function recipientsOf(v: string | undefined): string {
  return (v ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");
}

async function firstPublicSubnet(ctx: CreateContext, region: string): Promise<string> {
  const compartments = await ctx.inventory.compartments();
  for (const c of compartments) {
    const subnets = await ctx.api
      .listAll<{ id: string; prohibitPublicIpOnVnic?: boolean; lifecycleState: string }>({
        service: "iaas",
        region,
        path: "/20160918/subnets",
        query: { compartmentId: c.id, limit: 100 },
      })
      .catch(() => []);
    const hit = subnets.find((s) => s.lifecycleState === "AVAILABLE" && !s.prohibitPublicIpOnVnic);
    if (hit) return hit.id;
  }
  throw new Error(
    `No public subnet found in ${region}. Create a VCN with a public subnet there first, or pick a subnet.`,
  );
}

async function resolveImage(
  ctx: CreateContext,
  region: string,
  image: string,
  shape: string,
): Promise<string> {
  if (image.startsWith("ocid1.image.")) return image;
  const [operatingSystem, operatingSystemVersion] = image.split("|");
  const images = await ctx.api.listAll<{ id: string }>(
    {
      service: "iaas",
      region,
      path: "/20160918/images",
      query: {
        compartmentId: ctx.api.tenancyOcid,
        operatingSystem,
        operatingSystemVersion,
        shape,
        lifecycleState: "AVAILABLE",
        sortBy: "TIMECREATED",
        sortOrder: "DESC",
        limit: 1,
      },
    },
    1,
  );
  const first = images[0];
  if (!first) {
    throw new Error(
      `No ${operatingSystem} ${operatingSystemVersion} image for ${shape} in ${region}.`,
    );
  }
  return first.id;
}

export async function createResource(
  ctx: CreateContext,
  typeId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  const region = fields["region"] || ctx.inventory.homeRegion;
  const compartmentId = fields["compartmentId"] || ctx.api.tenancyOcid;
  const name = (fields["name"] ?? "").trim();
  const post = <T>(
    service: Parameters<typeof ctx.api.request>[0]["service"],
    path: string,
    body: unknown,
    r = region,
  ) =>
    ctx.api.request<T>({ service, region: r, method: "POST", path, body }).then((res) => res.data);

  switch (typeId) {
    case "compartment": {
      const c = await post<{
        id: string;
        name: string;
        description?: string;
        compartmentId: string;
        lifecycleState: string;
      }>(
        "identity",
        "/20160918/compartments",
        {
          compartmentId: fields["parentId"] || ctx.api.tenancyOcid,
          name,
          description: fields["description"] || name,
        },
        ctx.inventory.homeRegion,
      );
      return makeResource(
        ctx.accountId,
        "compartment",
        c.id,
        c.name,
        {
          name: c.name,
          description: c.description ?? "",
          parentId: c.compartmentId,
          path: "",
          status: c.lifecycleState,
        },
        { id: c.id },
      );
    }
    case "instance": {
      const { shape, ocpus, memoryGb } = parseSizeId(fields["size"] ?? "VM.Standard.E4.Flex/1/16");
      const ad = await resolveAd(ctx, region, fields["availabilityDomain"] ?? "1");
      const subnetId = fields["subnetId"] || (await firstPublicSubnet(ctx, region));
      const imageId = await resolveImage(
        ctx,
        region,
        fields["image"] ?? "Canonical Ubuntu|24.04",
        shape,
      );
      const bootGb = Number(fields["bootVolumeSizeGb"]) || undefined;
      const inst = await post<OciInstance>("iaas", "/20160918/instances", {
        availabilityDomain: ad,
        compartmentId,
        displayName: name,
        shape,
        ...(ocpus !== undefined && memoryGb !== undefined
          ? { shapeConfig: { ocpus, memoryInGBs: memoryGb } }
          : {}),
        sourceDetails: {
          sourceType: "image",
          imageId,
          ...(bootGb ? { bootVolumeSizeInGBs: bootGb } : {}),
        },
        createVnicDetails: { subnetId, assignPublicIp: bool(fields["assignPublicIp"], true) },
        ...(fields["sshPublicKey"]
          ? { metadata: { ssh_authorized_keys: fields["sshPublicKey"].trim() } }
          : {}),
      });
      return getInstance(ctx, inst.id).catch(() =>
        makeResource(
          ctx.accountId,
          "instance",
          inst.id,
          inst.displayName,
          {
            name: inst.displayName,
            region,
            availabilityDomain: ad,
            compartmentId,
            size: fields["size"] ?? shape,
            shape,
            status: inst.lifecycleState,
          },
          { id: inst.id },
        ),
      );
    }
    case "block-volume": {
      const ad = await resolveAd(ctx, region, fields["availabilityDomain"] ?? "1");
      const v = await post<Parameters<typeof mapVolume>[3]>("iaas", "/20160918/volumes", {
        availabilityDomain: ad,
        compartmentId,
        displayName: name,
        sizeInGBs: Number(fields["sizeGb"]) || 50,
        vpusPerGB: Number(fields["vpusPerGb"] ?? 10),
      });
      return mapVolume(ctx, "block-volume", region, v, new Map(), []);
    }
    case "vcn": {
      const v = await post<{ id: string; displayName: string; lifecycleState: string }>(
        "iaas",
        "/20160918/vcns",
        {
          compartmentId,
          displayName: name,
          cidrBlocks: [fields["cidrBlock"] || "10.0.0.0/16"],
          ...(fields["dnsLabel"] ? { dnsLabel: fields["dnsLabel"] } : {}),
        },
      );
      return makeResource(
        ctx.accountId,
        "vcn",
        v.id,
        v.displayName,
        {
          name: v.displayName,
          region,
          compartmentId,
          cidrBlocks: fields["cidrBlock"] || "10.0.0.0/16",
          status: v.lifecycleState,
        },
        { id: v.id },
      );
    }
    case "subnet": {
      const vcnId = fields["vcnId"] ?? "";
      if (!vcnId) throw new Error("Pick the VCN the subnet goes in.");
      const subnetRegion = await ctx.inventory.regionOfOcid(vcnId);
      const s = await post<{
        id: string;
        displayName: string;
        lifecycleState: string;
        vcnId: string;
        cidrBlock: string;
      }>(
        "iaas",
        "/20160918/subnets",
        {
          compartmentId,
          vcnId,
          displayName: name,
          cidrBlock: fields["cidrBlock"] || "10.0.0.0/24",
          prohibitPublicIpOnVnic: fields["access"] === "private",
          ...(fields["dnsLabel"] ? { dnsLabel: fields["dnsLabel"] } : {}),
        },
        subnetRegion,
      );
      return makeResource(
        ctx.accountId,
        "subnet",
        s.id,
        s.displayName,
        {
          name: s.displayName,
          region: subnetRegion,
          compartmentId,
          vcnId: s.vcnId,
          cidrBlock: s.cidrBlock,
          access: fields["access"] === "private" ? "private" : "public",
          status: s.lifecycleState,
        },
        { id: s.id },
      );
    }
    case "reserved-ip": {
      const ip = await post<{
        id: string;
        ipAddress: string;
        displayName?: string;
        lifecycleState: string;
      }>("iaas", "/20160918/publicIps", { compartmentId, lifetime: "RESERVED", displayName: name });
      return makeResource(
        ctx.accountId,
        "reserved-ip",
        ip.id,
        ip.displayName || ip.ipAddress,
        {
          name: ip.displayName ?? name,
          region,
          compartmentId,
          ipAddress: ip.ipAddress,
          status: ip.lifecycleState,
          assignedEntityId: "",
        },
        { ipAddress: ip.ipAddress, id: ip.id },
      );
    }
    case "load-balancer": {
      // CreateLoadBalancer is asynchronous: it answers with a work request
      // id and no body. The work request names the new load balancer as
      // soon as it is accepted, so poll briefly for that id.
      const res = await ctx.api.request<unknown>({
        service: "iaas",
        region,
        method: "POST",
        path: "/20170115/loadBalancers",
        body: {
          compartmentId,
          displayName: name,
          shapeName: "flexible",
          shapeDetails: {
            minimumBandwidthInMbps: Number(fields["minBandwidthMbps"]) || 10,
            maximumBandwidthInMbps: Number(fields["maxBandwidthMbps"]) || 100,
          },
          subnetIds: [fields["subnetId"]].filter(Boolean),
          isPrivate: bool(fields["isPrivate"]),
        },
      });
      const workRequestId = res.headers["opc-work-request-id"];
      let lbId = "";
      for (let i = 0; workRequestId && i < 10 && !lbId; i++) {
        const wr = await ctx.api
          .get<{
            loadBalancerId?: string;
            lifecycleState?: string;
            errorDetails?: Array<{ message?: string }>;
          }>("iaas", region, `/20170115/loadBalancerWorkRequests/${workRequestId}`)
          .catch(() => undefined);
        if (wr?.lifecycleState === "FAILED") {
          throw new Error(wr.errorDetails?.[0]?.message ?? "OCI rejected the load balancer.");
        }
        lbId = wr?.loadBalancerId ?? "";
        if (!lbId) await new Promise((r) => setTimeout(r, 1500));
      }
      if (!lbId) {
        throw new Error(
          "OCI accepted the load balancer but has not assigned it an id yet. It will appear on the next refresh.",
        );
      }
      return makeResource(
        ctx.accountId,
        "load-balancer",
        lbId,
        name,
        {
          name,
          region,
          compartmentId,
          shape: "flexible",
          minBandwidthMbps: Number(fields["minBandwidthMbps"]) || 10,
          maxBandwidthMbps: Number(fields["maxBandwidthMbps"]) || 100,
          backendSetCount: 0,
          status: "CREATING",
        },
        { id: lbId },
      );
    }
    case "bucket": {
      const ns = await objectStorageNamespace(ctx.api, region);
      await post<unknown>("objectstorage", `/n/${encodeURIComponent(ns)}/b`, {
        name,
        compartmentId,
        storageTier: fields["storageTier"] || "Standard",
        publicAccessType: fields["publicAccessType"] || "NoPublicAccess",
        versioning: fields["versioning"] || "Disabled",
        ...(fields["autoTiering"] ? { autoTiering: fields["autoTiering"] } : {}),
      });
      return getBucket(ctx, region, name).catch(() =>
        makeResource(ctx.accountId, "bucket", bucketExternalId(region, name), name, {
          name,
          region,
          compartmentId,
          namespace: ns,
        }),
      );
    }
    case "autonomous-database": {
      const free = bool(fields["freeTier"]);
      const db = await post<OciAutonomousDatabase>("database", "/20160918/autonomousDatabases", {
        compartmentId,
        displayName: name,
        dbName: fields["dbName"],
        adminPassword: fields["adminPassword"],
        dbWorkload: fields["workload"] || "OLTP",
        ...(free
          ? { isFreeTier: true }
          : {
              computeModel: "ECPU",
              computeCount: Number(fields["computeCount"]) || 2,
              dataStorageSizeInTBs: Number(fields["storageTb"]) || 1,
              isAutoScalingEnabled: bool(fields["autoScaling"], true),
              licenseModel: fields["licenseModel"] || "LICENSE_INCLUDED",
            }),
      });
      return mapAutonomousDatabase(ctx, region, db, new Map());
    }
    case "budget": {
      const targetType = fields["targetType"] === "TAG" ? "TAG" : "COMPARTMENT";
      const target =
        targetType === "TAG"
          ? `${fields["targetTagKey"] ?? ""}.${(fields["targetTagValue"] ?? "").trim()}`
          : fields["targetCompartmentId"] || ctx.api.tenancyOcid;
      if (targetType === "TAG" && (!fields["targetTagKey"] || !fields["targetTagValue"])) {
        throw new Error("Pick a cost-tracking tag and enter the value to track.");
      }
      const amount = Math.round(Number(fields["amount"]));
      if (!(amount > 0)) throw new Error("The budget amount must be a whole number above zero.");
      const b = await post<OciBudget>(
        "usage",
        "/20190111/budgets",
        {
          compartmentId: ctx.api.tenancyOcid,
          displayName: name,
          ...(fields["description"] ? { description: fields["description"] } : {}),
          amount,
          resetPeriod: "MONTHLY",
          processingPeriodType: fields["processingPeriodType"] || "MONTH",
          targetType,
          targets: [target],
        },
        ctx.inventory.homeRegion,
      );
      const threshold = Number(fields["alertThresholdPercent"]);
      if (threshold > 0) {
        await post<unknown>(
          "usage",
          `/20190111/budgets/${b.id}/alertRules`,
          {
            displayName: `${name} ${threshold}%`,
            type: "ACTUAL",
            thresholdType: "PERCENTAGE",
            threshold,
            recipients: recipientsOf(fields["alertRecipients"]),
          },
          ctx.inventory.homeRegion,
        );
        b.alertRuleCount = (b.alertRuleCount ?? 0) + 1;
      }
      return mapBudget(ctx, b);
    }
    case "budget-alert-rule": {
      const budgetId = parentResourceId ? externalOf(parentResourceId) : (fields["budgetId"] ?? "");
      if (!budgetId) throw new Error("Pick the budget this alert belongs to.");
      const r = await post<OciAlertRule>(
        "usage",
        `/20190111/budgets/${budgetId}/alertRules`,
        {
          ...(name ? { displayName: name } : {}),
          type: fields["type"] || "ACTUAL",
          thresholdType: fields["thresholdType"] || "PERCENTAGE",
          threshold: Number(fields["threshold"]),
          recipients: recipientsOf(fields["recipients"]),
          ...(fields["message"] ? { message: fields["message"] } : {}),
        },
        ctx.inventory.homeRegion,
      );
      return mapAlertRule(ctx, { ...r, budgetId: r.budgetId || budgetId });
    }
    default:
      throw new Error(`Oracle Cloud plugin: cannot create "${typeId}"`);
  }
}
