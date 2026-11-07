import { hostFetch, ListTruncatedError, requireListPage } from "@infrawrench/plugin-base";
import type { HttpHostServices, ResourceInstance, StorageObject } from "@infrawrench/plugin-base";
import type { Api, Bucket, CredentialMeta } from "@neondatabase/api-client";
import { isServiceUnavailable, resourceId, type BranchRef } from "./common.js";
import type { ListRun } from "./list-run.js";

export interface BranchStorageInfo {
  s3Endpoint: string;
  region: string;
}

/**
 * The host's storage browser passes only a bucket name (it has no branch
 * context) but Neon bucket names are unique per branch, not per account. This
 * cache maps a bucket name back to the branch it was listed from, and is
 * repopulated by listing buckets when cold.
 */
export class BucketLocator {
  private readonly locations = new Map<string, BranchRef>();
  private readonly storageInfo = new Map<string, BranchStorageInfo>();

  remember(bucketName: string, ref: BranchRef): void {
    this.locations.set(bucketName, ref);
  }

  rememberStorage(branchKey: string, info: BranchStorageInfo): void {
    this.storageInfo.set(branchKey, info);
  }

  lookup(bucketName: string): BranchRef | undefined {
    return this.locations.get(bucketName);
  }

  storageFor(ref: BranchRef): BranchStorageInfo | undefined {
    return this.storageInfo.get(`${ref.projectId}/${ref.branchId}`);
  }
}

/** The document's default and largest page is 1,000 items, so this is a million. */
const MAX_OBJECT_PAGES = 1_000;

/** Fetch a branch's S3 endpoint/region, or undefined when storage isn't enabled there. */
export async function fetchBranchStorage(
  api: Api<unknown>,
  ref: BranchRef,
): Promise<BranchStorageInfo | undefined> {
  try {
    const resp = await api.getProjectBranchStorage(ref.projectId, ref.branchId);
    return { s3Endpoint: resp.data.s3_endpoint, region: resp.data.region };
  } catch (err) {
    if (isServiceUnavailable(err)) return undefined;
    throw err;
  }
}

export function buildBucketResource(
  accountId: string,
  ref: BranchRef,
  bucket: Bucket,
  storage: BranchStorageInfo | undefined,
): ResourceInstance {
  const externalId = `${ref.projectId}/${ref.branchId}/${bucket.name}`;
  return {
    id: resourceId(accountId, "neon-bucket", externalId),
    pluginId: "neon",
    resourceTypeId: "neon-bucket",
    accountId,
    displayName: bucket.name,
    fields: {
      name: bucket.name,
      accessLevel: bucket.access_level,
      projectId: ref.projectId,
      branchId: ref.branchId,
      region: storage?.region ?? "",
      createdAt: bucket.created_at,
    },
    resolvedOutputs: {
      bucketName: bucket.name,
      s3Endpoint: storage?.s3Endpoint ?? "",
      region: storage?.region ?? "",
    },
    secretStates: [],
    externalId,
    parentResourceId: resourceId(accountId, "neon-branch", `${ref.projectId}/${ref.branchId}`),
    createdAt: bucket.created_at,
    updatedAt: bucket.created_at,
  };
}

export async function listAllBuckets(
  run: ListRun,
  accountId: string,
  locator: BucketLocator,
): Promise<ResourceInstance[]> {
  const { api } = run;
  return run.readBranchServices(accountId, async (ref) => {
    // No storage on this branch means the org lacks the Private Beta entitlement
    // or the branch is outside a supported region, not an error worth surfacing.
    const storageResp = await api.getProjectBranchStorage(ref.projectId, ref.branchId);
    const storage = { s3Endpoint: storageResp.data.s3_endpoint, region: storageResp.data.region };
    locator.rememberStorage(`${ref.projectId}/${ref.branchId}`, storage);

    const resp = await api.listProjectBranchBuckets(ref.projectId, ref.branchId);
    const buckets = requireListPage(resp.data.buckets, {
      vendor: "Neon",
      path: `/projects/${ref.projectId}/branches/${ref.branchId}/buckets`,
      key: "buckets",
    });
    return buckets.map((bucket) => {
      locator.remember(bucket.name, ref);
      return buildBucketResource(accountId, ref, bucket, storage);
    });
  });
}

/** Resolve which branch a bucket lives on, listing buckets to warm the cache if needed. */
export async function locateBucket(
  run: ListRun,
  accountId: string,
  locator: BucketLocator,
  bucketName: string,
): Promise<BranchRef> {
  const cached = locator.lookup(bucketName);
  if (cached) return cached;

  await listAllBuckets(run, accountId, locator);
  const found = locator.lookup(bucketName);
  if (!found) throw new Error(`Neon plugin: bucket "${bucketName}" not found on any branch`);
  return found;
}

/** List one page-set of objects under a prefix, mapping Neon's folders + objects to StorageObjects. */
export async function listBucketObjects(
  api: Api<unknown>,
  ref: BranchRef,
  bucketName: string,
  prefix: string,
): Promise<StorageObject[]> {
  const path = `/projects/${ref.projectId}/branches/${ref.branchId}/buckets/${bucketName}/objects`;
  const results: StorageObject[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_OBJECT_PAGES; page++) {
    const resp = await api.listProjectBranchBucketObjects({
      projectId: ref.projectId,
      branchId: ref.branchId,
      bucketName,
      prefix,
      delimiter: "/",
      ...(cursor ? { cursor } : {}),
    });

    const place = { vendor: "Neon", path };
    for (const folder of requireListPage(resp.data.folders, { ...place, key: "folders" })) {
      results.push({
        key: folder,
        name: trimPrefix(folder, prefix).replace(/\/$/, ""),
        size: 0,
        lastModified: "",
        isDirectory: true,
      });
    }
    for (const obj of requireListPage(resp.data.objects, { ...place, key: "objects" })) {
      // Neon returns the folder marker itself in the object list; the folder
      // entry above already represents it.
      if (obj.key === prefix) continue;
      results.push({
        key: obj.key,
        name: trimPrefix(obj.key, prefix),
        size: obj.size,
        lastModified: obj.last_modified,
        isDirectory: false,
      });
    }

    const next = resp.data.next_cursor;
    if (!next) return results;
    cursor = next;
  }
  throw new ListTruncatedError({
    vendor: "Neon",
    path,
    items: results.length,
    maxPages: MAX_OBJECT_PAGES,
  });
}

function trimPrefix(key: string, prefix: string): string {
  return prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Uploads go through a presigned URL rather than the management API: the
 * management API has no object-write endpoint, and presigning keeps the file
 * bytes off the control plane.
 */
export async function uploadBucketObject(
  api: Api<unknown>,
  ref: BranchRef,
  bucketName: string,
  key: string,
  body: Blob,
  contentType: string | undefined,
  http: HttpHostServices | undefined,
): Promise<void> {
  const resp = await api.presignProjectBranchBucketObject(
    ref.projectId,
    ref.branchId,
    bucketName,
    key,
    {
      operation: "upload",
      ...(contentType ? { content_type: contentType } : {}),
    },
  );

  const presigned = resp.data;
  const uploaded = await hostFetch({ http }, presigned.url, {
    method: presigned.method,
    headers: presigned.headers,
    body,
  });
  if (!uploaded.ok) {
    throw new Error(`Neon plugin: upload of "${key}" failed (${uploaded.status})`);
  }
}

export async function deleteBucketObject(
  api: Api<unknown>,
  ref: BranchRef,
  bucketName: string,
  key: string,
): Promise<void> {
  // A trailing slash means the host is deleting a folder: remove everything under it.
  if (key.endsWith("/")) {
    await api.deleteProjectBranchBucketObjectsByPrefix({
      projectId: ref.projectId,
      branchId: ref.branchId,
      bucketName,
      prefix: key,
    });
    return;
  }
  await api.deleteProjectBranchBucketObject(ref.projectId, ref.branchId, bucketName, key);
}

export function buildCredentialResource(
  accountId: string,
  ref: BranchRef,
  cred: CredentialMeta,
): ResourceInstance {
  const externalId = `${ref.projectId}/${ref.branchId}/${cred.token_id}`;
  return {
    id: resourceId(accountId, "neon-credential", externalId),
    pluginId: "neon",
    resourceTypeId: "neon-credential",
    accountId,
    displayName: cred.name ?? cred.token_id_short,
    fields: {
      name: cred.name ?? "",
      tokenIdShort: cred.token_id_short,
      scopes: cred.scopes.join(", "),
      projectId: ref.projectId,
      branchId: ref.branchId,
      createdAt: cred.created_at,
      lastUsedAt: cred.last_used_at ?? "",
      expiresAt: cred.expires_at ?? "",
    },
    resolvedOutputs: { tokenId: cred.token_id },
    secretStates: [],
    externalId,
    parentResourceId: resourceId(accountId, "neon-branch", `${ref.projectId}/${ref.branchId}`),
    createdAt: cred.created_at,
    updatedAt: cred.created_at,
  };
}

export async function listAllCredentials(
  run: ListRun,
  accountId: string,
): Promise<ResourceInstance[]> {
  return run.readBranchServices(accountId, async (ref) => {
    const resp = await run.api.listCredentials(ref.projectId, ref.branchId);
    const credentials = requireListPage(resp.data.credentials, {
      vendor: "Neon",
      path: `/projects/${ref.projectId}/branches/${ref.branchId}/credentials`,
      key: "credentials",
    });
    return (
      credentials
        // Revoked credentials stay in the listing; they aren't live resources.
        .filter((cred) => !cred.revoked_at)
        .map((cred) => buildCredentialResource(accountId, ref, cred))
    );
  });
}
