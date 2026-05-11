import type {
  SizeOption,
  ImageOption,
  DiskOption,
  RegionOption,
  CreateResourceConfig,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { GCP_REGIONS, REGION_INFO, PUBLIC_IMAGES } from "./regions.js";
import type { GcpCreateContext } from "./create-context.js";

export const computeEngineCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "gce-instance": async (ctx, parentResourceId) => {
    const p = ctx.project;
    // Fetch zones, machine types, account images, and existing disks in parallel
    const [zonesData, machineTypesData, accountImagesData, disksData] = await Promise.all([
      ctx.get<{ items?: Array<{ name: string; status: string; region: string }> }>(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones`,
      ),
      ctx.get<{ items?: Array<{ name: string; guestCpus: number; memoryMb: number }> }>(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones/us-central1-a/machineTypes?maxResults=500`,
      ),
      ctx
        .get<{
          items?: Array<{ name: string; selfLink: string; description?: string; status: string }>;
        }>(`https://compute.googleapis.com/compute/v1/projects/${p}/global/images`)
        .catch(() => ({
          items: [] as Array<{
            name: string;
            selfLink: string;
            description?: string;
            status: string;
          }>,
        })),
      ctx
        .get<{
          items?: Record<
            string,
            {
              disks?: Array<{
                name: string;
                selfLink: string;
                sizeGb: string;
                status: string;
                type: string;
                zone: string;
              }>;
            }
          >;
        }>(`https://compute.googleapis.com/compute/v1/projects/${p}/aggregated/disks`)
        .catch(() => ({ items: {} })),
    ]);

    // Zones
    const zones = (zonesData.items ?? [])
      .filter((z) => z.status === "UP")
      .map((z) => {
        const regionSlug = z.region.split("/").pop() ?? z.region;
        const info = REGION_INFO[regionSlug];
        return {
          id: z.name,
          label: z.name,
          ...(info ? { location: info.location, flag: info.flag } : { location: regionSlug }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    // Machine types grouped by family
    const familyOrder = ["e2", "n1", "n2", "n2d", "c2", "c3", "m1", "m2", "a2", "g2"];
    const familyLabels: Record<string, string> = {
      e2: "E2 · Cost-optimized",
      n1: "N1 · General purpose",
      n2: "N2 · General purpose",
      n2d: "N2D · AMD general purpose",
      c2: "C2 · Compute-optimized",
      c3: "C3 · Compute-optimized",
      m1: "M1 · Memory-optimized",
      m2: "M2 · Memory-optimized",
      a2: "A2 · GPU",
      g2: "G2 · GPU",
    };
    const machineTypes = (machineTypesData.items ?? []).filter((m) => !m.name.includes("custom"));

    // Pre-populate machine type spec cache so getCreateCostEstimate can skip the API call
    for (const m of machineTypes) {
      ctx.machineTypeSpecCache.set(m.name, { guestCpus: m.guestCpus, memoryMb: m.memoryMb });
    }

    const sizes: SizeOption[] = machineTypes
      .map((m) => {
        const family =
          familyOrder.find((f) => m.name.startsWith(f)) ?? m.name.split("-")[0] ?? "other";
        return {
          id: m.name,
          label: m.name,
          vcpus: m.guestCpus,
          memoryMb: m.memoryMb,
          category: familyLabels[family] ?? family.toUpperCase(),
        };
      })
      .sort((a, b) => {
        const ai = familyOrder.indexOf(a.category?.split(" ")[0]?.toLowerCase() ?? "");
        const bi = familyOrder.indexOf(b.category?.split(" ")[0]?.toLowerCase() ?? "");
        if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return a.vcpus - b.vcpus || a.memoryMb - b.memoryMb;
      });

    // Images: public families + account-owned
    const accountImages: ImageOption[] = (accountImagesData.items ?? [])
      .filter((i) => i.status === "READY")
      .map((i) => ({
        id: i.selfLink,
        label: i.name,
        ...(i.description ? { description: i.description } : {}),
        category: "My Images",
        isOwned: true as const,
      }));
    const images: ImageOption[] = [...PUBLIC_IMAGES, ...accountImages];

    // Existing disks from aggregated list
    const disks: DiskOption[] = [];
    for (const zoneData of Object.values(disksData.items ?? {}) as Array<{
      disks?: Array<{
        name: string;
        selfLink: string;
        sizeGb: string;
        status: string;
        type: string;
        zone: string;
      }>;
    }>) {
      for (const d of zoneData.disks ?? []) {
        if (d.status !== "READY") continue;
        const zone = d.zone.split("/").pop() ?? d.zone;
        const diskType = d.type.split("/").pop() ?? "";
        disks.push({ id: d.selfLink, label: d.name, sizeGb: Number(d.sizeGb), zone, diskType });
      }
    }
    disks.sort((a, b) => a.label.localeCompare(b.label));
    const defaultZone = zones.find((z) => z.id === "us-central1-a")?.id ?? zones[0]?.id;

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "zone",
          label: "Zone",
          kind: "region-picker",
          required: true,
          regions: zones,
          ...(defaultZone ? { defaultValue: defaultZone } : {}),
        },
        {
          key: "machineType",
          label: "Machine Type",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: "e2-medium",
        },
        {
          key: "bootSource",
          label: "Boot Disk",
          kind: "select",
          required: true,
          defaultValue: "new-image",
          options: [
            { id: "new-image", label: "New disk from OS image" },
            { id: "existing-disk", label: "Existing persistent disk" },
          ],
        },
        {
          key: "image",
          label: "OS Image",
          kind: "image-picker",
          required: true,
          images,
          defaultValue: "projects/debian-cloud/global/images/family/debian-12",
          showWhen: { fieldKey: "bootSource", fieldValue: "new-image" },
        },
        {
          key: "diskGb",
          label: "Boot Disk Size",
          kind: "disk-slider",
          required: false,
          minGb: 10,
          maxGb: 2000,
          defaultGb: 50,
          stepGb: 10,
          showWhen: { fieldKey: "bootSource", fieldValue: "new-image" },
        },
        {
          key: "existingDisk",
          label: "Select Disk",
          kind: "disk-picker",
          required: true,
          disks,
          showWhen: { fieldKey: "bootSource", fieldValue: "existing-disk" },
        },
        { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
        {
          key: "addExtraDisk",
          label: "Extra Persistent Disk",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [
            { id: "false", label: "None" },
            { id: "true", label: "Add an extra disk" },
          ],
        },
        {
          key: "extraDiskSizeGb",
          label: "Extra Disk Size",
          kind: "disk-slider",
          required: false,
          minGb: 10,
          maxGb: 2000,
          defaultGb: 100,
          stepGb: 10,
          showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
        },
        {
          key: "extraDiskType",
          label: "Extra Disk Type",
          kind: "select",
          required: false,
          defaultValue: "pd-balanced",
          options: [
            { id: "pd-balanced", label: "Balanced Persistent Disk" },
            { id: "pd-ssd", label: "SSD Persistent Disk" },
            { id: "pd-standard", label: "Standard Persistent Disk" },
          ],
          showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network to attach the instance to",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
        {
          key: "firewall",
          label: "Firewall Rule",
          kind: "resource-picker",
          required: false,
          description:
            "Apply an existing firewall rule. The rule's target tags are added to the VM.",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "firewall-rule", outputKey: "name" },
          ],
        },
        {
          key: "tags",
          label: "Network Tags",
          kind: "text",
          required: false,
          description: "Comma-separated firewall tags (e.g. http-server,allow-ssh)",
        },
      ],
    };
  },
  "gce-disk": async (ctx, parentResourceId) => {
    const p = ctx.project;
    const zonesData = await ctx.get<{
      items?: Array<{ name: string; status: string; region: string }>;
    }>(`https://compute.googleapis.com/compute/v1/projects/${p}/zones`);
    const zones = (zonesData.items ?? [])
      .filter((z) => z.status === "UP")
      .map((z) => {
        const regionSlug = z.region.split("/").pop() ?? z.region;
        const info = REGION_INFO[regionSlug];
        return {
          id: z.name,
          label: z.name,
          ...(info ? { location: info.location, flag: info.flag } : { location: regionSlug }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const defaultZone = zones.find((z) => z.id === "us-central1-a")?.id ?? zones[0]?.id;

    return {
      fields: [
        {
          key: "name",
          label: "Disk Name",
          kind: "text",
          required: true,
        },
        {
          key: "zone",
          label: "Zone",
          kind: "region-picker",
          required: true,
          regions: zones,
          ...(defaultZone ? { defaultValue: defaultZone } : {}),
        },
        {
          key: "sizeGb",
          label: "Size",
          kind: "disk-slider",
          required: true,
          minGb: 10,
          maxGb: 2000,
          defaultGb: 50,
          stepGb: 10,
        },
        {
          key: "type",
          label: "Disk Type",
          kind: "select",
          required: true,
          options: [
            { id: "pd-balanced", label: "Balanced Persistent Disk" },
            { id: "pd-ssd", label: "SSD Persistent Disk" },
            { id: "pd-standard", label: "Standard Persistent Disk" },
          ],
          defaultValue: "pd-balanced",
        },
      ],
    };
  },
  "static-ip": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Address Name",
          kind: "text",
          required: true,
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
      ],
    };
  },
  "instance-template": async (ctx, parentResourceId) => {
    const machineTypesData = await ctx
      .get<{
        items?: Array<{ name: string; guestCpus: number; memoryMb: number }>;
      }>(
        `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/zones/us-central1-a/machineTypes?maxResults=500`,
      )
      .catch(() => ({
        items: [] as Array<{ name: string; guestCpus: number; memoryMb: number }>,
      }));
    const accountImagesData = await ctx
      .get<{
        items?: Array<{ name: string; selfLink: string; description?: string; status: string }>;
      }>(`https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/images`)
      .catch(() => ({
        items: [] as Array<{
          name: string;
          selfLink: string;
          description?: string;
          status: string;
        }>,
      }));

    const familyOrder = ["e2", "n1", "n2", "n2d", "c2", "c3", "m1", "m2", "a2", "g2"];
    const familyLabels: Record<string, string> = {
      e2: "E2 · Cost-optimized",
      n1: "N1 · General purpose",
      n2: "N2 · General purpose",
      n2d: "N2D · AMD general purpose",
      c2: "C2 · Compute-optimized",
      c3: "C3 · Compute-optimized",
      m1: "M1 · Memory-optimized",
      m2: "M2 · Memory-optimized",
      a2: "A2 · GPU",
      g2: "G2 · GPU",
    };
    const machineTypes = (machineTypesData.items ?? []).filter((m) => !m.name.includes("custom"));
    for (const m of machineTypes) {
      ctx.machineTypeSpecCache.set(m.name, { guestCpus: m.guestCpus, memoryMb: m.memoryMb });
    }
    const sizes: SizeOption[] = machineTypes
      .map((m) => {
        const family =
          familyOrder.find((f) => m.name.startsWith(f)) ?? m.name.split("-")[0] ?? "other";
        return {
          id: m.name,
          label: m.name,
          vcpus: m.guestCpus,
          memoryMb: m.memoryMb,
          category: familyLabels[family] ?? family.toUpperCase(),
        };
      })
      .sort((a, b) => {
        const ai = familyOrder.indexOf(a.category?.split(" ")[0]?.toLowerCase() ?? "");
        const bi = familyOrder.indexOf(b.category?.split(" ")[0]?.toLowerCase() ?? "");
        if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return a.vcpus - b.vcpus || a.memoryMb - b.memoryMb;
      });

    const accountImages: ImageOption[] = (accountImagesData.items ?? [])
      .filter((i) => i.status === "READY")
      .map((i) => ({
        id: i.selfLink,
        label: i.name,
        ...(i.description ? { description: i.description } : {}),
        category: "My Images",
        isOwned: true as const,
      }));
    const images: ImageOption[] = [...PUBLIC_IMAGES, ...accountImages];

    return {
      fields: [
        { key: "name", label: "Template Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: false },
        {
          key: "machineType",
          label: "Machine Type",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: "e2-medium",
        },
        {
          key: "image",
          label: "OS Image",
          kind: "image-picker",
          required: true,
          images,
          defaultValue: "projects/debian-cloud/global/images/family/debian-12",
        },
        {
          key: "diskSizeGb",
          label: "Boot Disk Size",
          kind: "disk-slider",
          required: false,
          minGb: 10,
          maxGb: 2000,
          defaultGb: 10,
          stepGb: 10,
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network to attach the template to",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
        { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
        {
          key: "tags",
          label: "Network Tags",
          kind: "text",
          required: false,
          description: "Comma-separated firewall tags (e.g. http-server,allow-ssh)",
        },
      ],
    };
  },
  "instance-group": async (ctx, parentResourceId) => {
    const zonesData = await ctx
      .get<{
        items?: Array<{ name: string; status: string; region: string }>;
      }>(`https://compute.googleapis.com/compute/v1/projects/${ctx.project}/zones`)
      .catch(() => ({
        items: [] as Array<{ name: string; status: string; region: string }>,
      }));
    const zones: RegionOption[] = (zonesData.items ?? [])
      .filter((z) => z.status === "UP")
      .map((z) => {
        const regionSlug = z.region.split("/").pop() ?? z.region;
        const info = REGION_INFO[regionSlug];
        return {
          id: z.name,
          label: z.name,
          ...(info ? { location: info.location, flag: info.flag } : { location: regionSlug }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const defaultZone = zones.find((z) => z.id === "us-central1-a")?.id ?? zones[0]?.id;
    return {
      fields: [
        { key: "name", label: "Group Name", kind: "text", required: true },
        {
          key: "zone",
          label: "Zone",
          kind: "region-picker",
          required: true,
          regions: zones,
          ...(defaultZone ? { defaultValue: defaultZone } : {}),
        },
        {
          key: "instanceTemplate",
          label: "Instance Template",
          kind: "resource-picker",
          required: true,
          description: "Select an existing instance template, or create one first.",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "instance-template", outputKey: "selfLink" },
          ],
        },
        {
          key: "targetSize",
          label: "Target Size",
          kind: "number",
          required: true,
          defaultValue: "1",
        },
      ],
    };
  },
};

export const computeEngineCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "gce-instance": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const zone = fields["zone"] ?? "";
    const machineType = fields["machineType"] ?? "";
    const name = fields["name"] ?? "";
    const tok = await ctx.token();
    const bootSource = fields["bootSource"] ?? "new-image";

    let bootDisk: Record<string, unknown>;
    if (bootSource === "existing-disk") {
      bootDisk = { boot: true, source: fields["existingDisk"] };
    } else {
      const diskSizeGb = Number(fields["diskGb"] ?? 50);
      bootDisk = {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: fields["image"] ?? "projects/debian-cloud/global/images/family/debian-12",
          diskSizeGb: String(diskSizeGb),
        },
      };
    }

    // SSH key → GCP metadata format: "username:ssh-rsa AAAA..."
    let metadata: Record<string, unknown> | undefined;
    const sshPub = fields["sshPublicKey"];
    if (sshPub) {
      const comment = sshPub.trim().split(" ")[2] ?? "";
      const username = comment.split("@")[0] || "user";
      metadata = { items: [{ key: "ssh-keys", value: `${username}:${sshPub.trim()}` }] };
    }

    const network = fields["network"] || "global/networks/default";
    const disks: Record<string, unknown>[] = [bootDisk];
    if (fields["addExtraDisk"] === "true") {
      const extraSize = Number(fields["extraDiskSizeGb"] ?? 100);
      const extraType = fields["extraDiskType"] || "pd-balanced";
      disks.push({
        boot: false,
        autoDelete: false,
        initializeParams: {
          diskName: `${name}-data`,
          diskSizeGb: String(extraSize),
          diskType: `zones/${zone}/diskTypes/${extraType}`,
        },
      });
    }
    // Build the VM tag list. Manual "tags" field + any targetTags from a
    // chosen firewall rule are merged and deduped.
    const manualTags = (fields["tags"] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const firewallName = fields["firewall"]?.trim() ?? "";
    let firewallTags: string[] = [];
    if (firewallName) {
      try {
        const fw = await ctx.get<{ targetTags?: string[] }>(
          `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls/${firewallName}`,
        );
        firewallTags = fw.targetTags ?? [];
      } catch {
        /* firewall fetch failed — skip silently; user's manual tags still apply */
      }
    }
    const tagItems = Array.from(new Set([...manualTags, ...firewallTags]));

    const body: Record<string, unknown> = {
      name,
      machineType: `zones/${zone}/machineTypes/${machineType}`,
      disks,
      networkInterfaces: [
        {
          network,
          accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
        },
      ],
      ...(metadata ? { metadata } : {}),
      ...(tagItems.length > 0 ? { tags: { items: tagItems } } : {}),
    };
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instances`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`GCP Compute API ${res.status}: ${await res.text()}`);
    }
    // The API returns an Operation, not the instance directly — return a stub and let the user refresh
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "gce-instance", `${p}/${zone}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "gce-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        zone,
        machineType,
        status: "PROVISIONING",
        sshUsername: sshPub ? sshPub.trim().split(" ")[2]?.split("@")[0] || "user" : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
  "gce-disk": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const zone = fields["zone"] ?? "";
    const sizeGb = fields["sizeGb"] ?? "50";
    const diskType = fields["type"] ?? "pd-balanced";

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/disks`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          sizeGb,
          type: `zones/${zone}/diskTypes/${diskType}`,
        }),
      },
    );
    if (!res.ok) throw new Error(`GCE Disk API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "gce-disk", `${p}/${zone}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "gce-disk",
      accountId,
      displayName: name,
      fields: {
        name,
        zone,
        sizeGb: Number(sizeGb),
        type: diskType,
        status: "CREATING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${zone}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
  "static-ip": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "";

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/addresses`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      },
    );
    if (!res.ok) throw new Error(`Static IP API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "static-ip", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "static-ip",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        address: "",
        addressType: "EXTERNAL",
        status: "RESERVING",
        networkTier: "PREMIUM",
        ipVersion: "IPV4",
      },
      resolvedOutputs: { address: "" },
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
  "instance-template": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const description = fields["description"] ?? "";
    const machineType = fields["machineType"] ?? "e2-medium";
    const sourceImage = fields["image"] ?? "projects/debian-cloud/global/images/family/debian-12";
    const diskSizeGb = Number(fields["diskSizeGb"] ?? 10);
    const network = fields["network"] || "global/networks/default";
    const sshPub = fields["sshPublicKey"]?.trim() ?? "";
    const tagsInput = (fields["tags"] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const tok = await ctx.token();
    const properties: Record<string, unknown> = {
      machineType,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage,
            diskSizeGb: String(diskSizeGb),
          },
        },
      ],
      networkInterfaces: [
        {
          network,
          accessConfigs: [{ type: "ONE_TO_ONE_NAT", name: "External NAT" }],
        },
      ],
    };
    if (sshPub) {
      const comment = sshPub.split(" ")[2] ?? "";
      const username = comment.split("@")[0] || "user";
      properties["metadata"] = {
        items: [{ key: "ssh-keys", value: `${username}:${sshPub}` }],
      };
    }
    if (tagsInput.length > 0) {
      properties["tags"] = { items: tagsInput };
    }
    const body: Record<string, unknown> = {
      name,
      ...(description ? { description } : {}),
      properties,
    };
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/instanceTemplates`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok)
      throw new Error(`Instance Template create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    const selfLink = `https://www.googleapis.com/compute/v1/projects/${p}/global/instanceTemplates/${name}`;
    return {
      id: ctx.id(accountId, "instance-template", name),
      pluginId: "gcp",
      resourceTypeId: "instance-template",
      accountId,
      displayName: name,
      fields: {
        name,
        machineType,
        sourceImage: sourceImage.split("/").pop() ?? sourceImage,
        diskSizeGb,
        description,
      },
      resolvedOutputs: { selfLink },
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
  "instance-group": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const zone = fields["zone"] ?? "";
    const instanceTemplate = fields["instanceTemplate"] ?? "";
    const targetSize = Number(fields["targetSize"] ?? "1");
    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/zones/${zone}/instanceGroupManagers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          instanceTemplate,
          targetSize,
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Instance Group create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "instance-group", `${zone}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "instance-group",
      accountId,
      displayName: name,
      fields: {
        name,
        zone,
        region: "",
        size: targetSize,
        isManaged: true,
        targetSize,
        instanceTemplate: instanceTemplate.split("/").pop() ?? instanceTemplate,
        status: "CREATING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${zone}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  },
};
