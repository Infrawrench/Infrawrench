/**
 * CI downloads: the files a job keeps with `downloads:`, which the runners
 * store in their R2 bucket and list in the run's report. The browser
 * fetches one straight from the CI proxy (`ci-proxy/src/artifacts.ts`) with
 * a link signed here, after the caller's access to the run is checked, so a
 * download never passes through this server or the runners.
 *
 * The signature is HMAC-SHA-256, under `CI_ARTIFACT_SIGNING_KEY` (the
 * proxy's `ARTIFACT_SIGNING_KEY`), over the lines
 * `iwci-download-v1, owner, repo-id, run, object, name, expires`, as
 * unpadded base64url; a test vector here and in the proxy keeps the two in
 * step.
 */
import { createHmac } from "node:crypto";
import type { CiDownload, CiDownloadLink } from "@infrawrench/client-core";

/** Why a link cannot be made: no such file (404), or not set up (409). */
export class DownloadLinkError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "DownloadLinkError";
  }
}

/** How long a link works. The proxy refuses any signed for over a day. */
export const LINK_SECS = 15 * 60;

export interface DownloadLinkFields {
  owner: string;
  repoId: string;
  run: string;
  object: string;
  name: string;
  expires: number;
}

/** What the runner's report says of one download (snake case, as it writes it). */
export interface ProxyDownload {
  path?: string;
  size?: number;
  sha256?: string;
  content_type?: string;
  expires_at?: number;
  key?: string;
  masked?: boolean;
}

export function downloadsConfigured(): boolean {
  return Boolean(process.env["CI_ARTIFACT_SIGNING_KEY"] && process.env["CI_PROXY_URL"]);
}

export function signDownload(secret: string, link: DownloadLinkFields): string {
  return createHmac("sha256", secret)
    .update(
      [
        "iwci-download-v1",
        link.owner,
        link.repoId,
        link.run,
        link.object,
        link.name,
        String(link.expires),
      ].join("\n"),
    )
    .digest("base64url");
}

const ID = /^[A-Za-z0-9._-]{1,128}$/;
const OBJECT = /^(\d{1,12})-[0-9a-f]{32}$/;

/**
 * A report's download as the API shows it, or `null` for one that is not
 * well formed (an older or newer runner writing something else).
 */
export function toDownload(d: ProxyDownload): CiDownload | null {
  if (
    typeof d.path !== "string" ||
    typeof d.size !== "number" ||
    typeof d.expires_at !== "number" ||
    typeof d.key !== "string"
  ) {
    return null;
  }
  return {
    path: d.path,
    size: d.size,
    sha256: typeof d.sha256 === "string" ? d.sha256 : "",
    contentType: typeof d.content_type === "string" ? d.content_type : "application/octet-stream",
    expiresAt: new Date(d.expires_at * 1000).toISOString(),
    masked: d.masked === true,
  };
}

/**
 * The link for one stored download of run `run` (the runner's id, without
 * the proxy's runner prefix), good for {@link LINK_SECS} or until the file
 * expires, whichever is first.
 */
export function downloadLink(
  owner: string,
  repoId: string,
  run: string,
  download: ProxyDownload,
  nowSecs: number = Math.floor(Date.now() / 1000),
): CiDownloadLink {
  const secret = process.env["CI_ARTIFACT_SIGNING_KEY"];
  const base = process.env["CI_PROXY_URL"];
  if (!secret || !base) {
    throw new DownloadLinkError(
      "Downloads are not set up on this server (CI_ARTIFACT_SIGNING_KEY).",
      409,
    );
  }
  const key = download.key ?? "";
  const prefix = `artifacts/${owner}/${repoId}/${run}/`;
  const object = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  const match = OBJECT.exec(object);
  if (!match || ![owner, repoId, run].every((id) => ID.test(id))) {
    throw new DownloadLinkError("That download is not stored where this run keeps its files.", 404);
  }
  const fileExpires = Number(match[1]);
  if (fileExpires <= nowSecs) throw new DownloadLinkError("That download has expired.", 404);
  const path = download.path ?? "";
  // The proxy refuses a name with a path separator or a control character.
  const name =
    (path.split("/").pop() ?? "").replace(/[\x00-\x1f\x7f\\]/g, "_").slice(0, 255) || "download";
  const expires = Math.min(nowSecs + LINK_SECS, fileExpires);
  const fields = { owner, repoId, run, object, name, expires };
  const query = new URLSearchParams({
    n: name,
    e: String(expires),
    s: signDownload(secret, fields),
  });
  return {
    url: `${base.replace(/\/+$/, "")}/v1/artifacts/${owner}/${repoId}/${run}/${object}?${query}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}
