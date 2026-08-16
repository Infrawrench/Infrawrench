/**
 * The Linux app server binaries the web server uploads to a customer's host,
 * mirroring the desktop app's `electron/iwappd-archive.ts`.
 *
 * The two differ only in where the archive comes from. The desktop app ships
 * `iwappd.tar.xz` inside the packaged app, because it has to work on a laptop
 * with no network path to our storage. The web server has no such constraint
 * and, more to the point, cannot get the archive at build time at all: the
 * image is built from `turbo prune @infrawrench/web --docker`, whose pruned
 * tree carries only workspace packages, and `linux-appserver/` is deliberately
 * outside `pnpm-workspace.yaml`. So this fetches the archive at runtime and
 * holds the result in memory.
 *
 * `latest` is a pointer object written by the `rust-tar` job in
 * `.github/workflows/desktop-build.yml`; it holds the hash of the newest build
 * rather than an archive. Reading it first means a refresh that finds nothing
 * new costs one small request instead of re-downloading and re-compressing
 * megabytes.
 */

import { promisify } from "node:util";
import path from "node:path";
import { constants as zlibConstants, gzip } from "node:zlib";
// `xz-decompress` is CJS with no ESM entry, and Node's cjs-module-lexer cannot
// see the class through its UMD wrapper — a named import resolves under the
// esbuild bundle that `pnpm build` produces and throws under `tsx watch` in
// dev. Taking the default and destructuring works in both.
import xzDecompressModule from "xz-decompress";
import { Parser, type ReadEntry } from "tar";

const { XzReadableStream } = xzDecompressModule;

const gzipAsync = promisify(gzip);

const X86_64_BINARY = "iwappd-x86_64-unknown-linux-musl";
const ARM64_BINARY = "iwappd-aarch64-unknown-linux-musl";

/**
 * Same host `app/packages/desktop/scripts/ensure-iwappd.mjs` downloads from.
 * `/<hash>` serves that build's `iwappd.tar.xz`; `/latest` serves the pointer.
 */
const DOWNLOADER_ORIGIN = "https://iwappd-hash-asset-downloader.infrawrench.com";

/**
 * How long a resolved set of binaries is served before the pointer is checked
 * again. A deploy of new binaries reaches every web instance within this
 * window without a restart, and the cost of the window is that a host enrolled
 * in the first minutes after a release may get the previous build — which is
 * fine, because the archive is versioned by content and the compositor
 * negotiates its protocol version with the client anyway.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedBinaries {
  /** The `linux-appserver/` hash these were built from. */
  hash: string;
  x86_64: Buffer;
  arm64: Buffer;
  /** `Date.now()` when the pointer was last confirmed current. */
  checkedAt: number;
}

let cached: CachedBinaries | undefined;
/**
 * De-duplicates concurrent refreshes. Without it, N simultaneous enrolments on
 * a cold instance each download and re-compress the same archive.
 */
let inflight: Promise<CachedBinaries> | undefined;

/**
 * Pulls the named members out of an uncompressed tarball held in memory. The
 * archive is small enough (a couple of megabytes per binary) that buffering is
 * cheaper than staging it on disk.
 */
function readTarMembers(tarball: Buffer, wanted: readonly string[]): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const members = new Map<string, Buffer>();
    const parser = new Parser();

    parser.on("entry", (entry: ReadEntry) => {
      // Members are stored as `./iwappd-<target triple>`, so match the basename.
      const name = path.posix.basename(entry.path);
      if (!wanted.includes(name)) {
        // Unread entries stall the parser, so drain the ones we don't want.
        entry.resume();
        return;
      }
      const chunks: Buffer[] = [];
      entry.on("data", (chunk: Buffer) => chunks.push(chunk));
      entry.on("end", () => members.set(name, Buffer.concat(chunks)));
    });
    parser.on("error", reject);
    parser.on("end", () => resolve(members));

    parser.end(tarball);
  });
}

/**
 * Decompresses an xz stream held in memory. `xz-decompress` is a WebAssembly
 * build of liblzma rather than a native addon, so the service image needs no
 * compiler and no per-architecture build.
 */
async function xzDecompress(compressed: Buffer): Promise<Buffer> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(compressed));
      controller.close();
    },
  });
  const chunks: Buffer[] = [];
  for await (const chunk of new XzReadableStream(source)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function recompressBufferAsGz(binary: Buffer): Promise<Buffer> {
  // The result is held for the life of the cache entry and then pushed over
  // SSH, so trade CPU here for the smallest upload.
  return gzipAsync(binary, { level: zlibConstants.Z_BEST_COMPRESSION });
}

async function fetchOrThrow(url: string, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (cause) {
    throw new Error(`Fetching ${what} from ${url} failed`, { cause });
  }
  if (!res.ok) {
    throw new Error(`Fetching ${what} from ${url} failed with HTTP ${res.status}`);
  }
  return res;
}

/** Reads the pointer object and returns the hash of the newest published build. */
async function fetchLatestHash(): Promise<string> {
  const res = await fetchOrThrow(`${DOWNLOADER_ORIGIN}/latest`, "the iwappd latest pointer");
  const hash = (await res.text()).trim();
  // The pointer is written by CI, but it is still a value off the network
  // deciding the next URL we fetch, so constrain its shape.
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(
      `The iwappd latest pointer is not a sha256 hex digest (got ${JSON.stringify(hash.slice(0, 80))})`,
    );
  }
  return hash;
}

async function fetchBinaries(hash: string): Promise<Pick<CachedBinaries, "x86_64" | "arm64">> {
  const url = `${DOWNLOADER_ORIGIN}/${hash}`;
  const res = await fetchOrThrow(url, "the iwappd archive");
  const decomp = await xzDecompress(Buffer.from(await res.arrayBuffer()));
  const members = await readTarMembers(decomp, [X86_64_BINARY, ARM64_BINARY]);
  const x86_64 = members.get(X86_64_BINARY);
  const arm64 = members.get(ARM64_BINARY);
  if (!x86_64 || !arm64) {
    throw new Error(`${url} is missing ${!x86_64 ? X86_64_BINARY : ARM64_BINARY}`);
  }
  const [x86_64Gz, arm64Gz] = await Promise.all([
    recompressBufferAsGz(x86_64),
    recompressBufferAsGz(arm64),
  ]);
  return { x86_64: x86_64Gz, arm64: arm64Gz };
}

async function refresh(previous: CachedBinaries | undefined): Promise<CachedBinaries> {
  const hash = await fetchLatestHash();
  if (previous && previous.hash === hash) {
    // Still the current build — keep the compressed buffers and just restart
    // the clock.
    previous.checkedAt = Date.now();
    return previous;
  }
  const binaries = await fetchBinaries(hash);
  return { hash, ...binaries, checkedAt: Date.now() };
}

async function getBinaries(): Promise<CachedBinaries> {
  const previous = cached;
  if (previous && Date.now() - previous.checkedAt < CACHE_TTL_MS) return previous;

  inflight ??= refresh(previous)
    .then((next) => {
      cached = next;
      return next;
    })
    .catch((error: unknown) => {
      // Serving the previous build beats failing an enrolment because the
      // downloader had a bad minute; the entry is stale but it is a real
      // iwappd. With nothing cached there is no choice but to fail.
      if (previous) {
        console.error("Refreshing the iwappd binaries failed; serving the cached build", error);
        previous.checkedAt = Date.now();
        return previous;
      }
      throw error;
    })
    .finally(() => {
      inflight = undefined;
    });

  return inflight;
}

/** Gets the x86_64 binary compressed with gunzip. You should send this to the server and decompress there. */
export function getx86_64GzBinary(): Promise<Buffer> {
  return getBinaries().then((b) => b.x86_64);
}

/** Gets the arm64 binary compressed with gunzip. You should send this to the server and decompress there. */
export function getArm64GzBinary(): Promise<Buffer> {
  return getBinaries().then((b) => b.arm64);
}
