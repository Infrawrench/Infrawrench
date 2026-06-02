/**
 * Desktop SFTP adapter. Wraps @infrawrench/sftp-host so every connection runs
 * through the desktop's persistent TOFU host-key verifier (see
 * ssh-host-keys.ts, backed by the local sql.js `ssh_host_keys` table).
 */
import type { ConnectConfig } from "ssh2";
import {
  sftpList as sftpListImpl,
  sftpMkdir as sftpMkdirImpl,
  sftpDelete as sftpDeleteImpl,
  sftpUpload as sftpUploadImpl,
  sftpDownload as sftpDownloadImpl,
  sftpDownloadToBuffer as sftpDownloadToBufferImpl,
  type SftpEntry,
  type WithSftpOptions,
} from "@infrawrench/sftp-host";
import type { SftpConfig } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};
import {
  ensureHostKeyCacheLoaded,
  verifyOrPinHostKeyInteractive,
  HostKeyMismatchError,
} from "./ssh-host-keys";

function withHostKeyVerifier(
  opts: ConnectConfig,
  hostKeyErrorRef: { value: HostKeyMismatchError | null },
): ConnectConfig {
  const host = String(opts.host);
  const port = Number(opts.port);
  return {
    ...opts,
    hostVerifier: (hostKey: Buffer, verify: (matches: boolean) => void) => {
      verifyOrPinHostKeyInteractive(host, port, hostKey).then(
        (result) => {
          if (!result.ok) {
            console.error(
              `[sftp] host key rejected for ${result.error.host}:${result.error.port} ` +
                `(stored=${result.error.storedFingerprint}, presented=${result.error.presentedFingerprint})`,
            );
            hostKeyErrorRef.value = result.error;
            verify(false);
            return;
          }
          verify(true);
        },
        (err) => {
          console.error("[sftp] host-key verification error:", err);
          verify(false);
        },
      );
    },
  };
}

async function buildOptions(): Promise<{
  options: WithSftpOptions;
  hostKeyErrorRef: { value: HostKeyMismatchError | null };
}> {
  await ensureHostKeyCacheLoaded();
  const hostKeyErrorRef = { value: null as HostKeyMismatchError | null };
  const options: WithSftpOptions = {
    configureConnect: (opts) => withHostKeyVerifier(opts, hostKeyErrorRef),
  };
  return { options, hostKeyErrorRef };
}

async function withMismatchRethrow<T>(
  fn: () => Promise<T>,
  ref: { value: HostKeyMismatchError | null },
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (ref.value) throw ref.value;
    throw e;
  }
}

export async function sftpList(config: SftpConfig, dirPath: string): Promise<SftpEntry[]> {
  const { options, hostKeyErrorRef } = await buildOptions();
  return withMismatchRethrow(() => sftpListImpl(config, dirPath, options), hostKeyErrorRef);
}

export async function sftpMkdir(config: SftpConfig, dirPath: string): Promise<void> {
  const { options, hostKeyErrorRef } = await buildOptions();
  return withMismatchRethrow(() => sftpMkdirImpl(config, dirPath, options), hostKeyErrorRef);
}

export async function sftpDelete(
  config: SftpConfig,
  remotePath: string,
  isDir: boolean,
): Promise<void> {
  const { options, hostKeyErrorRef } = await buildOptions();
  return withMismatchRethrow(
    () => sftpDeleteImpl(config, remotePath, isDir, options),
    hostKeyErrorRef,
  );
}

export async function sftpUpload(
  config: SftpConfig,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  const { options, hostKeyErrorRef } = await buildOptions();
  return withMismatchRethrow(
    () => sftpUploadImpl(config, remotePath, data, options),
    hostKeyErrorRef,
  );
}

export async function sftpDownload(
  config: SftpConfig,
  remotePath: string,
  localPath: string,
): Promise<void> {
  const { options, hostKeyErrorRef } = await buildOptions();
  return withMismatchRethrow(
    () => sftpDownloadImpl(config, remotePath, localPath, options),
    hostKeyErrorRef,
  );
}

export async function sftpDownloadToBuffer(
  config: SftpConfig,
  remotePath: string,
): Promise<Buffer> {
  const { options, hostKeyErrorRef } = await buildOptions();
  return withMismatchRethrow(
    () => sftpDownloadToBufferImpl(config, remotePath, options),
    hostKeyErrorRef,
  );
}
