// Downloads: the files jobs keep with `downloads:`, served from the runners'
// R2 bucket straight to the browser, and swept once they expire.
//
// The runners write each file as one object,
// `artifacts/<owner>/<repo-id>/<run>/<expires>-<id>`, and list it in the
// run's report (`ci-runner/README.md`, "Downloads"). Nothing here is public:
// a download URL carries an HMAC that the app (`server-core/src/ci/
// downloads.ts`, after checking the user may read the run) makes with the
// same `ARTIFACT_SIGNING_KEY`, over the owner, repository, run, object, file
// name and the link's expiry. So a link names exactly one file, for minutes,
// and nothing passes through the runners or the app's servers.
//
// The signature's message is the lines
//   iwci-download-v1, owner, repo-id, run, object, name, expires
// joined with "\n", signed with HMAC-SHA-256 under the key's UTF-8 bytes and
// written as unpadded base64url. `__tests__/artifacts.test.ts` and
// server-core's `downloads.test.ts` share a vector, so the two cannot drift.

import { isId } from "./identity";

/** Where the runners keep downloads in the bucket. */
export const PREFIX = "artifacts/";
/** The longest a link may be signed for, whatever the signer asks. */
export const MAX_LINK_SECS = 24 * 60 * 60;
/** Objects listed per page, and pages read per tick, when sweeping. */
const SWEEP_PAGE = 1000;
const SWEEP_PAGES_PER_TICK = 3;
/** A sweep that reached the end of the bucket starts again this much later. */
export const SWEEP_EVERY_SECS = 60 * 60;

/** The part of an R2 object the proxy reads. */
export interface ArtifactObject {
  key: string;
  size: number;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  range?: { offset?: number; length?: number; suffix?: number };
}

export interface ArtifactBody extends ArtifactObject {
  body: ReadableStream;
}

export type ArtifactRange = { offset: number; length?: number } | { suffix: number };

/** The R2 binding, as much of it as downloads use; tests give a fake. */
export interface ArtifactBucket {
  get(key: string, options?: { range?: ArtifactRange }): Promise<ArtifactBody | null>;
  head(key: string): Promise<ArtifactObject | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<void>;
}

/** Where a sweep has got to, kept in D1 between ticks. */
export interface SweepState {
  read(): Promise<{ cursor: string | null; finishedAt: number | null }>;
  write(cursor: string | null, finishedAt: number | null): Promise<void>;
}

export interface Downloads {
  bucket: ArtifactBucket;
  /** ARTIFACT_SIGNING_KEY; without it no link is accepted. */
  key: string | null;
  sweep: SweepState;
}

/** The fields a download link signs. */
export interface DownloadLink {
  owner: string;
  repoId: string;
  run: string;
  object: string;
  /** The file's name, for `Content-Disposition`. */
  name: string;
  /** Unix seconds after which the link is refused. */
  expires: number;
}

function base64url(bytes: ArrayBuffer): string {
  let text = "";
  for (const b of new Uint8Array(bytes)) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

function message(link: DownloadLink): Uint8Array {
  return new TextEncoder().encode(
    [
      "iwci-download-v1",
      link.owner,
      link.repoId,
      link.run,
      link.object,
      link.name,
      String(link.expires),
    ].join("\n"),
  );
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** The link's signature (what server-core's `signDownload` makes). */
export async function signDownload(secret: string, link: DownloadLink): Promise<string> {
  return base64url(await crypto.subtle.sign("HMAC", await hmacKey(secret), message(link)));
}

async function verify(secret: string, link: DownloadLink, signature: string): Promise<boolean> {
  const given = fromBase64url(signature);
  if (given === null || given.length !== 32) return false;
  // `verify` compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(secret), given, message(link));
}

/** The expiry a download's object name carries, or `null` for one that is not. */
export function objectExpiry(object: string): number | null {
  const match = /^(\d{1,12})-[0-9a-f]{32}$/.exec(object);
  return match ? Number(match[1]) : null;
}

function plain(status: number, text: string): Response {
  return new Response(JSON.stringify({ error: text }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** `attachment`, with an ASCII fallback name and the real one (RFC 6266). */
export function disposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** One `bytes=` range, or `null` for none or for several (served whole). */
export function parseRange(header: string | null): ArtifactRange | null | "invalid" {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from = "", to = ""] = match;
  if (from === "" && to === "") return "invalid";
  if (from === "") return { suffix: Number(to) };
  const offset = Number(from);
  if (to === "") return { offset };
  const end = Number(to);
  if (end < offset) return "invalid";
  return { offset, length: end - offset + 1 };
}

/**
 * `GET` or `HEAD /v1/artifacts/{owner}/{repo-id}/{run}/{object}?n=&e=&s=`:
 * the file, streamed from R2, when the signature holds and neither the link
 * nor the file has expired. `parts` are the path's segments after `v1`.
 */
export async function serveDownload(
  request: Request,
  url: URL,
  parts: string[],
  downloads: Downloads | undefined,
  now: number,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return plain(405, "downloads are read with GET");
  }
  if (!downloads?.key) return plain(503, "downloads are not configured on this proxy");
  const [owner = "", repoId = "", run = "", object = "", ...extra] = parts;
  const name = url.searchParams.get("n") ?? "";
  const expiresText = url.searchParams.get("e") ?? "";
  const signature = url.searchParams.get("s") ?? "";
  if (
    extra.length > 0 ||
    ![owner, repoId, run, object].every(isId) ||
    !/^\d{1,12}$/.test(expiresText) ||
    name.length === 0 ||
    name.length > 255 ||
    /[\x00-\x1f\x7f/\\]/.test(name)
  ) {
    return plain(400, "not a download link");
  }
  const link: DownloadLink = { owner, repoId, run, object, name, expires: Number(expiresText) };
  if (!(await verify(downloads.key, link, signature))) {
    return plain(403, "this download link is not valid");
  }
  if (link.expires <= now) {
    return plain(410, "this download link has expired; open the run again for a new one");
  }
  if (link.expires > now + MAX_LINK_SECS) return plain(403, "this download link is not valid");
  const fileExpires = objectExpiry(object);
  if (fileExpires === null) return plain(404, "no such download");
  if (fileExpires <= now) return plain(410, "this download has expired and been deleted");

  const key = `${PREFIX}${owner}/${repoId}/${run}/${object}`;
  const headers = new Headers({
    "Content-Disposition": disposition(name),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
  });
  const describe = (o: ArtifactObject) => {
    headers.set("Content-Type", o.httpMetadata?.contentType ?? "application/octet-stream");
    headers.set("ETag", o.httpEtag);
  };

  if (request.method === "HEAD") {
    const head = await downloads.bucket.head(key);
    if (!head) return plain(404, "no such download");
    describe(head);
    headers.set("Content-Length", String(head.size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRange(request.headers.get("Range"));
  if (range === "invalid") return plain(416, "the range is not satisfiable");
  let found: ArtifactBody | null;
  try {
    found = await downloads.bucket.get(key, range ? { range } : undefined);
  } catch {
    // R2 refuses a range that starts past the end.
    return plain(416, "the range is not satisfiable");
  }
  if (!found) return plain(404, "no such download");
  describe(found);
  if (range && found.range) {
    const size = found.size;
    const offset =
      "suffix" in range ? Math.max(0, size - range.suffix) : (found.range.offset ?? range.offset);
    const length = Math.min(
      found.range.length ?? ("suffix" in range ? range.suffix : size - offset),
      size - offset,
    );
    if (length <= 0) return plain(416, "the range is not satisfiable");
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${size}`);
    headers.set("Content-Length", String(length));
    return new Response(found.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(found.size));
  return new Response(found.body, { status: 200, headers });
}

export interface SweepResult {
  scanned: number;
  deleted: number;
  /** Where the next tick goes on from, or `null` when this pass ended. */
  cursor: string | null;
  skipped?: true;
}

/**
 * Deletes downloads past their expiry: a few pages of the bucket's
 * `artifacts/` per tick, carrying on from where the last tick stopped, and
 * once a pass reaches the end, not again for an hour. The expiry is in each
 * key, so a listing is all it reads. The proxy does this rather than the
 * runners for the reason it fires schedules: a Cron Trigger runs once for
 * the whole pool, where every runner would sweep the same keys.
 */
export async function sweepDownloads(downloads: Downloads, now: number): Promise<SweepResult> {
  const state = await downloads.sweep.read();
  if (
    state.cursor === null &&
    state.finishedAt !== null &&
    now < state.finishedAt + SWEEP_EVERY_SECS
  ) {
    return { scanned: 0, deleted: 0, cursor: null, skipped: true };
  }
  let cursor = state.cursor ?? undefined;
  let scanned = 0;
  let deleted = 0;
  for (let page = 0; page < SWEEP_PAGES_PER_TICK; page++) {
    const listed = await downloads.bucket.list({
      prefix: PREFIX,
      limit: SWEEP_PAGE,
      ...(cursor === undefined ? {} : { cursor }),
    });
    scanned += listed.objects.length;
    const expired = listed.objects
      .map((o) => o.key)
      .filter((key) => {
        const expires = objectExpiry(key.slice(key.lastIndexOf("/") + 1));
        return expires !== null && expires <= now;
      });
    if (expired.length > 0) {
      await downloads.bucket.delete(expired);
      deleted += expired.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
    if (cursor === undefined) break;
  }
  await downloads.sweep.write(cursor ?? null, cursor === undefined ? now : state.finishedAt);
  return { scanned, deleted, cursor: cursor ?? null };
}

/** The sweep's place in D1 (`migrations/0004_download_sweep.sql`). */
export class D1SweepState implements SweepState {
  constructor(private readonly db: import("@cloudflare/workers-types/index").D1Database) {}

  async read(): Promise<{ cursor: string | null; finishedAt: number | null }> {
    const row = await this.db
      .prepare("SELECT cursor, finished_at FROM download_sweep WHERE id = 1")
      .first<{ cursor: string | null; finished_at: number | null }>();
    return { cursor: row?.cursor ?? null, finishedAt: row?.finished_at ?? null };
  }

  async write(cursor: string | null, finishedAt: number | null): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO download_sweep (id, cursor, finished_at) VALUES (1, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor, finished_at = excluded.finished_at",
      )
      .bind(cursor, finishedAt)
      .run();
  }
}

export class MemorySweepState implements SweepState {
  cursor: string | null = null;
  finishedAt: number | null = null;

  async read(): Promise<{ cursor: string | null; finishedAt: number | null }> {
    return { cursor: this.cursor, finishedAt: this.finishedAt };
  }

  async write(cursor: string | null, finishedAt: number | null): Promise<void> {
    this.cursor = cursor;
    this.finishedAt = finishedAt;
  }
}
