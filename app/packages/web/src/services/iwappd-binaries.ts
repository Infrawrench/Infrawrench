/**
 * The Linux app server binaries the web server uploads to a customer's host.
 *
 * The web server has no build-time copy at all: the image is built from
 * `turbo prune @infrawrench/web --docker`, whose pruned tree carries only
 * workspace packages, and `linux-appserver/` is deliberately outside
 * `pnpm-workspace.yaml`. So everything comes from the shared runtime source in
 * `@infrawrench/appstream-host` — the `latest` pointer, the download, the
 * in-memory cache — with no bundled fallback, because there is nothing here to
 * fall back to. The desktop's `electron/iwappd-archive.ts` is the same source
 * with its packaged `iwappd.tar.xz` behind it.
 */

import { createIwappdBinarySource } from "@infrawrench/appstream-host";

const source = createIwappdBinarySource();

/** Gets the x86_64 binary compressed with gunzip. You should send this to the server and decompress there. */
export function getx86_64GzBinary(): Promise<Buffer> {
  return source.getx86_64GzBinary();
}

/** Gets the arm64 binary compressed with gunzip. You should send this to the server and decompress there. */
export function getArm64GzBinary(): Promise<Buffer> {
  return source.getArm64GzBinary();
}
