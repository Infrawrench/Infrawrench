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
import { resolveSafeHost } from "./host-validation";

/**
 * Wrap an SFTP call so any host-key trust failure surfaces as a typed
 * `HostKeyTrustRequiredError` instead of the underlying ssh2 connect error.
 *
 * The destination is vetted first and the socket pinned to the address that
 * cleared; host-key identity stays the configured name (the verifier is
 * installed before the host is swapped, and keys off the config it sees).
 */
async function withHostKeyCapture<T>(
  organizationId: string,
  config: SftpConfig,
  run: (opts: WithSftpOptions) => Promise<T>,
): Promise<T> {
  const dialAddress = await resolveSafeHost(config.host);
  const hostKeyErrorRef = { value: null as HostKeyTrustRequiredError | null };
  const withHostKey = makeHostKeyConfigureConnect(organizationId, hostKeyErrorRef, "sftp");
  try {
    return await run({
      configureConnect: (opts) => ({ ...withHostKey(opts), host: dialAddress }),
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
  return withHostKeyCapture(organizationId, config, (opts) => sftpListImpl(config, dirPath, opts));
}

export function sftpMkdir(
  organizationId: string,
  config: SftpConfig,
  dirPath: string,
): Promise<void> {
  return withHostKeyCapture(organizationId, config, (opts) => sftpMkdirImpl(config, dirPath, opts));
}

export function sftpDelete(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
  isDir: boolean,
): Promise<void> {
  return withHostKeyCapture(organizationId, config, (opts) =>
    sftpDeleteImpl(config, remotePath, isDir, opts),
  );
}

export function sftpUpload(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  return withHostKeyCapture(organizationId, config, (opts) =>
    sftpUploadImpl(config, remotePath, data, opts),
  );
}

export function sftpDownloadToBuffer(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
): Promise<Buffer> {
  return withHostKeyCapture(organizationId, config, (opts) =>
    sftpDownloadToBufferImpl(config, remotePath, opts),
  );
}
