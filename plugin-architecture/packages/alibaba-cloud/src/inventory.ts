import {
  AliApiError,
  isPermissionGap,
  isServiceUnavailable,
  mapLimit,
  type AliApi,
} from "./api.js";
import { ALI_REGIONS, DEFAULT_REGION, productInRegion, type AliProduct } from "./regions.js";

/**
 * Which regions to scan. An explicit `regions` credential wins; otherwise
 * the account's own ECS `DescribeRegions` answer (the regions open to it),
 * falling back to the static public list when that call is refused.
 */
export class Inventory {
  private regionsPromise: Promise<string[]> | null = null;
  private callerPromise: Promise<CallerIdentity> | null = null;

  constructor(
    readonly api: AliApi,
    readonly homeRegion: string,
    private readonly configuredRegions: string[],
  ) {}

  regions(): Promise<string[]> {
    if (this.configuredRegions.length) return Promise.resolve(this.configuredRegions);
    if (!this.regionsPromise) {
      this.regionsPromise = this.api
        .rpc<{ Regions?: { Region?: Array<{ RegionId: string; Status?: string }> } }>(
          "ecs",
          this.homeRegion,
          "DescribeRegions",
          { AcceptLanguage: "en-US" },
        )
        .then((res) => {
          const ids = (res.Regions?.Region ?? [])
            .filter((r) => !r.Status || r.Status === "available")
            .map((r) => r.RegionId);
          const known = new Set(ALI_REGIONS.map((r) => r.id));
          // Finance and government clouds answer DescribeRegions too but
          // need a separate contract; only scan the public regions.
          const usable = ids.filter((id) => known.has(id));
          return usable.length ? usable : [this.homeRegion];
        })
        .catch((err: unknown) => {
          this.regionsPromise = null;
          throw err;
        });
    }
    return this.regionsPromise;
  }

  /** Regions to list `product` in, narrowed by a region hint when one is given. */
  async regionsFor(product: AliProduct, regionHint?: string): Promise<string[]> {
    const all = regionHint ? [regionHint] : await this.regions();
    return all.filter((r) => productInRegion(product, r));
  }

  caller(): Promise<CallerIdentity> {
    if (!this.callerPromise) {
      const region = productInRegion("sts", this.homeRegion) ? this.homeRegion : DEFAULT_REGION;
      this.callerPromise = this.api
        .rpc<CallerIdentity>("sts", region, "GetCallerIdentity")
        .catch((err: unknown) => {
          this.callerPromise = null;
          throw err;
        });
    }
    return this.callerPromise;
  }
}

export interface CallerIdentity {
  AccountId: string;
  UserId?: string;
  Arn?: string;
  IdentityType?: string;
  PrincipalId?: string;
}

/**
 * Run `fn` in every region the product is served in. A region where the
 * credential lacks permission or the service is not activated lists empty;
 * any other failure fails the listing (a silently missing region would read
 * as resources having been deleted). When every region is refused, the
 * refusal is thrown so the account shows why it lists nothing.
 */
export async function perRegion<T>(
  inventory: Inventory,
  product: AliProduct,
  regionHint: string | undefined,
  fn: (region: string) => Promise<T[]>,
): Promise<T[]> {
  const regions = await inventory.regionsFor(product, regionHint);
  let refused: unknown = null;
  let refusedCount = 0;
  const results = await mapLimit(regions, 6, async (region) => {
    try {
      return await fn(region);
    } catch (err) {
      if (isServiceUnavailable(err)) return [];
      if (isPermissionGap(err)) {
        refused = err;
        refusedCount++;
        return [];
      }
      throw err;
    }
  });
  if (regions.length > 0 && refusedCount === regions.length && refused instanceof AliApiError) {
    throw refused;
  }
  return results.flat();
}

/** Page through a PageNumber/PageSize listing until TotalCount is reached. */
export async function pageNumbers<T>(
  pageSize: number,
  fetchPage: (page: number) => Promise<{ items: T[]; total?: number | undefined }>,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, total } = await fetchPage(page);
    out.push(...items);
    if (items.length < pageSize) break;
    if (total !== undefined && out.length >= total) break;
  }
  return out;
}

/** Page through a NextToken listing. */
export async function nextTokens<T>(
  fetchPage: (token: string | undefined) => Promise<{ items: T[]; next?: string | undefined }>,
  maxPages = 100,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const { items, next } = await fetchPage(token);
    out.push(...items);
    if (!next) break;
    token = next;
  }
  return out;
}
