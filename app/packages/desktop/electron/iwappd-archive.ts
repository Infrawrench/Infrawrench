/**
 * The Linux app server binaries the desktop app uploads to a customer's host.
 *
 * They come from the shared runtime source in `@infrawrench/appstream-host`:
 * the newest published build, fetched from the asset downloader and cached in
 * memory — so a compositor fix reaches desktop users when it is published,
 * not when they next update the app. The `iwappd.tar.xz` packaged with the
 * app (produced by `scripts/ensure-iwappd.mjs`, copied in by the
 * `extraResources` entry in package.json) is the offline fallback: a laptop
 * with no route to our storage stages that build, exactly as every install did
 * before the runtime refresh existed.
 *
 * The archive ships on every platform, not just Linux: the host being
 * streamed from is remote, so a macOS or Windows client needs the binaries
 * just as much. It holds one static musl binary per Linux architecture at its
 * root, named `iwappd-<target triple>`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { createIwappdBinarySource } from "@infrawrench/appstream-host";

function iwappdArchivePath(): string {
  // extraResources lands beside the asar rather than inside it, so the packaged
  // path is not app.getAppPath()-relative. In dev, getAppPath() is the package
  // root, which is where ensure-iwappd.mjs writes the archive.
  return app.isPackaged
    ? path.join(process.resourcesPath, "iwappd.tar.xz")
    : path.join(app.getAppPath(), "iwappd.tar.xz");
}

const source = createIwappdBinarySource({
  bundledArchive: () => readFile(iwappdArchivePath()),
});

/** Gets the x86_64 binary compressed with gunzip. You should send this to the server and decompress there. */
export function getx86_64GzBinary(): Promise<Buffer> {
  return source.getx86_64GzBinary();
}

/** Gets the arm64 binary compressed with gunzip. You should send this to the server and decompress there. */
export function getArm64GzBinary(): Promise<Buffer> {
  return source.getArm64GzBinary();
}
