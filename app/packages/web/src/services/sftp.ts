/**
 * Web SFTP adapter. Wraps @infrawrench/sftp-host so every connection runs
 * through the web's TOFU host-key verifier (see ssh-host-keys.ts).
 */
import type { ConnectConfig } from "ssh2";
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
import { HostKeyTrustRequiredError, verifyHostKey } from "./ssh-host-keys";

/**
 * Build SFTP connection options that route the host-key check through
 * `verifyHostKey`. Captures any trust-required error on `hostKeyErrorRef.value`
 * so the calling route can surface it as a 409 instead of the generic ssh2
 * "connection failed" message.
 */
function makeHostKeyOptions(
  organizationId: string,
  hostKeyErrorRef: { value: HostKeyTrustRequiredError | null },
): WithSftpOptions {
  return {
    configureConnect: (opts: ConnectConfig): ConnectConfig => {
      const host = String(opts.host);
      const port = Number(opts.port);
      return {
        ...opts,
        hostVerifier: (hostKey: Buffer, verify: (valid: boolean) => void) => {
          verifyHostKey(organizationId, host, port, hostKey).then(
            () => verify(true),
            (e: unknown) => {
              if (e instanceof HostKeyTrustRequiredError) {
                console.warn(
                  `[sftp] host key ${e.kind} for ${e.host}:${e.port} ` +
                    `(stored=${e.storedFingerprint ?? "(none)"}, presented=${e.presentedFingerprint})`,
                );
                hostKeyErrorRef.value = e;
              }
              verify(false);
            },
          );
        },
      };
    },
  };
}

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
    return await run(makeHostKeyOptions(organizationId, hostKeyErrorRef));
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
