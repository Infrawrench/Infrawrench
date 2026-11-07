import {
  ListTruncatedError,
  rethrowIncompleteList,
  requireListPage,
} from "@infrawrench/plugin-base";
import { cfFetch, refusedBesideAnswer } from "./shared.js";
import type { ResourceInstance, StorageObject } from "@infrawrench/plugin-base";
import type { CloudflareApi } from "./shared.js";
import { asRecord } from "./shared.js";
import type {
  Bucket,
  BucketCreateParams,
  BucketListResponse,
} from "cloudflare/resources/r2/buckets/buckets";

/**
 * R2 bucket CRUD uses the official SDK (`cf.r2.buckets.*`). The R2 *object*
 * plane (list/upload/delete per-object) is not exposed by the SDK so those
 * operations remain on `api.fetch`. See task spec for details.
 */

/**
 * The complete set of location hints the R2 API accepts
 * (`BucketCreateParams.locationHint`). Anything else is rejected by Cloudflare,
 * so an unrecognised hint is dropped rather than forwarded: omitting the hint
 * means "let R2 choose", which is the create form's "Automatic" option.
 */
const R2_LOCATION_HINTS = [
  "apac",
  "eeur",
  "enam",
  "weur",
  "wnam",
  "oc",
] as const satisfies readonly NonNullable<BucketCreateParams["locationHint"]>[];
type R2LocationHint = (typeof R2_LOCATION_HINTS)[number];

/**
 * Default storage classes for new objects (`BucketCreateParams.storageClass`,
 * and the `cf-r2-storage-class` header the PATCH endpoint reads). Infrequent
 * Access trades a lower storage price for per-GB retrieval fees and a 30-day
 * minimum storage duration.
 */
const R2_STORAGE_CLASSES = ["Standard", "InfrequentAccess"] as const satisfies readonly NonNullable<
  BucketCreateParams["storageClass"]
>[];
type R2StorageClass = (typeof R2_STORAGE_CLASSES)[number];

function isR2StorageClass(value: string): value is R2StorageClass {
  return (R2_STORAGE_CLASSES as readonly string[]).includes(value);
}

function isR2LocationHint(value: string): value is R2LocationHint {
  return (R2_LOCATION_HINTS as readonly string[]).includes(value);
}

/** The data-location jurisdictions a bucket can live in besides the default. */
const OTHER_JURISDICTIONS = ["eu", "fedramp"] as const;
type R2Jurisdiction = (typeof OTHER_JURISDICTIONS)[number];

function isOtherJurisdiction(value: unknown): value is R2Jurisdiction {
  return OTHER_JURISDICTIONS.some((j) => j === value);
}

/**
 * How a bucket is named to the rest of the plugin: its name in the default jurisdiction, and
 * `<jurisdiction>/<name>` in another. Bucket names cannot hold a `/`, and a name is only unique
 * within its jurisdiction, so the default buckets keep the ids they always had.
 */
export function r2BucketRef(name: string, jurisdiction?: string): string {
  return isOtherJurisdiction(jurisdiction) ? `${jurisdiction}/${name}` : name;
}

/** The bucket name and jurisdiction a {@link r2BucketRef} names. */
export function parseR2BucketRef(ref: string): { name: string; jurisdiction?: R2Jurisdiction } {
  const slash = ref.indexOf("/");
  const prefix = slash < 0 ? "" : ref.slice(0, slash);
  return isOtherJurisdiction(prefix)
    ? { name: ref.slice(slash + 1), jurisdiction: prefix }
    : { name: ref };
}

/** A bucket ref to act on, refusing a blank name rather than sending a request without one. */
function requireBucket(ref: string): { name: string; jurisdiction?: R2Jurisdiction } {
  const parsed = parseR2BucketRef(ref);
  if (!parsed.name) throw new Error("Cloudflare plugin: no R2 bucket named.");
  return parsed;
}

/** The SDK's `jurisdiction` param (it sets `cf-r2-jurisdiction`), only outside the default. */
function sdkJurisdiction(jurisdiction?: R2Jurisdiction): { jurisdiction?: R2Jurisdiction } {
  return jurisdiction ? { jurisdiction } : {};
}

function jurisdictionHeader(jurisdiction?: R2Jurisdiction): Record<string, string> {
  return jurisdiction ? { "cf-r2-jurisdiction": jurisdiction } : {};
}

/** The S3 endpoint, which names a jurisdiction outside the default (`<account>.eu.r2...`). */
export function r2S3Endpoint(cfAccountId: string, jurisdiction?: string): string {
  return isOtherJurisdiction(jurisdiction)
    ? `https://${cfAccountId}.${jurisdiction}.r2.cloudflarestorage.com`
    : `https://${cfAccountId}.r2.cloudflarestorage.com`;
}

function mapR2Bucket(
  b: Record<string, unknown>,
  accountId: string,
  cfAccountId: string,
  requested?: R2Jurisdiction,
): ResourceInstance {
  const name = String(b["name"] ?? "");
  const own = b["jurisdiction"];
  const jurisdiction = isOtherJurisdiction(own) ? own : own === "default" ? undefined : requested;
  const ref = r2BucketRef(name, jurisdiction);
  return {
    id: `${accountId}:r2-bucket:${ref}`,
    pluginId: "cloudflare",
    resourceTypeId: "r2-bucket",
    accountId,
    displayName: name,
    fields: {
      name,
      location: String(b["location"] ?? ""),
      storageClass: String(b["storage_class"] ?? "Standard"),
      jurisdiction: jurisdiction ?? "default",
      createdOn: String(b["creation_date"] ?? b["created"] ?? ""),
    },
    resolvedOutputs: {
      bucketName: name,
      s3Endpoint: r2S3Endpoint(cfAccountId, jurisdiction),
    },
    secretStates: [],
    externalId: ref,
    createdAt: String(b["creation_date"] ?? b["created"] ?? new Date().toISOString()),
    updatedAt: new Date().toISOString(),
  };
}

/** The largest page Cloudflare documents for listing buckets. */
const BUCKETS_PER_PAGE = 1000;
/** 100,000 buckets, the most one sync reads. */
const BUCKETS_MAX_PAGES = 100;

interface BucketPage {
  result?: BucketListResponse | null;
  result_info?: { cursor?: string };
}

/**
 * Every R2 bucket in one jurisdiction, the default unless named. `cf.r2.buckets.list` unwraps
 * `result`, which drops the `result_info.cursor` that names the next page, so this reads the
 * envelope itself.
 */
export async function listAllR2Buckets(
  api: CloudflareApi,
  jurisdiction?: R2Jurisdiction,
): Promise<Bucket[]> {
  const account_id = await api.getAccountId();
  const path = `/accounts/${account_id}/r2/buckets`;
  const out: Bucket[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < BUCKETS_MAX_PAGES; page++) {
    const query = { per_page: BUCKETS_PER_PAGE, ...(cursor ? { cursor } : {}) };
    const body = await api.cf.get<typeof query, BucketPage>(path, {
      query,
      ...(jurisdiction ? { headers: jurisdictionHeader(jurisdiction) } : {}),
    });
    // The document marks `buckets` optional within `result`, so only a missing `result` is wrong.
    const list = body.result ? (body.result.buckets ?? []) : undefined;
    const buckets = requireListPage(list, { vendor: "Cloudflare", path, key: "buckets" });
    out.push(...buckets);
    cursor = body.result_info?.cursor;
    if (!cursor || buckets.length === 0) return out;
  }
  throw new ListTruncatedError({
    vendor: "Cloudflare",
    path,
    items: out.length,
    maxPages: BUCKETS_MAX_PAGES,
  });
}

/**
 * Buckets in every documented jurisdiction. A list answers only for the jurisdiction its
 * `cf-r2-jurisdiction` header names (the default without one), so EU and FedRAMP buckets each take
 * their own read. The default read fails the list as it always has; with that answered, a refusal
 * of another jurisdiction means the account does not have it (FedRAMP is granted on request), so
 * it reads as none, while a throttle, an outage or a rejected token still fails the list.
 */
export async function listR2Buckets(
  api: CloudflareApi,
  accountId: string,
): Promise<ResourceInstance[]> {
  const account_id = await api.getAccountId();
  const out = new Map<string, ResourceInstance>();
  const add = (buckets: Bucket[], jurisdiction?: R2Jurisdiction) => {
    for (const b of buckets) {
      const mapped = mapR2Bucket(asRecord(b), accountId, account_id, jurisdiction);
      if (!out.has(mapped.id)) out.set(mapped.id, mapped);
    }
  };
  add(await listAllR2Buckets(api));
  for (const jurisdiction of OTHER_JURISDICTIONS) {
    let buckets: Bucket[];
    try {
      buckets = await listAllR2Buckets(api, jurisdiction);
    } catch (err) {
      rethrowIncompleteList(err);
      if (!refusedBesideAnswer(err)) throw err;
      continue;
    }
    add(buckets, jurisdiction);
  }
  return [...out.values()];
}

export async function getR2Bucket(
  api: CloudflareApi,
  externalId: string,
  accountId: string,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const { name, jurisdiction } = requireBucket(externalId);
  const bucket = await api.cf.r2.buckets.get(name, {
    account_id,
    ...sdkJurisdiction(jurisdiction),
  });
  return mapR2Bucket(asRecord(bucket), accountId, account_id, jurisdiction);
}

export async function createR2Bucket(
  api: CloudflareApi,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const locationHint = fields["locationHint"] ?? "";
  const storageClass = fields["storageClass"] ?? "";
  const params: BucketCreateParams = {
    account_id,
    name: fields["name"] ?? "",
    ...(isR2LocationHint(locationHint) ? { locationHint } : {}),
    ...(isR2StorageClass(storageClass) ? { storageClass } : {}),
  };
  const bucket = await api.cf.r2.buckets.create(params);
  return mapR2Bucket(asRecord(bucket), accountId, account_id);
}

/**
 * Change a bucket's default storage class (`PATCH /r2/buckets/{name}` with the
 * `cf-r2-storage-class` header, which the SDK sets from `storage_class`). Only
 * new uploads pick up the class; existing objects keep theirs.
 */
export async function editR2Bucket(
  api: CloudflareApi,
  accountId: string,
  externalId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const account_id = await api.getAccountId();
  const storageClass = fields["storageClass"] ?? "";
  if (!isR2StorageClass(storageClass)) {
    throw new Error(`Unknown R2 storage class "${storageClass}".`);
  }
  const { name, jurisdiction } = requireBucket(externalId);
  const bucket = await api.cf.r2.buckets.edit(name, {
    account_id,
    storage_class: storageClass,
    ...sdkJurisdiction(jurisdiction),
  });
  return mapR2Bucket(asRecord(bucket), accountId, account_id, jurisdiction);
}

/**
 * The bucket's public r2.dev development URL
 * (`GET /r2/buckets/{name}/domains/managed`). `domain` is filled in whether or
 * not public access is on; `enabled` says whether it actually serves.
 */
export async function getR2DevDomain(
  api: CloudflareApi,
  bucketName: string,
  jurisdiction = "",
): Promise<{ domain: string; enabled: boolean }> {
  const account_id = await api.getAccountId();
  const res = asRecord(
    await api.cf.r2.buckets.domains.managed.list(bucketName, {
      account_id,
      ...jurisdictionParam(jurisdiction),
    }),
  );
  return { domain: String(res["domain"] ?? ""), enabled: Boolean(res["enabled"]) };
}

/** Turn public r2.dev access on or off (`PUT /r2/buckets/{name}/domains/managed`). */
export async function setR2DevDomain(
  api: CloudflareApi,
  bucketName: string,
  enabled: boolean,
  jurisdiction = "",
): Promise<void> {
  const account_id = await api.getAccountId();
  await api.cf.r2.buckets.domains.managed.update(bucketName, {
    account_id,
    enabled,
    ...jurisdictionParam(jurisdiction),
  });
}

/**
 * Buckets created in a data-location jurisdiction are only addressable with
 * the matching `cf-r2-jurisdiction` header; the default jurisdiction needs none.
 */
function jurisdictionParam(jurisdiction: string): { jurisdiction?: "eu" | "fedramp" } {
  return jurisdiction === "eu" || jurisdiction === "fedramp" ? { jurisdiction } : {};
}

export async function deleteR2Bucket(api: CloudflareApi, externalId: string): Promise<void> {
  const { name, jurisdiction } = requireBucket(externalId);
  const account_id = await api.getAccountId();
  await api.cf.r2.buckets.delete(name, { account_id, ...sdkJurisdiction(jurisdiction) });
}

// --- R2 object plane (intentionally left on raw fetch: SDK has no coverage) ---

export async function listR2StorageObjects(
  api: CloudflareApi,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const cfAccountId = await api.getAccountId();
  const { name, jurisdiction } = requireBucket(bucket);
  const params = new URLSearchParams({ prefix, delimiter: "/" });
  // The list-objects endpoint puts objects in the envelope's `result` array
  // (not a nested `objects` field) and common prefixes in
  // `result_info.delimited`. `api.fetch` only returns `result`, so go through
  // raw fetch to access `result_info`.
  const path = `/accounts/${cfAccountId}/r2/buckets/${name}/objects?${params.toString()}`;
  const res = await cfFetch(api, `${api.baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${api.apiToken}`,
      "Content-Type": "application/json",
      ...jurisdictionHeader(jurisdiction),
    },
  });
  if (!res.ok) {
    throw new Error(`Cloudflare API error ${res.status} for ${path}: ${await res.text()}`);
  }
  const envelope = (await res.json()) as {
    success: boolean;
    result?: Array<Record<string, unknown>>;
    result_info?: { delimited?: string[] };
    errors?: Array<{ message: string }>;
  };
  if (!envelope.success) {
    const msgs = envelope.errors?.map((e) => e.message).join(", ") ?? "unknown error";
    throw new Error(`Cloudflare API error for ${path}: ${msgs}`);
  }

  const objects: StorageObject[] = [];

  // Directories (common prefixes)
  for (const p of envelope.result_info?.delimited ?? []) {
    const name = p.endsWith("/") ? p.slice(prefix.length, -1) : p.slice(prefix.length);
    objects.push({
      key: p,
      name: name || p,
      size: 0,
      lastModified: "",
      isDirectory: true,
    });
  }

  // Files
  for (const item of envelope.result ?? []) {
    const key = String(item["key"] ?? "");
    if (key === prefix) continue; // skip the prefix itself
    const name = key.slice(prefix.length);
    if (!name) continue;
    const httpMeta = item["http_metadata"] as { contentType?: string } | undefined;
    objects.push({
      key,
      name,
      size: Number(item["size"] ?? 0),
      lastModified: String(item["last_modified"] ?? ""),
      isDirectory: false,
      contentType: String(httpMeta?.contentType ?? ""),
    });
  }

  return objects;
}

export async function deleteR2StorageObject(
  api: CloudflareApi,
  bucket: string,
  key: string,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  const { name, jurisdiction } = requireBucket(bucket);
  if (key.endsWith("/")) {
    // Delete all objects under this prefix
    const objects = await listR2StorageObjects(api, bucket, key);
    for (const obj of objects) {
      await deleteR2StorageObject(api, bucket, obj.key);
    }
  }
  await api.fetch(
    `/accounts/${cfAccountId}/r2/buckets/${name}/objects/${encodeURIComponent(key)}`,
    {
      method: "DELETE",
      ...(jurisdiction ? { headers: jurisdictionHeader(jurisdiction) } : {}),
    },
  );
}

export async function uploadR2StorageObject(
  api: CloudflareApi,
  bucket: string,
  key: string,
  file: File,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  const { name, jurisdiction } = requireBucket(bucket);
  const arrayBuffer = await file.arrayBuffer();
  const res = await cfFetch(
    api,
    `${api.baseUrl}/accounts/${cfAccountId}/r2/buckets/${name}/objects/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": file.type || "application/octet-stream",
        ...jurisdictionHeader(jurisdiction),
      },
      body: arrayBuffer,
    },
  );
  if (!res.ok) {
    throw new Error(`R2 upload error ${res.status}: ${await res.text()}`);
  }
}

export async function makeR2StorageFolder(
  api: CloudflareApi,
  bucket: string,
  key: string,
): Promise<void> {
  const cfAccountId = await api.getAccountId();
  const { name, jurisdiction } = requireBucket(bucket);
  const folderKey = key.endsWith("/") ? key : `${key}/`;
  const res = await cfFetch(
    api,
    `${api.baseUrl}/accounts/${cfAccountId}/r2/buckets/${name}/objects/${encodeURIComponent(folderKey)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${api.apiToken}`,
        "Content-Type": "application/x-directory",
        "Content-Length": "0",
        ...jurisdictionHeader(jurisdiction),
      },
      body: null,
    },
  );
  if (!res.ok) {
    throw new Error(`R2 mkdir error ${res.status}: ${await res.text()}`);
  }
}
