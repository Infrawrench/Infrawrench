/**
 * Web SFTP adapter. Wraps @infrawrench/sftp-host so every connection runs
 * through the web's TOFU host-key verifier (see ssh-host-keys.ts).
 */
import {
  sftpList as sftpListImpl,
  sftpMkdir as sftpMkdirImpl,
  sftpDelete as sftpDeleteImpl,
  sftpUpload as sftpUploadImpl,
  sftpDownloadToBuffer as sftpDownloadToBufferImpl,
  type SftpEntry,
  type WithSftpOptions,
} from "@infrawrench/sftp-host";
import type { SftpConfig } from "@infrawrench/plugin-base";
import { HostKeyTrustRequiredError, makeHostKeyConfigureConnect } from "./ssh-host-keys";

/**
 * Wrap an SFTP call so any host-key trust failure surfaces as a typed
 * `HostKeyTrustRequiredError` instead of the underlying ssh2 connect error.
 */
async function withHostKeyCapture<T>(
  organizationId: string,
  run: (opts: WithSftpOptions) => Promise<T>,
): Promise<T> {
  const hostKeyErrorRef = { value: null as HostKeyTrustRequiredError | null };
  try {
    return await run({
      configureConnect: makeHostKeyConfigureConnect(organizationId, hostKeyErrorRef, "sftp"),
    });
  } catch (e) {
    if (hostKeyErrorRef.value) throw hostKeyErrorRef.value;
    throw e;
  }
}

export function sftpList(
  organizationId: string,
  config: SftpConfig,
  dirPath: string,
): Promise<SftpEntry[]> {
  return withHostKeyCapture(organizationId, (opts) => sftpListImpl(config, dirPath, opts));
}

export function sftpMkdir(
  organizationId: string,
  config: SftpConfig,
  dirPath: string,
): Promise<void> {
  return withHostKeyCapture(organizationId, (opts) => sftpMkdirImpl(config, dirPath, opts));
}

export function sftpDelete(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
  isDir: boolean,
): Promise<void> {
  return withHostKeyCapture(organizationId, (opts) =>
    sftpDeleteImpl(config, remotePath, isDir, opts),
  );
}

export function sftpUpload(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  return withHostKeyCapture(organizationId, (opts) =>
    sftpUploadImpl(config, remotePath, data, opts),
  );
}

export function sftpDownloadToBuffer(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
): Promise<Buffer> {
  return withHostKeyCapture(organizationId, (opts) =>
    sftpDownloadToBufferImpl(config, remotePath, opts),
  );
}
