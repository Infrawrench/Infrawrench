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
import { SPACES_REGIONS, regionDisplay } from "./constants.js";

export interface DoCreateContext {
  fetch<T>(path: string, options?: RequestInit): Promise<T>;
  credentials: Record<string, string>;
}

/**
 * Estimate the per-node monthly price (USD) of a DigitalOcean managed-database
 * node from its size slug. DO doesn't expose DB pricing via /v2 — the only
 * source of truth is www.digitalocean.com/pricing/managed-databases — so this
 * is a slug-pattern + memory heuristic verified against DO's published rates
 * for the well-defined tiers:
 *
 *   - Standard nodes (db-s-…): ~$15.20/mo per GiB of memory
 *     (db-s-1vcpu-1gb=$15, db-s-2vcpu-4gb=$60, db-s-4vcpu-8gb=$120,
 *      db-s-6vcpu-16gb=$240, db-s-8vcpu-32gb=$480; verified May 2026)
 *   - Memory-optimized (db-r-…): ~$30.45/mo per GiB
 *   - Burstable (db-b-…): ~$8/mo per GiB
 *
 * Returns 0 (the picker reads this as "no price chip") whenever the slug
 * doesn't match a tier we have verified rates for. Engines with their own
 * namespacing (do-kafka-…, mongodb-…, opensearch-…, valkey-…) all price
 * differently from the Standard tier, so rather than fake a number we
 * just omit the chip — "$0/mo" on a c-96-intel-sized SKU is more
 * misleading than no chip at all.
 */
export function estimateDoDatabaseMonthlyPrice(slug: string, memoryGb: number): number {
  if (!memoryGb) return 0;
  if (/^db-r-/i.test(slug)) return memoryGb * 30.45;
  if (/^db-b-/i.test(slug)) return memoryGb * 8;
  if (/^db-s-/i.test(slug)) return memoryGb * 15.2;
  // Anything else (engine-namespaced slugs, future tiers, etc.) — bail.
  return 0;
}

/**
 * Build a "Project" select field for the create form. Returned as a
 * single-element array so callers can spread it into their fields list
 * (`...projectField`); empty when a `parentResourceId` was already passed
 * in (the form was opened from a project's detail page so the target is
 * implicit) or when the account has no projects at all (DO assigns to
 * the default project automatically). Default option is the project DO
 * marks `is_default`, falling back to the first listed project.
 *
 * The field key is fixed as `projectId` so `doCreateResourceImpl` can
 * resolve it generically: when there's no parentResourceId it reads
 * `fields["projectId"]` as the project to assign to, and synthesizes a
 * matching `parentResourceId` on the returned ResourceInstance so the
 * new resource nests under its project in the sidebar.
 */
async function buildProjectField(
  ctx: DoCreateContext,
  parentResourceId: string | undefined,
): Promise<CreateResourceConfig["fields"]> {
  if (parentResourceId) return [];
  const projectsData = await ctx
    .fetch<{
      projects?: Array<{ id: string; name: string; is_default?: boolean }> | null;
    }>("/projects")
    .catch(() => null);
  const projects = projectsData?.projects ?? [];
  if (projects.length === 0) return [];
  const options = projects.map((p) => ({
    id: p.id,
    label: p.is_default ? `${p.name} (default)` : p.name,
  }));
  const defaultProjectId = projects.find((p) => p.is_default)?.id ?? options[0]?.id;
  return [
    {
      key: "projectId",
      label: "Project",
      kind: "select" as const,
      required: false,
      options,
      ...(defaultProjectId ? { defaultValue: defaultProjectId } : {}),
      description: "DigitalOcean project to assign this resource to.",
    },
  ];
}

export async function doGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig> {
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

  if (typeId === "spaces-bucket") {
    const [regionsData, projectField] = await Promise.all([
      ctx.fetch<{ regions: Array<{ slug: string; name: string; available: boolean }> }>("/regions"),
      buildProjectField(ctx, parentResourceId),
    ]);
    const spacesRegions = regionsData.regions
      .filter((r) => r.available)
      .filter((r) => SPACES_REGIONS.includes(r.slug))
      .map((r) => {
        const info = regionDisplay(r.slug);
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
        ...projectField,
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
    // Database node sizes come from /v2/databases/options, NOT /v2/sizes
    // (which lists droplet sizes — none of those carry the `db-` prefix,
    // so the picker was always empty). The options endpoint groups sizes
    // by engine and layout (num_nodes); we take the union across every
    // engine so a single picker covers all engines the user can pick
    // above. DO will reject mismatched engine+size combos at create time
    // with a clear message.
    const [regionsData, optionsData, projectField] = await Promise.all([
      ctx.fetch<{
        regions: Array<{ slug: string; name: string; available: boolean }>;
      }>("/regions"),
      ctx.fetch<{
        options?: Record<
          string,
          {
            regions?: string[];
            layouts?: Array<{ num_nodes?: number; sizes?: string[] }>;
            versions?: string[];
          }
        > | null;
      }>("/databases/options"),
      buildProjectField(ctx, parentResourceId),
    ]);

    // DO's `/regions` lists legacy datacenters (nyc1, nyc2, ams2, sfo1,
    // sfo2, sgp2) as available because they still serve droplets, but
    // none of them host managed databases. DO's create endpoint rejects
    // these with `region '<slug>' is not valid` regardless of engine, so
    // they're excluded unconditionally before the per-engine tagging.
    const NON_DBAAS_REGIONS = new Set(["nyc1", "nyc2", "ams2", "sfo1", "sfo2", "sgp2"]);

    // Per-engine region availability lets the picker reactively filter by
    // the chosen engine field so users can't pick an engine+region combo
    // DO will reject. Primary source is /databases/options.{engine}.regions.
    //
    // DO migrated Redis storage to Valkey; the options endpoint surfaces
    // the live list under a `valkey` key, but the create-time engine value
    // the API still accepts (and that the picker above offers) is `redis`.
    // Mirror the slugs under both names so the filter matches whichever
    // label DO is currently using.
    const engineAliases: Record<string, string[]> = {
      valkey: ["valkey", "redis"],
      redis: ["valkey", "redis"],
    };
    const engineRegions = new Map<string, Set<string>>();
    for (const [engine, info] of Object.entries(optionsData.options ?? {})) {
      const labels = engineAliases[engine] ?? [engine];
      for (const slug of info.regions ?? []) {
        if (NON_DBAAS_REGIONS.has(slug)) continue;
        if (!engineRegions.has(slug)) engineRegions.set(slug, new Set());
        const set = engineRegions.get(slug)!;
        for (const label of labels) set.add(label);
      }
    }

    // Final per-engine fallback for accounts where /databases/options
    // doesn't return a `regions` list (we've seen this happen even though
    // DO's own OpenAPI spec declares the field). These slugs are the
    // current DBaaS-supported regions from DO's public docs; they're
    // intentionally narrow so we err on the side of "show fewer regions
    // than the API would accept" rather than "let DO reject a pick".
    const FALLBACK_ENGINE_REGIONS: Record<string, string[]> = {
      pg: ["ams3", "blr1", "fra1", "lon1", "nyc3", "sfo3", "sgp1", "syd1", "tor1"],
      mysql: ["ams3", "blr1", "fra1", "lon1", "nyc3", "sfo3", "sgp1", "syd1", "tor1"],
      redis: ["ams3", "blr1", "fra1", "lon1", "nyc3", "sfo3", "sgp1", "syd1", "tor1"],
      valkey: ["ams3", "blr1", "fra1", "lon1", "nyc3", "sfo3", "sgp1", "syd1", "tor1"],
      mongodb: ["ams3", "blr1", "fra1", "lon1", "nyc3", "sfo3", "sgp1", "syd1", "tor1"],
      kafka: ["ams3", "fra1", "lon1", "nyc3", "sfo3", "sgp1", "syd1", "tor1"],
      opensearch: ["ams3", "fra1", "lon1", "nyc3", "sfo3", "sgp1", "syd1", "tor1"],
    };
    for (const [engine, slugs] of Object.entries(FALLBACK_ENGINE_REGIONS)) {
      const labels = engineAliases[engine] ?? [engine];
      // Only fill from the fallback when the API gave us nothing for any of
      // this engine's labels — preserves the live list when DO does return
      // accurate per-engine regions.
      const haveLive = labels.some((label) =>
        [...engineRegions.values()].some((set) => set.has(label)),
      );
      if (haveLive) continue;
      for (const slug of slugs) {
        if (NON_DBAAS_REGIONS.has(slug)) continue;
        if (!engineRegions.has(slug)) engineRegions.set(slug, new Set());
        const set = engineRegions.get(slug)!;
        for (const label of labels) set.add(label);
      }
    }

    const dbCapableSlugs = engineRegions.size > 0 ? new Set(engineRegions.keys()) : null;
    const regions = regionsData.regions
      .filter((r) => r.available)
      // DBaaS isn't offered in DO's legacy datacenters — exclude them
      // regardless of whether the per-engine map came from the API or the
      // hardcoded fallback above.
      .filter((r) => !NON_DBAAS_REGIONS.has(r.slug))
      // When we have a per-engine list, drop regions no engine supports.
      .filter((r) => !dbCapableSlugs || dbCapableSlugs.has(r.slug))
      .map((r) => {
        const info = regionDisplay(r.slug);
        const engines = engineRegions.get(r.slug);
        return {
          id: r.slug,
          label: r.name,
          ...(info ? { location: info.location, flag: info.flag } : {}),
          ...(engines ? { availableFor: [...engines].sort() } : {}),
        };
      });

    // Tag each size slug with the engines it's valid for, so the picker can
    // reactively filter when the engine field changes. Kafka and OpenSearch
    // use engine-specific size slugs (e.g. `db-r-*` is invalid for them);
    // submitting the wrong combo got us `invalid layout and size combination:
    // plan does not match cluster type` from DO.
    const sizeEngines = new Map<string, Set<string>>();
    for (const [engine, info] of Object.entries(optionsData.options ?? {})) {
      const labels = engineAliases[engine] ?? [engine];
      for (const layout of info.layouts ?? []) {
        for (const slug of layout.sizes ?? []) {
          if (!sizeEngines.has(slug)) sizeEngines.set(slug, new Set());
          const set = sizeEngines.get(slug)!;
          for (const label of labels) set.add(label);
        }
      }
    }
    const dbSizes = [...sizeEngines.entries()]
      .map(([slug, engines]) => {
        // Slugs look like "db-s-1vcpu-1gb" / "db-r-2vcpu-16gb" / engine-namespaced
        // variants for Kafka/OpenSearch. Older slugs encode vCPU + memory inline;
        // the picker drops anything we can't parse so the chips don't read
        // "0 vCPUs / 0 MB" for unknown shapes.
        const vcpuMatch = /(\d+)\s*v?cpu/i.exec(slug);
        const memMatch = /(\d+)gb/i.exec(slug);
        const vcpus = vcpuMatch ? Number(vcpuMatch[1]) : 0;
        const memoryGb = memMatch ? Number(memMatch[1]) : 0;
        const price = estimateDoDatabaseMonthlyPrice(slug, memoryGb);
        return {
          id: slug,
          label: slug,
          vcpus,
          memoryMb: memoryGb * 1024,
          diskGb: 0,
          ...(price > 0 ? { priceMonthly: price } : {}),
          category: slug.split("-").slice(0, 2).join("-") || "Database",
          availableFor: [...engines].sort(),
          _parsable: vcpus > 0 && memoryGb > 0,
        };
      })
      .filter((s) => s._parsable)
      .map(({ _parsable: _, ...rest }) => rest)
      .sort((a, b) => a.vcpus - b.vcpus || a.memoryMb - b.memoryMb || a.id.localeCompare(b.id));

    return {
      fields: [
        { key: "name", label: "Name", kind: "text", required: true },
        ...projectField,
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
          filterByFieldKey: "engine",
          ...(regions[0] ? { defaultValue: regions[0].id } : {}),
        },
        {
          key: "size",
          label: "Node Size",
          kind: "size-picker",
          required: true,
          sizes: dbSizes,
          filterByFieldKey: "engine",
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

  if (typeId === "db-user") {
    return {
      fields: [
        {
          key: "name",
          label: "Username",
          kind: "text",
          required: true,
          description:
            "Letters, digits, and `_-` only. Must be unique within the cluster. DO will " +
            "auto-generate the password and we'll persist it locally so the cluster's " +
            "connection string can use it.",
          placeholder: "infrawrench",
          defaultValue: `infrawrench-${Math.random().toString(36).slice(2, 8)}`,
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
    const [regionsData, projectField] = await Promise.all([
      ctx.fetch<{ regions: Array<{ slug: string; name: string; available: boolean }> }>("/regions"),
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
    return {
      fields: [
        { key: "name", label: "Volume Name", kind: "text", required: true },
        ...projectField,
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

  if (typeId === "nfs-share") {
    // NFS shares are pinned to a VPC. List both regions (only some are
    // NFS-eligible — DO returns 422 from create otherwise, surfaced as the
    // host error) and the account's VPCs so the user can pick.
    const [regionsData, vpcsData, projectField] = await Promise.all([
      ctx.fetch<{
        regions: Array<{ slug: string; name: string; available: boolean }>;
      }>("/regions"),
      ctx
        .fetch<{ vpcs: Array<{ id: string; name: string; region: string }> }>("/vpcs?per_page=200")
        .catch(() => ({ vpcs: [] as Array<{ id: string; name: string; region: string }> })),
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
    const vpcOptions = vpcsData.vpcs.map((v) => ({
      id: v.id,
      label: `${v.name} (${v.region})`,
    }));
    return {
      fields: [
        { key: "name", label: "Share Name", kind: "text", required: true },
        ...projectField,
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions,
          ...(regions[0] ? { defaultValue: regions[0].id } : {}),
          description:
            "Only some DO regions host NFS. The create call will 422 in unsupported regions.",
        },
        {
          key: "sizeGib",
          label: "Size",
          kind: "disk-slider",
          required: true,
          minGb: 50,
          maxGb: 16000,
          defaultGb: 50,
          stepGb: 50,
          description: "Minimum 50 GiB; max 16,000 GiB.",
        },
        {
          key: "performanceTier",
          label: "Performance Tier",
          kind: "select",
          required: true,
          defaultValue: "standard",
          options: [
            { id: "standard", label: "Standard ($0.15 / GiB-mo)" },
            { id: "high-performance", label: "High Performance ($0.30 / GiB-mo, GPU-tuned)" },
          ],
        },
        {
          key: "vpcId",
          label: "VPC",
          kind: "select",
          required: true,
          options: vpcOptions,
          ...(vpcOptions[0] ? { defaultValue: vpcOptions[0].id } : {}),
          description:
            "Shares are reachable only from droplets/DOKS nodes in this VPC. Multiple VPCs can be added after creation via the DO console.",
        },
      ],
    };
  }

  if (typeId === "gen-ai-agent") {
    // GenAI agents need to be tied to a foundation model. Fetch the
    // available agent-usecase models so the user can pick one rather than
    // pasting a UUID. The regions list comes from the GenAI regions endpoint
    // (separate from /v2/regions, which only covers the classic IaaS
    // footprint — GenAI is only deployed in a subset).
    const [models, routers, regions, workspaces, projectField] = await Promise.all([
      ctx
        .fetch<{
          models?: Array<{
            uuid?: string;
            name?: string;
            provider?: { name?: string };
          }>;
        }>("/gen-ai/models?usecases=MODEL_USECASE_AGENT&per_page=200")
        .catch(() => ({ models: [] })),
      ctx
        .fetch<{
          model_routers?: Array<{ uuid?: string; name?: string }>;
        }>("/gen-ai/models/routers?per_page=200")
        .catch(() => ({ model_routers: [] })),
      ctx
        .fetch<{
          regions?: Array<{ region: string; serves_inference?: boolean }>;
        }>("/gen-ai/regions")
        .catch(() => ({ regions: [] })),
      ctx
        .fetch<{
          workspaces?: Array<{ uuid?: string; name?: string }>;
        }>("/gen-ai/workspaces")
        .catch(() => ({ workspaces: [] })),
      buildProjectField(ctx, parentResourceId),
    ]);
    const modelOptions = (models.models ?? []).map((m) => ({
      id: String(m.uuid ?? ""),
      label: `${String(m.name ?? "")}${m.provider?.name ? ` (${m.provider.name})` : ""}`,
    }));
    const routerOptions = (routers.model_routers ?? []).map((r) => ({
      id: String(r.uuid ?? ""),
      label: String(r.name ?? r.uuid ?? ""),
    }));
    const workspaceOptions = (workspaces.workspaces ?? []).map((w) => ({
      id: String(w.uuid ?? ""),
      label: String(w.name ?? w.uuid ?? ""),
    }));
    const regionOptions = (regions.regions ?? [])
      .filter((r) => r.serves_inference !== false)
      .map((r) => {
        const info = regionDisplay(r.region);
        return {
          id: r.region,
          label: r.region,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    // Toggle between a single foundation model and an Inference Router.
    // DO's API accepts `model_uuid` XOR `model_router_uuid` (mutually
    // exclusive — sending both is a 400), so we gate the two pickers
    // with showWhen and require at most one at create time.
    const hasRouters = routerOptions.length > 0;
    return {
      fields: [
        { key: "name", label: "Agent Name", kind: "text", required: true },
        ...projectField,
        {
          key: "workspaceUuid",
          label: "Workspace",
          kind: "select",
          required: false,
          options: workspaceOptions,
          ...(workspaceOptions[0] ? { defaultValue: workspaceOptions[0].id } : {}),
          description:
            workspaceOptions.length === 0
              ? "No workspaces in this team yet — leave empty to auto-create a 'default' workspace, or click '+ New workspace' to pick a name."
              : "Workspace this agent will belong to. Use '+ New workspace' to create another.",
          actions: [
            {
              id: "create-workspace",
              label: "+ New workspace",
              description: "Create a new GenAI workspace and attach this agent to it.",
              submitLabel: "Create workspace",
              formFields: [
                {
                  key: "name",
                  label: "Workspace Name",
                  kind: "text",
                  required: true,
                  placeholder: "default",
                },
                {
                  key: "description",
                  label: "Description",
                  kind: "text",
                  required: false,
                },
              ],
            },
          ],
        },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(regionOptions[0] ? { defaultValue: regionOptions[0].id } : {}),
        },
        {
          key: "modelSource",
          label: "Model Source",
          kind: "select",
          required: true,
          defaultValue: "model",
          options: [
            { id: "model", label: "Single foundation model" },
            {
              id: "router",
              label: hasRouters
                ? "Inference Router (auto-pick model per call)"
                : "Inference Router (none configured yet — create one first)",
            },
          ],
          description:
            "Pick one foundation model, or route requests through an Inference Router that " +
            "picks the right model per call based on prompt complexity.",
        },
        {
          key: "modelUuid",
          label: "Foundation Model",
          kind: "select",
          required: false,
          options: modelOptions,
          ...(modelOptions[0] ? { defaultValue: modelOptions[0].id } : {}),
          description: "Foundation model that powers the agent's responses.",
          showWhen: { fieldKey: "modelSource", fieldValue: "model" },
        },
        {
          key: "modelRouterUuid",
          label: "Inference Router",
          kind: "select",
          required: false,
          options: routerOptions,
          ...(routerOptions[0] ? { defaultValue: routerOptions[0].id } : {}),
          description:
            "Pick an existing Inference Router or create a new one inline. The router's policies and fallback models govern which underlying model serves each request.",
          showWhen: { fieldKey: "modelSource", fieldValue: "router" },
          actions: [
            {
              id: "create-inference-router",
              label: "+ New router",
              description: "Create a new Inference Router and attach it to this agent in one step.",
              submitLabel: "Create router",
              formFields: [
                {
                  key: "name",
                  label: "Router Name",
                  kind: "text",
                  required: true,
                  placeholder: "my-router",
                },
                {
                  key: "description",
                  label: "Description",
                  kind: "text",
                  required: false,
                },
                {
                  key: "fallbackModels",
                  label: "Fallback Models",
                  kind: "select",
                  required: false,
                  options: modelOptions,
                  description:
                    "Comma-separated list of fallback model UUIDs the router can use. Optional — the router can be configured fully later.",
                },
              ],
            },
          ],
        },
        {
          key: "instruction",
          label: "Instruction",
          kind: "text",
          required: false,
          multiline: true,
          description:
            "System prompt — guidance for the agent's behaviour and persona. Long-form supported.",
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

  if (typeId === "gen-ai-knowledge-base") {
    const [models, regions, projectField] = await Promise.all([
      ctx
        .fetch<{
          models?: Array<{ uuid?: string; name?: string }>;
        }>("/gen-ai/models?usecases=MODEL_USECASE_KNOWLEDGEBASE&per_page=200")
        .catch(() => ({ models: [] })),
      ctx
        .fetch<{
          regions?: Array<{ region: string; serves_inference?: boolean }>;
        }>("/gen-ai/regions")
        .catch(() => ({ regions: [] })),
      buildProjectField(ctx, parentResourceId),
    ]);
    const modelOptions = (models.models ?? []).map((m) => ({
      id: String(m.uuid ?? ""),
      label: String(m.name ?? ""),
    }));
    const regionOptions = (regions.regions ?? [])
      .filter((r) => r.serves_inference !== false)
      .map((r) => {
        const info = regionDisplay(r.region);
        return {
          id: r.region,
          label: r.region,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    return {
      fields: [
        { key: "name", label: "Knowledge Base Name", kind: "text", required: true },
        ...projectField,
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(regionOptions[0] ? { defaultValue: regionOptions[0].id } : {}),
        },
        {
          key: "embeddingModelUuid",
          label: "Embedding Model",
          kind: "select",
          required: true,
          options: modelOptions,
          ...(modelOptions[0] ? { defaultValue: modelOptions[0].id } : {}),
          description: "Embedding model used to vectorize indexed documents.",
        },
        {
          key: "tags",
          label: "Tags",
          kind: "text",
          required: false,
          description: "Comma-separated tags for organisation.",
        },
      ],
    };
  }

  if (typeId === "gen-ai-model-router") {
    const [models, regions] = await Promise.all([
      ctx
        .fetch<{
          models?: Array<{ uuid?: string; name?: string }>;
        }>("/gen-ai/models?usecases=MODEL_USECASE_SERVERLESS&per_page=200")
        .catch(() => ({ models: [] })),
      ctx
        .fetch<{
          regions?: Array<{ region: string; serves_inference?: boolean }>;
        }>("/gen-ai/regions")
        .catch(() => ({ regions: [] })),
    ]);
    const modelOptions = (models.models ?? []).map((m) => ({
      id: String(m.uuid ?? ""),
      label: String(m.name ?? ""),
    }));
    const regionOptions = (regions.regions ?? [])
      .filter((r) => r.serves_inference !== false)
      .map((r) => {
        const info = regionDisplay(r.region);
        return {
          id: r.region,
          label: r.region,
          ...(info ? { location: info.location, flag: info.flag } : {}),
        };
      });
    return {
      fields: [
        { key: "name", label: "Router Name", kind: "text", required: true },
        { key: "description", label: "Description", kind: "text", required: false },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(regionOptions[0] ? { defaultValue: regionOptions[0].id } : {}),
        },
        {
          key: "fallbackModels",
          label: "Fallback Models",
          kind: "select",
          required: false,
          options: modelOptions,
          description:
            "Comma-separated list of foundation-model UUIDs to fall back on when no policy matches.",
        },
      ],
    };
  }

  if (typeId === "dedicated-inference") {
    // Pull both the size catalog (region+GPU+pricing) and the GPU model
    // config catalog (what model_id each accelerator can serve) so the
    // user can pick a region/size that's actually viable for their model.
    const [sizes, accelerators] = await Promise.all([
      ctx
        .fetch<{
          regions?: Array<{
            region: string;
            sizes?: Array<{ slug: string; gpu_count: number; price_monthly?: number }>;
          }>;
        }>("/dedicated-inferences/sizes")
        .catch(() => ({ regions: [] })),
      ctx
        .fetch<{
          accelerators?: Array<{ slug?: string; model_id?: string; name?: string }>;
        }>("/dedicated-inferences/accelerators")
        .catch(() => ({ accelerators: [] })),
    ]);
    const regionOptions = (sizes.regions ?? []).map((r) => {
      const info = regionDisplay(r.region);
      return {
        id: r.region,
        label: r.region,
        ...(info ? { location: info.location, flag: info.flag } : {}),
      };
    });
    const sizeOptions = (sizes.regions ?? []).flatMap((r) =>
      (r.sizes ?? []).map((s) => ({
        id: s.slug,
        label: s.price_monthly
          ? `${s.slug} (${s.gpu_count}× GPU, $${Math.round(s.price_monthly)}/mo)`
          : `${s.slug} (${s.gpu_count}× GPU)`,
      })),
    );
    const modelOptions = (accelerators.accelerators ?? []).map((a) => ({
      id: String(a.model_id ?? a.slug ?? ""),
      label: String(a.name ?? a.model_id ?? a.slug ?? ""),
    }));
    return {
      fields: [
        { key: "name", label: "Deployment Name", kind: "text", required: true },
        {
          key: "region",
          label: "Region",
          kind: "region-picker",
          required: true,
          regions: regionOptions,
          ...(regionOptions[0] ? { defaultValue: regionOptions[0].id } : {}),
        },
        {
          key: "size",
          label: "GPU Size",
          kind: "select",
          required: true,
          options: sizeOptions,
          description: "Accelerator size — GPU count and monthly price.",
        },
        {
          key: "modelId",
          label: "Model",
          kind: "select",
          required: true,
          options: modelOptions,
          description: "Model deployed on this dedicated inference instance.",
        },
        {
          key: "enablePublicEndpoint",
          label: "Public Endpoint",
          kind: "select",
          required: true,
          defaultValue: "false",
          options: [
            { id: "true", label: "Public + VPC" },
            { id: "false", label: "VPC only" },
          ],
          description: "Expose a public HTTPS endpoint in addition to the private VPC FQDN.",
        },
        {
          key: "vpcUuid",
          label: "VPC",
          kind: "text",
          required: false,
          description: "Optional VPC UUID. Defaults to the region's default VPC when empty.",
        },
        {
          key: "huggingFaceToken",
          label: "Hugging Face Token",
          kind: "text",
          required: false,
          description: "Required only for gated Hugging Face models.",
        },
      ],
    };
  }

  if (typeId === "model-api-key") {
    return {
      fields: [{ key: "name", label: "Key Name", kind: "text", required: true }],
    };
  }

  if (typeId === "agent-api-key") {
    if (!parentResourceId) {
      const list = await ctx
        .fetch<{ agents?: Array<{ uuid?: string; name?: string }> }>("/gen-ai/agents?per_page=200")
        .catch(() => ({ agents: [] }));
      const options = (list.agents ?? []).map((a) => ({
        id: String(a.uuid ?? ""),
        label: String(a.name ?? a.uuid ?? ""),
      }));
      return {
        fields: [
          {
            key: "agentUuid",
            label: "Agent",
            kind: "select",
            required: true,
            options,
            ...(options[0] ? { defaultValue: options[0].id } : {}),
            description: "Agent this access key will authenticate against.",
          },
          { key: "name", label: "Key Name", kind: "text", required: true },
        ],
      };
    }
    return {
      fields: [{ key: "name", label: "Key Name", kind: "text", required: true }],
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
  // Mutable cell — handlers that mint sidecar credentials (e.g. spaces-bucket
  // auto-creating an account-wide Spaces key) write into it, and the wrapper
  // forwards them up to the host as `credentialUpdates` on the result.
  const credentialUpdatesRef: { value?: Record<string, string> } = {};
  const resource = await doCreateResourceImpl(
    ctx,
    typeId,
    accountId,
    fields,
    parentResourceId,
    warnings,
    credentialUpdatesRef,
  );
  return {
    resource,
    warnings,
    ...(credentialUpdatesRef.value ? { credentialUpdates: credentialUpdatesRef.value } : {}),
  };
}

async function doCreateResourceImpl(
  ctx: DoCreateContext,
  typeId: string,
  accountId: string,
  fields: Record<string, string>,
  parentResourceId: string | undefined,
  warnings: ResourceWarning[],
  credentialUpdatesRef: { value?: Record<string, string> },
): Promise<ResourceInstance> {
  // When a child resource is created from its parent's detail page, the form
  // omits the parent-identifying field — recover it by parsing the parent's
  // `{accountId}:{typeId}:{externalId}` id. DO project ids are UUIDs; DO
  // domain ids are the domain name itself. Falls back to `fields["projectId"]`
  // when the form was opened from the account base and the user picked a
  // project explicitly via the build-helper-added field.
  const parentExternalId = parentResourceId
    ? parentResourceId.split(":").slice(2).join(":")
    : (fields["projectId"] ?? "");

  // For project-assignable types, build a synthetic parentResourceId from
  // the picked project so the new resource nests under its project in the
  // sidebar/account view even when the form was opened from the account
  // base. Type-specific create branches below thread this onto the
  // returned ResourceInstance via `parentResourceId: effectiveParentId`.
  const effectiveParentId =
    parentResourceId ?? (parentExternalId ? `${accountId}:project:${parentExternalId}` : "");

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

  if (typeId === "spaces-bucket") {
    // Spaces buckets are created via the S3-compatible API — DO's REST API
    // (/v2/spaces/...) only exposes access-key CRUD, no bucket operations
    // (verified in digitalocean/openapi/spaces/). The S3 PUT needs a pair
    // of Spaces keys distinct from the API token; modelled as
    // `spacesAccessKeyId` / `spacesSecretAccessKey` on the account.
    //
    // When the pair is missing we mint an account-wide key via POST
    // /spaces/keys (PAT scope: spaces_keys:create) and return it via
    // `credentialUpdates` so the host persists it. A freshly-minted key
    // takes a few seconds to propagate to DO's S3 auth backend, so after
    // minting we probe with a cheap authenticated call (ListAllMyBuckets
    // GET against the regional endpoint) before the bucket PUT, then
    // retry the PUT on transient 403 in case propagation finishes mid-
    // flight.
    let accessKeyId = ctx.credentials["spacesAccessKeyId"] as string | undefined;
    let secretAccessKey = ctx.credentials["spacesSecretAccessKey"] as string | undefined;
    let mintedCredentialUpdates: Record<string, string> | undefined;
    let keyJustMinted = false;
    if (!accessKeyId || !secretAccessKey) {
      const name = `infrawrench-spaces-${Date.now().toString(36)}`;
      // POST /spaces/keys with NO grants (or grants: []) mints a "No Grant
      // Key" — DO's spec for an unauthorized key with zero permissions,
      // which is what was producing the AccessDenied response on the
      // bucket PUT. The correct shape for an account-wide full-access
      // key (the equivalent of the legacy console-generated "Spaces
      // access key") is a single grant with empty bucket + "fullaccess".
      const mintResp = await ctx
        .fetch<{
          key?: { access_key?: string; secret_key?: string };
        }>("/spaces/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            grants: [{ bucket: "", permission: "fullaccess" }],
          }),
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `DigitalOcean plugin: couldn't auto-generate Spaces access keys via POST /spaces/keys (${message}). ` +
              "Make sure the API token has the spaces_keys:create scope, or generate a key manually in the DO console (API > Spaces Keys) and edit this account.",
          );
        });
      const minted = mintResp.key;
      if (!minted?.access_key || !minted?.secret_key) {
        throw new Error(
          "DigitalOcean plugin: POST /spaces/keys returned no key. Generate one in the DO console (API > Spaces Keys) and edit this account.",
        );
      }
      accessKeyId = minted.access_key;
      secretAccessKey = minted.secret_key;
      mintedCredentialUpdates = {
        spacesAccessKeyId: accessKeyId,
        spacesSecretAccessKey: secretAccessKey,
      };
      keyJustMinted = true;
    }

    const bucketName = fields["name"];
    if (!bucketName) throw new Error("Bucket name is required");
    const region = fields["region"] ?? "nyc3";
    const host = `${bucketName}.${region}.digitaloceanspaces.com`;
    const endpoint = `https://${host}`;

    // Wait for a freshly-minted key to propagate. ListAllMyBuckets is the
    // cheapest authenticated probe — it doesn't require any pre-existing
    // bucket and returns 200 with an empty body on a brand-new account.
    if (keyJustMinted) {
      const regionalEndpoint = `https://${region}.digitaloceanspaces.com/`;
      const maxAttempts = 15;
      let ready = false;
      for (let i = 0; i < maxAttempts; i++) {
        const probe = await signedS3Fetch({
          accessKey: accessKeyId,
          secretKey: secretAccessKey,
          region,
          method: "GET",
          url: regionalEndpoint,
        }).catch(() => null);
        if (probe && probe.ok) {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      if (!ready) {
        throw new Error(
          "DigitalOcean plugin: auto-generated Spaces key isn't usable yet (still propagating after 30s). " +
            "The key has been saved on your account — retry the bucket create in a minute, or paste an existing Spaces key in the DO console (API > Spaces Keys) and edit this account.",
        );
      }
    }

    // Retry the bucket PUT on transient 403 — propagation can finish a
    // beat after the probe succeeds, especially if the user's account
    // has never used Spaces before.
    const tryPut = async (
      access: string,
      secret: string,
      attempts: number,
    ): Promise<{ ok: true } | { ok: false; status: number; text: string }> => {
      for (let i = 0; i < attempts; i++) {
        const r = await signedS3Fetch({
          accessKey: access,
          secretKey: secret,
          region,
          method: "PUT",
          url: `${endpoint}/`,
        });
        if (r.ok) return { ok: true };
        if (r.status !== 403 || i === attempts - 1) {
          return { ok: false, status: r.status, text: await r.text() };
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return { ok: false, status: 0, text: "no attempts" };
    };
    let putResult = await tryPut(accessKeyId, secretAccessKey, keyJustMinted ? 4 : 1);

    // Recovery for the previous "no grant key" leak: an earlier version
    // of this handler minted account-wide keys without the
    // `[{ bucket: "", permission: "fullaccess" }]` grant, producing a
    // valid key with zero permissions. Those keys are still saved on
    // affected accounts and will 403 every Spaces call. If a stored
    // (i.e. not-just-minted) key 403s on bucket creation, mint a
    // fresh full-access one, surface the replacement via
    // `credentialUpdates`, and retry once.
    if (!putResult.ok && putResult.status === 403 && !keyJustMinted) {
      const name = `infrawrench-spaces-${Date.now().toString(36)}`;
      const mintResp = await ctx
        .fetch<{
          key?: { access_key?: string; secret_key?: string };
        }>("/spaces/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            grants: [{ bucket: "", permission: "fullaccess" }],
          }),
        })
        .catch(() => null);
      const replacement = mintResp?.key;
      if (replacement?.access_key && replacement?.secret_key) {
        accessKeyId = replacement.access_key;
        secretAccessKey = replacement.secret_key;
        mintedCredentialUpdates = {
          spacesAccessKeyId: accessKeyId,
          spacesSecretAccessKey: secretAccessKey,
        };
        // Wait for the replacement key to propagate, same as the
        // first-time mint path.
        const regionalEndpoint = `https://${region}.digitaloceanspaces.com/`;
        for (let i = 0; i < 15; i++) {
          const probe = await signedS3Fetch({
            accessKey: accessKeyId,
            secretKey: secretAccessKey,
            region,
            method: "GET",
            url: regionalEndpoint,
          }).catch(() => null);
          if (probe && probe.ok) break;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        putResult = await tryPut(accessKeyId, secretAccessKey, 4);
      }
    }

    if (!putResult.ok) {
      throw new Error(
        `Spaces S3 API error ${putResult.status} creating bucket "${bucketName}": ${putResult.text}`,
      );
    }

    await assignToProjectIfNeeded(`do:space:${bucketName}`);
    const resource: ResourceInstance = {
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
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Forward the minted credentials to the wrapping `doCreateResource`
    // so the host can persist them on the account. Returning a bare
    // ResourceInstance from this branch alone loses them.
    if (mintedCredentialUpdates) {
      credentialUpdatesRef.value = mintedCredentialUpdates;
    }
    return resource;
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
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
      createdAt: String(db["created_at"] ?? new Date().toISOString()),
      updatedAt: String(db["created_at"] ?? new Date().toISOString()),
    };
  }

  if (typeId === "db-user") {
    // The parent cluster id arrives via the standard {accountId}:{typeId}:{externalId}
    // composite — for managed-database that's the cluster's UUID. The form
    // doesn't expose a cluster picker because db-user is always created from
    // a cluster's detail page.
    if (!parentResourceId) {
      throw new Error("db-user must be created from a managed-database's detail page");
    }
    const clusterId = parentExternalId;
    if (!clusterId) {
      throw new Error("Could not parse cluster id from parentResourceId");
    }
    const username = String(fields["name"] ?? "").trim();
    if (!username) throw new Error("Username is required");
    const resp = await ctx.fetch<{
      user?: { name?: string; role?: string; password?: string };
    }>(`/databases/${clusterId}/users`, {
      method: "POST",
      body: JSON.stringify({ name: username }),
    });
    const user = resp.user ?? {};
    const password = String(user.password ?? "");
    // The whole point of routing user creation through Infrawrench is to
    // capture the password DO surfaces exactly once. Refuse to persist the
    // resource if it didn't come back — better a clear error here than a
    // silently-useless user record.
    if (!password) {
      throw new Error(
        "DigitalOcean did not return a password for the new user. Confirm the API token has " +
          "`database:view_credentials` scope and try again.",
      );
    }
    const name = String(user.name ?? username);
    const now = new Date().toISOString();
    return {
      id: `${accountId}:db-user:${clusterId}:${name}`,
      pluginId: "digitalocean",
      resourceTypeId: "db-user",
      accountId,
      displayName: name,
      fields: {
        name,
        role: String(user.role ?? ""),
      },
      resolvedOutputs: {},
      secretStates: [{ fieldKey: "password", resolution: { kind: "plaintext", value: password } }],
      externalId: name,
      parentResourceId: `${accountId}:managed-database:${clusterId}`,
      createdAt: now,
      updatedAt: now,
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
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
      createdAt: String(v["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "nfs-share") {
    const region = fields["region"] ?? "";
    const body: Record<string, unknown> = {
      name: fields["name"],
      region,
      size_gib: Number(fields["sizeGib"] ?? 50),
      vpc_ids: fields["vpcId"] ? [fields["vpcId"]] : [],
      performance_tier: fields["performanceTier"] ?? "standard",
    };
    const data = await ctx.fetch<{ nfs: Record<string, unknown> }>("/nfs", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const s = data.nfs ?? {};
    const now = new Date().toISOString();
    const externalId = `${region}/${String(s["id"] ?? "")}`;
    return {
      id: `${accountId}:nfs-share:${externalId}`,
      pluginId: "digitalocean",
      resourceTypeId: "nfs-share",
      accountId,
      displayName: String(s["name"] ?? fields["name"]),
      fields: {
        name: String(s["name"] ?? fields["name"]),
        region,
        sizeGib: Number(s["size_gib"] ?? fields["sizeGib"] ?? 0),
        performanceTier: String(s["performance_tier"] ?? fields["performanceTier"] ?? "standard"),
        vpcIds: Array.isArray(s["vpc_ids"])
          ? (s["vpc_ids"] as string[]).join(",")
          : (fields["vpcId"] ?? ""),
        mountTarget: "",
        status: String(s["status"] ?? "creating"),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId,
      ...(effectiveParentId ? { parentResourceId: effectiveParentId } : {}),
      createdAt: String(s["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "gen-ai-agent") {
    // `model_uuid` and `model_router_uuid` are mutually exclusive in DO's
    // API — the form's `modelSource` toggle decides which one we send.
    const useRouter = fields["modelSource"] === "router";
    const modelSourceFields: Record<string, unknown> = useRouter
      ? fields["modelRouterUuid"]
        ? { model_router_uuid: fields["modelRouterUuid"] }
        : {}
      : fields["modelUuid"]
        ? { model_uuid: fields["modelUuid"] }
        : {};
    if (Object.keys(modelSourceFields).length === 0) {
      throw new Error(
        useRouter
          ? "Pick an Inference Router (or switch the Model Source back to a foundation model)."
          : "Pick a Foundation Model (or switch the Model Source to an Inference Router).",
      );
    }

    // DO's GenAI plane scopes agents to a workspace. New accounts have no
    // workspaces — the DO console auto-creates one transparently. Match
    // that UX: if the user didn't pick (or there are none), look one up,
    // and create a "default" workspace if there are still none. The
    // workspace picker's inline-create FieldAction covers the case where
    // the user wants to pick a name explicitly.
    let workspaceUuid = String(fields["workspaceUuid"] ?? "").trim();
    if (!workspaceUuid) {
      const list = await ctx
        .fetch<{ workspaces?: Array<{ uuid?: string }> }>("/gen-ai/workspaces")
        .catch(() => ({ workspaces: [] }));
      workspaceUuid = String(list.workspaces?.[0]?.uuid ?? "");
      if (!workspaceUuid) {
        const created = await ctx.fetch<{ workspace: { uuid?: string } }>("/gen-ai/workspaces", {
          method: "POST",
          body: JSON.stringify({
            name: "default",
            description: "Auto-created by Infrawrench for first agent",
          }),
        });
        workspaceUuid = String(created.workspace?.uuid ?? "");
        if (!workspaceUuid) {
          throw new Error(
            "DigitalOcean did not return a workspace UUID after auto-creating the default workspace. Create one manually in the DO console under Agent Platform → Workspaces and try again.",
          );
        }
      }
    }

    const body: Record<string, unknown> = {
      name: fields["name"],
      ...modelSourceFields,
      region: fields["region"],
      workspace_uuid: workspaceUuid,
      ...(fields["instruction"] ? { instruction: fields["instruction"] } : {}),
      ...(fields["description"] ? { description: fields["description"] } : {}),
      ...(parentExternalId ? { project_id: parentExternalId } : {}),
    };
    const data = await ctx.fetch<{ agent: Record<string, unknown> }>("/gen-ai/agents", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const a = data.agent ?? {};
    const uuid = String(a["uuid"] ?? "");
    const deployment = a["deployment"] as Record<string, unknown> | undefined;
    const deploymentUrl = String(deployment?.["url"] ?? "");
    const respRouter = a["model_router"] as Record<string, unknown> | undefined;
    const respModel = a["model"] as Record<string, unknown> | undefined;
    const now = new Date().toISOString();
    return {
      id: `${accountId}:gen-ai-agent:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-agent",
      accountId,
      displayName: String(a["name"] ?? fields["name"]),
      fields: {
        name: String(a["name"] ?? fields["name"]),
        region: String(a["region"] ?? fields["region"] ?? ""),
        description: String(a["description"] ?? fields["description"] ?? ""),
        instruction: String(a["instruction"] ?? fields["instruction"] ?? ""),
        modelUuid: String(respModel?.["uuid"] ?? (useRouter ? "" : (fields["modelUuid"] ?? ""))),
        modelName: String(respModel?.["name"] ?? ""),
        modelRouterUuid: String(
          respRouter?.["uuid"] ?? (useRouter ? (fields["modelRouterUuid"] ?? "") : ""),
        ),
        modelRouterName: String(respRouter?.["name"] ?? ""),
        projectId: parentExternalId,
        temperature: 0,
        maxTokens: 0,
        k: 0,
        status: String(deployment?.["status"] ?? "provisioning"),
        knowledgeBaseCount: 0,
        deploymentUrl,
      },
      resolvedOutputs: deploymentUrl ? { deploymentUrl, agentEndpoint: deploymentUrl } : {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(a["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "gen-ai-knowledge-base") {
    const body: Record<string, unknown> = {
      name: fields["name"],
      region: fields["region"],
      embedding_model_uuid: fields["embeddingModelUuid"],
      ...(parentExternalId ? { project_id: parentExternalId } : {}),
      ...(fields["tags"]
        ? {
            tags: fields["tags"]
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          }
        : {}),
    };
    const data = await ctx.fetch<{ knowledge_base: Record<string, unknown> }>(
      "/gen-ai/knowledge_bases",
      { method: "POST", body: JSON.stringify(body) },
    );
    const kb = data.knowledge_base ?? {};
    const uuid = String(kb["uuid"] ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:gen-ai-knowledge-base:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-knowledge-base",
      accountId,
      displayName: String(kb["name"] ?? fields["name"]),
      fields: {
        name: String(kb["name"] ?? fields["name"]),
        region: String(kb["region"] ?? fields["region"] ?? ""),
        embeddingModelUuid: String(kb["embedding_model_uuid"] ?? fields["embeddingModelUuid"]),
        databaseId: String(kb["database_id"] ?? ""),
        projectId: String(kb["project_id"] ?? parentExternalId),
        isPublic: "no",
        lastIndexingStatus: "",
        dataSourceCount: 0,
        tags: String(fields["tags"] ?? ""),
      },
      resolvedOutputs: uuid
        ? { retrievalEndpoint: `https://kbaas.do-ai.run/v1/${uuid}/retrieve` }
        : {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(kb["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "gen-ai-model-router") {
    const fallback = String(fields["fallbackModels"] ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const regions = fields["region"] ? [fields["region"]] : [];
    const body: Record<string, unknown> = {
      name: fields["name"],
      ...(fields["description"] ? { description: fields["description"] } : {}),
      ...(regions.length ? { regions } : {}),
      ...(fallback.length ? { fallback_models: fallback } : {}),
    };
    const data = await ctx.fetch<{ model_router: Record<string, unknown> }>(
      "/gen-ai/models/routers",
      { method: "POST", body: JSON.stringify(body) },
    );
    const r = data.model_router ?? {};
    const uuid = String(r["uuid"] ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:gen-ai-model-router:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "gen-ai-model-router",
      accountId,
      displayName: String(r["name"] ?? fields["name"]),
      fields: {
        name: String(r["name"] ?? fields["name"]),
        description: String(r["description"] ?? fields["description"] ?? ""),
        regions: regions.join(","),
        fallbackModels: fallback.join(","),
        policyCount: 0,
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: uuid,
      createdAt: String(r["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "dedicated-inference") {
    const body: Record<string, unknown> = {
      spec: {
        name: fields["name"],
        region: fields["region"],
        enable_public_endpoint: fields["enablePublicEndpoint"] === "true",
        ...(fields["vpcUuid"] ? { vpc: { uuid: fields["vpcUuid"] } } : {}),
        model_deployments: [
          {
            model_id: fields["modelId"],
            size: fields["size"],
          },
        ],
      },
      ...(fields["huggingFaceToken"]
        ? { access_tokens: { hugging_face_token: fields["huggingFaceToken"] } }
        : {}),
    };
    // POST returns 202 Accepted with the provisioning record — same shape
    // as GET /dedicated-inferences/{id} but with status `provisioning`.
    const data = await ctx.fetch<{ dedicated_inference: Record<string, unknown> }>(
      "/dedicated-inferences",
      { method: "POST", body: JSON.stringify(body) },
    );
    const d = data.dedicated_inference ?? {};
    const id = String(d["id"] ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:dedicated-inference:${id}`,
      pluginId: "digitalocean",
      resourceTypeId: "dedicated-inference",
      accountId,
      displayName: String(fields["name"]),
      fields: {
        name: String(fields["name"]),
        region: String(d["region"] ?? fields["region"] ?? ""),
        vpcUuid: String(d["vpc_uuid"] ?? fields["vpcUuid"] ?? ""),
        enablePublicEndpoint: fields["enablePublicEndpoint"] === "true" ? "yes" : "no",
        modelCount: 1,
        modelSummary: String(fields["modelId"] ?? ""),
        publicEndpoint: "",
        privateEndpoint: "",
        status: String(d["status"] ?? "provisioning"),
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: id,
      createdAt: String(d["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "model-api-key") {
    const data = await ctx.fetch<{
      api_key_info?: Record<string, unknown>;
      secret_key?: string;
    }>("/gen-ai/models/api_keys", {
      method: "POST",
      body: JSON.stringify({ name: fields["name"] }),
    });
    const info = data.api_key_info ?? {};
    const uuid = String(info["uuid"] ?? "");
    const now = new Date().toISOString();
    return {
      id: `${accountId}:model-api-key:${uuid}`,
      pluginId: "digitalocean",
      resourceTypeId: "model-api-key",
      accountId,
      displayName: String(info["name"] ?? fields["name"]),
      fields: {
        name: String(info["name"] ?? fields["name"]),
        createdBy: String(info["created_by"] ?? ""),
        lastUsedAt: "",
      },
      resolvedOutputs: data.secret_key ? { secretKey: data.secret_key } : {},
      secretStates: data.secret_key
        ? [
            {
              fieldKey: "secretKey",
              resolution: { kind: "plaintext", value: data.secret_key },
            },
          ]
        : [],
      externalId: uuid,
      createdAt: String(info["created_at"] ?? now),
      updatedAt: now,
    };
  }

  if (typeId === "agent-api-key") {
    // Resolve the parent agent uuid: from parentResourceId when opened
    // from the agent detail page, otherwise from the form field.
    const agentUuid = parentResourceId
      ? parentResourceId.split(":").slice(2).join(":")
      : String(fields["agentUuid"] ?? "");
    if (!agentUuid) throw new Error("Agent UUID is required.");
    // The agent-API-key create response nests everything (including the
    // one-shot secret) inside `api_key_info`. Older/model-key endpoints
    // return a top-level `secret_key`, so read both for resilience.
    const data = await ctx.fetch<{
      api_key_info?: Record<string, unknown>;
      secret_key?: string;
    }>(`/gen-ai/agents/${agentUuid}/api_keys`, {
      method: "POST",
      body: JSON.stringify({ name: fields["name"] }),
    });
    const info = data.api_key_info ?? {};
    const secret = String(info["secret_key"] ?? data.secret_key ?? "");
    const keyUuid = String(info["uuid"] ?? "");
    const externalId = `${agentUuid}/${keyUuid}`;
    const now = new Date().toISOString();
    return {
      id: `${accountId}:agent-api-key:${externalId}`,
      pluginId: "digitalocean",
      resourceTypeId: "agent-api-key",
      accountId,
      displayName: String(info["name"] ?? fields["name"]),
      fields: {
        name: String(info["name"] ?? fields["name"]),
        createdBy: String(info["created_by"] ?? ""),
      },
      resolvedOutputs: secret ? { secretKey: secret } : {},
      secretStates: secret
        ? [
            {
              fieldKey: "secretKey",
              resolution: { kind: "plaintext", value: secret },
            },
          ]
        : [],
      externalId,
      parentResourceId: `${accountId}:gen-ai-agent:${agentUuid}`,
      createdAt: String(info["created_at"] ?? now),
      updatedAt: now,
    };
  }

  throw new Error(`DigitalOcean plugin: createResource not supported for type "${typeId}"`);
}
