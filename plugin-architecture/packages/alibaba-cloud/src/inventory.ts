import { ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";
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

export const VENDOR = "Alibaba Cloud";

/**
 * A resource sync reads every type inside one poll, so a list stops at whichever comes
 * first. Past either it throws: part of a list reads as the rest having been deleted.
 */
const MAX_LIST_ROWS = 100_000;
const MAX_LIST_REQUESTS = 1000;

function maxPagesFor(pageSize: number): number {
  return Math.min(MAX_LIST_REQUESTS, Math.ceil(MAX_LIST_ROWS / pageSize));
}

/** One paged list: the action that reads it, where its rows are, and the page size it asks for. */
export interface PagedList {
  path: string;
  key: string;
  pageSize: number;
}

/**
 * Page through a PageNumber/PageSize listing until TotalCount is reached. A short page
 * does not end it while TotalCount says there is more, since a product may send fewer
 * than it was asked for. An empty page does, as it does on every other dialect.
 */
export async function pageNumbers<T>(
  list: PagedList,
  fetchPage: (
    page: number,
  ) => Promise<{ items: readonly T[] | null | undefined; total?: number | undefined }>,
): Promise<T[]> {
  const { path, key, pageSize } = list;
  const maxPages = maxPagesFor(pageSize);
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const { items, total } = await fetchPage(page);
    // A count of zero says it is empty on its own. Anything else needs its rows.
    const rows =
      items === undefined && total === 0
        ? []
        : requireListPage(items, { vendor: VENDOR, path, key });
    out.push(...rows);
    if (rows.length === 0) return out;
    if (total === undefined ? rows.length < pageSize : out.length >= total) return out;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
}

/**
 * Page through a NextToken listing. These answers carry no count to check an empty page
 * against (ECS documents its TotalCount as invalid when paging by token), so a list key
 * has to be there. `missingListIsEmpty` is for a product whose document does not show
 * what an empty answer holds.
 */
export async function nextTokens<T>(
  list: PagedList & { missingListIsEmpty?: boolean },
  fetchPage: (
    token: string | undefined,
  ) => Promise<{ items: readonly T[] | null | undefined; next?: string | undefined }>,
): Promise<T[]> {
  const { path, key, pageSize, missingListIsEmpty } = list;
  const maxPages = maxPagesFor(pageSize);
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const { items, next } = await fetchPage(token);
    const rows =
      items === undefined && missingListIsEmpty
        ? []
        : requireListPage(items, { vendor: VENDOR, path, key });
    out.push(...rows);
    if (!next) return out;
    token = next;
  }
  throw new ListTruncatedError({ vendor: VENDOR, path, items: out.length, maxPages });
}
