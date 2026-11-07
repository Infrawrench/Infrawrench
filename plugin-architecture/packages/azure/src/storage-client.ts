/**
 * Blob Storage operations: list, upload, mkdir, delete.
 *
 * Uses an AAD storage-scoped bearer token (`storage.azure.com`) and talks to the
 * REST surface at `https://<account>.blob.core.windows.net`. A browser key is
 * `container/path/in/container`: the account root lists containers (List
 * Containers), and below it a container's blobs (List Blobs).
 */
import {
  ListTruncatedError,
  requireListPage,
  type ListPlace,
  type StorageObject,
} from "@infrawrench/plugin-base";
import { azureRequest, type AzureHttpTransport } from "./http.js";

interface StorageContext extends AzureHttpTransport {
  /** Returns a valid AAD token scoped to `storage.azure.com`. */
  storageToken(): Promise<string>;
}

const VERSION = "2023-11-03";
/** List Blobs and List Containers both answer at most 5,000 entries a page. */
const PAGE_SIZE = 5000;
/** 50,000 entries. The browser shows what it read; a folder delete refuses past it. */
const MAX_LIST_PAGES = 10;
const VENDOR = "Azure Blob Storage";

interface ListedBlob {
  name: string;
  size: number;
  lastModified: string;
  contentType: string;
}

interface EnumerationPage {
  /** `Container` names at the account root, or `BlobPrefix` names in a container. */
  folders: string[];
  blobs: ListedBlob[];
}

interface ParsedPage extends EnumerationPage {
  nextMarker: string;
}

/**
 * Splits a browser key into its container and the blob path inside it. Keys are
 * `container/path/in/container`, so the account root lists containers.
 */
function splitKey(key: string): { container: string; rest: string } {
  const slash = key.indexOf("/");
  return slash < 0
    ? { container: key, rest: "" }
    : { container: key.slice(0, slash), rest: key.slice(slash + 1) };
}

/**
 * The URL of the one blob a key names, each segment percent-encoded: a `#` or
 * `?` left raw would name a different blob. A key that names no container or no
 * blob is refused rather than guessed at.
 */
function blobUrl(bucket: string, key: string): string {
  const { container, rest } = splitKey(key);
  if (!container || !rest) {
    throw new Error(`${VENDOR}: "${key}" does not name a blob inside a container`);
  }
  const path = [container, ...rest.split("/")].map(encodeURIComponent).join("/");
  return `https://${bucket}.blob.core.windows.net/${path}`;
}

export async function listStorageObjects(
  ctx: StorageContext,
  bucket: string,
  prefix: string,
): Promise<StorageObject[]> {
  if (!prefix) {
    const { folders } = await enumerate(ctx, bucket, "", { partial: true });
    return folders.map((name) => ({
      key: `${name}/`,
      name,
      size: 0,
      lastModified: "",
      isDirectory: true,
    }));
  }
  const { container, rest } = splitKey(prefix);
  const page = await enumerate(ctx, bucket, container, {
    prefix: rest,
    delimiter: "/",
    partial: true,
  });
  return [
    ...page.folders.map((name) => ({
      key: `${container}/${name}`,
      name: name.slice(rest.length).replace(/\/$/, ""),
      size: 0,
      lastModified: "",
      isDirectory: true,
    })),
    ...page.blobs.map((blob) => ({
      key: `${container}/${blob.name}`,
      name: blob.name.slice(rest.length),
      size: blob.size,
      lastModified: blob.lastModified,
      isDirectory: false,
      contentType: blob.contentType,
    })),
  ];
}

/**
 * Every page of List Containers (no `container`) or List Blobs, up to
 * `MAX_LIST_PAGES`. Past it this throws, unless `partial` (the storage browser,
 * which shows a folder's first pages).
 */
async function enumerate(
  ctx: StorageContext,
  bucket: string,
  container: string,
  opts: { prefix?: string; delimiter?: string; partial?: boolean },
): Promise<EnumerationPage> {
  const place: ListPlace = {
    vendor: VENDOR,
    path: container ? `/${container}` : "/",
  };
  const out: EnumerationPage = { folders: [], blobs: [] };
  let marker = "";
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params = new URLSearchParams(container ? { restype: "container" } : {});
    params.set("comp", "list");
    if (opts.prefix) params.set("prefix", opts.prefix);
    if (opts.delimiter) params.set("delimiter", opts.delimiter);
    params.set("maxresults", String(PAGE_SIZE));
    if (marker) params.set("marker", marker);
    const path = container ? `/${encodeURIComponent(container)}` : "/";
    const xml = await getXml(ctx, `https://${bucket}.blob.core.windows.net${path}?${params}`);
    const parsed = container ? parseBlobPage(xml, place) : parseContainerPage(xml, place);
    out.folders.push(...parsed.folders);
    out.blobs.push(...parsed.blobs);
    marker = parsed.nextMarker;
    if (!marker) return out;
  }
  if (opts.partial) return out;
  throw new ListTruncatedError({
    ...place,
    items: out.folders.length + out.blobs.length,
    maxPages: MAX_LIST_PAGES,
  });
}

async function getXml(ctx: StorageContext, url: string): Promise<string> {
  const tok = await ctx.storageToken();
  // The enumeration response is XML, which crosses the host boundary as text
  // just as happily as JSON: `azureRequest` never assumes a JSON body.
  const res = await azureRequest(ctx.http, url, {
    headers: { Authorization: `Bearer ${tok}`, "x-ms-version": VERSION },
  });
  if (!res.ok) throw new Error(`Azure Blob list failed: ${res.status}`);
  return res.text();
}

// Parsed by hand: the plugin runs in Node on the server and the desktop's main
// process, where there is no DOMParser.

function elements(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  for (const m of xml.matchAll(re)) out.push(m[1] ?? "");
  return out;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

function childText(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeXml(m[1] ?? "") : "";
}

/**
 * A `Name`, percent-decoded when it carries `Encoded="true"`, which List Blobs
 * uses for a name holding characters XML cannot carry.
 */
function nameOf(xml: string): string {
  const m = /<Name(\s[^>]*)?>([\s\S]*?)<\/Name>/.exec(xml);
  if (!m) return "";
  const text = decodeXml(m[2] ?? "");
  return /\bEncoded\s*=\s*"true"/.test(m[1] ?? "") ? decodeURIComponent(text) : text;
}

function isEnumeration(xml: string): boolean {
  return /<EnumerationResults[\s>]/.test(xml);
}

function nextMarkerOf(xml: string): string {
  return childText(xml, "NextMarker");
}

function parseContainerPage(xml: string, place: ListPlace): ParsedPage {
  const rows = isEnumeration(xml) ? elements(xml, "Container") : undefined;
  const folders = requireListPage(rows, { ...place, key: "Containers" })
    .map(nameOf)
    .filter(Boolean);
  return { folders, blobs: [], nextMarker: nextMarkerOf(xml) };
}

function parseBlobPage(xml: string, place: ListPlace): ParsedPage {
  const blobRows = isEnumeration(xml) ? elements(xml, "Blob") : undefined;
  const blobs = requireListPage(blobRows, { ...place, key: "Blobs" })
    .map((row) => ({
      name: nameOf(row),
      size: Number(childText(row, "Content-Length") || "0"),
      lastModified: childText(row, "Last-Modified"),
      contentType: childText(row, "Content-Type"),
    }))
    .filter((blob) => blob.name);
  const folders = elements(xml, "BlobPrefix").map(nameOf).filter(Boolean);
  return { folders, blobs, nextMarker: nextMarkerOf(xml) };
}

export async function uploadStorageObject(
  ctx: StorageContext,
  bucket: string,
  key: string,
  file: File,
): Promise<void> {
  const url = blobUrl(bucket, key);
  const tok = await ctx.storageToken();
  // Bytes, not a stream: `File.arrayBuffer()` already buffers the whole blob
  // in memory, so handing the host a Uint8Array costs one more copy and no
  // additional peak, and it is the only body shape the host accepts.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const res = await azureRequest(ctx.http, url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": VERSION,
      "x-ms-blob-type": "BlockBlob",
      "Content-Type": file.type || "application/octet-stream",
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Azure Blob upload failed: ${res.status}`);
}

export async function makeStorageFolder(
  ctx: StorageContext,
  bucket: string,
  key: string,
): Promise<void> {
  // Azure doesn't have real folders: upload a zero-byte blob with trailing /
  const url = blobUrl(bucket, key);
  const tok = await ctx.storageToken();
  const res = await azureRequest(ctx.http, url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": VERSION,
      "x-ms-blob-type": "BlockBlob",
    },
    body: new Uint8Array(0),
  });
  if (!res.ok) throw new Error(`Azure Blob mkdir failed: ${res.status}`);
}

export async function deleteStorageObject(
  ctx: StorageContext,
  bucket: string,
  key: string,
): Promise<void> {
  if (key.endsWith("/")) return deleteFolder(ctx, bucket, key);
  return deleteBlob(ctx, bucket, key);
}

async function deleteBlob(ctx: StorageContext, bucket: string, key: string): Promise<void> {
  const url = blobUrl(bucket, key);
  const tok = await ctx.storageToken();
  const res = await azureRequest(ctx.http, url, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${tok}`,
      "x-ms-version": VERSION,
    },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Azure Blob delete failed: ${res.status}`);
  }
}

/**
 * Deletes every blob under a folder. It lists the whole prefix with no delimiter
 * first, so nested folders come with it and a list past the cap deletes nothing,
 * then lists again, rather than report a folder gone that is not.
 */
async function deleteFolder(ctx: StorageContext, bucket: string, key: string): Promise<void> {
  const { container, rest } = splitKey(key);
  if (!container) throw new Error(`${VENDOR}: no container was named to delete from`);
  const { blobs } = await enumerate(ctx, bucket, container, { prefix: rest });
  // Deepest first: an account with a hierarchical namespace lists its directories
  // as blobs too, and will not delete one that still holds anything.
  const names = blobs.map((blob) => blob.name).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  for (const name of names) await deleteBlob(ctx, bucket, `${container}/${name}`);
  const left = await enumerate(ctx, bucket, container, { prefix: rest, partial: true });
  if (left.blobs.length > 0) {
    throw new Error(
      `${VENDOR}: ${key} still holds ${left.blobs.length} blobs after the delete, such as ${container}/${left.blobs[0]!.name}`,
    );
  }
}
