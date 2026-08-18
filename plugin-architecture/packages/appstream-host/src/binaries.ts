/**
 * Where the `iwappd` binaries come from: the newest published build, fetched
 * at runtime and cached, with an optional bundled archive behind it.
 *
 * Both apps used to source the binaries differently — the web server fetched
 * from the asset downloader at runtime (its pruned image cannot contain
 * `linux-appserver/` at all), while the desktop served the `iwappd.tar.xz`
 * frozen into the package it was installed from. The desktop route meant every
 * compositor fix waited on a desktop release *and* every user updating: a fix
 * could be merged, published, and live on the web while every desktop install
 * kept staging the old build indefinitely. So both apps now share this source:
 * read the `latest` pointer, download the archive it names, cache the gzipped
 * binaries in memory, and — where a bundled archive exists — fall back to it
 * when the downloader cannot be reached, so a laptop with no route to our
 * storage still works exactly as before.
 *
 * The pointer is what makes the cache cheap: an unchanged build costs one
 * small request per TTL rather than re-downloading and re-compressing
 * megabytes, and a refresh that fails serves the previous entry rather than
 * failing a session. Serving a newer compositor than the client shipped with
 * is safe by design — the two ends negotiate the protocol on hello, exactly as
 * they already had to for the web server, whose deploys and binary publishes
 * were never in lockstep either.
 */

import path from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants, gzip } from "node:zlib";
// `xz-decompress` is CJS with no ESM entry, and Node's cjs-module-lexer cannot
// see the class through its UMD wrapper — a named import breaks under real
// ESM. Take the default and destructure, as both apps always had to.
import xzDecompressModule from "xz-decompress";
import { Parser, type ReadEntry } from "tar";

const { XzReadableStream } = xzDecompressModule;

const gzipAsync = promisify(gzip);

const X86_64_BINARY = "iwappd-x86_64-unknown-linux-musl";
const ARM64_BINARY = "iwappd-aarch64-unknown-linux-musl";

/**
 * Same origin `app/packages/desktop/scripts/ensure-iwappd.mjs` downloads from.
 * `/<hash>` serves that build's `iwappd.tar.xz`; `/latest` serves the pointer
 * written by the `rust-latest` job in `.github/workflows/desktop-build.yml`.
 */
const DOWNLOADER_ORIGIN = "https://iwappd-hash-asset-downloader.infrawrench.com";

/**
 * How long a resolved set of binaries is served before the pointer is checked
 * again. A publish of new binaries reaches every consumer within this window
 * without a restart, and the cost of the window is that a session started in
 * the first minutes after a release may get the previous build — which is
 * fine, because the archive is versioned by content and the compositor
 * negotiates its protocol version with the client anyway.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * How long the pointer read may take before the bundled archive wins. Only the
 * pointer is bounded: it is one tiny request, so on a network where it cannot
 * complete in this time the download would not have finished either, and a
 * desktop on a flaky or captive network must not hang a session open on it.
 * Once the pointer answers, the archive download runs to completion.
 */
const POINTER_TIMEOUT_MS = 15 * 1000;

export interface IwappdBinarySource {
  /** The x86_64 binary, gzipped for the SSH upload. */
  getx86_64GzBinary(): Promise<Buffer>;
  /** The arm64 binary, gzipped for the SSH upload. */
  getArm64GzBinary(): Promise<Buffer>;
}

export interface IwappdBinarySourceOptions {
  /**
   * The raw `iwappd.tar.xz` to fall back on when the downloader cannot be
   * reached and nothing is cached yet — the desktop's bundled archive. Without
   * it, an unreachable downloader on a cold start is an error, which is the
   * web server's situation: it has no archive of its own to offer.
   */
  bundledArchive?: () => Promise<Buffer>;
}

interface CachedBinaries {
  /**
   * The `linux-appserver/` hash these were built from, or null when they came
   * from the bundled archive — null never equals a pointer read, so the first
   * successful refresh after a fallback always downloads the published build.
   */
  hash: string | null;
  x86_64: Buffer;
  arm64: Buffer;
  /** `Date.now()` when the pointer was last confirmed current (or last failed). */
  checkedAt: number;
}

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
 * build of liblzma rather than a native addon, so no consumer needs a compiler,
 * a per-architecture build, or a `.node` to unpack from an asar.
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

async function fetchOrThrow(url: string, what: string, timeoutMs?: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(
      url,
      timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : undefined,
    );
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
  const res = await fetchOrThrow(
    `${DOWNLOADER_ORIGIN}/latest`,
    "the iwappd latest pointer",
    POINTER_TIMEOUT_MS,
  );
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

/** Splits a raw `iwappd.tar.xz` into the two gzipped binaries. */
async function splitArchive(
  archive: Buffer,
  what: string,
): Promise<Pick<CachedBinaries, "x86_64" | "arm64">> {
  const decomp = await xzDecompress(archive);
  const members = await readTarMembers(decomp, [X86_64_BINARY, ARM64_BINARY]);
  const x86_64 = members.get(X86_64_BINARY);
  const arm64 = members.get(ARM64_BINARY);
  if (!x86_64 || !arm64) {
    throw new Error(`${what} is missing ${!x86_64 ? X86_64_BINARY : ARM64_BINARY}`);
  }
  const [x86_64Gz, arm64Gz] = await Promise.all([
    recompressBufferAsGz(x86_64),
    recompressBufferAsGz(arm64),
  ]);
  return { x86_64: x86_64Gz, arm64: arm64Gz };
}

async function fetchBinaries(hash: string): Promise<Pick<CachedBinaries, "x86_64" | "arm64">> {
  const url = `${DOWNLOADER_ORIGIN}/${hash}`;
  const res = await fetchOrThrow(url, "the iwappd archive");
  return splitArchive(Buffer.from(await res.arrayBuffer()), url);
}

/** One shared runtime-refreshing source of iwappd binaries. */
export function createIwappdBinarySource(
  options: IwappdBinarySourceOptions = {},
): IwappdBinarySource {
  let cached: CachedBinaries | undefined;
  /**
   * De-duplicates concurrent refreshes. Without it, N simultaneous sessions on
   * a cold start each download and re-compress the same archive.
   */
  let inflight: Promise<CachedBinaries> | undefined;

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

  async function fallback(previous: CachedBinaries | undefined, error: unknown) {
    // Serving a previous build beats failing a session because the downloader
    // had a bad minute; the entry is stale but it is a real iwappd. Behind
    // that, the bundled archive covers the cold start with no network at all.
    // Either way the clock restarts, so an outage costs one failed request per
    // TTL rather than one per session.
    if (previous) {
      console.error("Refreshing the iwappd binaries failed; serving the cached build", error);
      previous.checkedAt = Date.now();
      return previous;
    }
    if (options.bundledArchive) {
      console.error("Fetching the iwappd binaries failed; serving the bundled build", error);
      const archive = await options.bundledArchive();
      const binaries = await splitArchive(archive, "the bundled iwappd.tar.xz");
      return { hash: null, ...binaries, checkedAt: Date.now() };
    }
    throw error;
  }

  function getBinaries(): Promise<CachedBinaries> {
    const previous = cached;
    if (previous && Date.now() - previous.checkedAt < CACHE_TTL_MS)
      return Promise.resolve(previous);

    inflight ??= refresh(previous)
      .catch((error: unknown) => fallback(previous, error))
      .then((next) => {
        cached = next;
        return next;
      })
      .finally(() => {
        inflight = undefined;
      });

    return inflight;
  }

  return {
    getx86_64GzBinary: () => getBinaries().then((b) => b.x86_64),
    getArm64GzBinary: () => getBinaries().then((b) => b.arm64),
  };
}
