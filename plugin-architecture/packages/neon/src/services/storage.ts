import type { ResourceInstance, StorageObject } from "@infrawrench/plugin-base";
import type { Api, Bucket, CredentialMeta, ProjectListItem } from "@neondatabase/api-client";
import { enumerateBranches, isServiceUnavailable, resourceId, type BranchRef } from "./common.js";

export interface BranchStorageInfo {
  s3Endpoint: string;
  region: string;
}

/**
 * The host's storage browser passes only a bucket name — it has no branch
 * context — but Neon bucket names are unique per branch, not per account. This
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
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
  locator: BucketLocator,
): Promise<ResourceInstance[]> {
  const branches = await enumerateBranches(api, projects);
  const results: ResourceInstance[] = [];

  for (const ref of branches) {
    const storage = await fetchBranchStorage(api, ref);
    // No storage on this branch means the org lacks the Private Beta entitlement
    // or the branch is outside a supported region — not an error worth surfacing.
    if (!storage) continue;
    locator.rememberStorage(`${ref.projectId}/${ref.branchId}`, storage);

    try {
      const resp = await api.listProjectBranchBuckets(ref.projectId, ref.branchId);
      for (const bucket of resp.data.buckets) {
        locator.remember(bucket.name, ref);
        results.push(buildBucketResource(accountId, ref, bucket, storage));
      }
    } catch (err) {
      if (!isServiceUnavailable(err)) throw err;
    }
  }
  return results;
}

/** Resolve which branch a bucket lives on, listing buckets to warm the cache if needed. */
export async function locateBucket(
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
  locator: BucketLocator,
  bucketName: string,
): Promise<BranchRef> {
  const cached = locator.lookup(bucketName);
  if (cached) return cached;

  await listAllBuckets(api, accountId, projects, locator);
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
  const results: StorageObject[] = [];
  let cursor: string | undefined;

  for (let i = 0; i < 50; i++) {
    const resp = await api.listProjectBranchBucketObjects({
      projectId: ref.projectId,
      branchId: ref.branchId,
      bucketName,
      prefix,
      delimiter: "/",
      ...(cursor ? { cursor } : {}),
    });

    for (const folder of resp.data.folders) {
      results.push({
        key: folder,
        name: trimPrefix(folder, prefix).replace(/\/$/, ""),
        size: 0,
        lastModified: "",
        isDirectory: true,
      });
    }
    for (const obj of resp.data.objects) {
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
    if (!next) break;
    cursor = next;
  }
  return results;
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
  contentType?: string,
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
  const uploaded = await fetch(presigned.url, {
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
  api: Api<unknown>,
  accountId: string,
  projects: ProjectListItem[],
): Promise<ResourceInstance[]> {
  const branches = await enumerateBranches(api, projects);
  const results: ResourceInstance[] = [];

  for (const ref of branches) {
    try {
      const resp = await api.listCredentials(ref.projectId, ref.branchId);
      for (const cred of resp.data.credentials) {
        // Revoked credentials stay in the listing; they aren't live resources.
        if (cred.revoked_at) continue;
        results.push(buildCredentialResource(accountId, ref, cred));
      }
    } catch (err) {
      if (!isServiceUnavailable(err)) throw err;
    }
  }
  return results;
}
