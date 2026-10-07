/**
 * SOS (Simple Object Storage) browsing. Exoscale IAM API keys work against
 * SOS's S3-compatible API at `https://sos-{zone}.exo.io` with SigV4, the
 * zone as signing region, so the account's own key signs; no separate
 * credential is needed (the key's IAM role must allow `sos`). Bucket ids
 * are `{zone}/{name}`; path-style addressing.
 */

import type { S3StorageConfig, StorageObject } from "@infrawrench/plugin-base";
import {
  deleteS3Object,
  listS3Objects,
  makeS3Folder,
  pathStyleUrl,
  uploadS3Object,
} from "@infrawrench/plugin-base";
import type { ExoscaleApi } from "./api.js";

export function bucketConfig(
  api: ExoscaleApi,
  bucketId: string,
): { config: S3StorageConfig; bucket: string } {
  const i = bucketId.indexOf("/");
  const zone = i < 0 ? "ch-gva-2" : bucketId.slice(0, i);
  const bucket = i < 0 ? bucketId : bucketId.slice(i + 1);
  const host = `sos-${zone}.exo.io`;
  return {
    bucket,
    config: {
      accessKey: api.apiKey,
      secretKey: api.apiSecret,
      region: zone,
      buildUrl: pathStyleUrl(() => host)(zone),
    },
  };
}

export function listObjects(
  api: ExoscaleApi,
  bucketId: string,
  prefix: string,
): Promise<StorageObject[]> {
  const { config, bucket } = bucketConfig(api, bucketId);
  return listS3Objects(config, bucket, prefix);
}

export async function uploadObject(
  api: ExoscaleApi,
  bucketId: string,
  key: string,
  file: File,
  onProgress?: (pct: number) => void,
) {
  const { config, bucket } = bucketConfig(api, bucketId);
  await uploadS3Object(config, bucket, key, file);
  onProgress?.(100);
}

export function makeFolder(api: ExoscaleApi, bucketId: string, key: string) {
  const { config, bucket } = bucketConfig(api, bucketId);
  return makeS3Folder(config, bucket, key);
}

export function deleteObject(api: ExoscaleApi, bucketId: string, key: string) {
  const { config, bucket } = bucketConfig(api, bucketId);
  return deleteS3Object(config, bucket, key);
}
