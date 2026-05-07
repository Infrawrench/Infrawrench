import yaml from "js-yaml";
import type {
  CreateFieldConfig,
  CreateResourceConfig,
  SizeOption,
  ImageOption,
  DiskOption,
  RegionOption,
  PolicyOption,
  ResourceInstance,
} from "@infrawrench/plugin-base";
import { formatGcpError } from "./utils.js";
import {
  GCP_REGIONS,
  REGION_INFO,
  regionOption,
  PUBLIC_IMAGES,
  CLOUD_BUILD_REGIONS,
} from "./regions.js";
import { engineInfoFromVersion } from "./cloudsql-engine.js";

export interface GcpCreateContext {
  get<T>(url: string): Promise<T>;
  paginate<T>(baseUrl: string, key: string, params?: Record<string, string>): Promise<T[]>;
  token(): Promise<string>;
  project: string;
  id(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  machineTypeSpecCache: Map<string, { guestCpus: number; memoryMb: number }>;
}

/** CRC-32 (ISO 3309) for ZIP file construction */
function crc32cf(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a (stored, uncompressed) ZIP archive from a list of named files. */
function buildZipArchive(files: { name: string; content: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((f) => {
    const nameBytes = encoder.encode(f.name);
    const data = encoder.encode(f.content);
    return { nameBytes, data, crc: crc32cf(data) };
  });

  let totalLocal = 0;
  for (const e of entries) totalLocal += 30 + e.nameBytes.length + e.data.length;
  let totalCentral = 0;
  for (const e of entries) totalCentral += 46 + e.nameBytes.length;

  const out = new Uint8Array(totalLocal + totalCentral + 22);
  const offsets: number[] = [];
  let p = 0;

  for (const e of entries) {
    offsets.push(p);
    const ldv = new DataView(out.buffer, p, 30);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0, true);
    ldv.setUint16(8, 0, true);
    ldv.setUint16(10, 0, true);
    ldv.setUint16(12, 0, true);
    ldv.setUint32(14, e.crc, true);
    ldv.setUint32(18, e.data.length, true);
    ldv.setUint32(22, e.data.length, true);
    ldv.setUint16(26, e.nameBytes.length, true);
    ldv.setUint16(28, 0, true);
    out.set(e.nameBytes, p + 30);
    out.set(e.data, p + 30 + e.nameBytes.length);
    p += 30 + e.nameBytes.length + e.data.length;
  }

  const centralStart = p;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const cdv = new DataView(out.buffer, p, 46);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0, true);
    cdv.setUint16(10, 0, true);
    cdv.setUint16(12, 0, true);
    cdv.setUint16(14, 0, true);
    cdv.setUint32(16, e.crc, true);
    cdv.setUint32(20, e.data.length, true);
    cdv.setUint32(24, e.data.length, true);
    cdv.setUint16(28, e.nameBytes.length, true);
    cdv.setUint16(30, 0, true);
    cdv.setUint16(32, 0, true);
    cdv.setUint16(34, 0, true);
    cdv.setUint16(36, 0, true);
    cdv.setUint32(38, 0, true);
    cdv.setUint32(42, offsets[i]!, true);
    out.set(e.nameBytes, p + 46);
    p += 46 + e.nameBytes.length;
  }

  const ev = new DataView(out.buffer, p, 22);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, p - centralStart, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);

  return out;
}

export async function gcpGetCreateConfig(
  ctx: GcpCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  const p = ctx.project;
  if (typeId === "gce-instance") {
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
  }

  if (typeId === "gke-cluster") {
    const [zonesData, machineTypesData, serverConfig] = await Promise.all([
      ctx.get<{ items?: Array<{ name: string; status: string; region: string }> }>(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones`,
      ),
      ctx.get<{ items?: Array<{ name: string; guestCpus: number; memoryMb: number }> }>(
        `https://compute.googleapis.com/compute/v1/projects/${p}/zones/us-central1-a/machineTypes?maxResults=500`,
      ),
      ctx.get<{
        defaultClusterVersion?: string;
        validMasterVersions?: string[];
      }>(`https://container.googleapis.com/v1/projects/${p}/locations/us-central1-a/serverConfig`),
    ]);

    const locations = (zonesData.items ?? [])
      .filter((zone) => zone.status === "UP")
      .map((zone) => {
        const regionSlug = zone.region.split("/").pop() ?? zone.region;
        const info = REGION_INFO[regionSlug];
        return {
          id: zone.name,
          label: zone.name,
          ...(info ? { location: info.location, flag: info.flag } : { location: regionSlug }),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const machineTypes = (machineTypesData.items ?? []).filter((m) => !m.name.includes("custom"));

    // Pre-populate machine type spec cache for GKE cost estimates
    for (const m of machineTypes) {
      ctx.machineTypeSpecCache.set(m.name, { guestCpus: m.guestCpus, memoryMb: m.memoryMb });
    }

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
    const sizes: SizeOption[] = machineTypes
      .map((machineType) => {
        const family =
          familyOrder.find((candidate) => machineType.name.startsWith(candidate)) ??
          machineType.name.split("-")[0] ??
          "other";
        return {
          id: machineType.name,
          label: machineType.name,
          vcpus: machineType.guestCpus,
          memoryMb: machineType.memoryMb,
          category: familyLabels[family] ?? family.toUpperCase(),
        };
      })
      .sort((a, b) => {
        const ai = familyOrder.indexOf(a.category?.split(" ")[0]?.toLowerCase() ?? "");
        const bi = familyOrder.indexOf(b.category?.split(" ")[0]?.toLowerCase() ?? "");
        if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        return a.vcpus - b.vcpus || a.memoryMb - b.memoryMb;
      });
    const versions = (serverConfig.validMasterVersions ?? []).map((version) => ({
      id: version,
      label: version,
    }));
    const defaultLocation =
      locations.find((location) => location.id === "us-central1-a")?.id ?? locations[0]?.id;
    const defaultVersion = serverConfig.defaultClusterVersion ?? versions[0]?.id;

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: locations,
          ...(defaultLocation ? { defaultValue: defaultLocation } : {}),
        },
        {
          key: "version",
          label: "Kubernetes Version",
          kind: "select",
          required: true,
          options: versions,
          ...(defaultVersion ? { defaultValue: defaultVersion } : {}),
        },
        {
          key: "machineType",
          label: "Node Machine Type",
          kind: "size-picker",
          required: true,
          sizes,
          defaultValue: "e2-medium",
        },
        {
          key: "diskSizeGb",
          label: "Disk Per Node",
          kind: "disk-slider",
          required: false,
          minGb: 10,
          maxGb: 2048,
          defaultGb: 100,
          stepGb: 10,
          description: "Persistent disk size attached to each node.",
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "3",
          minValue: 1,
          stepValue: 1,
          description: "Initial number of nodes in the default node pool.",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network to deploy the cluster in",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  }

  if (typeId === "gcs-bucket") {
    return {
      fields: [
        {
          key: "name",
          label: "Bucket Name",
          kind: "text",
          required: true,
          description: "Globally unique bucket name",
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: [
            { id: "US", label: "US (multi-region)" },
            { id: "EU", label: "EU (multi-region)" },
            { id: "ASIA", label: "Asia (multi-region)" },
            regionOption("us-central1"),
            regionOption("us-east1"),
            regionOption("us-west1"),
            regionOption("europe-west1"),
            regionOption("europe-west4"),
            regionOption("asia-east1"),
            regionOption("asia-southeast1"),
          ],
          defaultValue: "US",
        },
        {
          key: "storageClass",
          label: "Storage Class",
          kind: "select",
          required: true,
          options: [
            { id: "STANDARD", label: "Standard" },
            { id: "NEARLINE", label: "Nearline" },
            { id: "COLDLINE", label: "Coldline" },
            { id: "ARCHIVE", label: "Archive" },
          ],
          defaultValue: "STANDARD",
        },
      ],
    };
  }

  if (typeId === "cloudsql-instance") {
    return {
      fields: [
        { key: "name", label: "Instance Name", kind: "text", required: true },
        {
          key: "databaseVersion",
          label: "Database Version",
          kind: "select",
          required: true,
          options: [
            { id: "POSTGRES_18", label: "PostgreSQL 18" },
            { id: "POSTGRES_17", label: "PostgreSQL 17" },
            { id: "POSTGRES_16", label: "PostgreSQL 16" },
            { id: "POSTGRES_15", label: "PostgreSQL 15" },
            { id: "POSTGRES_14", label: "PostgreSQL 14" },
            { id: "MYSQL_8_4", label: "MySQL 8.4" },
            { id: "MYSQL_8_0", label: "MySQL 8.0" },
            { id: "MYSQL_5_7", label: "MySQL 5.7" },
            { id: "SQLSERVER_2022_ENTERPRISE", label: "SQL Server 2022 Enterprise" },
            { id: "SQLSERVER_2022_STANDARD", label: "SQL Server 2022 Standard" },
            { id: "SQLSERVER_2022_EXPRESS", label: "SQL Server 2022 Express" },
            { id: "SQLSERVER_2022_WEB", label: "SQL Server 2022 Web" },
            { id: "SQLSERVER_2019_ENTERPRISE", label: "SQL Server 2019 Enterprise" },
            { id: "SQLSERVER_2019_STANDARD", label: "SQL Server 2019 Standard" },
            { id: "SQLSERVER_2019_EXPRESS", label: "SQL Server 2019 Express" },
            { id: "SQLSERVER_2019_WEB", label: "SQL Server 2019 Web" },
            { id: "SQLSERVER_2017_ENTERPRISE", label: "SQL Server 2017 Enterprise" },
            { id: "SQLSERVER_2017_STANDARD", label: "SQL Server 2017 Standard" },
            { id: "SQLSERVER_2017_EXPRESS", label: "SQL Server 2017 Express" },
            { id: "SQLSERVER_2017_WEB", label: "SQL Server 2017 Web" },
          ],
          defaultValue: "POSTGRES_18",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "tier",
          label: "Machine Tier",
          kind: "select",
          required: true,
          options: [
            { id: "db-f1-micro", label: "db-f1-micro (shared, 0.6 GB)" },
            { id: "db-g1-small", label: "db-g1-small (shared, 1.7 GB)" },
            { id: "db-n1-standard-1", label: "db-n1-standard-1 (1 vCPU, 3.75 GB)" },
            { id: "db-n1-standard-2", label: "db-n1-standard-2 (2 vCPU, 7.5 GB)" },
            { id: "db-n1-standard-4", label: "db-n1-standard-4 (4 vCPU, 15 GB)" },
            { id: "db-n1-highmem-2", label: "db-n1-highmem-2 (2 vCPU, 13 GB)" },
          ],
          defaultValue: "db-f1-micro",
        },
        {
          key: "diskSizeGb",
          label: "Disk Size (GB)",
          kind: "number",
          required: false,
          defaultValue: "10",
          minValue: 10,
          maxValue: 65536,
        },
        {
          key: "rootPassword",
          label: "Root Password",
          kind: "password",
          required: true,
          description: "Password for the default admin user (postgres / root / sqlserver)",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network for private IP access",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  }

  if (typeId === "pubsub-topic") {
    return {
      fields: [
        {
          key: "name",
          label: "Topic Name",
          kind: "text",
          required: true,
          description: "Topic ID (letters, numbers, hyphens, underscores)",
        },
      ],
    };
  }

  if (typeId === "pubsub-subscription") {
    const p = ctx.project;
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [
      {
        key: "name",
        label: "Subscription Name",
        kind: "text",
        required: true,
      },
    ];
    if (!hasParent) {
      const topics = await ctx.paginate<Record<string, unknown>>(
        `https://pubsub.googleapis.com/v1/projects/${p}/topics`,
        "topics",
      );
      const topicOptions = topics.map((t) => {
        const fullName = String(t["name"] ?? "");
        const shortName = fullName.split("/").pop() ?? fullName;
        return { id: fullName, label: shortName };
      });
      fields.push({
        key: "topic",
        label: "Topic",
        kind: "select",
        required: true,
        options: topicOptions,
        ...(topicOptions[0] ? { defaultValue: topicOptions[0].id } : {}),
      });
    }
    fields.push({
      key: "ackDeadlineSeconds",
      label: "Ack Deadline (seconds)",
      kind: "number",
      required: false,
      defaultValue: "10",
      minValue: 10,
      maxValue: 600,
    });
    return { fields };
  }

  if (typeId === "cloud-dns-zone") {
    return {
      fields: [
        {
          key: "name",
          label: "Zone Name",
          kind: "text",
          required: true,
          description: "Internal name (letters, numbers, hyphens)",
        },
        {
          key: "dnsName",
          label: "DNS Name",
          kind: "text",
          required: true,
          description: "Domain name with trailing dot, e.g. example.com.",
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
      ],
    };
  }

  if (typeId === "secret-manager-secret") {
    return {
      fields: [
        {
          key: "name",
          label: "Secret Name",
          kind: "text",
          required: true,
          description: "Secret ID (letters, numbers, hyphens, underscores)",
        },
        {
          key: "initialValue",
          label: "Initial Value",
          kind: "text",
          required: false,
          description: "If set, a first enabled version is added with this value.",
        },
      ],
    };
  }

  if (typeId === "vpc-network") {
    return {
      fields: [
        {
          key: "name",
          label: "Network Name",
          kind: "text",
          required: true,
          description: "Name for the VPC network (letters, numbers, hyphens)",
        },
        {
          key: "autoCreateSubnetworks",
          label: "Auto-create Subnets",
          kind: "select",
          required: true,
          options: [
            { id: "true", label: "Auto mode (one subnet per region)" },
            { id: "false", label: "Custom mode (no subnets created)" },
          ],
          defaultValue: "true",
        },
      ],
    };
  }

  if (typeId === "subnet") {
    return {
      fields: [
        {
          key: "name",
          label: "Subnet Name",
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
        {
          key: "network",
          label: "Network",
          kind: "text",
          required: true,
          description: "VPC network name (e.g. default)",
        },
        {
          key: "ipCidrRange",
          label: "IP CIDR Range",
          kind: "text",
          required: true,
          description: "e.g. 10.0.0.0/24",
        },
      ],
    };
  }

  if (typeId === "firewall-rule") {
    return {
      fields: [
        {
          key: "name",
          label: "Rule Name",
          kind: "text",
          required: true,
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: true,
          description: "VPC network this rule applies to",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
        {
          key: "direction",
          label: "Direction",
          kind: "select",
          required: true,
          options: [
            { id: "INGRESS", label: "Ingress" },
            { id: "EGRESS", label: "Egress" },
          ],
          defaultValue: "INGRESS",
        },
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          options: [
            { id: "tcp", label: "TCP" },
            { id: "udp", label: "UDP" },
            { id: "icmp", label: "ICMP" },
            { id: "all", label: "All" },
          ],
          defaultValue: "tcp",
        },
        {
          key: "ports",
          label: "Ports",
          kind: "text",
          required: false,
          description: "Comma-separated ports or ranges (e.g. 80,443,8000-9000)",
        },
        {
          key: "sourceRanges",
          label: "Source Ranges",
          kind: "text",
          required: false,
          description: "Comma-separated CIDRs (e.g. 0.0.0.0/0)",
        },
      ],
    };
  }

  if (typeId === "static-ip") {
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
  }

  if (typeId === "gce-disk") {
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
  }

  if (typeId === "artifact-registry-repo") {
    return {
      fields: [
        {
          key: "name",
          label: "Repository Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "format",
          label: "Format",
          kind: "select",
          required: true,
          options: [
            { id: "DOCKER", label: "Docker" },
            { id: "NPM", label: "NPM" },
            { id: "MAVEN", label: "Maven" },
            { id: "PYTHON", label: "Python" },
            { id: "APT", label: "APT" },
            { id: "YUM", label: "YUM" },
            { id: "GO", label: "Go" },
            { id: "HELM", label: "Helm" },
          ],
          defaultValue: "DOCKER",
        },
      ],
    };
  }

  if (typeId === "gcp-service-account") {
    const [predefined, custom] = await Promise.all([
      ctx
        .paginate<Record<string, unknown>>("https://iam.googleapis.com/v1/roles", "roles", {
          view: "BASIC",
          pageSize: "1000",
        })
        .catch(() => []),
      ctx
        .paginate<
          Record<string, unknown>
        >(`https://iam.googleapis.com/v1/projects/${p}/roles`, "roles", { view: "BASIC", pageSize: "1000" })
        .catch(() => []),
    ]);
    const toOption = (r: Record<string, unknown>, category: string): PolicyOption => {
      const name = String(r["name"] ?? "");
      const title = r["title"] ? String(r["title"]) : name;
      const desc = r["description"] ? String(r["description"]) : undefined;
      const stage = r["stage"] ? String(r["stage"]) : undefined;
      const option: PolicyOption = { id: name, label: title, category };
      if (desc) option.description = desc;
      if (stage && stage !== "GA") option.badge = stage;
      return option;
    };
    const policies: PolicyOption[] = [
      ...predefined
        .filter((r) => String(r["stage"] ?? "GA") !== "DEPRECATED")
        .map((r) => toOption(r, "Predefined")),
      ...custom.map((r) => toOption(r, "Custom")),
    ];
    policies.sort((a, b) => a.label.localeCompare(b.label));
    return {
      fields: [
        {
          key: "accountId",
          label: "Account ID",
          kind: "text",
          required: true,
          description:
            "Unique ID for the service account (6-30 characters, lowercase letters, digits, hyphens)",
        },
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: false,
          description: "A user-friendly name for this service account",
        },
        {
          key: "grantedRoles",
          label: "Granted Roles",
          kind: "policy-picker",
          required: false,
          description: "Project-level IAM roles to grant this service account",
          policies,
        },
      ],
    };
  }

  if (typeId === "cloud-dns-record-set") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      const zones = await ctx.paginate<Record<string, unknown>>(
        `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones`,
        "managedZones",
      );
      const zoneOptions = zones.map((z) => ({
        id: String(z["name"]),
        label: String(z["dnsName"] ?? z["name"]),
      }));
      fields.push({
        key: "managedZone",
        label: "Managed Zone",
        kind: "select",
        required: true,
        options: zoneOptions,
        ...(zoneOptions[0] ? { defaultValue: zoneOptions[0].id } : {}),
      });
    }
    fields.push(
      {
        key: "name",
        label: "Record Name",
        kind: "text",
        required: true,
        description: "Fully qualified domain name with trailing dot (e.g. www.example.com.)",
      },
      {
        key: "type",
        label: "Record Type",
        kind: "select",
        required: true,
        options: [
          { id: "A", label: "A" },
          { id: "AAAA", label: "AAAA" },
          { id: "CNAME", label: "CNAME" },
          { id: "MX", label: "MX" },
          { id: "TXT", label: "TXT" },
          { id: "NS", label: "NS" },
          { id: "SRV", label: "SRV" },
        ],
        defaultValue: "A",
      },
      {
        key: "ttl",
        label: "TTL (seconds)",
        kind: "number",
        required: false,
        defaultValue: "300",
        minValue: 1,
        maxValue: 86400,
      },
      {
        key: "rrdatas",
        label: "Data",
        kind: "text",
        required: true,
        description: "Comma-separated record data (e.g. 1.2.3.4)",
      },
    );
    return { fields };
  }

  if (typeId === "cloud-tasks-queue") {
    return {
      fields: [
        {
          key: "name",
          label: "Queue Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
      ],
    };
  }

  if (typeId === "cloud-scheduler-job") {
    return {
      fields: [
        {
          key: "name",
          label: "Job Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "schedule",
          label: "Schedule (cron)",
          kind: "text",
          required: true,
          description: "Cron expression (e.g. */5 * * * *)",
        },
        {
          key: "timeZone",
          label: "Time Zone",
          kind: "select",
          required: false,
          description: "IANA time zone (e.g. America/New_York)",
          options: Intl.supportedValuesOf("timeZone").map((tz) => ({ id: tz, label: tz })),
          defaultValue: "UTC",
        },
        {
          key: "httpUri",
          label: "HTTP Target URI",
          kind: "text",
          required: true,
          description: "The URL that will be called on schedule",
        },
        {
          key: "httpMethod",
          label: "HTTP Method",
          kind: "select",
          required: false,
          options: [
            { id: "POST", label: "POST" },
            { id: "GET", label: "GET" },
            { id: "PUT", label: "PUT" },
            { id: "DELETE", label: "DELETE" },
          ],
          defaultValue: "POST",
        },
      ],
    };
  }

  if (typeId === "kms-key-ring") {
    return {
      fields: [
        {
          key: "name",
          label: "Key Ring Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: [
            { id: "global", label: "Global" },
            regionOption("us-central1"),
            regionOption("us-east1"),
            regionOption("us-west1"),
            regionOption("europe-west1"),
            regionOption("europe-west4"),
            regionOption("asia-east1"),
          ],
          defaultValue: "global",
        },
      ],
    };
  }

  if (typeId === "kms-key") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [
      {
        key: "name",
        label: "Key Name",
        kind: "text",
        required: true,
      },
    ];
    if (!hasParent) {
      fields.push(
        {
          key: "keyRingLocation",
          label: "Key Ring Location",
          kind: "select",
          required: true,
          options: [
            { id: "global", label: "Global" },
            { id: "us-central1", label: "Iowa (us-central1)" },
            { id: "us-east1", label: "South Carolina (us-east1)" },
            { id: "us-west1", label: "Oregon (us-west1)" },
            { id: "europe-west1", label: "Belgium (europe-west1)" },
            { id: "europe-west4", label: "Netherlands (europe-west4)" },
            { id: "asia-east1", label: "Taiwan (asia-east1)" },
          ],
          defaultValue: "global",
        },
        {
          key: "keyRing",
          label: "Key Ring Name",
          kind: "text",
          required: true,
          description: "The name of the key ring to create this key in",
        },
      );
    }
    fields.push(
      {
        key: "purpose",
        label: "Purpose",
        kind: "select",
        required: true,
        options: [
          { id: "ENCRYPT_DECRYPT", label: "Symmetric encrypt/decrypt" },
          { id: "ASYMMETRIC_SIGN", label: "Asymmetric sign" },
          { id: "ASYMMETRIC_DECRYPT", label: "Asymmetric decrypt" },
        ],
        defaultValue: "ENCRYPT_DECRYPT",
      },
      {
        key: "protectionLevel",
        label: "Protection Level",
        kind: "select",
        required: true,
        options: [
          { id: "SOFTWARE", label: "Software" },
          { id: "HSM", label: "HSM" },
        ],
        defaultValue: "SOFTWARE",
      },
    );
    return { fields };
  }

  if (typeId === "log-sink") {
    return {
      fields: [
        {
          key: "name",
          label: "Sink Name",
          kind: "text",
          required: true,
        },
        {
          key: "destination",
          label: "Destination",
          kind: "text",
          required: true,
          description:
            "e.g. storage.googleapis.com/my-bucket or bigquery.googleapis.com/projects/my-project/datasets/my-dataset",
        },
        {
          key: "filter",
          label: "Filter",
          kind: "text",
          required: false,
          description: "Optional log filter expression",
        },
      ],
    };
  }

  if (typeId === "firestore-database") {
    return {
      fields: [
        {
          key: "name",
          label: "Database ID",
          kind: "text",
          required: true,
          description: "Database ID (use '(default)' for the default database)",
        },
        {
          key: "databaseEdition",
          label: "Edition",
          kind: "select",
          required: true,
          options: [
            {
              id: "STANDARD",
              label: "Standard — Firestore's simple query engine with automatic indexing",
            },
            {
              id: "ENTERPRISE",
              label: "Enterprise — Firestore Native + MongoDB-compatible data access",
            },
          ],
          defaultValue: "STANDARD",
        },
        {
          key: "locationId",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: [
            { id: "nam5", label: "United States (nam5)" },
            { id: "eur3", label: "Europe (eur3)" },
            regionOption("us-central1"),
            regionOption("us-east1"),
            regionOption("europe-west1"),
            regionOption("asia-east1"),
          ],
          defaultValue: "nam5",
        },
        {
          key: "type",
          label: "Mode",
          kind: "select",
          required: true,
          description: "Presets that determine how you structure and interact with your data.",
          options: [
            { id: "FIRESTORE_NATIVE", label: "Firestore in Native mode (Firestore SDKs)" },
            {
              id: "DATASTORE_MODE",
              label: "Datastore mode (legacy Datastore compatibility)",
            },
          ],
          defaultValue: "FIRESTORE_NATIVE",
          showWhen: { fieldKey: "databaseEdition", fieldValue: "STANDARD" },
        },
        {
          key: "enterpriseMode",
          label: "Mode",
          kind: "select",
          required: true,
          description: "Presets that determine how you structure and interact with your data.",
          options: [
            {
              id: "mongodb",
              label: "Firestore with MongoDB compatibility",
            },
            {
              id: "native",
              label: "Firestore in Native mode (Firestore SDKs + Pipeline queries)",
            },
          ],
          defaultValue: "mongodb",
          showWhen: { fieldKey: "databaseEdition", fieldValue: "ENTERPRISE" },
        },
      ],
    };
  }

  if (typeId === "memorystore-redis") {
    return {
      fields: [
        {
          key: "name",
          label: "Instance Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "tier",
          label: "Tier",
          kind: "select",
          required: true,
          options: [
            { id: "BASIC", label: "Basic" },
            { id: "STANDARD_HA", label: "Standard (HA)" },
          ],
          defaultValue: "BASIC",
        },
        {
          key: "memorySizeGb",
          label: "Memory (GB)",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 300,
        },
      ],
    };
  }

  if (typeId === "bigquery-dataset") {
    return {
      fields: [
        {
          key: "datasetId",
          label: "Dataset ID",
          kind: "text",
          required: true,
          description: "Letters, numbers, underscores (e.g. my_dataset)",
        },
        {
          key: "location",
          label: "Location",
          kind: "region-picker",
          required: true,
          regions: [
            { id: "US", label: "US (multi-region)" },
            { id: "EU", label: "EU (multi-region)" },
            regionOption("us-central1"),
            regionOption("us-east1"),
            regionOption("europe-west1"),
            regionOption("europe-west4"),
            regionOption("asia-east1"),
          ],
          defaultValue: "US",
        },
      ],
    };
  }

  if (typeId === "bigquery-table") {
    return {
      fields: [
        {
          key: "datasetId",
          label: "Dataset ID",
          kind: "text",
          required: true,
          description:
            "The parent dataset. When creating from a dataset's detail view, this is prefilled.",
        },
        {
          key: "tableId",
          label: "Table ID",
          kind: "text",
          required: true,
          description: "Letters, numbers, underscores (e.g. events)",
        },
        {
          key: "schemaJson",
          label: "Schema (JSON)",
          kind: "text",
          required: false,
          multiline: true,
          description:
            "BigQuery schema as a JSON array of fields. Leave blank to create an empty table.",
          placeholder:
            '[\n  {"name": "id", "type": "STRING", "mode": "REQUIRED"},\n  {"name": "created_at", "type": "TIMESTAMP"}\n]',
        },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
        {
          key: "expirationMs",
          label: "Table expiration (blank = never)",
          kind: "datetime",
          datetimeMode: "epoch-ms",
          required: false,
        },
      ],
    };
  }

  if (typeId === "spanner-instance") {
    return {
      fields: [
        {
          key: "name",
          label: "Instance Name",
          kind: "text",
          required: true,
        },
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: true,
        },
        {
          key: "config",
          label: "Instance Config",
          kind: "select",
          required: true,
          options: [
            { id: "regional-us-central1", label: "Regional US Central1" },
            { id: "regional-us-east1", label: "Regional US East1" },
            { id: "regional-us-west1", label: "Regional US West1" },
            { id: "regional-europe-west1", label: "Regional Europe West1" },
            { id: "regional-asia-east1", label: "Regional Asia East1" },
            { id: "nam6", label: "Multi-region NAM6" },
            { id: "nam-eur-asia1", label: "Multi-region NAM-EUR-ASIA1" },
          ],
          defaultValue: "regional-us-central1",
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          stepValue: 1,
        },
      ],
    };
  }

  if (typeId === "spanner-database") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      fields.push({
        key: "instance",
        label: "Instance",
        kind: "text",
        required: true,
        description: "The parent Spanner instance ID.",
      });
    }
    fields.push(
      {
        key: "name",
        label: "Database Name",
        kind: "text",
        required: true,
        description:
          "Between 2 and 30 characters, starting with a letter. Lowercase letters, numbers, hyphens, and underscores allowed.",
      },
      {
        key: "dialect",
        label: "Dialect",
        kind: "select",
        required: true,
        options: [
          { id: "GOOGLE_STANDARD_SQL", label: "Google Standard SQL" },
          { id: "POSTGRESQL", label: "PostgreSQL" },
        ],
        defaultValue: "GOOGLE_STANDARD_SQL",
      },
      {
        key: "ddl",
        label: "Schema (DDL)",
        kind: "text",
        required: false,
        multiline: true,
        description:
          "Optional Data Definition Language statements separated by semicolons. Leave blank to create an empty database.",
        placeholder:
          "CREATE TABLE Users (\n  UserId STRING(36) NOT NULL,\n  CreatedAt TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),\n) PRIMARY KEY (UserId);",
      },
    );
    return { fields };
  }

  if (typeId === "spanner-backup") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      fields.push({
        key: "instance",
        label: "Instance",
        kind: "text",
        required: true,
        description: "The parent Spanner instance ID.",
      });
    }
    fields.push(
      {
        key: "name",
        label: "Backup ID",
        kind: "text",
        required: true,
        description: "A unique name for the backup within the instance.",
      },
      {
        key: "database",
        label: "Source Database",
        kind: "text",
        required: true,
        description: "The database ID to back up.",
      },
      {
        key: "expireTime",
        label: "Expire Time",
        kind: "datetime",
        datetimeMode: "datetime",
        required: true,
        description: "When the backup should expire. Must be 6 hours to 1 year from now.",
      },
    );
    return { fields };
  }

  if (typeId === "bigtable-instance") {
    return {
      fields: [
        {
          key: "instanceId",
          label: "Instance ID",
          kind: "text",
          required: true,
        },
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: true,
        },
        {
          key: "instanceType",
          label: "Instance Type",
          kind: "select",
          required: true,
          options: [
            { id: "PRODUCTION", label: "Production" },
            { id: "DEVELOPMENT", label: "Development" },
          ],
          defaultValue: "PRODUCTION",
        },
        {
          key: "clusterLocation",
          label: "Cluster Location",
          kind: "region-picker",
          required: true,
          regions: [
            regionOption("us-central1-b"),
            regionOption("us-east1-c"),
            regionOption("us-west1-b"),
            regionOption("europe-west1-b"),
            regionOption("asia-east1-a"),
          ],
          defaultValue: "us-central1-b",
        },
      ],
    };
  }

  if (typeId === "filestore-instance") {
    return {
      fields: [
        {
          key: "name",
          label: "Instance Name",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Zone",
          kind: "region-picker",
          required: true,
          regions: [
            regionOption("us-central1-a"),
            regionOption("us-central1-b"),
            regionOption("us-east1-b"),
            regionOption("us-west1-a"),
            regionOption("europe-west1-b"),
            regionOption("europe-west4-a"),
            regionOption("asia-east1-a"),
          ],
          defaultValue: "us-central1-a",
        },
        {
          key: "tier",
          label: "Tier",
          kind: "select",
          required: true,
          options: [
            { id: "BASIC_HDD", label: "Basic HDD" },
            { id: "BASIC_SSD", label: "Basic SSD" },
            { id: "HIGH_SCALE_SSD", label: "High Scale SSD" },
            { id: "ENTERPRISE", label: "Enterprise" },
          ],
          defaultValue: "BASIC_HDD",
        },
        {
          key: "fileShareName",
          label: "File Share Name",
          kind: "text",
          required: true,
          description: "Name of the file share (e.g. vol1)",
        },
        {
          key: "capacityGb",
          label: "Capacity (GB)",
          kind: "number",
          required: true,
          defaultValue: "1024",
          minValue: 1024,
          maxValue: 65536,
        },
      ],
    };
  }

  if (typeId === "cloud-router") {
    return {
      fields: [
        {
          key: "name",
          label: "Router Name",
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
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: true,
          description: "VPC network the router attaches to",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  }

  if (typeId === "health-check") {
    return {
      fields: [
        {
          key: "name",
          label: "Health Check Name",
          kind: "text",
          required: true,
        },
        {
          key: "type",
          label: "Type",
          kind: "select",
          required: true,
          options: [
            { id: "HTTP", label: "HTTP" },
            { id: "HTTPS", label: "HTTPS" },
            { id: "TCP", label: "TCP" },
          ],
          defaultValue: "HTTP",
        },
        {
          key: "port",
          label: "Port",
          kind: "number",
          required: true,
          defaultValue: "80",
          minValue: 1,
          maxValue: 65535,
        },
        {
          key: "checkIntervalSec",
          label: "Check Interval (s)",
          kind: "number",
          required: false,
          defaultValue: "5",
          minValue: 1,
          maxValue: 300,
        },
      ],
    };
  }

  if (typeId === "alloydb-cluster") {
    return {
      fields: [
        {
          key: "clusterId",
          label: "Cluster ID",
          kind: "text",
          required: true,
        },
        {
          key: "location",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: true,
          description: "VPC network for private service access",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
        {
          key: "rootPassword",
          label: "Postgres Password",
          kind: "password",
          required: true,
          description: "Password for the default 'postgres' user",
        },
      ],
    };
  }

  if (typeId === "alloydb-instance") {
    return {
      fields: [
        {
          key: "instanceId",
          label: "Instance ID",
          kind: "text",
          required: true,
        },
        {
          key: "instanceType",
          label: "Instance Type",
          kind: "select",
          required: true,
          options: [
            { id: "PRIMARY", label: "Primary" },
            { id: "READ_POOL", label: "Read pool" },
          ],
          defaultValue: "PRIMARY",
          description:
            "A cluster needs exactly one PRIMARY before it can be reached. Add READ_POOL instances for read scaling.",
        },
        {
          key: "cpuCount",
          label: "vCPU Count",
          kind: "select",
          required: true,
          options: [
            { id: "2", label: "2 vCPU" },
            { id: "4", label: "4 vCPU" },
            { id: "8", label: "8 vCPU" },
            { id: "16", label: "16 vCPU" },
            { id: "32", label: "32 vCPU" },
            { id: "64", label: "64 vCPU" },
          ],
          defaultValue: "2",
        },
      ],
    };
  }

  if (typeId === "alert-policy") {
    const [descriptors, resourceDescriptors] = await Promise.all([
      ctx
        .paginate<{
          type?: string;
          displayName?: string;
        }>(
          `https://monitoring.googleapis.com/v3/projects/${p}/metricDescriptors`,
          "metricDescriptors",
          { pageSize: "1000" },
        )
        .catch(() => [] as Array<{ type?: string; displayName?: string }>),
      ctx
        .paginate<{
          type?: string;
          displayName?: string;
        }>(
          `https://monitoring.googleapis.com/v3/projects/${p}/monitoredResourceDescriptors`,
          "resourceDescriptors",
        )
        .catch(() => [] as Array<{ type?: string; displayName?: string }>),
    ]);

    const metricOptions = descriptors
      .filter(
        (d): d is { type: string; displayName?: string } =>
          typeof d.type === "string" && d.type.length > 0,
      )
      .map((d) => ({
        id: d.type,
        label: d.displayName?.trim() || d.type,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const resourceTypeOptions = resourceDescriptors
      .filter(
        (d): d is { type: string; displayName?: string } =>
          typeof d.type === "string" && d.type.length > 0,
      )
      .map((d) => ({
        id: d.type,
        label: d.displayName?.trim() ? `${d.displayName.trim()} (${d.type})` : d.type,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return {
      fields: [
        {
          key: "displayName",
          label: "Display Name",
          kind: "text",
          required: true,
        },
        {
          key: "conditionDisplayName",
          label: "Condition Name",
          kind: "text",
          required: true,
          description: "Display name for the alert condition",
        },
        {
          key: "metricType",
          label: "Metric Type",
          kind: "select",
          required: true,
          options: metricOptions,
          description: "e.g. compute.googleapis.com/instance/cpu/utilization",
        },
        {
          key: "resourceType",
          label: "Resource Type",
          kind: "select",
          required: true,
          options: resourceTypeOptions,
          defaultValue: "global",
          description: "Monitored resource that emits this metric (e.g. gce_instance, global)",
        },
        {
          key: "thresholdValue",
          label: "Threshold Value",
          kind: "number",
          required: true,
          defaultValue: "0.8",
          description: "Threshold at which to trigger the alert",
        },
        {
          key: "comparisonType",
          label: "Comparison",
          kind: "select",
          required: true,
          options: [
            { id: "COMPARISON_GT", label: "Greater than" },
            { id: "COMPARISON_LT", label: "Less than" },
            { id: "COMPARISON_GE", label: "Greater or equal" },
            { id: "COMPARISON_LE", label: "Less or equal" },
          ],
          defaultValue: "COMPARISON_GT",
        },
        {
          key: "duration",
          label: "Duration (seconds)",
          kind: "number",
          required: false,
          defaultValue: "60",
          description: "How long the condition must be true before alerting",
        },
      ],
    };
  }

  if (typeId === "cloud-run-service") {
    const regionsData = await ctx
      .get<{
        items?: Array<{ name: string; status: string }>;
      }>(`https://run.googleapis.com/v2/projects/${ctx.project}/locations`)
      .catch(() => ({
        items: [] as Array<{ name: string; status: string }>,
      }));
    const dynamicRegionIds = (regionsData.items ?? [])
      .map((r) => r.name?.split("/").pop())
      .filter((id): id is string => !!id);
    const regionOptions: RegionOption[] =
      dynamicRegionIds.length > 0
        ? dynamicRegionIds.map((id) => GCP_REGIONS.find((r) => r.id === id) ?? { id, label: id })
        : GCP_REGIONS;
    return {
      fields: [
        { key: "name", label: "Service Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          defaultValue: "us-central1",
        },
        {
          key: "image",
          label: "Container Image",
          kind: "text",
          required: true,
          description: "Container image URL (e.g. gcr.io/project/image:tag)",
        },
        {
          key: "port",
          label: "Container Port",
          kind: "number",
          required: false,
          defaultValue: "8080",
        },
        {
          key: "ingress",
          label: "Ingress",
          kind: "select",
          required: false,
          options: [
            { id: "INGRESS_TRAFFIC_ALL", label: "All traffic" },
            { id: "INGRESS_TRAFFIC_INTERNAL_ONLY", label: "Internal only" },
            { id: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER", label: "Internal load balancer" },
          ],
          defaultValue: "INGRESS_TRAFFIC_ALL",
        },
        {
          key: "network",
          label: "VPC Network",
          kind: "resource-picker",
          required: false,
          description: "VPC network for private service access",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "vpc-network", outputKey: "selfLink" },
          ],
        },
      ],
    };
  }
  if (typeId === "cloud-nat") {
    return {
      fields: [
        { key: "name", label: "NAT Name", kind: "text", required: true },
        {
          key: "router",
          label: "Cloud Router",
          kind: "resource-picker",
          required: true,
          description: "Router this NAT gateway will run on",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "cloud-router", outputKey: "selfLink" },
          ],
        },
        {
          key: "natIpAllocateOption",
          label: "IP Allocation",
          kind: "select",
          required: false,
          options: [
            { id: "AUTO_ONLY", label: "Automatic" },
            { id: "MANUAL_ONLY", label: "Manual" },
          ],
          defaultValue: "AUTO_ONLY",
        },
        {
          key: "sourceSubnetworkIpRangesToNat",
          label: "Subnet IP Ranges",
          kind: "select",
          required: false,
          options: [
            { id: "ALL_SUBNETWORKS_ALL_IP_RANGES", label: "All subnets, all IP ranges" },
            {
              id: "ALL_SUBNETWORKS_ALL_PRIMARY_IP_RANGES",
              label: "All subnets, primary IP ranges only",
            },
            { id: "LIST_OF_SUBNETWORKS", label: "Custom subnet list" },
          ],
          defaultValue: "ALL_SUBNETWORKS_ALL_IP_RANGES",
        },
      ],
    };
  }
  if (typeId === "memorystore-memcached") {
    return {
      fields: [
        { key: "name", label: "Instance Name", kind: "text", required: true },
        {
          key: "location",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "1",
        },
        {
          key: "cpuCount",
          label: "vCPUs Per Node",
          kind: "number",
          required: true,
          defaultValue: "1",
        },
        {
          key: "memorySizeMb",
          label: "Memory Per Node (MB)",
          kind: "number",
          required: true,
          defaultValue: "1024",
        },
        {
          key: "memcacheVersion",
          label: "Memcached Version",
          kind: "select",
          required: false,
          options: [
            { id: "MEMCACHE_1_5", label: "1.5" },
            { id: "MEMCACHE_1_6_15", label: "1.6.15" },
          ],
          defaultValue: "MEMCACHE_1_5",
        },
      ],
    };
  }
  if (typeId === "cloud-armor-policy") {
    return {
      fields: [
        { key: "name", label: "Policy Name", kind: "text", required: true },
        {
          key: "description",
          label: "Description",
          kind: "text",
          required: false,
        },
        {
          key: "type",
          label: "Policy Type",
          kind: "select",
          required: false,
          options: [
            { id: "CLOUD_ARMOR", label: "Cloud Armor" },
            { id: "CLOUD_ARMOR_EDGE", label: "Cloud Armor Edge" },
            { id: "CLOUD_ARMOR_NETWORK", label: "Cloud Armor Network" },
          ],
          defaultValue: "CLOUD_ARMOR",
        },
      ],
    };
  }
  if (typeId === "workflow") {
    return {
      fields: [
        { key: "name", label: "Workflow Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "sourceContents",
          label: "Workflow Definition (YAML)",
          kind: "text",
          required: true,
          description: "Workflow definition in YAML format",
        },
      ],
    };
  }
  if (typeId === "ssl-certificate") {
    return {
      fields: [
        { key: "name", label: "Certificate Name", kind: "text", required: true },
        {
          key: "domains",
          label: "Domains",
          kind: "text",
          required: true,
          description: "Comma-separated list of domains (Google-managed certificate)",
        },
      ],
    };
  }
  if (typeId === "backend-service") {
    // Fetch health checks for the selector
    const hcData = await ctx
      .get<{
        items?: Array<{ name: string; selfLink: string }>;
      }>(`https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/healthChecks`)
      .catch(() => ({ items: [] as Array<{ name: string; selfLink: string }> }));
    const hcOptions = (hcData.items ?? []).map((hc) => ({
      id: hc.selfLink ?? hc.name,
      label: hc.name,
    }));
    return {
      fields: [
        { key: "name", label: "Service Name", kind: "text", required: true },
        {
          key: "protocol",
          label: "Protocol",
          kind: "select",
          required: true,
          options: [
            { id: "HTTP", label: "HTTP" },
            { id: "HTTPS", label: "HTTPS" },
            { id: "TCP", label: "TCP" },
            { id: "SSL", label: "SSL" },
            { id: "HTTP2", label: "HTTP/2" },
          ],
          defaultValue: "HTTP",
        },
        {
          key: "healthCheck",
          label: "Health Check",
          kind: hcOptions.length > 0 ? "select" : "text",
          required: true,
          ...(hcOptions.length > 0 ? { options: hcOptions } : {}),
          description: "Health check to use for this backend service",
        },
        {
          key: "loadBalancingScheme",
          label: "Load Balancing Scheme",
          kind: "select",
          required: false,
          options: [
            { id: "EXTERNAL", label: "External" },
            { id: "INTERNAL", label: "Internal" },
            { id: "INTERNAL_SELF_MANAGED", label: "Internal Self-Managed" },
          ],
          defaultValue: "EXTERNAL",
        },
      ],
    };
  }
  if (typeId === "forwarding-rule") {
    // Fetch target HTTP proxies and target TCP proxies
    const [httpProxiesData, tcpProxiesData] = await Promise.all([
      ctx
        .get<{
          items?: Array<{ name: string; selfLink: string }>;
        }>(
          `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/targetHttpProxies`,
        )
        .catch(() => ({ items: [] as Array<{ name: string; selfLink: string }> })),
      ctx
        .get<{
          items?: Array<{ name: string; selfLink: string }>;
        }>(
          `https://compute.googleapis.com/compute/v1/projects/${ctx.project}/global/targetTcpProxies`,
        )
        .catch(() => ({ items: [] as Array<{ name: string; selfLink: string }> })),
    ]);
    const targetOptions = [
      ...(httpProxiesData.items ?? []).map((p) => ({
        id: p.selfLink ?? p.name,
        label: `${p.name} (HTTP)`,
      })),
      ...(tcpProxiesData.items ?? []).map((p) => ({
        id: p.selfLink ?? p.name,
        label: `${p.name} (TCP)`,
      })),
    ];
    return {
      fields: [
        { key: "name", label: "Rule Name", kind: "text", required: true },
        {
          key: "target",
          label: "Target Proxy",
          kind: targetOptions.length > 0 ? "select" : "text",
          required: true,
          ...(targetOptions.length > 0 ? { options: targetOptions } : {}),
          description: "Target proxy resource URL",
        },
        {
          key: "IPProtocol",
          label: "Protocol",
          kind: "select",
          required: true,
          options: [
            { id: "TCP", label: "TCP" },
            { id: "UDP", label: "UDP" },
            { id: "ESP", label: "ESP" },
            { id: "ICMP", label: "ICMP" },
          ],
          defaultValue: "TCP",
        },
        {
          key: "portRange",
          label: "Port Range",
          kind: "text",
          required: false,
          description: "Port range (e.g. 80-80 or 443-443)",
          defaultValue: "80-80",
        },
      ],
    };
  }
  if (typeId === "instance-template") {
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
  }

  if (typeId === "instance-group") {
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
  }
  if (typeId === "cloud-build-trigger") {
    const inlineYamlDefault = `steps:\n  - name: gcr.io/cloud-builders/docker\n    args: ['build', '-t', 'gcr.io/$PROJECT_ID/example:$SHORT_SHA', '.']\n`;

    // Fetch all Cloud Build 2nd-gen connected repos across the regions where
    // they're commonly created. Each region's connections + repositories
    // calls happen in parallel; failures are silent (region might have no
    // connections, or the API isn't enabled there).
    const connectedRepoOptions: Array<{ id: string; label: string }> = [];
    await Promise.all([
      // 2nd-gen connected repositories — preferred path on new projects.
      ...CLOUD_BUILD_REGIONS.map(async (loc) => {
        try {
          const conns = await ctx.paginate<Record<string, unknown>>(
            `https://cloudbuild.googleapis.com/v2/projects/${p}/locations/${loc}/connections`,
            "connections",
          );
          await Promise.all(
            conns.map(async (conn) => {
              const connFullName = String(conn["name"] ?? "");
              const connShort = connFullName.split("/").pop() ?? "";
              if (!connShort) return;
              const repoListUrl = `https://cloudbuild.googleapis.com/v2/projects/${p}/locations/${loc}/connections/${connShort}/repositories`;
              try {
                const repos = await ctx.paginate<Record<string, unknown>>(
                  repoListUrl,
                  "repositories",
                );
                for (const r of repos) {
                  const rName = String(r["name"] ?? "");
                  const rShort = rName.split("/").pop() ?? "";
                  if (!rShort || !rName.startsWith("projects/")) continue;
                  connectedRepoOptions.push({
                    id: rName,
                    label: `${connShort}/${rShort} (2nd gen, ${loc})`,
                  });
                }
              } catch {
                /* connection has no linked repos or list call failed */
              }
              // Also offer linkable (visible-but-not-yet-linked) repos. The
              // create handler auto-links them on submit. Wrapped in `link:`
              // so the handler knows to do the link step first.
              try {
                const fetchUrl = `https://cloudbuild.googleapis.com/v2/projects/${p}/locations/${loc}/connections/${connShort}:fetchLinkableRepositories`;
                const fetched = await ctx.get<{
                  repositories?: Array<{ name?: string; remoteUri?: string }>;
                }>(fetchUrl);
                for (const lr of fetched.repositories ?? []) {
                  const remote = String(lr.remoteUri ?? "");
                  if (!remote) continue;
                  // Strip any trailing .git for the human label.
                  const niceName =
                    remote.replace(/^https?:\/\/(?:[^/]+\/)?/, "").replace(/\.git$/, "") || remote;
                  connectedRepoOptions.push({
                    id: `link:${connFullName}|${remote}`,
                    label: `${niceName} (link via ${connShort}, ${loc})`,
                  });
                }
              } catch {
                /* fetchLinkableRepositories not supported / connection not OAuth-style */
              }
            }),
          );
        } catch {
          /* region has no Cloud Build connections / API disabled */
        }
      }),
      // 1st-gen Cloud Source Repositories — surfaced with a `csr:` prefix
      // so the create handler knows to use triggerTemplate (legacy path)
      // rather than sourceToBuild + gitFileSource. CSR is deprecated for
      // new projects but still works where it's enabled.
      (async () => {
        try {
          const repos = await ctx.paginate<Record<string, unknown>>(
            `https://sourcerepo.googleapis.com/v1/projects/${p}/repos`,
            "repos",
          );
          for (const r of repos) {
            const rName = String(r["name"] ?? "");
            const rShort = rName.split("/").pop() ?? "";
            if (!rShort) continue;
            connectedRepoOptions.push({
              id: `csr:${rShort}`,
              label: `${rShort} (Cloud Source Repos)`,
            });
          }
        } catch {
          /* CSR API not enabled or project has no CSR repos */
        }
      })(),
    ]);
    connectedRepoOptions.sort((a, b) => a.label.localeCompare(b.label));

    // If the project has no connected repos, the field stays a text input
    // (so the user can paste a custom path) — the description tells them
    // where to set up a connection in Console.
    const repoFieldBase: Omit<CreateFieldConfig, "showWhen"> =
      connectedRepoOptions.length > 0
        ? {
            key: "repository",
            label: "Repository (2nd gen)",
            kind: "select",
            required: false,
            options: connectedRepoOptions,
            description:
              "Pick from your connected Cloud Build repos. Manage connections at console.cloud.google.com/cloud-build/repositories/2nd-gen.",
          }
        : {
            key: "repository",
            label: "Repository (2nd gen)",
            kind: "text",
            required: false,
            placeholder: "projects/PROJECT/locations/REGION/connections/CONN/repositories/REPO",
            description:
              "No 2nd-gen Cloud Build connections found in this project. Connect a repo at console.cloud.google.com/cloud-build/repositories/2nd-gen, or paste a full resource path.",
          };
    // CSR (1st-gen Cloud Source Repositories) doesn't support pull-request
    // triggers — the Cloud Build API rejects the combo. Filter those entries
    // out of the PR variant of the picker so users can't pick an incompatible
    // repo. Other event types keep the full list (incl. CSR).
    const nonCsrRepoOptions = connectedRepoOptions.filter((o) => !o.id.startsWith("csr:"));
    const repoField = (
      eventValue: string,
      overrides?: Partial<CreateFieldConfig>,
    ): CreateFieldConfig => {
      const base: Omit<CreateFieldConfig, "showWhen"> = { ...repoFieldBase };
      if (eventValue === "pull-request" && Array.isArray(base.options)) {
        base.options = nonCsrRepoOptions;
      }
      return {
        ...base,
        ...overrides,
        showWhen: { fieldKey: "eventType", fieldValue: eventValue },
      };
    };

    return {
      fields: [
        {
          key: "name",
          label: "Name",
          kind: "text",
          required: true,
          description: "Must be unique within the project's region.",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: [{ id: "global", label: "global", location: "Multi-region" }, ...GCP_REGIONS],
          defaultValue: "global",
        },
        { key: "description", label: "Description", kind: "text", required: false },
        {
          key: "tags",
          label: "Tags",
          kind: "text",
          required: false,
          description: "Comma-separated tags.",
        },
        {
          key: "eventType",
          label: "Event",
          kind: "select",
          required: true,
          defaultValue: "manual",
          options: [
            { id: "push-branch", label: "Push to a branch" },
            { id: "push-tag", label: "Push new tag" },
            { id: "pull-request", label: "Pull request" },
            { id: "manual", label: "Manual invocation" },
            { id: "pubsub", label: "Pub/Sub message" },
            { id: "webhook", label: "Webhook event" },
          ],
        },
        repoField("push-branch", { required: true }),
        repoField("push-tag", { required: true }),
        repoField("pull-request", { required: true }),
        repoField("manual", {
          label: "Repository (optional, 2nd gen)",
          description:
            "If set, manual builds check out this repo to read the build config. Required when Config location = Repository.",
        }),
        {
          key: "manualRef",
          label: "Manual build ref",
          kind: "text",
          required: false,
          defaultValue: "refs/heads/main",
          description: "Git ref Cloud Build checks out when running manually.",
          showWhen: { fieldKey: "eventType", fieldValue: "manual" },
        },
        {
          key: "branchPattern",
          label: "Branch (regex)",
          kind: "text",
          required: false,
          defaultValue: "^main$",
          description: 'RE2 regex matched against branch names. Use ".*" to match all.',
          showWhen: { fieldKey: "eventType", fieldValue: "push-branch" },
        },
        {
          key: "tagPattern",
          label: "Tag (regex)",
          kind: "text",
          required: false,
          defaultValue: "^v.*",
          description: "RE2 regex matched against tag names.",
          showWhen: { fieldKey: "eventType", fieldValue: "push-tag" },
        },
        {
          key: "branchPattern",
          label: "Base branch (regex)",
          kind: "text",
          required: false,
          defaultValue: "^main$",
          description: "RE2 regex matched against the PR base branch.",
          showWhen: { fieldKey: "eventType", fieldValue: "pull-request" },
        },
        {
          key: "prComment",
          label: "Comment control",
          kind: "select",
          required: false,
          defaultValue: "COMMENTS_DISABLED",
          options: [
            { id: "COMMENTS_DISABLED", label: "Build immediately" },
            {
              id: "COMMENTS_ENABLED",
              label: 'Require "/gcbrun" comment from owner/collaborator',
            },
            {
              id: "COMMENTS_ENABLED_FOR_EXTERNAL_CONTRIBUTORS_ONLY",
              label: 'Require "/gcbrun" only for external contributors',
            },
          ],
          showWhen: { fieldKey: "eventType", fieldValue: "pull-request" },
        },
        {
          key: "pubsubTopic",
          label: "Pub/Sub topic",
          kind: "resource-picker",
          required: true,
          showWhen: { fieldKey: "eventType", fieldValue: "pubsub" },
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "pubsub-topic", outputKey: "topicName" },
          ],
        },
        // configType: only push-style events (push-branch / push-tag /
        // pull-request) support synthetic inline `build` blocks (yaml inline,
        // dockerfile, buildpacks). Manual / pubsub / webhook triggers must
        // read their build config from a repo, so they don't see this field —
        // the handler defaults to "yaml" + "repository" when configType is
        // unset on submit.
        {
          key: "configType",
          label: "Configuration type",
          kind: "select",
          required: true,
          defaultValue: "yaml",
          options: [
            { id: "yaml", label: "Cloud Build configuration file (yaml or json)" },
            { id: "dockerfile", label: "Dockerfile" },
            { id: "buildpacks", label: "Buildpacks" },
          ],
          showWhen: {
            fieldKey: "eventType",
            fieldValues: ["push-branch", "push-tag", "pull-request"],
          },
        },
        // configLocation: only meaningful for push events with yaml. For
        // non-push events configType is hidden (and unset on submit), so the
        // showWhen below evaluates false → field hidden, handler falls back
        // to reading the build config from the repo (filename below).
        {
          key: "configLocation",
          label: "Config location",
          kind: "select",
          required: true,
          defaultValue: "repository",
          options: [
            { id: "repository", label: "Repository — read from source" },
            { id: "inline", label: "Inline — write YAML below" },
          ],
          showWhen: { fieldKey: "configType", fieldValue: "yaml" },
        },
        // filename — push event variant: only when reading from repo.
        {
          key: "filename",
          label: "Config file location",
          kind: "text",
          required: false,
          defaultValue: "cloudbuild.yaml",
          description: "Path within the repo (e.g. cloudbuild.yaml).",
          showWhen: { fieldKey: "configLocation", fieldValue: "repository" },
        },
        // filename — non-push event variant: always shown for manual /
        // pubsub / webhook (those triggers always read their build config
        // from the repo). Same key + default so form state stays consistent.
        {
          key: "filename",
          label: "Config file location",
          kind: "text",
          required: false,
          defaultValue: "cloudbuild.yaml",
          description: "Path within the repo (e.g. cloudbuild.yaml).",
          showWhen: {
            fieldKey: "eventType",
            fieldValues: ["manual", "pubsub", "webhook"],
          },
        },
        {
          key: "inlineConfig",
          label: "Inline build config",
          kind: "code",
          codeLanguage: "yaml",
          required: false,
          defaultValue: inlineYamlDefault,
          description: "YAML body of the build config — written into the trigger directly.",
          showWhen: { fieldKey: "configLocation", fieldValue: "inline" },
        },
        {
          key: "dockerfilePath",
          label: "Dockerfile path",
          kind: "text",
          required: false,
          defaultValue: "Dockerfile",
          description: "Path to the Dockerfile within the repo.",
          showWhen: { fieldKey: "configType", fieldValue: "dockerfile" },
        },
        {
          key: "dockerfileImage",
          label: "Image name",
          kind: "text",
          required: false,
          defaultValue: "gcr.io/$PROJECT_ID/$REPO_NAME:$COMMIT_SHA",
          description: "Tag for the resulting image. Substitutions are supported.",
          showWhen: { fieldKey: "configType", fieldValue: "dockerfile" },
        },
        {
          key: "buildpacksImage",
          label: "Image name",
          kind: "text",
          required: false,
          defaultValue: "gcr.io/$PROJECT_ID/$REPO_NAME:$COMMIT_SHA",
          showWhen: { fieldKey: "configType", fieldValue: "buildpacks" },
        },
        {
          key: "buildpacksDir",
          label: "Source directory",
          kind: "text",
          required: false,
          defaultValue: ".",
          description: "Directory inside the repo to build with Buildpacks.",
          showWhen: { fieldKey: "configType", fieldValue: "buildpacks" },
        },
        {
          key: "substitutions",
          label: "Substitution variables",
          kind: "key-value-list",
          required: false,
          description:
            "User-defined substitutions — keys must start with an underscore (e.g. _MY_VAR).",
          entryKeyLabel: "Key",
          entryKeyPlaceholder: "_MY_VAR",
          entryValueLabel: "Value",
          entryValueDefault: "literal",
          entryValueOptions: [{ id: "literal", label: "Value" }],
          addLabel: "+ Add variable",
        },
        {
          key: "requireApproval",
          label: "Approval",
          kind: "select",
          required: false,
          defaultValue: "no",
          options: [
            { id: "no", label: "Build runs immediately" },
            { id: "yes", label: "Require approval before build executes" },
          ],
        },
        {
          key: "serviceAccount",
          label: "Service account",
          kind: "resource-picker",
          required: true,
          description:
            "User-managed SA the build runs as. Cloud Build began requiring this for new projects in mid-2024 — without it the API returns a silent INVALID_ARGUMENT.",
          associationSources: [
            { pluginId: "gcp", resourceTypeId: "gcp-service-account", outputKey: "email" },
          ],
        },
        {
          key: "disabled",
          label: "Disabled",
          kind: "select",
          required: false,
          defaultValue: "no",
          options: [
            { id: "no", label: "Enabled — runs on event" },
            { id: "yes", label: "Disabled — won't run automatically" },
          ],
        },
      ],
    };
  }
  if (typeId === "cloud-function") {
    const nodeDefault = `const functions = require('@google-cloud/functions-framework');\n\nfunctions.http('helloHttp', (req, res) => {\n  res.send('Hello from Cloud Functions!');\n});\n`;
    const pythonDefault = `import functions_framework\n\n@functions_framework.http\ndef helloHttp(request):\n    return "Hello from Cloud Functions!"\n`;
    const goDefault = `package function\n\nimport (\n\t"fmt"\n\t"net/http"\n\n\t"github.com/GoogleCloudPlatform/functions-framework-go/functions"\n)\n\nfunc init() {\n\tfunctions.HTTP("helloHttp", helloHttp)\n}\n\nfunc helloHttp(w http.ResponseWriter, r *http.Request) {\n\tfmt.Fprint(w, "Hello from Cloud Functions!")\n}\n`;
    const javaDefault = `package com.example;\n\nimport com.google.cloud.functions.HttpFunction;\nimport com.google.cloud.functions.HttpRequest;\nimport com.google.cloud.functions.HttpResponse;\nimport java.io.BufferedWriter;\n\npublic class HelloHttp implements HttpFunction {\n  @Override\n  public void service(HttpRequest request, HttpResponse response) throws Exception {\n    BufferedWriter writer = response.getWriter();\n    writer.write("Hello from Cloud Functions!");\n  }\n}\n`;
    return {
      fields: [
        { key: "name", label: "Function Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: GCP_REGIONS,
          defaultValue: "us-central1",
        },
        {
          key: "language",
          label: "Language",
          kind: "select",
          required: true,
          options: [
            { id: "nodejs", label: "Node.js" },
            { id: "python", label: "Python" },
            { id: "go", label: "Go" },
            { id: "java", label: "Java" },
          ],
          defaultValue: "nodejs",
        },
        {
          key: "runtime_nodejs",
          label: "Runtime",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "nodejs" },
          options: [
            { id: "nodejs24", label: "Node.js 24" },
            { id: "nodejs22", label: "Node.js 22" },
            { id: "nodejs20", label: "Node.js 20" },
          ],
          defaultValue: "nodejs22",
        },
        {
          key: "runtime_python",
          label: "Runtime",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "python" },
          options: [
            { id: "python313", label: "Python 3.13" },
            { id: "python312", label: "Python 3.12" },
            { id: "python311", label: "Python 3.11" },
            { id: "python310", label: "Python 3.10" },
          ],
          defaultValue: "python313",
        },
        {
          key: "runtime_go",
          label: "Runtime",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "go" },
          options: [
            { id: "go124", label: "Go 1.24" },
            { id: "go123", label: "Go 1.23" },
          ],
          defaultValue: "go124",
        },
        {
          key: "runtime_java",
          label: "Runtime",
          kind: "select",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "java" },
          options: [
            { id: "java21", label: "Java 21" },
            { id: "java17", label: "Java 17" },
          ],
          defaultValue: "java21",
        },
        {
          key: "entryPoint",
          label: "Entry Point",
          kind: "text",
          required: true,
          defaultValue: "helloHttp",
          description:
            "The exported function name (Node.js/Python/Go) or the fully-qualified class for Java that handles requests",
        },
        {
          key: "code_nodejs",
          label: "Source Code (index.js)",
          kind: "code",
          codeLanguage: "javascript",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "nodejs" },
          defaultValue: nodeDefault,
          description:
            "Saved as index.js. A package.json depending on @google-cloud/functions-framework is added automatically.",
        },
        {
          key: "code_python",
          label: "Source Code (main.py)",
          kind: "code",
          codeLanguage: "python",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "python" },
          defaultValue: pythonDefault,
          description:
            "Saved as main.py. A requirements.txt with functions-framework is added automatically.",
        },
        {
          key: "code_go",
          label: "Source Code (function.go)",
          kind: "code",
          codeLanguage: "go",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "go" },
          defaultValue: goDefault,
          description: "Saved as function.go alongside an auto-generated go.mod.",
        },
        {
          key: "code_java",
          label: "Source Code (HelloHttp.java)",
          kind: "code",
          codeLanguage: "java",
          required: true,
          showWhen: { fieldKey: "language", fieldValue: "java" },
          defaultValue: javaDefault,
          description:
            "Saved under src/main/java alongside an auto-generated pom.xml that depends on functions-framework-api.",
        },
        {
          key: "availableMemory",
          label: "Memory",
          kind: "select",
          required: false,
          options: [
            { id: "128M", label: "128 MB" },
            { id: "256M", label: "256 MB" },
            { id: "512M", label: "512 MB" },
            { id: "1024M", label: "1 GB" },
            { id: "2048M", label: "2 GB" },
          ],
          defaultValue: "256M",
        },
        {
          key: "timeout",
          label: "Timeout (seconds)",
          kind: "number",
          required: false,
          defaultValue: "60",
        },
      ],
    };
  }
  throw new Error(`No create config for type "${typeId}"`);
}

export async function gcpCreateResource(
  ctx: GcpCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceInstance> {
  if (typeId === "gce-instance") {
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
  }

  if (typeId === "gke-cluster") {
    const p = ctx.project;
    const location = fields["location"] ?? "";
    const machineType = fields["machineType"] ?? "e2-medium";
    const requestedDiskSizeGb = Number.parseInt(fields["diskSizeGb"] ?? "100", 10);
    const diskSizeGb =
      Number.isFinite(requestedDiskSizeGb) && requestedDiskSizeGb >= 10 ? requestedDiskSizeGb : 100;
    const name = fields["name"] ?? "";
    const version = fields["version"] ?? "";
    const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "3", 10);
    const initialNodeCount =
      Number.isFinite(requestedNodeCount) && requestedNodeCount > 0 ? requestedNodeCount : 3;
    const tok = await ctx.token();
    const network = fields["network"];
    const body = {
      cluster: {
        name,
        ...(version ? { initialClusterVersion: version } : {}),
        initialNodeCount,
        nodeConfig: {
          machineType,
          diskSizeGb,
        },
        ...(network
          ? {
              network:
                network.indexOf("projects/") >= 0
                  ? network.slice(network.indexOf("projects/"))
                  : `projects/${p}/global/networks/${network}`,
            }
          : {}),
      },
    };
    const res = await fetch(
      `https://container.googleapis.com/v1/projects/${p}/locations/${location}/clusters`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`GKE API ${res.status}: ${await res.text()}`);
    }
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "gke-cluster", `${p}/${location}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "gke-cluster",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        version,
        machineType,
        diskSizeGb,
        nodeCount: initialNodeCount,
        status: "PROVISIONING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "gcs-bucket") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "US";
    const storageClass = fields["storageClass"] ?? "STANDARD";

    const res = await fetch(`https://storage.googleapis.com/storage/v1/b?project=${p}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, location, storageClass }),
    });
    if (!res.ok) throw new Error(`GCS API ${res.status}: ${await res.text()}`);
    const bucket = (await res.json()) as Record<string, unknown>;
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "gcs-bucket", name),
      pluginId: "gcp",
      resourceTypeId: "gcs-bucket",
      accountId,
      displayName: name,
      fields: {
        name,
        location: String(bucket["location"] ?? location),
        storageClass: String(bucket["storageClass"] ?? storageClass),
        publicAccessPrevention: "",
        versioning: false,
      },
      resolvedOutputs: {
        endpoint: `https://storage.googleapis.com/${name}`,
        bucketName: name,
      },
      secretStates: [],
      externalId: name,
      createdAt: String(bucket["timeCreated"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "cloudsql-instance") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const databaseVersion = fields["databaseVersion"] ?? "POSTGRES_18";
    const region = fields["region"] ?? "us-central1";
    const tier = fields["tier"] ?? "db-f1-micro";
    const diskSizeGb = fields["diskSizeGb"] ?? "10";
    const rootPassword = fields["rootPassword"] ?? "";
    const network = fields["network"];
    const engine = engineInfoFromVersion(databaseVersion);

    const ipConfig: Record<string, unknown> = {};
    if (network) {
      const projectsIdx = network.indexOf("projects/");
      ipConfig.privateNetwork =
        projectsIdx >= 0 ? network.slice(projectsIdx) : `projects/${p}/global/networks/${network}`;
      ipConfig.ipv4Enabled = false;
    } else {
      ipConfig.ipv4Enabled = true;
    }

    const res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${p}/instances`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        databaseVersion,
        region,
        rootPassword,
        settings: {
          tier,
          edition: "ENTERPRISE",
          dataDiskSizeGb: diskSizeGb,
          ipConfiguration: ipConfig,
        },
      }),
    });
    if (!res.ok) throw new Error(`Cloud SQL API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "cloudsql-instance", name),
      pluginId: "gcp",
      resourceTypeId: "cloudsql-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        databaseVersion,
        region,
        tier,
        state: "PENDING_CREATE",
        availabilityType: "ZONAL",
      },
      resolvedOutputs: {
        connectionName: `${p}:${region}:${name}`,
        ipAddress: "",
        connectionUrl: "",
        username: engine.username,
        port: engine.port,
      },
      secretStates: [
        {
          fieldKey: "rootPassword",
          resolution: { kind: "plaintext", value: rootPassword },
        },
      ],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "pubsub-topic") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const fullName = `projects/${p}/topics/${name}`;

    const res = await fetch(`https://pubsub.googleapis.com/v1/${fullName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Pub/Sub API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "pubsub-topic", name),
      pluginId: "gcp",
      resourceTypeId: "pubsub-topic",
      accountId,
      displayName: name,
      fields: { name, kmsKeyName: "", messageRetentionDuration: "" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "pubsub-subscription") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    // When created from a topic's detail page, the topic field is hidden in
    // the form — recover the full topic path from parentResourceId.
    // Resource IDs are `{accountId}:pubsub-topic:projects/{p}/topics/{name}`.
    const parentTopicPath = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const topic = fields["topic"] || parentTopicPath;
    const ackDeadlineSeconds = Number(fields["ackDeadlineSeconds"] || 10);
    const fullName = `projects/${p}/subscriptions/${name}`;

    const res = await fetch(`https://pubsub.googleapis.com/v1/${fullName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ topic, ackDeadlineSeconds }),
    });
    if (!res.ok) throw new Error(`Pub/Sub API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "pubsub-subscription", name),
      pluginId: "gcp",
      resourceTypeId: "pubsub-subscription",
      accountId,
      displayName: name,
      fields: {
        name,
        topic: topic.split("/").pop() ?? topic,
        ackDeadlineSeconds,
        messageRetentionDuration: "",
        filter: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "cloud-dns-zone") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const dnsName = fields["dnsName"] ?? "";
    const description = fields["description"] ?? "";

    const res = await fetch(`https://dns.googleapis.com/dns/v1/projects/${p}/managedZones`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, dnsName, description, visibility: "public" }),
    });
    if (!res.ok) throw new Error(`Cloud DNS API ${res.status}: ${await res.text()}`);
    const zone = (await res.json()) as Record<string, unknown>;
    const now = ctx.now();
    const ns = (zone["nameServers"] as string[]) ?? [];
    return {
      id: ctx.id(accountId, "cloud-dns-zone", name),
      pluginId: "gcp",
      resourceTypeId: "cloud-dns-zone",
      accountId,
      displayName: dnsName,
      fields: {
        name,
        dnsName,
        description,
        visibility: "public",
        nameservers: ns.join(", "),
        dnssecState: "",
        recordCount: 0,
      },
      resolvedOutputs: { nameservers: ns.join(", ") },
      secretStates: [],
      externalId: name,
      createdAt: String(zone["creationTime"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "secret-manager-secret") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const initialValue = fields["initialValue"] ?? "";

    const res = await fetch(
      `https://secretmanager.googleapis.com/v1/projects/${p}/secrets?secretId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ replication: { automatic: {} } }),
      },
    );
    if (!res.ok) throw new Error(`Secret Manager API ${res.status}: ${await res.text()}`);
    const secretName = `projects/${p}/secrets/${name}`;
    let versionCount = 0;
    if (initialValue) {
      const addRes = await fetch(
        `https://secretmanager.googleapis.com/v1/${secretName}:addVersion`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            payload: { data: btoa(unescape(encodeURIComponent(initialValue))) },
          }),
        },
      );
      if (!addRes.ok)
        throw new Error(`Secret Manager API ${addRes.status}: ${await addRes.text()}`);
      versionCount = 1;
    }
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "secret-manager-secret", secretName),
      pluginId: "gcp",
      resourceTypeId: "secret-manager-secret",
      accountId,
      displayName: name,
      fields: { name, replicationType: "AUTOMATIC", versionCount },
      resolvedOutputs: {},
      secretStates: [],
      externalId: secretName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "vpc-network") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const autoCreateSubnetworks = fields["autoCreateSubnetworks"] ?? "true";

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/networks`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, autoCreateSubnetworks: autoCreateSubnetworks === "true" }),
      },
    );
    if (!res.ok) throw new Error(`VPC Network API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "vpc-network", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "vpc-network",
      accountId,
      displayName: name,
      fields: {
        name,
        description: "",
        autoCreateSubnetworks: autoCreateSubnetworks === "true",
        mtu: 1460,
        subnetCount: 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "subnet") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "";
    const network = fields["network"] ?? "";
    const ipCidrRange = fields["ipCidrRange"] ?? "";

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/subnetworks`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          network: `projects/${p}/global/networks/${network}`,
          ipCidrRange,
        }),
      },
    );
    if (!res.ok) throw new Error(`Subnet API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "subnet", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "subnet",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        network,
        ipCidrRange,
        gatewayAddress: "",
        privateIpGoogleAccess: false,
        purpose: "PRIVATE",
        stackType: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "firewall-rule") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const networkRaw = fields["network"] ?? "";
    const direction = fields["direction"] ?? "INGRESS";
    const protocol = fields["protocol"] ?? "tcp";
    const ports = fields["ports"] ?? "";
    const sourceRanges = fields["sourceRanges"] ?? "";

    // Resource picker hands us a selfLink URL; fall back to wrapping a bare name.
    const networkRef = networkRaw.includes("/")
      ? networkRaw
      : `projects/${p}/global/networks/${networkRaw}`;
    const networkShort = networkRaw.split("/").pop() ?? networkRaw;

    const allowed: Array<Record<string, unknown>> = [
      {
        IPProtocol: protocol,
        ...(ports && protocol !== "icmp" ? { ports: ports.split(",").map((s) => s.trim()) } : {}),
      },
    ];
    const body: Record<string, unknown> = {
      name,
      network: networkRef,
      direction,
      allowed,
    };
    if (sourceRanges) {
      body.sourceRanges = sourceRanges.split(",").map((s) => s.trim());
    }

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/firewalls`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Firewall API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const allowedStr = ports ? `${protocol}:${ports}` : protocol;
    return {
      id: ctx.id(accountId, "firewall-rule", name),
      pluginId: "gcp",
      resourceTypeId: "firewall-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        network: networkShort,
        direction,
        priority: 1000,
        action: "ALLOW",
        sourceRanges: sourceRanges,
        destinationRanges: "",
        allowed: allowedStr,
        denied: "",
        disabled: false,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "static-ip") {
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
  }

  if (typeId === "gce-disk") {
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
  }

  if (typeId === "artifact-registry-repo") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const format = fields["format"] ?? "DOCKER";

    const res = await fetch(
      `https://artifactregistry.googleapis.com/v1/projects/${p}/locations/${location}/repositories?repositoryId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      },
    );
    if (!res.ok) throw new Error(`Artifact Registry API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/repositories/${name}`;
    return {
      id: ctx.id(accountId, "artifact-registry-repo", fullName),
      pluginId: "gcp",
      resourceTypeId: "artifact-registry-repo",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        format,
        description: "",
        sizeBytes: "0 KB",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "gcp-service-account") {
    const p = ctx.project;
    const tok = await ctx.token();
    const accountIdField = fields["accountId"] ?? "";
    const displayName = fields["displayName"] ?? "";

    const res = await fetch(`https://iam.googleapis.com/v1/projects/${p}/serviceAccounts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: accountIdField,
        serviceAccount: { displayName },
      }),
    });
    if (!res.ok) throw new Error(await formatGcpError("Create service account", res));
    const data = (await res.json()) as Record<string, unknown>;
    const email = String(data["email"] ?? `${accountIdField}@${p}.iam.gserviceaccount.com`);

    const grantedRoles = ((): string[] => {
      const raw = fields["grantedRoles"];
      if (!raw) return [];
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
      } catch {
        return [];
      }
    })();

    if (grantedRoles.length > 0) {
      const crmBase = `https://cloudresourcemanager.googleapis.com/v1/projects/${p}`;
      const getRes = await fetch(`${crmBase}:getIamPolicy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
      });
      if (!getRes.ok) {
        throw new Error(await formatGcpError("Read project IAM policy", getRes));
      }
      const policy = (await getRes.json()) as {
        bindings?: Array<{ role: string; members: string[]; condition?: unknown }>;
        etag?: string;
        version?: number;
      };
      const member = `serviceAccount:${email}`;
      const bindings = policy.bindings ?? [];
      for (const role of grantedRoles) {
        const existing = bindings.find((b) => b.role === role && !b.condition);
        if (existing) {
          if (!existing.members.includes(member)) existing.members.push(member);
        } else {
          bindings.push({ role, members: [member] });
        }
      }
      const setRes = await fetch(`${crmBase}:setIamPolicy`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          policy: { ...policy, bindings },
        }),
      });
      if (!setRes.ok) {
        throw new Error(await formatGcpError("Grant IAM roles", setRes));
      }
    }

    const now = ctx.now();
    return {
      id: ctx.id(accountId, "gcp-service-account", email),
      pluginId: "gcp",
      resourceTypeId: "gcp-service-account",
      accountId,
      displayName: displayName || accountIdField,
      fields: {
        name: accountIdField,
        email,
        displayName,
        disabled: false,
        description: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: email,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "cloud-dns-record-set") {
    const p = ctx.project;
    const tok = await ctx.token();
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const managedZone = fields["managedZone"] || parentExternalId;
    if (!managedZone) throw new Error("Cloud DNS record set creation requires a managed zone");
    const name = fields["name"] ?? "";
    const type = fields["type"] ?? "A";
    const ttl = Number(fields["ttl"] || 300);
    const rrdatasStr = fields["rrdatas"] ?? "";
    const rrdatas = rrdatasStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const res = await fetch(
      `https://dns.googleapis.com/dns/v1/projects/${p}/managedZones/${managedZone}/changes`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          additions: [{ name, type, ttl, rrdatas }],
        }),
      },
    );
    if (!res.ok) throw new Error(`Cloud DNS API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const shortName = name.replace(/\.$/, "");
    const recordKey = `${type}:${name}`;
    return {
      id: ctx.id(accountId, "cloud-dns-record-set", `${managedZone}/${recordKey}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-dns-record-set",
      accountId,
      displayName: `${type} ${shortName}`,
      fields: {
        type,
        name: shortName,
        rrdatas: rrdatas.join(", "),
        ttl,
        zoneName: managedZone,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${managedZone}/${recordKey}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "cloud-tasks-queue") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";

    const res = await fetch(
      `https://cloudtasks.googleapis.com/v2/projects/${p}/locations/${location}/queues`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `projects/${p}/locations/${location}/queues/${name}`,
        }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Tasks API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/queues/${name}`;
    return {
      id: ctx.id(accountId, "cloud-tasks-queue", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-tasks-queue",
      accountId,
      displayName: name,
      fields: {
        name,
        region: location,
        state: "RUNNING",
        maxDispatchesPerSecond: 0,
        maxConcurrentDispatches: 0,
        maxAttempts: 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "cloud-scheduler-job") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const schedule = fields["schedule"] ?? "";
    const timeZone = fields["timeZone"] ?? "UTC";
    const httpUri = fields["httpUri"] ?? "";
    const httpMethod = fields["httpMethod"] ?? "POST";

    const res = await fetch(
      `https://cloudscheduler.googleapis.com/v1/projects/${p}/locations/${location}/jobs`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `projects/${p}/locations/${location}/jobs/${name}`,
          schedule,
          timeZone,
          httpTarget: { uri: httpUri, httpMethod },
        }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Scheduler API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/jobs/${name}`;
    return {
      id: ctx.id(accountId, "cloud-scheduler-job", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-scheduler-job",
      accountId,
      displayName: name,
      fields: {
        name,
        region: location,
        schedule,
        timeZone,
        state: "ENABLED",
        targetType: "HTTP",
        targetUri: httpUri,
        lastAttemptTime: "",
        scheduleTime: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "kms-key-ring") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";

    const res = await fetch(
      `https://cloudkms.googleapis.com/v1/projects/${p}/locations/${location}/keyRings?keyRingId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/keyRings/${name}`;
    return {
      id: ctx.id(accountId, "kms-key-ring", fullName),
      pluginId: "gcp",
      resourceTypeId: "kms-key-ring",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        keyCount: 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "kms-key") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    // When created from a key ring's detail page, keyRing and keyRingLocation
    // fields are hidden — recover them from the parent key ring's externalId
    // (format: `projects/{p}/locations/{location}/keyRings/{name}`).
    const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const parentMatch = parentExternalId.match(
      /^projects\/[^/]+\/locations\/([^/]+)\/keyRings\/([^/]+)$/,
    );
    const keyRing = fields["keyRing"] || (parentMatch?.[2] ?? "");
    const keyRingLocation = fields["keyRingLocation"] || (parentMatch?.[1] ?? "global");
    const purpose = fields["purpose"] ?? "ENCRYPT_DECRYPT";
    const protectionLevel = fields["protectionLevel"] ?? "SOFTWARE";
    if (!keyRing) throw new Error("KMS key creation requires a key ring");

    const algorithm =
      purpose === "ASYMMETRIC_SIGN"
        ? "RSA_SIGN_PSS_2048_SHA256"
        : purpose === "ASYMMETRIC_DECRYPT"
          ? "RSA_DECRYPT_OAEP_2048_SHA256"
          : "GOOGLE_SYMMETRIC_ENCRYPTION";

    const res = await fetch(
      `https://cloudkms.googleapis.com/v1/projects/${p}/locations/${keyRingLocation}/keyRings/${keyRing}/cryptoKeys?cryptoKeyId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          purpose,
          versionTemplate: { protectionLevel, algorithm },
        }),
      },
    );
    if (!res.ok) throw new Error(`KMS API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${keyRingLocation}/keyRings/${keyRing}/cryptoKeys/${name}`;
    return {
      id: ctx.id(accountId, "kms-key", fullName),
      pluginId: "gcp",
      resourceTypeId: "kms-key",
      accountId,
      displayName: name,
      fields: {
        name,
        keyRing,
        location: keyRingLocation,
        purpose,
        algorithm,
        protectionLevel,
        state: "ENABLED",
        rotationPeriod: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      parentResourceId: ctx.id(
        accountId,
        "kms-key-ring",
        `projects/${p}/locations/${keyRingLocation}/keyRings/${keyRing}`,
      ),
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "log-sink") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const destination = fields["destination"] ?? "";
    const filter = fields["filter"] ?? "";

    const res = await fetch(`https://logging.googleapis.com/v2/projects/${p}/sinks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, destination, filter }),
    });
    if (!res.ok) throw new Error(`Logging API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "log-sink", name),
      pluginId: "gcp",
      resourceTypeId: "log-sink",
      accountId,
      displayName: name,
      fields: {
        name,
        destination,
        filter,
        disabled: false,
        writerIdentity: String(data["writerIdentity"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "firestore-database") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const locationId = fields["locationId"] ?? "";
    const databaseEdition = fields["databaseEdition"] ?? "STANDARD";
    // Enterprise is only supported with FIRESTORE_NATIVE; Datastore Mode
    // is a Standard-only option.
    const type =
      databaseEdition === "ENTERPRISE"
        ? "FIRESTORE_NATIVE"
        : (fields["type"] ?? "FIRESTORE_NATIVE");

    const body: Record<string, unknown> = { locationId, type };
    if (databaseEdition === "ENTERPRISE") {
      body["databaseEdition"] = "ENTERPRISE";
      // Enterprise defaults to MongoDB-compatible access mode. If the
      // caller picked Native mode, flip the two access-mode fields.
      if (fields["enterpriseMode"] === "native") {
        body["firestoreDataAccessMode"] = "DATA_ACCESS_MODE_ENABLED";
        body["mongodbCompatibleDataAccessMode"] = "DATA_ACCESS_MODE_DISABLED";
      }
    }

    const res = await fetch(
      `https://firestore.googleapis.com/v1/projects/${p}/databases?databaseId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Firestore API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "firestore-database", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "firestore-database",
      accountId,
      displayName: name === "(default)" ? `${p} (default)` : name,
      fields: {
        name,
        locationId,
        type,
        databaseEdition,
        concurrencyMode: "",
        state: "CREATING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "memorystore-redis") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const tier = fields["tier"] ?? "BASIC";
    const memorySizeGb = Number(fields["memorySizeGb"] || 1);

    const res = await fetch(
      `https://redis.googleapis.com/v1/projects/${p}/locations/${location}/instances?instanceId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ tier, memorySizeGb }),
      },
    );
    if (!res.ok) throw new Error(`Memorystore Redis API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/instances/${name}`;
    return {
      id: ctx.id(accountId, "memorystore-redis", fullName),
      pluginId: "gcp",
      resourceTypeId: "memorystore-redis",
      accountId,
      displayName: name,
      fields: {
        name,
        region: location,
        tier,
        memorySizeGb,
        redisVersion: "",
        state: "CREATING",
      },
      resolvedOutputs: {
        host: "",
        port: "6379",
      },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "bigquery-dataset") {
    const p = ctx.project;
    const tok = await ctx.token();
    const datasetId = fields["datasetId"] ?? "";
    const location = fields["location"] ?? "US";

    const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        datasetReference: { projectId: p, datasetId },
        location,
      }),
    });
    if (!res.ok) throw new Error(`BigQuery API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "bigquery-dataset", `${p}:${datasetId}`),
      pluginId: "gcp",
      resourceTypeId: "bigquery-dataset",
      accountId,
      displayName: datasetId,
      fields: {
        name: datasetId,
        location,
        description: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}:${datasetId}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "bigquery-table") {
    const p = ctx.project;
    const tok = await ctx.token();
    const datasetId = fields["datasetId"] ?? "";
    const tableId = fields["tableId"] ?? "";
    const description = fields["description"] ?? "";
    const schemaJson = fields["schemaJson"] ?? "";
    const expirationMs = fields["expirationMs"] ?? "";
    if (!datasetId || !tableId)
      throw new Error("BigQuery table creation requires datasetId and tableId");

    const body: Record<string, unknown> = {
      tableReference: { projectId: p, datasetId, tableId },
    };
    if (description) body["description"] = description;
    if (expirationMs) body["expirationTime"] = expirationMs;
    if (schemaJson.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(schemaJson);
      } catch (e) {
        throw new Error(`Schema JSON is not valid JSON: ${(e as Error).message}`);
      }
      if (!Array.isArray(parsed))
        throw new Error("Schema JSON must be an array of field definitions");
      body["schema"] = { fields: parsed };
    }

    const res = await fetch(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${p}/datasets/${datasetId}/tables`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`BigQuery API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const externalId = `${p}:${datasetId}/${tableId}`;
    return {
      id: ctx.id(accountId, "bigquery-table", externalId),
      pluginId: "gcp",
      resourceTypeId: "bigquery-table",
      accountId,
      displayName: tableId,
      parentResourceId: ctx.id(accountId, "bigquery-dataset", `${p}:${datasetId}`),
      fields: {
        name: tableId,
        type: "TABLE",
        description,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "spanner-instance") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const displayName = fields["displayName"] ?? "";
    const config = fields["config"] ?? "regional-us-central1";
    const nodeCount = Math.max(1, Number(fields["nodeCount"] ?? 1));

    const res = await fetch(`https://spanner.googleapis.com/v1/projects/${p}/instances`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId: name,
        instance: {
          displayName,
          config: `projects/${p}/instanceConfigs/${config}`,
          nodeCount,
        },
      }),
    });
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "spanner-instance", name),
      pluginId: "gcp",
      resourceTypeId: "spanner-instance",
      accountId,
      displayName: displayName || name,
      fields: {
        name,
        displayName,
        config,
        nodeCount,
        processingUnits: 0,
        state: "CREATING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "spanner-database") {
    const p = ctx.project;
    const tok = await ctx.token();
    const instance = fields["instance"] || parentResourceId?.split(":")[2] || "";
    const name = fields["name"] ?? "";
    const dialect = fields["dialect"] ?? "GOOGLE_STANDARD_SQL";
    const ddlRaw = fields["ddl"] ?? "";
    if (!instance || !name)
      throw new Error("Spanner database creation requires an instance and a name");

    const extraStatements = ddlRaw
      .split(";")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    const createStatement =
      dialect === "POSTGRESQL" ? `CREATE DATABASE "${name}"` : `CREATE DATABASE \`${name}\``;

    const body: Record<string, unknown> = {
      createStatement,
      databaseDialect: dialect,
    };
    if (extraStatements.length > 0) {
      body["extraStatements"] = extraStatements;
    }

    const res = await fetch(
      `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/databases`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const externalId = `${instance}/${name}`;
    return {
      id: ctx.id(accountId, "spanner-database", externalId),
      pluginId: "gcp",
      resourceTypeId: "spanner-database",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "spanner-instance", instance),
      fields: {
        name,
        instance,
        state: "CREATING",
        dialect,
        versionRetentionPeriod: "",
        earliestVersionTime: "",
        createTime: now,
        enableDropProtection: false,
        encryptionConfig: "",
        defaultLeader: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "spanner-backup") {
    const p = ctx.project;
    const tok = await ctx.token();
    const instance = fields["instance"] || parentResourceId?.split(":")[2] || "";
    const name = fields["name"] ?? "";
    const database = fields["database"] ?? "";
    const expireTime = fields["expireTime"] ?? "";
    if (!instance || !name || !database || !expireTime)
      throw new Error(
        "Spanner backup creation requires instance, name, source database, and expire time",
      );

    const res = await fetch(
      `https://spanner.googleapis.com/v1/projects/${p}/instances/${instance}/backups?backupId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          database: `projects/${p}/instances/${instance}/databases/${database}`,
          expireTime,
        }),
      },
    );
    if (!res.ok) throw new Error(`Spanner API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const externalId = `${instance}/${name}`;
    return {
      id: ctx.id(accountId, "spanner-backup", externalId),
      pluginId: "gcp",
      resourceTypeId: "spanner-backup",
      accountId,
      displayName: name,
      parentResourceId: ctx.id(accountId, "spanner-instance", instance),
      fields: {
        name,
        instance,
        database,
        state: "CREATING",
        sizeBytes: "0",
        createTime: now,
        expireTime,
        versionTime: "",
        backupSchedules: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "bigtable-instance") {
    const p = ctx.project;
    const tok = await ctx.token();
    const instanceId = fields["instanceId"] ?? "";
    const displayName = fields["displayName"] ?? "";
    const instanceType = fields["instanceType"] ?? "PRODUCTION";
    const clusterLocation = fields["clusterLocation"] ?? "us-central1-b";

    const clusterBody: Record<string, unknown> = {
      defaultStorageType: "SSD",
      location: `projects/${p}/locations/${clusterLocation}`,
    };
    if (instanceType === "PRODUCTION") {
      clusterBody.serveNodes = 3;
    }

    const res = await fetch(`https://bigtableadmin.googleapis.com/v2/projects/${p}/instances`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        instanceId,
        instance: { displayName, type: instanceType },
        clusters: { [`${instanceId}-cluster`]: clusterBody },
      }),
    });
    if (!res.ok) throw new Error(`Bigtable API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "bigtable-instance", instanceId),
      pluginId: "gcp",
      resourceTypeId: "bigtable-instance",
      accountId,
      displayName: displayName || instanceId,
      fields: {
        name: instanceId,
        displayName,
        type: instanceType,
        state: "CREATING",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: instanceId,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "filestore-instance") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "";
    const tier = fields["tier"] ?? "BASIC_HDD";
    const fileShareName = fields["fileShareName"] ?? "";
    const capacityGb = Number(fields["capacityGb"] || 1024);

    const res = await fetch(
      `https://file.googleapis.com/v1/projects/${p}/locations/${location}/instances?instanceId=${name}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tier,
          fileShares: [{ name: fileShareName, capacityGb }],
          networks: [{ network: "default", modes: ["MODE_IPV4"] }],
        }),
      },
    );
    if (!res.ok) throw new Error(`Filestore API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/instances/${name}`;
    return {
      id: ctx.id(accountId, "filestore-instance", fullName),
      pluginId: "gcp",
      resourceTypeId: "filestore-instance",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        tier,
        state: "CREATING",
        capacityGb,
        network: "default",
        fileShareName,
        ipAddress: "",
      },
      resolvedOutputs: { ipAddress: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "cloud-router") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "";
    const networkRaw = fields["network"] ?? "";

    const networkRef = networkRaw.includes("/")
      ? networkRaw
      : `projects/${p}/global/networks/${networkRaw}`;
    const networkShort = networkRaw.split("/").pop() ?? networkRaw;

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          network: networkRef,
        }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Router API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "cloud-router", `${region}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-router",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        network: networkShort,
        bgpAsn: 0,
        natCount: 0,
      },
      resolvedOutputs: {
        selfLink: `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${name}`,
      },
      secretStates: [],
      externalId: `${region}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "health-check") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const type = fields["type"] ?? "HTTP";
    const port = Number(fields["port"] || 80);
    const checkIntervalSec = Number(fields["checkIntervalSec"] || 5);

    const body: Record<string, unknown> = {
      name,
      type,
      checkIntervalSec,
      timeoutSec: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 2,
    };
    if (type === "HTTP") {
      body.httpHealthCheck = { port };
    } else if (type === "HTTPS") {
      body.httpsHealthCheck = { port };
    } else {
      body.tcpHealthCheck = { port };
    }

    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/healthChecks`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) throw new Error(`Health Check API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "health-check", name),
      pluginId: "gcp",
      resourceTypeId: "health-check",
      accountId,
      displayName: name,
      fields: {
        name,
        type,
        port,
        checkIntervalSec,
        timeoutSec: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "alloydb-cluster") {
    const p = ctx.project;
    const tok = await ctx.token();
    const clusterId = fields["clusterId"] ?? "";
    const location = fields["location"] ?? "";
    const network = fields["network"] ?? "";
    const rootPassword = fields["rootPassword"] ?? "";
    const projectsIdx = network.indexOf("projects/");
    const networkPath =
      projectsIdx >= 0 ? network.slice(projectsIdx) : `projects/${p}/global/networks/${network}`;

    const res = await fetch(
      `https://alloydb.googleapis.com/v1/projects/${p}/locations/${location}/clusters?clusterId=${clusterId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          network: networkPath,
          initialUser: { user: "postgres", password: rootPassword },
        }),
      },
    );
    if (!res.ok) throw new Error(`AlloyDB API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `projects/${p}/locations/${location}/clusters/${clusterId}`;
    return {
      id: ctx.id(accountId, "alloydb-cluster", fullName),
      pluginId: "gcp",
      resourceTypeId: "alloydb-cluster",
      accountId,
      displayName: clusterId,
      fields: {
        name: clusterId,
        location,
        databaseVersion: "POSTGRES_14",
        state: "CREATING",
        clusterType: "",
      },
      resolvedOutputs: {},
      secretStates: [
        {
          fieldKey: "rootPassword",
          resolution: { kind: "plaintext", value: rootPassword },
        },
      ],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "alloydb-instance") {
    const tok = await ctx.token();
    const instanceId = fields["instanceId"] ?? "";
    const instanceType = fields["instanceType"] || "PRIMARY";
    const cpuCount = Number.parseInt(fields["cpuCount"] ?? "2", 10) || 2;
    if (!parentResourceId) {
      throw new Error("AlloyDB instance creation requires a parent cluster");
    }
    // parentResourceId format: "{accountId}:alloydb-cluster:projects/{p}/locations/{l}/clusters/{c}"
    const clusterFullName = parentResourceId.split(":").slice(2).join(":");
    if (!clusterFullName.startsWith("projects/")) {
      throw new Error(`Invalid AlloyDB cluster reference: ${parentResourceId}`);
    }

    const res = await fetch(
      `https://alloydb.googleapis.com/v1/${clusterFullName}/instances?instanceId=${instanceId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceType,
          machineConfig: { cpuCount },
        }),
      },
    );
    if (!res.ok) throw new Error(`AlloyDB API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    const fullName = `${clusterFullName}/instances/${instanceId}`;
    return {
      id: ctx.id(accountId, "alloydb-instance", fullName),
      pluginId: "gcp",
      resourceTypeId: "alloydb-instance",
      accountId,
      parentResourceId,
      displayName: instanceId,
      fields: {
        name: instanceId,
        instanceType,
        state: "CREATING",
        cpuCount,
        ipAddress: "",
        availabilityType: "",
      },
      resolvedOutputs: { ipAddress: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "alert-policy") {
    const p = ctx.project;
    const tok = await ctx.token();
    const displayName = fields["displayName"] ?? "";
    const conditionDisplayName = fields["conditionDisplayName"] ?? "";
    const metricType = fields["metricType"] ?? "";
    const resourceType = fields["resourceType"] ?? "global";
    const thresholdValue = Number(fields["thresholdValue"] || 0.8);
    const comparisonType = fields["comparisonType"] ?? "COMPARISON_GT";
    const duration = fields["duration"] ?? "60";

    const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${p}/alertPolicies`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName,
        combiner: "OR",
        conditions: [
          {
            displayName: conditionDisplayName,
            conditionThreshold: {
              filter: `metric.type="${metricType}" AND resource.type="${resourceType}"`,
              comparison: comparisonType,
              thresholdValue,
              duration: `${duration}s`,
            },
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Monitoring API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;
    const fullName = String(data["name"] ?? "");
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "alert-policy", fullName),
      pluginId: "gcp",
      resourceTypeId: "alert-policy",
      accountId,
      displayName,
      fields: {
        name: fullName,
        displayName,
        enabled: true,
        conditionCount: 1,
        notificationChannelCount: 0,
        combiner: "OR",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }

  if (typeId === "cloud-run-service") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "us-central1";
    const image = fields["image"] ?? "";
    const port = Number(fields["port"] ?? "8080");
    const ingress = fields["ingress"] ?? "INGRESS_TRAFFIC_ALL";
    const network = fields["network"];
    const tok = await ctx.token();

    const template: Record<string, unknown> = {
      containers: [
        {
          image,
          ports: [{ containerPort: port }],
        },
      ],
    };

    if (network) {
      template.vpcAccess = {
        network: `projects/${p}/global/networks/${network}`,
      };
    }

    const res = await fetch(
      `https://run.googleapis.com/v2/projects/${p}/locations/${region}/services?serviceId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ingress, template }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Run create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    // Use the full GCP service name so the resource ID matches what
    // listResources returns once the service is provisioned. Otherwise
    // getResource and getManifest will throw "not found" until the next sync.
    const fullName = `projects/${p}/locations/${region}/services/${name}`;
    return {
      id: ctx.id(accountId, "cloud-run-service", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-run-service",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        latestRevision: "",
        state: "PROVISIONING",
        ingress,
      },
      resolvedOutputs: { url: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "cloud-nat") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const routerField = fields["router"] ?? "";
    // Resource picker hands us a selfLink URL like
    // ".../projects/P/regions/REGION/routers/ROUTER"; the legacy select used
    // a "region/router" pair. Support both shapes.
    const selfLinkMatch = /\/regions\/([^/]+)\/routers\/([^/]+)$/.exec(routerField);
    const [region, routerName] = selfLinkMatch
      ? [selfLinkMatch[1] ?? "", selfLinkMatch[2] ?? ""]
      : routerField.includes("/")
        ? routerField.split("/")
        : ["us-central1", routerField];
    const natIpAllocateOption = fields["natIpAllocateOption"] ?? "AUTO_ONLY";
    const sourceSubnetworkIpRangesToNat =
      fields["sourceSubnetworkIpRangesToNat"] ?? "ALL_SUBNETWORKS_ALL_IP_RANGES";
    const tok = await ctx.token();
    // Get the existing router, patch with new NAT
    const router = await ctx.get<Record<string, unknown>>(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${routerName}`,
    );
    const nats = (router["nats"] as Array<Record<string, unknown>>) ?? [];
    nats.push({
      name,
      natIpAllocateOption,
      sourceSubnetworkIpRangesToNat,
    });
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/regions/${region}/routers/${routerName}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ nats }),
      },
    );
    if (!res.ok) throw new Error(`Cloud NAT create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "cloud-nat", `${p}/${region}/${routerName}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-nat",
      accountId,
      displayName: name,
      fields: {
        name,
        region: region ?? "",
        router: routerName ?? "",
        natIpAllocateOption,
        sourceSubnetworkIpRangesToNat,
        status: "ACTIVE",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${region}/${routerName}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "memorystore-memcached") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const location = fields["location"] ?? "us-central1";
    const nodeCount = Number(fields["nodeCount"] ?? "1");
    const cpuCount = Number(fields["cpuCount"] ?? "1");
    const memorySizeMb = Number(fields["memorySizeMb"] ?? "1024");
    const memcacheVersion = fields["memcacheVersion"] ?? "MEMCACHE_1_5";
    const tok = await ctx.token();
    const res = await fetch(
      `https://memcache.googleapis.com/v1/projects/${p}/locations/${location}/instances?instanceId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeCount,
          nodeConfig: { cpuCount, memorySizeMb },
          memcacheVersion,
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Memorystore Memcached create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "memorystore-memcached", `${p}/${location}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "memorystore-memcached",
      accountId,
      displayName: name,
      fields: {
        name,
        location,
        state: "CREATING",
        nodeCount,
        cpuCount,
        memorySizeMb,
        memcacheVersion,
        discoveryEndpoint: "",
      },
      resolvedOutputs: { discoveryEndpoint: "" },
      secretStates: [],
      externalId: `${p}/${location}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "cloud-armor-policy") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const description = fields["description"] ?? "";
    const type = fields["type"] ?? "CLOUD_ARMOR";
    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/securityPolicies`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, type }),
      },
    );
    if (!res.ok) throw new Error(`Cloud Armor create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "cloud-armor-policy", `${p}/${name}`),
      pluginId: "gcp",
      resourceTypeId: "cloud-armor-policy",
      accountId,
      displayName: name,
      fields: { name, description, type, ruleCount: 0 },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${p}/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "workflow") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "us-central1";
    const sourceContents = fields["sourceContents"] ?? "";
    const tok = await ctx.token();
    const res = await fetch(
      `https://workflows.googleapis.com/v1/projects/${p}/locations/${region}/workflows?workflowId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sourceContents }),
      },
    );
    if (!res.ok) throw new Error(`Workflow create failed: ${res.status}: ${await res.text()}`);
    const fullName = `projects/${p}/locations/${region}/workflows/${name}`;
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "workflow", fullName),
      pluginId: "gcp",
      resourceTypeId: "workflow",
      accountId,
      displayName: name,
      fields: { name, region, state: "ACTIVE", revisionId: "", serviceAccount: "" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "ssl-certificate") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const domainsStr = fields["domains"] ?? "";
    const domains = domainsStr
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/sslCertificates`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type: "MANAGED",
          managed: { domains },
        }),
      },
    );
    if (!res.ok)
      throw new Error(`SSL Certificate create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    const domainList = domains.join(", ");
    const dnsRecords = domains
      .map((domain) => {
        const recordName = `_acme-challenge.${domain}.`;
        const recordValue = `${name}.${p}.dscvr.cloud.goog.`;
        return `CNAME ${recordName} -> ${recordValue}`;
      })
      .join("\n");
    return {
      id: ctx.id(accountId, "ssl-certificate", name),
      pluginId: "gcp",
      resourceTypeId: "ssl-certificate",
      accountId,
      displayName: name,
      fields: {
        name,
        type: "MANAGED",
        status: "PROVISIONING",
        domains: domainList,
        expireTime: "",
      },
      resolvedOutputs: { dnsRecords, domains: domainList },
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "backend-service") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const protocol = fields["protocol"] ?? "HTTP";
    const healthCheck = fields["healthCheck"] ?? "";
    const loadBalancingScheme = fields["loadBalancingScheme"] ?? "EXTERNAL";
    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/backendServices`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          protocol,
          healthChecks: [healthCheck],
          loadBalancingScheme,
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Backend Service create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "backend-service", name),
      pluginId: "gcp",
      resourceTypeId: "backend-service",
      accountId,
      displayName: name,
      fields: {
        name,
        protocol,
        port: 0,
        portName: "",
        loadBalancingScheme,
        healthCheckCount: 1,
        backendCount: 0,
        enableCDN: false,
        sessionAffinity: "NONE",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "forwarding-rule") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const target = fields["target"] ?? "";
    const ipProtocol = fields["IPProtocol"] ?? "TCP";
    const portRange = fields["portRange"] ?? "";
    const tok = await ctx.token();
    const res = await fetch(
      `https://compute.googleapis.com/compute/v1/projects/${p}/global/forwardingRules`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          target,
          IPProtocol: ipProtocol,
          portRange,
        }),
      },
    );
    if (!res.ok)
      throw new Error(`Forwarding Rule create failed: ${res.status}: ${await res.text()}`);
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "forwarding-rule", `global/${name}`),
      pluginId: "gcp",
      resourceTypeId: "forwarding-rule",
      accountId,
      displayName: name,
      fields: {
        name,
        region: "global",
        IPAddress: "",
        IPProtocol: ipProtocol,
        portRange,
        target: target.split("/").pop() ?? target,
        loadBalancingScheme: "EXTERNAL",
        networkTier: "PREMIUM",
      },
      resolvedOutputs: { IPAddress: "" },
      secretStates: [],
      externalId: `global/${name}`,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "instance-template") {
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
  }
  if (typeId === "instance-group") {
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
  }
  if (typeId === "cloud-build-trigger") {
    const p = ctx.project;
    const name = fields["name"] ?? "";
    const region = fields["region"] || "global";
    const description = fields["description"] ?? "";
    const tagsCsv = fields["tags"] ?? "";
    const eventType = fields["eventType"] ?? "manual";
    const repository = fields["repository"]?.trim() ?? "";
    const manualRef = fields["manualRef"]?.trim() || "refs/heads/main";
    const branchPattern = fields["branchPattern"]?.trim() ?? "";
    const tagPattern = fields["tagPattern"]?.trim() ?? "";
    const prComment = fields["prComment"]?.trim() ?? "";
    const pubsubTopic = fields["pubsubTopic"]?.trim() ?? "";
    const configType = fields["configType"] ?? "yaml";
    const configLocation = fields["configLocation"] ?? "repository";
    const filename = fields["filename"] ?? "cloudbuild.yaml";
    const inlineConfig = fields["inlineConfig"] ?? "";
    const dockerfilePath = fields["dockerfilePath"] ?? "Dockerfile";
    const dockerfileImage = fields["dockerfileImage"] ?? "";
    const buildpacksImage = fields["buildpacksImage"] ?? "";
    const buildpacksDir = fields["buildpacksDir"] ?? ".";
    const substitutionsRaw = fields["substitutions"] ?? "";
    const requireApproval = fields["requireApproval"] === "yes";
    const serviceAccount = fields["serviceAccount"]?.trim() ?? "";
    const disabled = fields["disabled"] === "yes";

    const tok = await ctx.token();

    // Resolve `link:<connection>|<remoteUri>` options into a real repo path
    // by linking the repo first (idempotent — Cloud Build returns the
    // existing record if it's already linked). Ignored for CSR shortcuts
    // and for repository fields that already point at a repo.
    let resolvedRepository = repository;
    if (repository.startsWith("link:")) {
      const rest = repository.slice("link:".length);
      const sepIdx = rest.indexOf("|");
      if (sepIdx <= 0) {
        throw new Error(`Malformed link option: ${repository}`);
      }
      const connectionPath = rest.slice(0, sepIdx);
      const remoteUri = rest.slice(sepIdx + 1);
      // Synthesise a stable repo id from the remote URI.
      const repoId = remoteUri
        .replace(/^https?:\/\//, "")
        .replace(/\.git$/, "")
        .replace(/[^a-zA-Z0-9-]/g, "-")
        .toLowerCase()
        .slice(0, 63)
        .replace(/^-+|-+$/g, "");
      const linkUrl = `https://cloudbuild.googleapis.com/v2/${connectionPath}/repositories?repositoryId=${encodeURIComponent(repoId)}`;
      const linkRes = await fetch(linkUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${connectionPath}/repositories/${repoId}`,
          remoteUri,
        }),
      });
      if (!linkRes.ok && linkRes.status !== 409) {
        // 409 = already linked; treat as success.
        throw new Error(`Failed to link repository: ${linkRes.status} ${await linkRes.text()}`);
      }
      resolvedRepository = `${connectionPath}/repositories/${repoId}`;
    }

    // Reject paths that point at a connection rather than a repository —
    // a common copy-paste mistake.
    if (
      resolvedRepository.startsWith("projects/") &&
      !resolvedRepository.includes("/repositories/")
    ) {
      throw new Error(
        `"${resolvedRepository}" is a connection path, not a repository path. Link a repo to that connection in console.cloud.google.com/cloud-build/repositories/2nd-gen, or pick a "(link via …)" option from the dropdown.`,
      );
    }

    const body: Record<string, unknown> = { name };
    if (description) body["description"] = description;
    if (tagsCsv) {
      body["tags"] = tagsCsv
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (disabled) body["disabled"] = true;

    // The repository field carries either a 2nd-gen path ("projects/...")
    // or a 1st-gen Cloud Source Repos shortcut ("csr:<repo-name>"). Decode
    // once so the event/build branches don't repeat the parsing.
    const isCsrRepo = resolvedRepository.startsWith("csr:");
    const csrRepoName = isCsrRepo ? resolvedRepository.slice(4) : "";

    // Event configuration
    if (eventType === "push-branch") {
      if (!repository) throw new Error("Repository is required for branch-push triggers");
      if (isCsrRepo) {
        body["triggerTemplate"] = {
          projectId: p,
          repoName: csrRepoName,
          branchName: branchPattern || ".*",
        };
      } else {
        body["repositoryEventConfig"] = {
          repository: resolvedRepository,
          push: { branch: branchPattern || ".*" },
        };
      }
    } else if (eventType === "push-tag") {
      if (!repository) throw new Error("Repository is required for tag-push triggers");
      if (isCsrRepo) {
        body["triggerTemplate"] = {
          projectId: p,
          repoName: csrRepoName,
          tagName: tagPattern || ".*",
        };
      } else {
        body["repositoryEventConfig"] = {
          repository: resolvedRepository,
          push: { tag: tagPattern || ".*" },
        };
      }
    } else if (eventType === "pull-request") {
      if (!repository) throw new Error("Repository is required for pull-request triggers");
      // CSR doesn't support PR triggers — the form filters csr: entries out
      // of the pull-request repository picker, so isCsrRepo is unreachable
      // here unless the user manually pasted a `csr:` value into a free-text
      // repo field. Still validate defensively.
      if (isCsrRepo) {
        throw new Error(
          "Pull-request triggers aren't supported with Cloud Source Repositories. Use a 2nd-gen connected repo (GitHub/Bitbucket/GitLab).",
        );
      }
      const pr: Record<string, unknown> = { branch: branchPattern || ".*" };
      if (prComment) pr["commentControl"] = prComment;
      body["repositoryEventConfig"] = { repository: resolvedRepository, pullRequest: pr };
    } else if (eventType === "pubsub") {
      if (!pubsubTopic) throw new Error("Pub/Sub topic is required for pubsub triggers");
      const topic = pubsubTopic.startsWith("projects/")
        ? pubsubTopic
        : `projects/${p}/topics/${pubsubTopic}`;
      body["pubsubConfig"] = { topic };
    } else if (eventType === "webhook") {
      body["webhookConfig"] = { state: "ENABLED" };
    }
    // Manual / Pub/Sub / Webhook triggers don't get their source from an
    // event — Cloud Build requires an explicit sourceToBuild + gitFileSource
    // pointing at a connected repo. Inline builds aren't supported on
    // these trigger types (see cloud.google.com/build/docs/automate-builds-pubsub-events).
    if (eventType === "manual" || eventType === "pubsub" || eventType === "webhook") {
      if (!repository) {
        throw new Error(
          `Cloud Build ${eventType} triggers need a source repository — they don't support inline builds. Either:\n` +
            `  • Connect a 2nd-gen repo at console.cloud.google.com/cloud-build/repositories/2nd-gen, or\n` +
            `  • Create a Cloud Source Repos repo (gcloud source repos create <name>).\n` +
            `Then reopen this form to pick it.`,
        );
      }
      const ref = eventType === "manual" ? manualRef : "refs/heads/main";
      if (isCsrRepo) {
        // 1st-gen path uses triggerTemplate even for non-event triggers; the
        // sourceToBuild field is unused by Cloud Build for CSR-backed
        // pubsub/webhook/manual triggers.
        body["triggerTemplate"] = {
          projectId: p,
          repoName: csrRepoName,
          branchName: ref.replace(/^refs\/heads\//, ""),
        };
      } else {
        body["sourceToBuild"] = { repository: resolvedRepository, ref };
      }
    }

    // Build configuration
    const isPushEvent =
      eventType === "push-branch" || eventType === "push-tag" || eventType === "pull-request";
    if (configType === "yaml" && configLocation === "repository") {
      // Push events get their source (and so the filename's resolution
      // context) from the event itself. Manual / Pub/Sub / Webhook need an
      // explicit gitFileSource pointing at the same repo we set as
      // sourceToBuild — but ONLY for 2nd-gen connected repos. CSR (1st-gen)
      // triggers resolve `filename` against the triggerTemplate repo.
      if (!isPushEvent && !isCsrRepo) {
        if (!repository) {
          throw new Error("A repository is required to read the build config from.");
        }
        body["gitFileSource"] = {
          path: filename,
          repository: resolvedRepository,
          revision: eventType === "manual" ? manualRef : "refs/heads/main",
        };
      } else {
        body["filename"] = filename;
      }
    } else if (configType === "yaml" && configLocation === "inline") {
      // The form hides the inline option for non-push events (configType +
      // configLocation are gated on eventType ∈ push-*), so this branch is
      // only reachable for push-branch / push-tag / pull-request.
      // Cloud Build's REST API accepts an inline `build` JSON object. We
      // parse the user's YAML (or JSON) into a JS object and submit that.
      let parsed: unknown;
      try {
        parsed = yaml.load(inlineConfig);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Inline build config is not valid YAML/JSON: ${msg}`);
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("Inline build config must be a YAML mapping with steps: [...]");
      }
      body["build"] = parsed;
    } else if (configType === "dockerfile") {
      // Build a synthetic build with a docker step.
      body["build"] = {
        steps: [
          {
            name: "gcr.io/cloud-builders/docker",
            args: ["build", "-t", dockerfileImage, "-f", dockerfilePath, "."],
          },
        ],
        ...(dockerfileImage ? { images: [dockerfileImage] } : {}),
      };
    } else if (configType === "buildpacks") {
      body["build"] = {
        steps: [
          {
            name: "gcr.io/k8s-skaffold/pack",
            entrypoint: "pack",
            args: [
              "build",
              buildpacksImage,
              "--builder",
              "gcr.io/buildpacks/builder:v1",
              "--path",
              buildpacksDir,
            ],
          },
        ],
        ...(buildpacksImage ? { images: [buildpacksImage] } : {}),
      };
    }

    // Substitutions: the key-value-list field stores a JSON string of
    // {key, value} pairs.
    if (substitutionsRaw) {
      try {
        const arr = JSON.parse(substitutionsRaw) as Array<Record<string, string>>;
        const subs: Record<string, string> = {};
        for (const row of arr) {
          const k = String(row["key"] ?? "");
          const v = String(row["value"] ?? "");
          if (k) subs[k] = v;
        }
        if (Object.keys(subs).length > 0) body["substitutions"] = subs;
      } catch {
        /* ignore malformed substitution rows */
      }
    }

    if (requireApproval) {
      body["approvalConfig"] = { approvalRequired: true };
    }
    if (serviceAccount) {
      const sa = serviceAccount.includes("@")
        ? serviceAccount
        : `${serviceAccount}@${p}.iam.gserviceaccount.com`;
      body["serviceAccount"] = `projects/${p}/serviceAccounts/${sa}`;
      // When a user-specified service account is set AND we're sending an
      // inline `build`, Cloud Build requires an explicit logging option —
      // otherwise it returns INVALID_ARGUMENT. Set CLOUD_LOGGING_ONLY by
      // default; users can override by editing the inline YAML themselves.
      const inlineBuild = body["build"] as Record<string, unknown> | undefined;
      if (inlineBuild) {
        const opts = (inlineBuild["options"] as Record<string, unknown> | undefined) ?? {};
        if (!opts["logging"]) opts["logging"] = "CLOUD_LOGGING_ONLY";
        inlineBuild["options"] = opts;
      }
    }

    // Cloud Build Triggers v1 supports both global and regional endpoints.
    // Regional uses `/v1/projects/{p}/locations/{region}/triggers`; global
    // uses the project-only path.
    const url =
      region === "global"
        ? `https://cloudbuild.googleapis.com/v1/projects/${p}/triggers`
        : `https://cloudbuild.googleapis.com/v1/projects/${p}/locations/${region}/triggers`;
    const bodyJson = JSON.stringify(body);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: bodyJson,
    });
    if (!res.ok) {
      const errText = await res.text();
      // Cloud Build's INVALID_ARGUMENT message is generic; include the
      // request body so the user can spot the field the API didn't like.
      throw new Error(
        `Cloud Build Trigger create failed (${res.status}): ${errText}\n\nRequest body sent:\n${bodyJson}`,
      );
    }
    const result = (await res.json()) as Record<string, unknown>;
    const triggerId = String(result["id"] ?? "");
    const now = new Date().toISOString();
    const triggerTypeLabel =
      eventType === "manual"
        ? "Manual"
        : eventType === "webhook"
          ? "Webhook"
          : eventType === "pubsub"
            ? "Pub/Sub"
            : eventType === "pull-request"
              ? "Pull request"
              : eventType === "push-tag"
                ? "Push tag"
                : "Push branch";
    // externalId encodes the region so the lister/detail/delete code can
    // hit the right regional endpoint. Must match the shape produced by
    // listCloudBuildTriggers in resource-listers/devops.ts.
    const externalId = `${region}/${triggerId}`;
    return {
      id: ctx.id(accountId, "cloud-build-trigger", externalId),
      pluginId: "gcp",
      resourceTypeId: "cloud-build-trigger",
      accountId,
      displayName: name,
      fields: {
        name,
        description,
        disabled,
        triggerType: triggerTypeLabel,
        repoName: repository,
        branchName: branchPattern || tagPattern,
        filename: configLocation === "repository" ? filename : "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (typeId === "cloud-function") {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const region = fields["region"] ?? "us-central1";
    const language = fields["language"] ?? "nodejs";
    const runtime = fields[`runtime_${language}`] ?? "nodejs22";
    const entryPoint = fields["entryPoint"] ?? "helloHttp";
    const availableMemory = fields["availableMemory"] ?? "256M";
    const timeout = fields["timeout"] ?? "60";
    const userCode = fields[`code_${language}`] ?? "";

    // Build the source archive. Cloud Functions Gen 2 hands the upload to
    // Buildpacks, which require a manifest file per language — without these
    // the build fails after the create call returns success.
    let sourceFiles: { name: string; content: string }[];
    if (language === "nodejs") {
      sourceFiles = [
        { name: "index.js", content: userCode },
        {
          name: "package.json",
          content: JSON.stringify(
            {
              name: "function",
              version: "0.0.1",
              main: "index.js",
              dependencies: { "@google-cloud/functions-framework": "^3.4.0" },
            },
            null,
            2,
          ),
        },
      ];
    } else if (language === "python") {
      sourceFiles = [
        { name: "main.py", content: userCode },
        { name: "requirements.txt", content: "functions-framework==3.*\n" },
      ];
    } else if (language === "go") {
      const goVersion = runtime.replace(/^go/, "").replace(/(\d)(\d)$/, "$1.$2");
      sourceFiles = [
        { name: "function.go", content: userCode },
        {
          name: "go.mod",
          content: `module example.com/function\n\ngo ${goVersion}\n\nrequire github.com/GoogleCloudPlatform/functions-framework-go v1.9.1\n`,
        },
      ];
    } else if (language === "java") {
      sourceFiles = [
        { name: "src/main/java/com/example/HelloHttp.java", content: userCode },
        {
          name: "pom.xml",
          content: `<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.example</groupId>\n  <artifactId>function</artifactId>\n  <version>0.0.1</version>\n  <properties>\n    <maven.compiler.source>17</maven.compiler.source>\n    <maven.compiler.target>17</maven.compiler.target>\n  </properties>\n  <dependencies>\n    <dependency>\n      <groupId>com.google.cloud.functions</groupId>\n      <artifactId>functions-framework-api</artifactId>\n      <version>1.1.0</version>\n      <scope>provided</scope>\n    </dependency>\n  </dependencies>\n</project>\n`,
        },
      ];
    } else {
      throw new Error(`Cloud Functions: unsupported language "${language}"`);
    }

    // Step 1: Generate upload URL (default environment is GEN_2 for v2 API)
    const uploadUrlRes = await fetch(
      `https://cloudfunctions.googleapis.com/v2/projects/${p}/locations/${region}/functions:generateUploadUrl`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "GEN_2" }),
      },
    );
    if (!uploadUrlRes.ok)
      throw new Error(
        `Cloud Functions generateUploadUrl failed: ${uploadUrlRes.status}: ${await uploadUrlRes.text()}`,
      );
    const uploadUrlData = (await uploadUrlRes.json()) as {
      uploadUrl: string;
      storageSource?: Record<string, unknown>;
    };
    const uploadUrl = uploadUrlData.uploadUrl;

    // Step 2: Upload the ZIP to the signed URL. The signed URL must NOT carry
    // an Authorization header — the URL itself is the credential.
    const zipBuffer = buildZipArchive(sourceFiles);
    // Only Content-Type is required per Google's docs — adding
    // x-goog-content-length-range is not (and trips CORS preflight on the
    // signed URL bucket from the desktop renderer).
    const uploadRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: zipBuffer as BodyInit,
    });
    if (!uploadRes.ok)
      throw new Error(
        `Cloud Functions source upload failed: ${uploadRes.status}: ${await uploadRes.text()}`,
      );

    // Step 3: Create the function. No trigger block is needed for HTTP —
    // Gen 2 auto-creates an https trigger when no eventTrigger is specified.
    // The full resource name is required in the body in addition to the
    // functionId query parameter. We resolve the project number so we can
    // pin the build SA and runtime SA explicitly — leaving them unset can
    // cause the Cloud Run service to silently not deploy on newer projects
    // ("CloudRunServiceNotFound" stateMessage), since Google has been
    // tightening default-SA behaviour.
    const fullResourceName = `projects/${p}/locations/${region}/functions/${name}`;
    let computeSaEmail: string | undefined;
    try {
      const proj = await ctx.get<{ projectNumber?: string }>(
        `https://cloudresourcemanager.googleapis.com/v3/projects/${p}`,
      );
      if (proj.projectNumber) {
        computeSaEmail = `${proj.projectNumber}-compute@developer.gserviceaccount.com`;
      }
    } catch {
      /* fall back to API defaults if we can't resolve the project number */
    }
    const buildConfig: Record<string, unknown> = {
      runtime,
      entryPoint,
      source: { storageSource: uploadUrlData.storageSource },
    };
    const serviceConfig: Record<string, unknown> = {
      availableMemory,
      timeoutSeconds: parseInt(timeout, 10),
      ingressSettings: "ALLOW_ALL",
      allTrafficOnLatestRevision: true,
    };
    if (computeSaEmail) {
      buildConfig["serviceAccount"] = `projects/${p}/serviceAccounts/${computeSaEmail}`;
      serviceConfig["serviceAccountEmail"] = computeSaEmail;
    }
    const createBody = {
      name: fullResourceName,
      environment: "GEN_2",
      buildConfig,
      serviceConfig,
    };
    const createRes = await fetch(
      `https://cloudfunctions.googleapis.com/v2/projects/${p}/locations/${region}/functions?functionId=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
        body: JSON.stringify(createBody),
      },
    );
    if (!createRes.ok) {
      const text = await createRes.text();
      throw new Error(
        `Cloud Functions create failed (${createRes.status}): ${text}\n\n` +
          `Tip: ensure these APIs are enabled on the project: ` +
          `cloudfunctions, cloudbuild, run, eventarc, artifactregistry. ` +
          `The default compute service account also needs roles/cloudfunctions.developer ` +
          `and roles/iam.serviceAccountUser.`,
      );
    }
    const fullName = fullResourceName;
    const now = new Date().toISOString();
    return {
      id: ctx.id(accountId, "cloud-function", fullName),
      pluginId: "gcp",
      resourceTypeId: "cloud-function",
      accountId,
      displayName: name,
      fields: {
        name,
        region,
        runtime,
        state: "DEPLOYING",
        availableMemory,
        timeout,
      },
      resolvedOutputs: { url: "" },
      secretStates: [],
      externalId: fullName,
      createdAt: now,
      updatedAt: now,
    };
  }
  throw new Error(`GCP plugin: createResource not supported for type "${typeId}"`);
}
