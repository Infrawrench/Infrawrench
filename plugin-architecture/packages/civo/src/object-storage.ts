/**
 * Object Store browsing. A Civo Object Store is one S3 bucket at
 * `objectstore_endpoint` (e.g. `objectstore.lon1.civo.com`), owned by an
 * Object Store credential whose secret is readable through
 * `GET /v2/objectstore/credentials/{id}` (`secret_access_key_id`). The
 * browser signs path-style SigV4 requests with that pair; the bucket id is
 * the store's `{region}/{id}` external id.
 */

import type { S3StorageConfig, StorageObject } from "@infrawrench/plugin-base";
import {
  deleteS3Object,
  listS3Objects,
  makeS3Folder,
  pathStyleUrl,
  uploadS3Object,
} from "@infrawrench/plugin-base";
import type { CivoApi } from "./api.js";
import type { CivoObjectStore, CivoObjectStoreCredential } from "./types.js";

export interface StoreAccess {
  bucket: string;
  config: S3StorageConfig;
}

export class ObjectStoreBrowser {
  private readonly cache = new Map<string, Promise<StoreAccess>>();
  constructor(private readonly api: CivoApi) {}

  access(storeRef: string): Promise<StoreAccess> {
    let pending = this.cache.get(storeRef);
    if (!pending) {
      pending = this.load(storeRef);
      pending.catch(() => this.cache.delete(storeRef));
      this.cache.set(storeRef, pending);
    }
    return pending;
  }

  private async load(storeRef: string): Promise<StoreAccess> {
    const i = storeRef.indexOf("/");
    const region = i < 0 ? "" : storeRef.slice(0, i);
    const id = i < 0 ? storeRef : storeRef.slice(i + 1);
    const store = await this.api.get<CivoObjectStore>(
      `/objectstores/${id}`,
      region ? { region } : undefined,
    );
    const credId = store.owner_info?.credential_id;
    if (!credId) throw new Error("Civo returned no credential for this Object Store.");
    const cred = await this.api.get<CivoObjectStoreCredential>(
      `/objectstore/credentials/${credId}`,
      region ? { region } : undefined,
    );
    if (!cred.access_key_id || !cred.secret_access_key_id) {
      throw new Error("Civo did not return the Object Store credential's keys.");
    }
    const host = (store.objectstore_endpoint ?? "")
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    if (!host) throw new Error("Civo returned no endpoint for this Object Store.");
    const signingRegion = region.toLowerCase() || "us-east-1";
    return {
      bucket: store.name ?? id,
      config: {
        accessKey: cred.access_key_id,
        secretKey: cred.secret_access_key_id,
        region: signingRegion,
        buildUrl: pathStyleUrl(() => host)(signingRegion),
      },
    };
  }

  async list(storeRef: string, prefix: string): Promise<StorageObject[]> {
    const a = await this.access(storeRef);
    return listS3Objects(a.config, a.bucket, prefix);
  }

  async upload(
    storeRef: string,
    key: string,
    file: File,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    const a = await this.access(storeRef);
    await uploadS3Object(a.config, a.bucket, key, file);
    onProgress?.(100);
  }

  async makeFolder(storeRef: string, key: string): Promise<void> {
    const a = await this.access(storeRef);
    await makeS3Folder(a.config, a.bucket, key);
  }

  async remove(storeRef: string, key: string): Promise<void> {
    const a = await this.access(storeRef);
    await deleteS3Object(a.config, a.bucket, key);
  }
}
