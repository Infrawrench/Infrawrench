/**
 * Blob Storage operations — list, upload, mkdir, delete.
 *
 * Uses an AAD storage-scoped bearer token (`storage.azure.com`) and talks to the
 * REST surface at `https://<account>.blob.core.windows.net`. Parsing is done
 * against the XML enumeration response.
 */
import type { StorageObject } from "@infrawrench/plugin-base";

export interface StorageContext {
  /** Returns a valid AAD token scoped to `storage.azure.com`. */
  storageToken(): Promise<string>;
}

export async function listStorageObjects(
  ctx: StorageContext,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const tok = await ctx.storageToken();
  const delimiter = "/";
  const params = new URLSearchParams({
    restype: "container",
    comp: "list",
    prefix,
    delimiter,
  });
  const url = `https://${bucket}.blob.core.windows.net/?${params}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": "2023-11-03",
    },
  });
  if (!res.ok) throw new Error(`Azure Blob list failed: ${res.status}`);
  const xml = await res.text();
  return parseBlobListXml(xml, prefix);
}

function parseBlobListXml(xml: string, prefix: string): StorageObject[] {
  const results: StorageObject[] = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");

  // Parse blob prefixes (directories)
  const blobPrefixes = doc.querySelectorAll("BlobPrefix");
  for (const bp of Array.from(blobPrefixes)) {
    const name = bp.querySelector("Name")?.textContent ?? "";
    if (name) {
      results.push({
        key: name,
        name: name.slice(prefix.length).replace(/\/$/, ""),
        size: 0,
        lastModified: "",
        isDirectory: true,
      });
    }
  }

  // Parse blobs (files)
  const blobs = doc.querySelectorAll("Blobs > Blob");
  for (const blob of Array.from(blobs)) {
    const blobName = blob.querySelector("Name")?.textContent ?? "";
    const props = blob.querySelector("Properties");
    const size = Number(props?.querySelector("Content-Length")?.textContent ?? "0");
    const lastModified = props?.querySelector("Last-Modified")?.textContent ?? "";
    const contentType = props?.querySelector("Content-Type")?.textContent ?? "";

    results.push({
      key: blobName,
      name: blobName.slice(prefix.length),
      size,
      lastModified,
      isDirectory: false,
      contentType,
    });
  }

  return results;
}

export async function uploadStorageObject(
  ctx: StorageContext,
  bucket: string,
  key: string,
  file: File,
): Promise<void> {
  const tok = await ctx.storageToken();
  // Find the first container, then upload blob
  const containerName = key.split("/")[0] ?? "$root";
  const blobName = key.split("/").slice(1).join("/") || key;
  const url = `https://${bucket}.blob.core.windows.net/${containerName}/${blobName}`;
  const arrayBuffer = await file.arrayBuffer();
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": "2023-11-03",
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": String(arrayBuffer.byteLength),
    },
    body: arrayBuffer,
  });
  if (!res.ok) throw new Error(`Azure Blob upload failed: ${res.status}`);
}

export async function makeStorageFolder(
  ctx: StorageContext,
  bucket: string,
  key: string,
): Promise<void> {
  // Azure doesn't have real folders — upload a zero-byte blob with trailing /
  const tok = await ctx.storageToken();
  const containerName = key.split("/")[0] ?? "$root";
  const folderKey = key.split("/").slice(1).join("/") || key;
  const url = `https://${bucket}.blob.core.windows.net/${containerName}/${folderKey}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": "2023-11-03",
      "x-ms-blob-type": "BlockBlob",
      "Content-Length": "0",
    },
  });
  if (!res.ok) throw new Error(`Azure Blob mkdir failed: ${res.status}`);
}

export async function deleteStorageObject(
  ctx: StorageContext,
  bucket: string,
  key: string,
): Promise<void> {
  const tok = await ctx.storageToken();
  if (key.endsWith("/")) {
    // Delete all blobs under this prefix
    const objects = await listStorageObjects(ctx, bucket, key);
    for (const obj of objects) {
      if (!obj.isDirectory) {
        await deleteStorageObject(ctx, bucket, obj.key);
      }
    }
  } else {
    const containerName = key.split("/")[0] ?? "$root";
    const blobName = key.split("/").slice(1).join("/") || key;
    const url = `https://${bucket}.blob.core.windows.net/${containerName}/${blobName}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tok}`,
        "x-ms-version": "2023-11-03",
      },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Azure Blob delete failed: ${res.status}`);
    }
  }
}
