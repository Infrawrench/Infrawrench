import type { StorageObject } from "@infrawrench/plugin-base";
import type { B2Api } from "./api.js";
import { B2ApiError } from "./api.js";
import type { B2File } from "./types.js";

/**
 * The file browser over the Native API. The host addresses buckets by name;
 * the Native API wants the bucket id, so names are resolved (and cached)
 * through `b2_list_buckets` filtered by name.
 *
 * Folders are not objects in B2: `b2_list_file_names` with `delimiter: "/"`
 * reports them as `action: "folder"` entries, and the B2 web console makes an
 * empty folder by uploading a zero-byte `.bzEmpty` file inside it, which is
 * what `makeFolder` does too so the two agree.
 */

const FOLDER_PLACEHOLDER = ".bzEmpty";

export class B2Storage {
  private bucketIds = new Map<string, string>();

  constructor(private readonly api: B2Api) {}

  async bucketId(bucketName: string): Promise<string> {
    const hit = this.bucketIds.get(bucketName);
    if (hit) return hit;
    const s = await this.api.getSession();
    const res = await this.api.call<{ buckets?: Array<{ bucketId: string; bucketName: string }> }>(
      "b2_list_buckets",
      { body: { accountId: s.accountId, bucketName } },
    );
    const id = res?.buckets?.find((b) => b.bucketName === bucketName)?.bucketId;
    if (!id)
      throw new B2ApiError(404, "not_found", `Backblaze B2: bucket "${bucketName}" not found`);
    this.bucketIds.set(bucketName, id);
    return id;
  }

  async list(bucketName: string, prefix: string): Promise<StorageObject[]> {
    const bucketId = await this.bucketId(bucketName);
    const out: StorageObject[] = [];
    let start: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await this.api.call<{ files?: B2File[]; nextFileName?: string | null }>(
        "b2_list_file_names",
        {
          body: {
            bucketId,
            prefix,
            delimiter: "/",
            maxFileCount: 1000,
            ...(start ? { startFileName: start } : {}),
          },
        },
      );
      for (const file of res?.files ?? []) {
        const name = file.fileName.slice(prefix.length);
        if (file.action === "folder") {
          out.push({
            key: file.fileName,
            name: name.replace(/\/$/, ""),
            size: 0,
            lastModified: "",
            isDirectory: true,
          });
          continue;
        }
        if (!name || name === FOLDER_PLACEHOLDER) continue;
        out.push({
          key: file.fileName,
          name,
          size: file.contentLength ?? 0,
          lastModified: file.uploadTimestamp ? new Date(file.uploadTimestamp).toISOString() : "",
          isDirectory: false,
          ...(file.contentType ? { contentType: file.contentType } : {}),
        });
      }
      start = res?.nextFileName ?? undefined;
      if (!start) break;
    }
    return out;
  }

  async upload(
    bucketName: string,
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const bucketId = await this.bucketId(bucketName);
    const target = await this.api.call<{ uploadUrl: string; authorizationToken: string }>(
      "b2_get_upload_url",
      { method: "GET", query: { bucketId } },
    );
    await this.api.raw(
      {
        url: target.uploadUrl,
        method: "POST",
        headers: {
          Authorization: target.authorizationToken,
          "X-Bz-File-Name": encodeFileName(key),
          "Content-Type": contentType || "b2/x-auto",
          "Content-Length": String(body.byteLength),
          "X-Bz-Content-Sha1": "do_not_verify",
        },
        body,
      },
      "b2_upload_file",
    );
  }

  async makeFolder(bucketName: string, key: string): Promise<void> {
    const folder = key.endsWith("/") ? key : `${key}/`;
    await this.upload(
      bucketName,
      `${folder}${FOLDER_PLACEHOLDER}`,
      new Uint8Array(0),
      "application/octet-stream",
    );
  }

  /** Every version of every file under a name (or prefix, for folders). */
  private async versions(
    bucketId: string,
    prefix: string,
    exact: boolean,
  ): Promise<Array<{ fileName: string; fileId: string }>> {
    const out: Array<{ fileName: string; fileId: string }> = [];
    let startName: string | undefined;
    let startId: string | undefined;
    for (let page = 0; page < 200; page++) {
      const res = await this.api.call<{
        files?: B2File[];
        nextFileName?: string | null;
        nextFileId?: string | null;
      }>("b2_list_file_versions", {
        body: {
          bucketId,
          prefix,
          maxFileCount: 1000,
          ...(startName ? { startFileName: startName } : {}),
          ...(startId ? { startFileId: startId } : {}),
        },
      });
      for (const f of res?.files ?? []) {
        if (!f.fileId) continue;
        if (exact && f.fileName !== prefix) continue;
        out.push({ fileName: f.fileName, fileId: f.fileId });
      }
      startName = res?.nextFileName ?? undefined;
      startId = res?.nextFileId ?? undefined;
      if (!startName) break;
      if (exact && startName !== prefix) break;
    }
    return out;
  }

  /**
   * Delete a file (every version, so it is really gone rather than hidden) or,
   * for a key ending in "/", everything under that prefix.
   */
  async delete(bucketName: string, key: string): Promise<void> {
    const bucketId = await this.bucketId(bucketName);
    const all = await this.versions(bucketId, key, !key.endsWith("/"));
    for (const v of all) {
      await this.api.call<unknown>("b2_delete_file_version", {
        body: { fileName: v.fileName, fileId: v.fileId },
      });
    }
  }
}

/** `X-Bz-File-Name` is percent-encoded UTF-8 with "/" left alone. */
export function encodeFileName(name: string): string {
  return name
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}
