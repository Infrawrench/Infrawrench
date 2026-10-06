/**
 * Object Storage browsing. A Vultr Object Storage subscription is an
 * S3-compatible endpoint (`{region}.vultrobjects.com`) with its own access
 * and secret key, both returned by `GET /v2/object-storage/{id}`. Buckets are
 * addressed `{subscriptionId}/{bucket}`, so the browser looks the keys up
 * from the subscription and signs S3 requests (SigV4, path-style) with them.
 * Keys are cached per subscription for the life of the client.
 */

import type { S3StorageConfig, StorageObject } from "@infrawrench/plugin-base";
import {
  deleteS3Object,
  listS3Objects,
  makeS3Folder,
  pathStyleUrl,
  uploadS3Object,
} from "@infrawrench/plugin-base";
import type { VultrApi } from "./api.js";
import type { VultrObjectStorage } from "./types.js";

export function splitBucketId(bucketId: string): { subscriptionId: string; bucket: string } {
  const i = bucketId.indexOf("/");
  if (i < 0)
    throw new Error(`Vultr plugin: bucket id "${bucketId}" is not {subscription}/{bucket}`);
  return { subscriptionId: bucketId.slice(0, i), bucket: bucketId.slice(i + 1) };
}

export class ObjectStorageBrowser {
  private readonly configs = new Map<string, Promise<S3StorageConfig>>();

  constructor(private readonly api: VultrApi) {}

  private config(subscriptionId: string): Promise<S3StorageConfig> {
    let pending = this.configs.get(subscriptionId);
    if (!pending) {
      pending = this.api
        .get<{ object_storage?: VultrObjectStorage }>(`/object-storage/${subscriptionId}`)
        .then((res) => {
          const sub = res.object_storage;
          if (!sub?.s3_hostname || !sub.s3_access_key || !sub.s3_secret_key) {
            throw new Error("Vultr did not return S3 keys for this Object Storage subscription.");
          }
          const host = sub.s3_hostname;
          // Vultr signs with any region label; the hostname's first label
          // (e.g. "ewr1") is what its own docs use.
          const region = host.split(".")[0] ?? "us-east-1";
          return {
            accessKey: sub.s3_access_key,
            secretKey: sub.s3_secret_key,
            region,
            buildUrl: pathStyleUrl(() => host)(region),
          };
        });
      pending.catch(() => this.configs.delete(subscriptionId));
      this.configs.set(subscriptionId, pending);
    }
    return pending;
  }

  async list(bucketId: string, prefix: string): Promise<StorageObject[]> {
    const { subscriptionId, bucket } = splitBucketId(bucketId);
    return listS3Objects(await this.config(subscriptionId), bucket, prefix);
  }

  async upload(
    bucketId: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const { subscriptionId, bucket } = splitBucketId(bucketId);
    await uploadS3Object(await this.config(subscriptionId), bucket, key, file);
    onProgress?.(100);
  }

  async makeFolder(bucketId: string, key: string): Promise<void> {
    const { subscriptionId, bucket } = splitBucketId(bucketId);
    await makeS3Folder(await this.config(subscriptionId), bucket, key);
  }

  async remove(bucketId: string, key: string): Promise<void> {
    const { subscriptionId, bucket } = splitBucketId(bucketId);
    await deleteS3Object(await this.config(subscriptionId), bucket, key);
  }
}
