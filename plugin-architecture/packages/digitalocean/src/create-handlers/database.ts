/** Create handlers for DigitalOcean managed database clusters and their users. */
import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import { regionDisplay } from "../constants.js";
import { kafkaAclFields } from "../resources/managed-database.js";
import { buildProjectField, type DoCreateArgs, type DoCreateContext } from "./shared.js";

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
 * Build the create form for the types this module owns. Returns `null` when
 * `typeId` belongs to another module so the dispatcher can try the next one.
 */
export async function databaseGetCreateConfig(
  ctx: DoCreateContext,
  typeId: string,
  parentResourceId?: string,
): Promise<CreateResourceConfig | null> {
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
    // DO discontinued Managed Redis on 2025-06-30 and fully replaced it with
    // Valkey (a drop-in Redis-compatible engine). The legacy `redis` engine
    // can no longer be provisioned — POST /databases with engine=redis rejects
    // every region with `region '<slug>' is not valid` because the retired
    // engine has no valid region set. So the picker creates `valkey` clusters
    // (the engine value DO now accepts). The options endpoint surfaces the
    // live region/size list under a `valkey` key; we mirror slugs under both
    // names so the filter still matches any legacy `redis` clusters DO reports.
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
            { id: "valkey", label: "Valkey (Redis-compatible caching)" },
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
    // Kafka users carry an ACL; surface the topic/permission fields so the
    // child-section create form matches the make-connection-user flow.
    let kafkaFields: CreateResourceConfig["fields"] = [];
    if (parentResourceId) {
      const clusterId = parentResourceId.split(":").slice(2).join(":");
      try {
        const cluster = await ctx.fetch<{ database?: { engine?: string } }>(
          `/databases/${clusterId}`,
        );
        if (String(cluster.database?.engine ?? "") === "kafka") {
          kafkaFields = kafkaAclFields();
        }
      } catch {
        /* fall back to the bare username form */
      }
    }
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
        ...kafkaFields,
      ],
    };
  }

  return null;
}

/**
 * Create one of the types this module owns. Returns `null` when `typeId`
 * belongs to another module.
 */
export async function databaseCreateResource(args: DoCreateArgs): Promise<ResourceInstance | null> {
  const {
    ctx,
    typeId,
    accountId,
    fields,
    parentResourceId,
    parentExternalId,
    effectiveParentId,
    assignToProjectIfNeeded,
  } = args;
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
    // Kafka users require a `settings.acl` block or DO rejects with 422
    // "settings is required". Default to full access on every topic; the
    // engine is read off the cluster so other engines stay on the bare
    // `{ name }` body they expect.
    const userBody: Record<string, unknown> = { name: username };
    try {
      const cluster = await ctx.fetch<{ database?: { engine?: string } }>(
        `/databases/${clusterId}`,
      );
      if (String(cluster.database?.engine ?? "") === "kafka") {
        const topic = String(fields["topic"] ?? "").trim() || "*";
        const permission = String(fields["permission"] ?? "").trim() || "admin";
        userBody["settings"] = { acl: [{ topic, permission }] };
      }
    } catch {
      /* non-Kafka engines don't need settings; ignore lookup failures */
    }
    const resp = await ctx.fetch<{
      user?: { name?: string; role?: string; password?: string };
    }>(`/databases/${clusterId}/users`, {
      method: "POST",
      body: JSON.stringify(userBody),
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

  return null;
}
