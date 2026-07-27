/** Create handlers for DigitalOcean Droplets and DOKS (managed Kubernetes) clusters. */
import type {
  CreateResourceConfig,
  ImageOption,
  ResourceInstance,
  SizeOption,
} from "@infrawrench/plugin-base";
import { regionDisplay } from "../constants.js";
import { buildProjectField, type DoCreateArgs, type DoCreateContext } from "./shared.js";

/**
 * Build the create form for the types this module owns. Returns `null` when
 * `typeId` belongs to another module so the dispatcher can try the next one.
 */
export async function computeGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
  if (typeId === "droplet") {
    // When the user creates a droplet from a project's detail page we already
    // know the project via parentResourceId — skip the projects fetch and
    // hide the Project field. From the account base we list projects so the
    // user can pick one (defaults to whichever project DO marks
    // `is_default`).
    const [regionsData, sizesData, publicImagesData, privateImagesData, projectField] =
      await Promise.all([
        ctx.fetch<{ regions: Array<{ slug: string; name: string; available: boolean }> }>(
          "/regions",
        ),
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
        buildProjectField(ctx, parentResourceId),
      ]);

    const regions = regionsData.regions
      .filter((r) => r.available)
      .map((r) => {
        const info = regionDisplay(r.slug);
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
      // DO returns price_monthly: 0 for some sizes (notably the highest-tier
      // CPU-Optimized SKUs like c-96-intel that are quoted-only). Omit
      // priceMonthly entirely when the value isn't a positive number — the
      // picker renders "$0/mo" otherwise, which is worse than no chip.
      const price = Number(s.price_monthly);
      sizesByCategory.get(cat)!.push({
        id: s.slug,
        label: s.slug,
        vcpus: s.vcpus,
        memoryMb: s.memory,
        diskGb: s.disk,
        ...(Number.isFinite(price) && price > 0 ? { priceMonthly: price } : {}),
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
        ...projectField,
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
    const [optionsData, sizesData, projectField] = await Promise.all([
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
      buildProjectField(ctx, parentResourceId),
    ]);

    const regions = (optionsData.options?.regions ?? []).map((region) => {
      const info = regionDisplay(region.slug);
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
      const price = Number(size.price_monthly);
      sizesByCategory.get(category)!.push({
        id: size.slug,
        label: size.slug,
        vcpus: size.vcpus,
        memoryMb: size.memory,
        diskGb: size.disk,
        ...(Number.isFinite(price) && price > 0 ? { priceMonthly: price } : {}),
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
        ...projectField,
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

  return null;
}

/**
 * Create one of the types this module owns. Returns `null` when `typeId`
 * belongs to another module.
 */
export async function computeCreateResource(args: DoCreateArgs): Promise<ResourceInstance | null> {
  const { ctx, typeId, accountId, fields, effectiveParentId, assignToProjectIfNeeded } = args;
  if (typeId === "droplet") {
    // SSH key: upload to DO account (idempotent — if it already exists DO returns the existing key)
    const sshKeyIds: number[] = [];
    const sshPub = fields["sshPublicKey"];
    if (sshPub) {
      try {
        const comment = sshPub.trim().split(" ")[2] ?? "infrawrench";
        let keyId: number | undefined;
        try {
          const created = await ctx.fetch<{ ssh_key: { id: number } }>("/account/keys", {
            method: "POST",
            body: JSON.stringify({ name: comment, public_key: sshPub.trim() }),
          });
          keyId = created.ssh_key.id;
        } catch (e: unknown) {
          if (!String(e).includes("422")) throw e;
          // 422 means the key already exists on the account — look up its id.
          // Keys can span multiple pages, so walk them until we find the
          // match or exhaust the list.
          const perPage = 200;
          for (let page = 1; keyId === undefined; page += 1) {
            const data = await ctx.fetch<{
              ssh_keys?: Array<{ id: number; public_key: string }>;
            }>(`/account/keys?per_page=${perPage}&page=${page}`);
            const keys = data.ssh_keys ?? [];
            keyId = keys.find((k) => k.public_key.trim() === sshPub.trim())?.id;
            if (keys.length < perPage) break;
          }
        }
        if (keyId) sshKeyIds.push(keyId);
        if (!keyId) {
          throw new Error("DigitalOcean did not return an id for the uploaded SSH key");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to attach SSH key to DigitalOcean Droplet: ${message}`);
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
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
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
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
      createdAt: String(cluster["created_at"] ?? new Date().toISOString()),
      updatedAt: String(cluster["updated_at"] ?? cluster["created_at"] ?? new Date().toISOString()),
    };
  }

  return null;
}
