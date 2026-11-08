/**
 * The built SPA (`dist/client`), as `server.ts` serves it in production for
 * every path that is not the API's (`isApiPath`, the same split the edge
 * Worker makes):
 *
 * 1. a file under the root answers with it, a directory with its
 *    `index.html`: `Content-Type` by extension, `Content-Length`,
 *    `Last-Modified`, and a single byte range when one is asked for (no
 *    `ETag`; none was ever sent);
 * 2. a hashed asset (`/assets/...`) is cached for a year, `immutable`, since
 *    its name changes with its bytes; a missing one answers 404 `no-store`, never the
 *    SPA shell: during a rolling deploy an old pod can be asked for a new
 *    bundle, and a 200 `text/html` under a `.js` URL is cached by extension at
 *    the CDN for hours, breaking the app for everyone; `no-store` keeps the
 *    miss out of the cache so the browser recovers on the next load;
 * 3. anything else answers with the SPA shell, `index.html`.
 *
 * Every answer carries the security headers. Apart from the hashed assets'
 * cache header, this is byte for byte what the production Hono app
 * (`serveStatic` from `@hono/node-server`) sent, method handling included:
 * HEAD and OPTIONS get the headers and no body, any other method the file.
 */
import { createReadStream, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { HASHED_ASSET_CACHE_CONTROL, setSecurityHeaders } from "../api/security-headers";

/** Content types by extension; anything else is `application/octet-stream`. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  aac: "audio/aac",
  avif: "image/avif",
  bin: "application/octet-stream",
  bmp: "image/bmp",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  eot: "application/vnd.ms-fontobject",
  gif: "image/gif",
  gz: "application/gzip",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  ics: "text/calendar; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  jsonld: "application/ld+json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml; charset=utf-8",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webm: "video/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml; charset=utf-8",
  zip: "application/zip",
};

export function contentTypeFor(path: string): string {
  const extension = /\.([a-zA-Z0-9]+?)$/.exec(path)?.[1]?.toLowerCase();
  return (extension && CONTENT_TYPES[extension]) || "application/octet-stream";
}

/** `decodeURI`, decoding what it can of a path with a malformed escape. */
function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURI(match);
      } catch {
        return match;
      }
    });
  }
}

/** A `.` or `..` segment, a doubled separator or a backslash: never a file of ours. */
const UNSAFE_PATH = /(?:^|[/\\])\.{1,2}(?:$|[/\\])|[/\\]{2,}|\\/;

function stat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** The file to serve for `pathname` under `root`, or undefined when there is none. */
function resolveFile(root: string, pathname: string): { path: string; stats: Stats } | undefined {
  const decoded = decodePath(pathname);
  if (UNSAFE_PATH.test(decoded)) return undefined;
  let path = join(root, decoded);
  let stats = stat(path);
  if (stats?.isDirectory()) {
    path = join(path, "index.html");
    stats = stat(path);
  }
  return stats ? { path, stats } : undefined;
}

type ByteRange = { start: number; end: number };

/** A `Range` header's single range within `size`, or undefined when it cannot be satisfied. */
function byteRange(header: string, size: number): ByteRange | undefined {
  const match = /^(?:bytes=)?(?!-$)(\d*)-(\d*)$/.exec(header);
  const start = match?.[1] ?? "";
  const end = match?.[2] ?? "";
  if (size === 0) return undefined;
  // A header that does not parse reads as the whole file from byte 0.
  if (!match || (start !== "" && end === "")) {
    const from = match ? Number(start) : 0;
    return from < size ? { start: from, end: size - 1 } : undefined;
  }
  if (start === "") {
    const length = Number(end);
    return length === 0 ? undefined : { start: Math.max(size - length, 0), end: size - 1 };
  }
  const first = Number(start);
  const last = Math.min(Number(end), size - 1);
  return first < size && first <= last ? { start: first, end: last } : undefined;
}

function fileResponse(request: Request, path: string, stats: Stats, hashed = false): Response {
  const headers = new Headers({
    "content-type": contentTypeFor(path),
    "last-modified": stats.mtime.toUTCString(),
  });
  if (hashed) headers.set("cache-control", HASHED_ASSET_CACHE_CONTROL);
  setSecurityHeaders(headers);
  const size = stats.size;
  if (request.method === "HEAD" || request.method === "OPTIONS") {
    headers.set("content-length", String(size));
    return new Response(null, { status: 200, headers });
  }
  const range = request.headers.get("range");
  if (!range) {
    headers.set("content-length", String(size));
    return new Response(stream(path), { status: 200, headers });
  }
  headers.set("accept-ranges", "bytes");
  const resolved = byteRange(range, size);
  if (!resolved) {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set("content-length", String(resolved.end - resolved.start + 1));
  headers.set("content-range", `bytes ${resolved.start}-${resolved.end}/${size}`);
  return new Response(stream(path, resolved), { status: 206, headers });
}

/** The file (or one range of it) as a web stream, read as the client takes it. */
function stream(path: string, range?: ByteRange): ReadableStream<Uint8Array> {
  const file = createReadStream(path, range);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      file.on("data", (chunk) => {
        controller.enqueue(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        if ((controller.desiredSize ?? 0) <= 0) file.pause();
      });
      file.once("end", () => controller.close());
      file.once("error", (error) => controller.error(error));
    },
    pull() {
      file.resume();
    },
    cancel() {
      file.destroy();
    },
  });
}

function textResponse(body: string, status: number, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=UTF-8", ...extra });
  setSecurityHeaders(headers);
  return new Response(body, { status, headers });
}

/** Serve the SPA under `root` (see the module docstring). */
export function makeStaticClientHandler(root: string): (request: Request) => Promise<Response> {
  return async (request) => {
    const { pathname } = new URL(request.url);
    const hashed = pathname === "/assets" || pathname.startsWith("/assets/");
    // `_headers` is the edge's header config (`workersAssetHeadersFile`),
    // which the Workers asset layer never serves either.
    const file = pathname === "/_headers" ? undefined : resolveFile(root, pathname);
    if (file) return fileResponse(request, file.path, file.stats, hashed);
    if (hashed) {
      return textResponse("Not found", 404, { "cache-control": "no-store" });
    }
    const shell = join(root, "index.html");
    const shellStats = stat(shell);
    if (shellStats) return fileResponse(request, shell, shellStats);
    return textResponse("404 Not Found", 404);
  };
}
