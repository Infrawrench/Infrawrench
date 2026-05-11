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
import { HostKeyMismatchError, verifyOrPinHostKey } from "./ssh-host-keys";

function makeTofuOptions(organizationId: string): WithSftpOptions {
  return {
    configureConnect: (opts: ConnectConfig): ConnectConfig => {
      const host = String(opts.host);
      const port = Number(opts.port);
      return {
        ...opts,
        hostVerifier: (hostKey: Buffer, verify: (valid: boolean) => void) => {
          verifyOrPinHostKey(organizationId, host, port, hostKey).then(
            () => verify(true),
            (e: unknown) => {
              if (e instanceof HostKeyMismatchError) {
                console.error(
                  `[sftp] host key mismatch for ${e.host}:${e.port} ` +
                    `(stored=${e.storedFingerprint}, presented=${e.presentedFingerprint})`,
                );
              }
              verify(false);
            },
          );
        },
      };
    },
  };
}

export function sftpList(
  organizationId: string,
  config: SftpConfig,
  dirPath: string,
): Promise<SftpEntry[]> {
  return sftpListImpl(config, dirPath, makeTofuOptions(organizationId));
}

export function sftpMkdir(
  organizationId: string,
  config: SftpConfig,
  dirPath: string,
): Promise<void> {
  return sftpMkdirImpl(config, dirPath, makeTofuOptions(organizationId));
}

export function sftpDelete(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
  isDir: boolean,
): Promise<void> {
  return sftpDeleteImpl(config, remotePath, isDir, makeTofuOptions(organizationId));
}

export function sftpUpload(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  return sftpUploadImpl(config, remotePath, data, makeTofuOptions(organizationId));
}

export function sftpDownloadToBuffer(
  organizationId: string,
  config: SftpConfig,
  remotePath: string,
): Promise<Buffer> {
  return sftpDownloadToBufferImpl(config, remotePath, makeTofuOptions(organizationId));
}

export type { SftpEntry };
