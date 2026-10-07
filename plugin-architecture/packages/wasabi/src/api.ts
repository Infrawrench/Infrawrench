import type { HttpHostServices } from "@infrawrench/plugin-base";
import { jsonRestFetch } from "@infrawrench/plugin-base";

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

/**
 * Page through a Stats API listing. The documented responses come both as
 * `{PageInfo, Records}` and as a bare array, so both are accepted; `PageCount`
 * is only returned on page 0.
 */
export async function statsPaged(
  ctx: WasabiContext,
  path: string,
  query: Query,
  maxPages = 200,
): Promise<Utilization[]> {
  const out: Utilization[] = [];
  let pageCount = 1;
  for (let page = 0; page < Math.min(pageCount, maxPages); page++) {
    const res = await statsFetch<
      Utilization[] | { PageInfo?: { PageCount?: number }; Records?: Utilization[] }
    >(ctx, path, { ...query, pageNum: page, pageSize: 100 });
    if (Array.isArray(res)) {
      out.push(...res);
      if (res.length < 100) break;
      pageCount = page + 2;
      continue;
    }
    const records = res?.Records ?? [];
    out.push(...records);
    if (page === 0) pageCount = res?.PageInfo?.PageCount ?? 1;
    if (records.length === 0) break;
  }
  return out;
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
