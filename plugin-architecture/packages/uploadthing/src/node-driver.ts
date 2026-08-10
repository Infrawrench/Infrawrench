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
 *
 * When the host passes `options.http` (bastion-bound cloud accounts), both the
 * grant call and the byte fetch go through that bridge so they stay on the
 * allowlisted tunnel. Without it we fall back to direct `fetch`, which is what
 * desktop uses today (no bastion surface yet).
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { HttpHostServices, StorageNodeDriver } from "@infrawrench/plugin-base";

const API_BASE = "https://api.uploadthing.com";

/** Bound outbound UploadThing fetches so a hung host cannot wedge the process. */
const FETCH_TIMEOUT_MS = 60_000;

/** `POST /v6/requestFileAccess` — presigned GET URL for a single file key. */
async function requestFileUrl(
  key: string,
  apiKey: string,
  http?: HttpHostServices,
): Promise<string> {
  const headers = {
    "Content-Type": "application/json",
    "x-uploadthing-api-key": apiKey,
  };
  const body = JSON.stringify({ fileKey: key });

  let parsed: { ufsUrl?: string; url?: string };
  if (http) {
    const result = await http.request({
      url: `${API_BASE}/v6/requestFileAccess`,
      method: "POST",
      headers,
      body,
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `UploadThing API error ${result.status} for /v6/requestFileAccess: ${result.body}`,
      );
    }
    parsed = JSON.parse(result.body) as { ufsUrl?: string; url?: string };
  } else {
    const res = await fetch(`${API_BASE}/v6/requestFileAccess`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(
        `UploadThing API error ${res.status} for /v6/requestFileAccess: ${await res.text()}`,
      );
    }
    parsed = (await res.json()) as { ufsUrl?: string; url?: string };
  }

  // `ufsUrl` is the current app-subdomain form; `url` is the deprecated
  // utfs.io one, kept only as a fallback for apps still served from it.
  const href = parsed.ufsUrl || parsed.url;
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
  options?: { http?: HttpHostServices },
): Promise<void> {
  const http = options?.http;
  const href = await requestFileUrl(key, accessToken, http);

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    if (http) {
      // Host HTTP returns buffered bytes (UTF-8 would corrupt the file). The
      // grant + GET both stay on the bastion allowlist this way.
      const result = await http.request({
        url: href,
        method: "GET",
        headers: {},
        responseEncoding: "binary",
      });
      if (result.status < 200 || result.status >= 300 || !result.rawBody) {
        throw new Error(`UploadThing download failed for "${key}": HTTP ${result.status}`);
      }
      await fs.promises.writeFile(destPath, result.rawBody);
      return;
    }

    // Plain `fetch` rather than `https.get`: presigned UploadThing URLs redirect
    // to the backing store, and fetch follows that for us.
    const res = await fetch(href, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok || !res.body) {
      throw new Error(`UploadThing download failed for "${key}": HTTP ${res.status}`);
    }
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
