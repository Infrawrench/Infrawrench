/**
 * UploadThing Node.js-side driver — runs in the Electron main process and in
 * the web server. Owns all UploadThing-specific download logic so the host
 * stays provider-agnostic.
 *
 * Unlike GCS, there is no bearer token that reads many objects: the only read
 * grant UploadThing issues is `POST /v6/requestFileAccess`, which mints a
 * presigned URL for **one** file. So the `accessToken` the host threads
 * through here is the app's API key (see `getStorageAccessToken`), and the
 * driver spends it on a per-file grant before fetching bytes.
 *
 * Going through `requestFileAccess` rather than composing the public
 * `https://<appId>.ufs.sh/f/<key>` URL is what makes private files work:
 * the public form 403s for anything whose ACL is not `public-read`, and an
 * app's default ACL can be either.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StorageNodeDriver } from "@infrawrench/plugin-base";

const API_BASE = "https://api.uploadthing.com";

/** `POST /v6/requestFileAccess` — presigned GET URL for a single file key. */
async function requestFileUrl(key: string, apiKey: string): Promise<string> {
  const res = await fetch(`${API_BASE}/v6/requestFileAccess`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-uploadthing-api-key": apiKey,
    },
    body: JSON.stringify({ fileKey: key }),
  });
  if (!res.ok) {
    throw new Error(
      `UploadThing API error ${res.status} for /v6/requestFileAccess: ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { ufsUrl?: string; url?: string };
  // `ufsUrl` is the current app-subdomain form; `url` is the deprecated
  // utfs.io one, kept only as a fallback for apps still served from it.
  const href = body.ufsUrl || body.url;
  if (!href) throw new Error(`UploadThing returned no download URL for file "${key}"`);
  return href;
}

/**
 * `bucket` is the app id. It is unused: an API key is app-scoped, so
 * `requestFileAccess` already resolves within the right app and there is
 * nothing to disambiguate.
 */
async function downloadFile(
  _bucket: string,
  key: string,
  accessToken: string,
  destPath: string,
): Promise<void> {
  const href = await requestFileUrl(key, accessToken);

  // Plain `fetch` rather than `https.get`: presigned UploadThing URLs redirect
  // to the backing store, and fetch follows that for us.
  const res = await fetch(href);
  if (!res.ok || !res.body) {
    throw new Error(`UploadThing download failed for "${key}": HTTP ${res.status}`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    // Node's Readable.fromWeb wants its own ReadableStream type; the global
    // one here is the DOM declaration. Same object at runtime.
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      fs.createWriteStream(destPath),
    );
  } catch (err) {
    // Never leave a truncated file behind pretending to be the real download.
    await fs.promises.unlink(destPath).catch(() => {});
    throw err;
  }
}

export const nodeDriver = {
  pluginId: "uploadthing",
  downloadFile,
} satisfies StorageNodeDriver;
