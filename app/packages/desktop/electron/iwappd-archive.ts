/**
 * `iwappd.tar.xz` — the Linux app server binaries the desktop app uploads to a
 * customer's host.
 *
 * The archive is produced by `scripts/ensure-iwappd.mjs` (downloaded from R2 when
 * the `linux-appserver/` hash has been built before, compiled in Docker otherwise)
 * and copied into the packaged app by the `extraResources` entry in package.json.
 * It holds one static musl binary per Linux architecture at its root, named
 * `iwappd-<target triple>` — `iwappd-x86_64-unknown-linux-musl` and
 * `iwappd-aarch64-unknown-linux-musl`.
 *
 * It ships on every platform, not just Linux: the host being streamed from is
 * remote, so a macOS or Windows client needs the binaries just as much.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { constants as zlibConstants, gzip } from "node:zlib";
import { app } from "electron";
import { XzReadableStream } from "xz-decompress";
import { Parser, type ReadEntry } from "tar";

const gzipAsync = promisify(gzip);

const X86_64_BINARY = "iwappd-x86_64-unknown-linux-musl";
const ARM64_BINARY = "iwappd-aarch64-unknown-linux-musl";

function iwappdArchivePath(): string {
  // extraResources lands beside the asar rather than inside it, so the packaged
  // path is not app.getAppPath()-relative. In dev, getAppPath() is the package
  // root, which is where ensure-iwappd.mjs writes the archive.
  return app.isPackaged
    ? path.join(process.resourcesPath, "iwappd.tar.xz")
    : path.join(app.getAppPath(), "iwappd.tar.xz");
}

let compressedBinaries: Promise<[Buffer<ArrayBufferLike>, Buffer<ArrayBufferLike>]> | undefined;

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
 * build of liblzma rather than a native addon, so it needs no per-platform
 * compilation and no `.node` to unpack from the asar.
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

function recompressBufferAsGz(binary: Buffer): Promise<Buffer<ArrayBufferLike>> {
  // The result is cached for the life of the process and then pushed over SSH,
  // so trade CPU here for the smallest upload.
  return gzipAsync(binary, { level: zlibConstants.Z_BEST_COMPRESSION });
}

async function splitInto2Archives(): Promise<[Buffer<ArrayBufferLike>, Buffer<ArrayBufferLike>]> {
  const file = await readFile(iwappdArchivePath());
  const decomp = await xzDecompress(file);
  const members = await readTarMembers(decomp, [X86_64_BINARY, ARM64_BINARY]);
  const x86_64 = members.get(X86_64_BINARY);
  const arm64 = members.get(ARM64_BINARY);
  if (!x86_64 || !arm64) {
    throw new Error(
      `${iwappdArchivePath()} is missing ${!x86_64 ? X86_64_BINARY : ARM64_BINARY} — rebuild it with scripts/ensure-iwappd.mjs`,
    );
  }
  return Promise.all([recompressBufferAsGz(x86_64), recompressBufferAsGz(arm64)]);
}

/** Gets the x86_64 binary compressed with gunzip. You should send this to the server and decompress there. */
export function getx86_64GzBinary() {
  if (!compressedBinaries) compressedBinaries = splitInto2Archives();
  return compressedBinaries.then((x) => x[0]);
}

/** Gets the arm64 binary compressed with gunzip. You should send this to the server and decompress there. */
export function getArm64GzBinary() {
  if (!compressedBinaries) compressedBinaries = splitInto2Archives();
  return compressedBinaries.then((x) => x[1]);
}
