import type {
  CreateResourceConfig,
  ResourceCreateResult,
  ResourceInstance,
  ResourceWarning,
  SizeOption,
  ImageOption,
  SectionNode,
} from "@infrawrench/plugin-base";
import { signedS3Fetch } from "@infrawrench/plugin-base";
import { SPACES_REGIONS, REGION_INFO } from "./constants.js";

export interface DoCreateContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
  credentials: Record<string, string>;
}

export async function doGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
  if (typeId === "droplet") {
    const [regionsData, sizesData, publicImagesData, privateImagesData] = await Promise.all([
      ctx.fetch<{ regions: Array<{ slug: string; name: string; available: boolean }> }>("/regions"),
      ctx.fetch<{
        sizes: Array<{
          slug: string;
          memory: number;
          vcpus: number;
          disk: number;
          price_monthly: number;
          available: boolean;
          description: string;
        }>;
      }>("/sizes"),
      ctx.fetch<{
        images: Array<{
          id: number;
          slug: string | null;
          name: string;
          distribution: string;
          type: string;
          public: boolean;
          status: string;
        }>;
      }>("/images?type=distribution&per_page=200"),
      ctx.fetch<{
        images: Array<{
          id: number;
          slug: string | null;
          name: string;
          distribution: string;
          type: string;
          public: boolean;
          status: string;
        }>;
      }>("/images?private=true&per_page=200"),
    ]);

    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = REGION_INFO[r.slug];
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });

    const sizesByCategory = new Map<string, SizeOption[]>();
    for (const s of sizesData.sizes) {
      if (!s.available) continue;
      const cat = s.description || "Standard";
      if (!sizesByCategory.has(cat)) sizesByCategory.set(cat, []);
      sizesByCategory.get(cat)!.push({
        id: s.slug,
        label: s.slug,
        vcpus: s.vcpus,
        memoryMb: s.memory,
        diskGb: s.disk,
        priceMonthly: s.price_monthly,
        category: cat,
      });
    }
    const sizes = [...sizesByCategory.values()].flat();

    const imageMap = new Map<string, ImageOption[]>();
    for (const img of publicImagesData.images) {
      if (img.status !== "available") continue;
      const cat = img.distribution;
      if (!imageMap.has(cat)) imageMap.set(cat, []);
      imageMap.get(cat)!.push({ id: img.slug ?? String(img.id), label: img.name, category: cat });
    }
    const privateImages: ImageOption[] = privateImagesData.images
      .filter((i) => i.status === "available")
      .map((i) => ({ id: String(i.id), label: i.name, category: "My Snapshots", isOwned: true }));
    const images: ImageOption[] = [...[...imageMap.values()].flat(), ...privateImages];
    const defaultImage = images.find((i) => i.category === "Ubuntu")?.id ?? images[0]?.id;

    const firstRegion = regions[0]?.id;
    const firstSize = sizes[0]?.id;
    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(firstRegion ? { defaultValue: firstRegion } : {}),
        },
        {
          key: "size",
          label: "Size",
          kind: "size-picker",
          required: true,
          sizes,
          ...(firstSize ? { defaultValue: firstSize } : {}),
        },
        {
          key: "image",
          label: "Image",
          kind: "image-picker",
          required: true,
          images,
          ...(defaultImage ? { defaultValue: defaultImage } : {}),
        },
        { key: "sshPublicKey", label: "SSH Key", kind: "ssh-key-picker", required: false },
        {
          key: "addExtraDisk",
          label: "Extra Volume",
          kind: "select",
          required: false,
          defaultValue: "false",
          options: [
            { id: "false", label: "None" },
            { id: "true", label: "Create and attach a volume" },
          ],
        },
        {
          key: "extraDiskSizeGb",
          label: "Volume Size",
          kind: "disk-slider",
          required: false,
          minGb: 1,
          maxGb: 16384,
          defaultGb: 100,
          stepGb: 1,
          showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
        },
        {
          key: "extraDiskFormat",
          label: "Filesystem",
          kind: "select",
          required: false,
          defaultValue: "ext4",
          options: [
            { id: "ext4", label: "ext4" },
            { id: "xfs", label: "xfs" },
          ],
          showWhen: { fieldKey: "addExtraDisk", fieldValue: "true" },
        },
      ],
    };
  }

  if (typeId === "doks-cluster") {
    const [optionsData, sizesData] = await Promise.all([
      ctx.fetch<{
        options?: {
          regions?: Array<{ slug: string; name: string }>;
          sizes?: Array<{ slug: string; name: string }>;
          versions?: Array<{ slug: string; kubernetes_version: string }>;
        };
      }>("/kubernetes/options"),
      ctx.fetch<{
        sizes: Array<{
          slug: string;
          memory: number;
          vcpus: number;
          disk: number;
          price_monthly: number;
          available: boolean;
          description: string;
        }>;
      }>("/sizes"),
    ]);

    const regions = (optionsData.options?.regions ?? []).map((region) => {
      const info = REGION_INFO[region.slug];
      return {
        id: region.slug,
        label: region.name,
        ...(info ? { location: info.location, flag: info.flag } : {}),
      };
    });

    const availableSizeSlugs = new Set((optionsData.options?.sizes ?? []).map((size) => size.slug));
    const sizesByCategory = new Map<string, SizeOption[]>();
    for (const size of sizesData.sizes) {
      if (!size.available || !availableSizeSlugs.has(size.slug)) continue;
      const category = size.description || "Standard";
      if (!sizesByCategory.has(category)) sizesByCategory.set(category, []);
      sizesByCategory.get(category)!.push({
        id: size.slug,
        label: size.slug,
        vcpus: size.vcpus,
        memoryMb: size.memory,
        diskGb: size.disk,
        priceMonthly: size.price_monthly,
        category,
      });
    }
    const sizes = [...sizesByCategory.values()].flat();

    const versions = (optionsData.options?.versions ?? []).map((version) => ({
      id: version.slug,
      label: `${version.kubernetes_version} (${version.slug})`,
    }));
    const defaultRegion = regions[0]?.id;
    const defaultSize = sizes[0]?.id;
    const defaultVersion = versions[0]?.id;

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(defaultRegion ? { defaultValue: defaultRegion } : {}),
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
          key: "nodePoolSize",
          label: "Node Pool Size",
          kind: "size-picker",
          required: true,
          sizes,
          ...(defaultSize ? { defaultValue: defaultSize } : {}),
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
      ],
    };
  }

  if (typeId === "spaces-bucket") {
    const regionsData = await ctx.fetch<{
      regions: Array<{ slug: string; name: string; available: boolean }>;
    }>("/regions");
    const spacesRegions = regionsData.regions
      .filter((r) => r.available)
      .filter((r) => SPACES_REGIONS.includes(r.slug))
      .map((r) => {
        const info = REGION_INFO[r.slug];
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });

    return {
      fields: [
        {
          key: "name",
          label: "Bucket Name",
          kind: "text",
          required: true,
          description: "Globally unique bucket name (lowercase, hyphens, 3-63 characters)",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: spacesRegions,
          ...(spacesRegions[0] ? { defaultValue: spacesRegions[0].id } : {}),
        },
      ],
    };
  }

  if (typeId === "managed-database") {
    const [regionsData, sizesData] = await Promise.all([
      ctx.fetch<{
        regions: Array<{ slug: string; name: string; available: boolean }>;
      }>("/regions"),
      ctx.fetch<{
        sizes: Array<{
          slug: string;
          memory: number;
          vcpus: number;
          disk: number;
          price_monthly: number;
          available: boolean;
          description: string;
        }>;
      }>("/sizes"),
    ]);

    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = REGION_INFO[r.slug];
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });

    const dbSizes = sizesData.sizes
      .filter((s) => s.available && s.slug.startsWith("db-"))
      .map((s) => ({
        id: s.slug,
        label: s.slug,
        vcpus: s.vcpus,
        memoryMb: s.memory,
        diskGb: s.disk,
        priceMonthly: s.price_monthly,
        category: s.description || "Database",
      }));

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        {
          key: "engine",
          label: "Engine",
          kind: "select",
          required: true,
          options: [
            { id: "pg", label: "PostgreSQL" },
            { id: "mysql", label: "MySQL" },
            { id: "redis", label: "Redis" },
            { id: "mongodb", label: "MongoDB" },
            { id: "kafka", label: "Kafka" },
            { id: "opensearch", label: "OpenSearch" },
          ],
          defaultValue: "pg",
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(regions[0] ? { defaultValue: regions[0].id } : {}),
        },
        {
          key: "size",
          label: "Node Size",
          kind: "size-picker",
          required: true,
          sizes: dbSizes,
          ...(dbSizes[0] ? { defaultValue: dbSizes[0].id } : {}),
        },
        {
          key: "nodeCount",
          label: "Node Count",
          kind: "number",
          required: true,
          defaultValue: "1",
          minValue: 1,
          maxValue: 5,
          stepValue: 1,
        },
      ],
    };
  }

  if (typeId === "domain") {
    return {
      fields: [
        {
          key: "name",
          label: "Domain Name",
          kind: "text",
          required: true,
          description: "Root domain name, e.g. example.com",
        },
      ],
    };
  }

  if (typeId === "dns-record") {
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [];
    if (!hasParent) {
      const domains = await ctx.fetch<{ domains: Array<Record<string, unknown>> }>("/domains");
      const domainOptions = (domains.domains ?? []).map((d) => ({
        id: String(d["name"]),
        label: String(d["name"]),
      }));
      fields.push({
        key: "domainName",
        label: "Domain",
        kind: "select",
        required: true,
        options: domainOptions,
        ...(domainOptions[0] ? { defaultValue: domainOptions[0].id } : {}),
      });
    }
    fields.push(
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
          { id: "CAA", label: "CAA" },
        ],
        defaultValue: "A",
      },
      {
        key: "name",
        label: "Hostname",
        kind: "text",
        required: true,
        description: "e.g. www or @ for the root",
      },
      {
        key: "data",
        label: "Value",
        kind: "text",
        required: true,
        description: "e.g. 192.168.1.1 for A records",
      },
      {
        key: "ttl",
        label: "TTL",
        kind: "number",
        required: false,
        defaultValue: "1800",
        minValue: 30,
        description: "Time to live in seconds",
      },
      {
        key: "priority",
        label: "Priority",
        kind: "number",
        required: false,
        showWhen: { fieldKey: "type", fieldValue: "MX" },
        description: "Priority for MX records",
      },
    );
    return { fields };
  }

  if (typeId === "project") {
    return {
      fields: [
        { key: "name", label: "Project Name", kind: "text", required: true },
        {
          key: "purpose",
          label: "Purpose",
          kind: "select",
          required: false,
          options: [
            { id: "Web Application", label: "Web Application" },
            { id: "API", label: "API" },
            { id: "Mobile Application", label: "Mobile Application" },
            { id: "Website", label: "Website" },
            { id: "CI/CD", label: "CI/CD" },
            { id: "Other", label: "Other" },
          ],
          defaultValue: "Web Application",
        },
        { key: "description", label: "Description", kind: "text", required: false },
        {
          key: "environment",
          label: "Environment",
          kind: "select",
          required: false,
          options: [
            { id: "Development", label: "Development" },
            { id: "Staging", label: "Staging" },
            { id: "Production", label: "Production" },
          ],
          defaultValue: "Development",
        },
      ],
    };
  }

  if (typeId === "volume") {
    const regionsData = await ctx.fetch<{
      regions: Array<{ slug: string; name: string; available: boolean }>;
    }>("/regions");
    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = REGION_INFO[r.slug];
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    return {
      fields: [
        { key: "name", label: "Volume Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(regions[0] ? { defaultValue: regions[0].id } : {}),
        },
        {
          key: "sizeGb",
          label: "Size",
          kind: "disk-slider",
          required: true,
          minGb: 1,
          maxGb: 16384,
          defaultGb: 100,
          stepGb: 1,
        },
        {
          key: "filesystemType",
          label: "Filesystem",
          kind: "select",
          required: false,
          defaultValue: "ext4",
          options: [
            { id: "ext4", label: "ext4" },
            { id: "xfs", label: "xfs" },
            { id: "", label: "None (unformatted)" },
          ],
        },
      ],
    };
  }

  throw new Error(`No create config for type "${typeId}"`);
}

export async function doCreateResource(
  ctx: DoCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId?: string,
): Promise<ResourceCreateResult> {
  const warnings: ResourceWarning[] = [];
  const resource = await doCreateResourceImpl(
    ctx,
    typeId,
    accountId,
    fields,
    parentResourceId,
    warnings,
  );
  return { resource, warnings };
}

async function doCreateResourceImpl(
  ctx: DoCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId: string | undefined,
  warnings: ResourceWarning[],
): Promise<ResourceInstance> {
  // When a child resource is created from its parent's detail page, the form
  // omits the parent-identifying field — recover it by parsing the parent's
  // `{accountId}:{typeId}:{externalId}` id. DO project ids are UUIDs; DO
  // domain ids are the domain name itself.
  const parentExternalId = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";

  // DigitalOcean projects are an organizational concept. Resources can be
  // created without being assigned to a project (they land in the default
  // project). When `parentResourceId` points to a project, we assign the
  // newly-created resource to that project via a separate POST after create.
  const assignToProjectIfNeeded = async (urn: string): Promise<void> => {
    if (!parentExternalId) return;
    try {
      await ctx.fetch(`/projects/${parentExternalId}/resources`, {
        method: "POST",
        body: JSON.stringify({ resources: [urn] }),
      });
    } catch (err) {
      warnings.push({
        code: "do.project-assignment-failed",
        message: `Failed to assign ${urn} to project ${parentExternalId}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  };

  if (typeId === "droplet") {
    // SSH key: upload to DO account (idempotent — if it already exists DO returns the existing key)
    const sshKeyIds: number[] = [];
    const sshPub = fields["sshPublicKey"];
    if (sshPub) {
      try {
        const comment = sshPub.trim().split(" ")[2] ?? "infrawrench";
        type KeyResponse =
          | { ssh_key: { id: number } }
          | { ssh_keys: Array<{ id: number; public_key: string }> };
        const keyData = await ctx
          .fetch<KeyResponse>("/account/keys", {
            method: "POST",
            body: JSON.stringify({ name: comment, public_key: sshPub.trim() }),
          })
          .catch(async (e: unknown) => {
            if (String(e).includes("422")) {
              return ctx.fetch<KeyResponse>("/account/keys");
            }
            throw e;
          });
        const keyId =
          "ssh_key" in keyData
            ? keyData.ssh_key.id
            : keyData.ssh_keys.find((k) => k.public_key.trim() === sshPub.trim())?.id;
        if (keyId) sshKeyIds.push(keyId);
      } catch {
        /* skip SSH key if upload fails */
      }
    }

    const body: Record<string, unknown> = {
      name: fields["name"],
      region: fields["region"],
      size: fields["size"],
      image: fields["image"],
      ...(sshKeyIds.length > 0 ? { ssh_keys: sshKeyIds } : {}),
    };
    const data = await ctx.fetch<{ droplet: Record<string, unknown> }>("/droplets", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const d = data.droplet;
    const networks = d["networks"] as
      | { v4?: Array<{ type: string; ip_address: string }> }
      | undefined;
    const publicIp = networks?.v4?.find((n) => n.type === "public")?.ip_address ?? "";
    const privateIp = networks?.v4?.find((n) => n.type === "private")?.ip_address ?? "";

    // Optionally create and attach an extra volume in the same flow
    if (fields["addExtraDisk"] === "true") {
      await ctx.fetch("/volumes", {
        method: "POST",
        body: JSON.stringify({
          name: `${fields["name"]}-data`,
          region: fields["region"],
          size_gigabytes: Number(fields["extraDiskSizeGb"] ?? 100),
          filesystem_type: fields["extraDiskFormat"] ?? "ext4",
          droplet_ids: [Number(d["id"])],
        }),
      });
    }
    await assignToProjectIfNeeded(`do:droplet:${String(d["id"])}`);
    return {
      id: `${accountId}:droplet:${String(d["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "droplet",
      accountId,
      displayName: String(d["name"]),
      fields: {
        name: String(d["name"]),
        region: String((d["region"] as Record<string, unknown>)?.["slug"] ?? fields["region"]),
        size: String((d["size"] as Record<string, unknown>)?.["slug"] ?? fields["size"]),
        image: String((d["image"] as Record<string, unknown>)?.["slug"] ?? fields["image"]),
      },
      resolvedOutputs: { ipv4: publicIp, ipv4Private: privateIp },
      secretStates: [],
      externalId: String(d["id"]),
      createdAt: String(d["created_at"] ?? new Date().toISOString()),
      updatedAt: String(d["created_at"] ?? new Date().toISOString()),
    };
  }

  if (typeId === "doks-cluster") {
    const requestedNodeCount = Number.parseInt(fields["nodeCount"] ?? "3", 10);
    const nodeCount =
      Number.isFinite(requestedNodeCount) && requestedNodeCount > 0 ? requestedNodeCount : 3;
    const nodePoolNameBase = (fields["name"] ?? "cluster").trim() || "cluster";
    const body = {
      name: fields["name"],
      region: fields["region"],
      version: fields["version"] ?? "latest",
      node_pools: [
        {
          name: `${nodePoolNameBase}-default-pool`,
          size: fields["nodePoolSize"],
          count: nodeCount,
        },
      ],
    };
    const data = await ctx.fetch<{ kubernetes_cluster: Record<string, unknown> }>(
      "/kubernetes/clusters",
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    const cluster = data.kubernetes_cluster;
    const nodePool = (cluster["node_pools"] as Array<Record<string, unknown>> | undefined)?.[0];
    await assignToProjectIfNeeded(`do:kubernetes:${String(cluster["id"])}`);
    return {
      id: `${accountId}:doks-cluster:${String(cluster["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "doks-cluster",
      accountId,
      displayName: String(cluster["name"] ?? fields["name"] ?? "DOKS Cluster"),
      fields: {
        name: String(cluster["name"] ?? fields["name"] ?? ""),
        region: String(cluster["region"] ?? fields["region"] ?? ""),
        version: String(cluster["version"] ?? fields["version"] ?? ""),
        nodePoolSize: String(nodePool?.["size"] ?? fields["nodePoolSize"] ?? ""),
        nodeCount: Number(nodePool?.["count"] ?? nodeCount),
      },
      resolvedOutputs: {
        clusterEndpoint: String(cluster["endpoint"] ?? ""),
      },
      secretStates: [],
      externalId: String(cluster["id"]),
      createdAt: String(cluster["created_at"] ?? new Date().toISOString()),
      updatedAt: String(cluster["updated_at"] ?? cluster["created_at"] ?? new Date().toISOString()),
    };
  }

  if (typeId === "spaces-bucket") {
    // Spaces are managed via the S3-compatible API, not the DO REST API.
    // This requires separate Spaces access key credentials.
    const accessKeyId = ctx.credentials["spacesAccessKeyId"] as string | undefined;
    const secretAccessKey = ctx.credentials["spacesSecretAccessKey"] as string | undefined;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "DigitalOcean plugin: Spaces management requires S3-compatible credentials " +
          '("spacesAccessKeyId" and "spacesSecretAccessKey"). ' +
          "Generate these in the DigitalOcean console under API > Spaces Keys.",
      );
    }

    const bucketName = fields["name"];
    if (!bucketName) throw new Error("Bucket name is required");
    const region = fields["region"] ?? "nyc3";
    const host = `${bucketName}.${region}.digitaloceanspaces.com`;
    const endpoint = `https://${host}`;

    const res = await signedS3Fetch({
      accessKey: accessKeyId,
      secretKey: secretAccessKey,
      region,
      method: "PUT",
      url: `${endpoint}/`,
    });
    if (!res.ok) {
      throw new Error(
        `Spaces S3 API error ${res.status} creating bucket "${bucketName}": ${await res.text()}`,
      );
    }

    await assignToProjectIfNeeded(`do:space:${bucketName}`);
    return {
      id: `${accountId}:spaces-bucket:${bucketName}`,
      pluginId: "digitalocean",
      resourceTypeId: "spaces-bucket",
      accountId,
      displayName: String(bucketName),
      fields: {
        name: String(bucketName),
        region,
        accessControl: "private",
      },
      resolvedOutputs: {
        endpoint,
      },
      secretStates: [],
      externalId: String(bucketName),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  if (typeId === "managed-database") {
    const data = await ctx.fetch<{ database: Record<string, unknown> }>("/databases", {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"],
        engine: fields["engine"],
        region: fields["region"],
        size: fields["size"],
        num_nodes: Number(fields["nodeCount"] || 1),
      }),
    });
    const db = data.database;
    await assignToProjectIfNeeded(`do:dbaas:${String(db["id"])}`);
    return {
      id: `${accountId}:managed-database:${String(db["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "managed-database",
      accountId,
      displayName: String(db["name"]),
      fields: {
        name: String(db["name"]),
        engine: String(db["engine"] ?? ""),
        version: String(db["version"] ?? ""),
        region: String(db["region"] ?? ""),
        size: String(db["size"] ?? ""),
        nodeCount: Number(db["num_nodes"] ?? 1),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(db["id"]),
      createdAt: String(db["created_at"] ?? new Date().toISOString()),
      updatedAt: String(db["created_at"] ?? new Date().toISOString()),
    };
  }

  if (typeId === "domain") {
    const data = await ctx.fetch<{ domain: Record<string, unknown> }>("/domains", {
      method: "POST",
      body: JSON.stringify({ name: fields["name"] }),
    });
    const d = data.domain;
    return {
      id: `${accountId}:domain:${String(d["name"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "domain",
      accountId,
      displayName: String(d["name"]),
      fields: {
        name: String(d["name"]),
        ttl: Number(d["ttl"] ?? 1800),
        zoneFile: String(d["zone_file"] ?? ""),
      },
      resolvedOutputs: {
        nameservers: "ns1.digitalocean.com, ns2.digitalocean.com, ns3.digitalocean.com",
      },
      secretStates: [],
      externalId: String(d["name"]),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  if (typeId === "dns-record") {
    // When created from a domain's detail page, the domain field is hidden
    // in the form — recover it from parentResourceId (domain externalId is
    // the domain name itself).
    const domainName = fields["domainName"] || parentExternalId;
    if (!domainName)
      throw new Error("DigitalOcean plugin: domainName is required to create a DNS record");
    const body: Record<string, unknown> = {
      type: fields["type"],
      name: fields["name"],
      data: fields["data"],
      ...(fields["ttl"] ? { ttl: Number(fields["ttl"]) } : {}),
      ...(fields["priority"] ? { priority: Number(fields["priority"]) } : {}),
    };
    const data = await ctx.fetch<{ domain_record: Record<string, unknown> }>(
      `/domains/${domainName}/records`,
      { method: "POST", body: JSON.stringify(body) },
    );
    const r = data.domain_record;
    const type = String(r["type"] ?? "");
    const name = String(r["name"] ?? "@");
    const displayName = name === "@" ? domainName : `${name}.${domainName}`;
    return {
      id: `${accountId}:dns-record:${domainName}/${String(r["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "dns-record",
      accountId,
      displayName: `${type} ${displayName}`,
      fields: {
        type,
        name: displayName,
        data: String(r["data"] ?? ""),
        ttl: Number(r["ttl"] ?? 1800),
        ...(r["priority"] != null ? { priority: Number(r["priority"]) } : {}),
        domainName,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: `${domainName}/${String(r["id"])}`,
      parentResourceId: `${accountId}:domain:${domainName}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  if (typeId === "project") {
    const data = await ctx.fetch<{ project: Record<string, unknown> }>("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: fields["name"] ?? "",
        purpose: fields["purpose"] ?? "Web Application",
        description: fields["description"] ?? "",
        environment: fields["environment"] ?? "Development",
      }),
    });
    const p = data.project ?? {};
    const now = new Date().toISOString();
    return {
      id: `${accountId}:project:${String(p["id"] ?? "")}`,
      pluginId: "digitalocean",
      resourceTypeId: "project",
      accountId,
      displayName: String(p["name"] ?? fields["name"]),
      fields: {
        name: String(p["name"] ?? fields["name"]),
        purpose: String(p["purpose"] ?? fields["purpose"] ?? ""),
        description: String(p["description"] ?? fields["description"] ?? ""),
        environment: String(p["environment"] ?? fields["environment"] ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(p["id"] ?? ""),
      createdAt: String(p["created_at"] ?? now),
      updatedAt: String(p["updated_at"] ?? now),
    };
  }

  if (typeId === "volume") {
    const body: Record<string, unknown> = {
      name: fields["name"],
      region: fields["region"],
      size_gigabytes: Number(fields["sizeGb"] ?? 100),
      ...(fields["filesystemType"] ? { filesystem_type: fields["filesystemType"] } : {}),
    };
    const data = await ctx.fetch<{ volume: Record<string, unknown> }>("/volumes", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const v = data.volume;
    const now = new Date().toISOString();
    await assignToProjectIfNeeded(`do:volume:${String(v["id"] ?? "")}`);
    return {
      id: `${accountId}:volume:${String(v["id"])}`,
      pluginId: "digitalocean",
      resourceTypeId: "volume",
      accountId,
      displayName: String(v["name"] ?? fields["name"]),
      fields: {
        name: String(v["name"] ?? fields["name"]),
        region: String((v["region"] as Record<string, unknown>)?.["slug"] ?? fields["region"]),
        sizeGb: Number(v["size_gigabytes"] ?? fields["sizeGb"] ?? 0),
        filesystemType: String(v["filesystem_type"] ?? ""),
        dropletIds: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: String(v["id"] ?? ""),
      createdAt: String(v["created_at"] ?? now),
      updatedAt: now,
    };
  }

  throw new Error(`DigitalOcean plugin: createResource not supported for type "${typeId}"`);
}
