import type { StorageObject, ArtifactEntry } from "@infrawrench/plugin-base";
import type { GcpClientContext } from "./shared.js";

export async function uploadStorageObject(
  ctx: GcpClientContext,
  bucket: string,
  key: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  const tok = await ctx.token();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(key)}`;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Authorization", `Bearer ${tok}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    if (onProgress) {
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      });
    }
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText.slice(0, 200)}`));
    });
    xhr.addEventListener("error", () => reject(new Error("Upload network error")));
    xhr.send(file);
  });
}

export async function deleteStorageObject(
  ctx: GcpClientContext,
  bucket: string,
  key: string,
): Promise<void> {
  const tok = await ctx.token();

  if (key.endsWith("/")) {
    // Folder — list all objects with this prefix (flat, no delimiter) and delete each
    const allKeys: string[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
      );
      url.searchParams.set("prefix", key);
      url.searchParams.set("maxResults", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await ctx.get<{ items?: Array<{ name: string }>; nextPageToken?: string }>(
        url.toString(),
      );
      for (const item of page.items ?? []) allKeys.push(item.name);
      pageToken = page.nextPageToken;
    } while (pageToken);

    await Promise.all(
      allKeys.map((k) =>
        fetch(
          `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(k)}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
        ),
      ),
    );
    return;
  }

  const res = await fetch(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${tok}` } },
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete failed: ${res.status}`);
  }
}

export async function makeStorageFolder(
  ctx: GcpClientContext,
  bucket: string,
  key: string,
): Promise<void> {
  const tok = await ctx.token();
  const folderKey = key.endsWith("/") ? key : `${key}/`;
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(folderKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tok}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  if (!res.ok) throw new Error(`Make folder failed: ${res.status}`);
}

export async function listStorageObjects(
  ctx: GcpClientContext,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  const url = new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
  );
  url.searchParams.set("delimiter", "/");
  url.searchParams.set("maxResults", "1000");
  if (prefix) url.searchParams.set("prefix", prefix);

  const results: StorageObject[] = [];
  let pageToken: string | undefined;

  do {
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await ctx.get<{
      items?: Array<{ name: string; size: string; updated: string; contentType?: string }>;
      prefixes?: string[];
      nextPageToken?: string;
    }>(url.toString());

    // Directories (common prefixes)
    for (const p of page.prefixes ?? []) {
      const name = p.slice(prefix.length).replace(/\/$/, "");
      results.push({ key: p, name, size: 0, lastModified: "", isDirectory: true });
    }

    // Objects
    for (const obj of page.items ?? []) {
      if (obj.name === prefix) continue; // skip the "folder" placeholder object
      const name = obj.name.slice(prefix.length);
      results.push({
        key: obj.name,
        name,
        size: Number(obj.size ?? 0),
        lastModified: obj.updated ?? "",
        isDirectory: false,
        ...(obj.contentType ? { contentType: obj.contentType } : {}),
      });
    }

    pageToken = page.nextPageToken;
  } while (pageToken);

  return results;
}

export async function listArtifacts(
  ctx: GcpClientContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  params?: { pageToken?: string; prefix?: string },
): Promise<{ items: ArtifactEntry[]; nextPageToken?: string }> {
  if (typeId !== "artifact-registry-repo") {
    throw new Error(`listArtifacts not supported for type ${typeId}`);
  }
  // Parse resourceId ("accountId:typeId:projects/.../repositories/...") directly —
  // we can't go through getResource() because the repository lister uses the
  // `locations/-` wildcard which Artifact Registry rejects.
  const marker = `${accountId}:${typeId}:`;
  const parent = resourceId.startsWith(marker) ? resourceId.slice(marker.length) : resourceId;
  if (!parent.startsWith("projects/")) {
    throw new Error(`Invalid artifact-registry-repo resource id: ${resourceId}`);
  }
  const repoInfo = await ctx.get<{ format?: string }>(
    `https://artifactregistry.googleapis.com/v1/${parent}`,
  );
  const format = String(repoInfo.format ?? "").toUpperCase();

  if (format === "DOCKER") {
    const url = new URL(`https://artifactregistry.googleapis.com/v1/${parent}/dockerImages`);
    url.searchParams.set("pageSize", "50");
    if (params?.pageToken) url.searchParams.set("pageToken", params.pageToken);
    const page = await ctx.get<{
      dockerImages?: Array<{
        name: string;
        tags?: string[];
        uri?: string;
        imageSizeBytes?: string;
        uploadTime?: string;
        mediaType?: string;
        buildTime?: string;
        updateTime?: string;
      }>;
      nextPageToken?: string;
    }>(url.toString());
    const items: ArtifactEntry[] = (page.dockerImages ?? []).map((img) => {
      // name looks like projects/p/locations/l/repositories/r/dockerImages/name@sha256:digest
      const resourceName = img.name;
      const atIdx = resourceName.lastIndexOf("@");
      const baseName = atIdx >= 0 ? resourceName.slice(0, atIdx) : resourceName;
      const shortName = baseName.split("/dockerImages/").pop() ?? baseName;
      const digest = atIdx >= 0 ? resourceName.slice(atIdx + 1) : undefined;
      const entry: ArtifactEntry = {
        name: decodeURIComponent(shortName),
      };
      if (img.tags && img.tags.length > 0 && img.tags[0]) {
        entry.tags = img.tags;
        entry.version = img.tags[0];
      }
      if (digest) entry.digest = digest;
      if (img.imageSizeBytes) entry.sizeBytes = Number(img.imageSizeBytes);
      const ts = img.updateTime ?? img.uploadTime ?? img.buildTime;
      if (ts) entry.updatedAt = ts;
      if (img.mediaType) entry.mediaType = img.mediaType;
      return entry;
    });
    const prefix = params?.prefix?.trim();
    const filtered = prefix ? items.filter((i) => i.name.includes(prefix)) : items;
    const result: { items: ArtifactEntry[]; nextPageToken?: string } = { items: filtered };
    if (page.nextPageToken) result.nextPageToken = page.nextPageToken;
    return result;
  }

  // Non-Docker formats: list packages, show latest version per package.
  const url = new URL(`https://artifactregistry.googleapis.com/v1/${parent}/packages`);
  url.searchParams.set("pageSize", "50");
  if (params?.pageToken) url.searchParams.set("pageToken", params.pageToken);
  const page = await ctx.get<{
    packages?: Array<{ name: string; displayName?: string; updateTime?: string }>;
    nextPageToken?: string;
  }>(url.toString());
  const items: ArtifactEntry[] = (page.packages ?? []).map((pkg) => {
    const shortName = pkg.name.split("/packages/").pop() ?? pkg.name;
    const entry: ArtifactEntry = {
      name: decodeURIComponent(pkg.displayName ?? shortName),
    };
    if (pkg.updateTime) entry.updatedAt = pkg.updateTime;
    return entry;
  });
  const prefix = params?.prefix?.trim();
  const filtered = prefix ? items.filter((i) => i.name.includes(prefix)) : items;
  const result: { items: ArtifactEntry[]; nextPageToken?: string } = { items: filtered };
  if (page.nextPageToken) result.nextPageToken = page.nextPageToken;
  return result;
}
