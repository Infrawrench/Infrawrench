import type { HttpHostServices } from "@infrawrench/plugin-base";
import { ListTruncatedError, jsonRestFetch, requireListPage } from "@infrawrench/plugin-base";

/**
 * Wasabi's two JSON APIs (docs.wasabi.com/apidocs, verified 2026-10):
 *
 * - **Stats API**, `https://stats.wasabisys.com/v1/standalone/...`: daily
 *   account and per-bucket utilization. Authorization is the literal
 *   `AccessKey:SecretKey` of a root key or one with billing permissions (not
 *   a signature).
 * - **Wasabi Account Control (WAC) API**, `https://partner.wasabisys.com/v1`:
 *   sub-accounts of a control account. Authorization is the separate WAC API
 *   key Wasabi issues to control accounts, sent bare.
 *
 * Everything else (buckets, objects, IAM) is the S3 and IAM APIs, signed with
 * SigV4 in `s3.ts`.
 */

export const STATS_BASE = "https://stats.wasabisys.com";
export const WAC_BASE = "https://partner.wasabisys.com";

export interface WasabiContext {
  accessKey: string;
  secretKey: string;
  wacKey?: string;
  caCert?: string;
  http?: HttpHostServices;
}

export class WasabiApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "WasabiApiError";
    this.status = status;
  }
}

export function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    return typeof s === "number" ? s : 0;
  }
  return 0;
}

type Query = Record<string, string | number | boolean | undefined>;

function withQuery(url: string, query?: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {}))
    if (v !== undefined && v !== "") p.set(k, String(v));
  const qs = p.toString();
  return qs ? `${url}?${qs}` : url;
}

async function call<T>(
  ctx: WasabiContext,
  vendor: string,
  url: string,
  auth: string,
  init?: { method?: string; body?: unknown; query?: Query },
): Promise<T> {
  try {
    return await jsonRestFetch<T>({
      vendor,
      url: withQuery(url, init?.query),
      errorPath: new URL(url).pathname,
      headers: { Accept: "application/json", Authorization: auth },
      init: {
        method: init?.method ?? "GET",
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      ...(ctx.caCert ? { caCert: ctx.caCert } : {}),
      ...(ctx.http ? { http: ctx.http } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = Number(/API error (\d{3})/.exec(message)?.[1] ?? 0);
    if (status) throw new WasabiApiError(status, message);
    throw err;
  }
}

export function statsFetch<T>(ctx: WasabiContext, path: string, query?: Query): Promise<T> {
  return call<T>(ctx, "Wasabi Stats", `${STATS_BASE}${path}`, `${ctx.accessKey}:${ctx.secretKey}`, {
    ...(query ? { query } : {}),
  });
}

export function wacFetch<T>(
  ctx: WasabiContext,
  path: string,
  init?: { method?: string; body?: unknown; query?: Query },
): Promise<T> {
  if (!ctx.wacKey) {
    return Promise.reject(
      new WasabiApiError(
        403,
        "Sub-accounts need a Wasabi Account Control API key on this account.",
      ),
    );
  }
  return call<T>(ctx, "Wasabi Account Control", `${WAC_BASE}${path}`, ctx.wacKey, init);
}

/** One daily utilization record (account- or bucket-level). */
export interface Utilization {
  AcctNum?: number;
  BucketNum?: number;
  StartTime: string;
  EndTime?: string;
  NumBillableObjects?: number;
  NumBillableDeletedObjects?: number;
  RawStorageSizeBytes?: number;
  PaddedStorageSizeBytes?: number;
  MetadataStorageSizeBytes?: number;
  DeletedStorageSizeBytes?: number;
  OrphanedStorageSizeBytes?: number;
  MinStorageChargeBytes?: number;
  NumAPICalls?: number;
  UploadBytes?: number;
  DownloadBytes?: number;
  NumGETCalls?: number;
  NumPUTCalls?: number;
  NumDELETECalls?: number;
  NumLISTCalls?: number;
  NumHEADCalls?: number;
  Bucket?: string;
  Region?: string;
}

/** The Stats API's largest page. */
const STATS_PAGE_SIZE = 100;

/**
 * Page through a Stats API listing. The documented responses come both as
 * `{PageInfo, Records}` and as a bare array, so both are accepted; `PageCount`
 * is only returned on page 0, and a page without it reads on while pages are
 * full. Past `maxPages` with more to read this throws, unless `partial`.
 */
export async function statsPaged(
  ctx: WasabiContext,
  path: string,
  query: Query,
  opts: { maxPages?: number; partial?: boolean } = {},
): Promise<Utilization[]> {
  const maxPages = opts.maxPages ?? 1000;
  const place = { vendor: "Wasabi Stats", path };
  const out: Utilization[] = [];
  let pageCount: number | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await statsFetch<
      Utilization[] | { PageInfo?: { PageCount?: number }; Records?: Utilization[] } | null
    >(ctx, path, { ...query, pageNum: page, pageSize: STATS_PAGE_SIZE });
    const records = Array.isArray(res)
      ? res
      : requireListPage(res?.Records, { ...place, key: "Records", page: res });
    out.push(...records);
    if (page === 0 && !Array.isArray(res)) pageCount = res?.PageInfo?.PageCount;
    const more = pageCount === undefined ? records.length >= STATS_PAGE_SIZE : page + 1 < pageCount;
    // An empty page ends the list, as it always has here: a PageCount one too high
    // must not fail a read that works.
    if (!more || records.length === 0) return out;
  }
  if (opts.partial) return out;
  throw new ListTruncatedError({ ...place, items: out.length, maxPages });
}

export interface SubAccount {
  AcctNum: number;
  AcctName: string;
  CreateTime?: string;
  IsTrial?: boolean;
  Inactive?: boolean;
  TrialExpiry?: string;
  QuotaGB?: number;
  StatusMFA?: boolean;
  AllowAccountDelete?: boolean;
  SendPasswordResetToSubAccountEmail?: boolean;
  FTPEnabled?: boolean;
  AccessKey?: string;
  SecretKey?: string;
}
