import type { OciApi } from "./api.js";

/**
 * Tenancy discovery: which regions and compartments to list, and which
 * (region, compartment) pairs actually hold a given resource type.
 *
 * OCI list operations are per compartment and never recurse, so a naive
 * lister makes regions × compartments calls per type. Resource Search
 * (`query.{region}.oci.oraclecloud.com/20180409/resources`) indexes every
 * resource the caller can see across all compartments, so one structured
 * query per region says where each type lives, and the listers only visit
 * those pairs. The root compartment is always visited as well, because
 * Search is eventually consistent and a resource created seconds ago may not
 * be indexed yet. If Search is refused, listers fall back to visiting every
 * compartment.
 */

export interface OciCompartment {
  id: string;
  name: string;
  parentId: string;
  path: string;
  description: string;
  lifecycleState: string;
  timeCreated?: string;
}

export interface Scope {
  region: string;
  compartmentId: string;
}

/** Resource Search type names (verified against Oracle's supported-resources list). */
export const SEARCH_TYPES = [
  "instance",
  "volume",
  "bootvolume",
  "vcn",
  "subnet",
  "securitylist",
  "publicip",
  "loadbalancer",
  "bucket",
  "autonomousdatabase",
  "clusterscluster",
] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

const CACHE_MS = 60_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export class OciInventory {
  private regionsCache: Cached<string[]> | null = null;
  private compartmentsCache: Cached<OciCompartment[]> | null = null;
  private regionKeysCache: Cached<Map<string, string>> | null = null;
  private searchCache = new Map<string, Cached<Map<string, Set<string>> | null>>();

  constructor(
    private readonly api: OciApi,
    readonly homeRegion: string,
  ) {}

  /**
   * Serve `slot` while fresh, otherwise start `load`. A rejected load clears
   * itself through `clear` so a transient failure is not served for a minute.
   */
  private cached<T>(
    slot: Cached<T> | null,
    load: () => Promise<T>,
    clear: (failed: Promise<T>) => void,
  ): Cached<T> {
    if (slot && Date.now() - slot.at < CACHE_MS) return slot;
    const value = load();
    value.catch(() => clear(value));
    return { at: Date.now(), value };
  }

  /** Subscribed, ready regions; the home region first. */
  regions(): Promise<string[]> {
    this.regionsCache = this.cached(
      this.regionsCache,
      async () => {
        const subs = await this.api.get<
          Array<{ regionName: string; status: string; isHomeRegion?: boolean }>
        >(
          "identity",
          this.homeRegion,
          `/20160918/tenancies/${this.api.tenancyOcid}/regionSubscriptions`,
        );
        const ready = subs.filter((s) => s.status === "READY");
        ready.sort((a, b) => Number(b.isHomeRegion === true) - Number(a.isHomeRegion === true));
        const names = ready.map((s) => s.regionName);
        return names.length > 0 ? names : [this.homeRegion];
      },
      (failed) => {
        if (this.regionsCache?.value === failed) this.regionsCache = null;
      },
    );
    return this.regionsCache.value;
  }

  /** The tenancy's actual home region, from its subscriptions. */
  async actualHomeRegion(): Promise<string> {
    const subs = await this.api.get<Array<{ regionName: string; isHomeRegion?: boolean }>>(
      "identity",
      this.homeRegion,
      `/20160918/tenancies/${this.api.tenancyOcid}/regionSubscriptions`,
    );
    return subs.find((s) => s.isHomeRegion)?.regionName ?? this.homeRegion;
  }

  /**
   * Every active compartment the credential can see, root (the tenancy)
   * first, each with its full path ("root/prod/web").
   */
  compartments(): Promise<OciCompartment[]> {
    this.compartmentsCache = this.cached(
      this.compartmentsCache,
      async () => {
        const tenancy = this.api.tenancyOcid;
        const [tenancyInfo, children] = await Promise.all([
          this.api
            .get<{ name?: string; description?: string }>(
              "identity",
              this.homeRegion,
              `/20160918/tenancies/${tenancy}`,
            )
            .catch(() => ({ name: "root", description: "" })),
          this.api.listAll<{
            id: string;
            compartmentId: string;
            name: string;
            description?: string;
            lifecycleState: string;
            timeCreated?: string;
          }>({
            service: "identity",
            region: this.homeRegion,
            path: "/20160918/compartments",
            query: {
              compartmentId: tenancy,
              compartmentIdInSubtree: true,
              accessLevel: "ACCESSIBLE",
              lifecycleState: "ACTIVE",
              limit: 1000,
            },
          }),
        ]);
        const rootName = tenancyInfo.name ?? "root";
        const byId = new Map(children.map((c) => [c.id, c]));
        const pathOf = (id: string, depth = 0): string => {
          if (id === tenancy || depth > 8) return rootName;
          const c = byId.get(id);
          if (!c) return rootName;
          return `${pathOf(c.compartmentId, depth + 1)}/${c.name}`;
        };
        const root: OciCompartment = {
          id: tenancy,
          name: rootName,
          parentId: "",
          path: rootName,
          description: tenancyInfo.description ?? "",
          lifecycleState: "ACTIVE",
        };
        return [
          root,
          ...children.map((c) => ({
            id: c.id,
            name: c.name,
            parentId: c.compartmentId,
            path: pathOf(c.id),
            description: c.description ?? "",
            lifecycleState: c.lifecycleState,
            ...(c.timeCreated ? { timeCreated: c.timeCreated } : {}),
          })),
        ];
      },
      (failed) => {
        if (this.compartmentsCache?.value === failed) this.compartmentsCache = null;
      },
    );
    return this.compartmentsCache.value;
  }

  private adCache = new Map<string, Cached<string[]>>();

  /** Availability domain names in a region ("Uocm:PHX-AD-1"), sorted. */
  availabilityDomains(region: string): Promise<string[]> {
    const slot = this.cached(
      this.adCache.get(region) ?? null,
      async () => {
        const ads = await this.api.get<Array<{ name: string }>>(
          "identity",
          region,
          "/20160918/availabilityDomains",
          { compartmentId: this.api.tenancyOcid },
        );
        return ads.map((a) => a.name).sort();
      },
      (failed) => {
        if (this.adCache.get(region)?.value === failed) this.adCache.delete(region);
      },
    );
    this.adCache.set(region, slot);
    return slot.value;
  }

  async compartmentName(id: string): Promise<string> {
    const all = await this.compartments().catch(() => []);
    return all.find((c) => c.id === id)?.name ?? "";
  }

  /** Region key ("IAD") → region name ("us-ashburn-1"), from `GET /regions`. */
  private regionKeys(): Promise<Map<string, string>> {
    this.regionKeysCache = this.cached(
      this.regionKeysCache,
      async () => {
        const regions = await this.api.get<Array<{ key: string; name: string }>>(
          "identity",
          this.homeRegion,
          "/20160918/regions",
        );
        return new Map(regions.map((r) => [r.key.toLowerCase(), r.name]));
      },
      (failed) => {
        if (this.regionKeysCache?.value === failed) this.regionKeysCache = null;
      },
    );
    return this.regionKeysCache.value;
  }

  /**
   * The region an OCID lives in. Its fourth segment is either the region's
   * three-letter key (`iad`) or, for newer regions, the region name; it is
   * empty for global resources (compartments, the tenancy), which resolve to
   * the home region.
   */
  async regionOfOcid(ocid: string): Promise<string> {
    const segment = ocid.split(".")[3] ?? "";
    if (!segment) return this.homeRegion;
    if (/^[a-z]{2}-[a-z]+-\d+$/.test(segment)) return segment;
    const keys = await this.regionKeys().catch(() => new Map<string, string>());
    return keys.get(segment.toLowerCase()) ?? this.homeRegion;
  }

  /**
   * (region, compartment) pairs to list `type` in. `regionHint` narrows the
   * fan-out to one region (the create form's resource pickers pass it).
   */
  async scopes(type: SearchType, regionHint?: string): Promise<Scope[]> {
    const allRegions = await this.regions();
    const regions = regionHint && allRegions.includes(regionHint) ? [regionHint] : allRegions;
    const tenancy = this.api.tenancyOcid;
    const out: Scope[] = [];
    let compartmentIds: string[] | null = null;
    for (const region of regions) {
      const index = await this.searchIndex(region);
      if (index) {
        const found = index.get(type) ?? new Set<string>();
        found.add(tenancy);
        for (const compartmentId of found) out.push({ region, compartmentId });
      } else {
        compartmentIds ??= (await this.compartments()).map((c) => c.id);
        for (const compartmentId of compartmentIds) out.push({ region, compartmentId });
      }
    }
    return out;
  }

  /** type → compartment ids holding it, for one region; null when Search is unavailable. */
  private searchIndex(region: string): Promise<Map<string, Set<string>> | null> {
    const slot = this.searchCache.get(region);
    if (slot && Date.now() - slot.at < CACHE_MS) return slot.value;
    const value = (async () => {
      try {
        const items = await this.api.listAll<{ resourceType?: string; compartmentId?: string }>(
          {
            service: "query",
            region,
            method: "POST",
            path: "/20180409/resources",
            query: { limit: 1000 },
            body: {
              type: "Structured",
              query: `query ${SEARCH_TYPES.join(", ")} resources`,
            },
          },
          100,
        );
        const index = new Map<string, Set<string>>();
        for (const item of items) {
          if (!item.resourceType || !item.compartmentId) continue;
          const key = item.resourceType.toLowerCase();
          if (!index.has(key)) index.set(key, new Set());
          index.get(key)!.add(item.compartmentId);
        }
        return index;
      } catch {
        // A refused or failing Search should not take listing down: fall
        // back to the full fan-out for this pass.
        return null;
      }
    })();
    this.searchCache.set(region, { at: Date.now(), value });
    return value;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}
