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

function withHostKeyVerifier(opts: ConnectConfig): ConnectConfig {
  const host = String(opts.host);
  const port = Number(opts.port);
  return {
    ...opts,
    hostVerifier: (hostKey: Buffer) => {
      try {
        verifyOrPinHostKey(host, port, hostKey);
        return true;
      } catch (e) {
        if (e instanceof HostKeyMismatchError) {
          console.error(
            `[sftp] host key mismatch for ${e.host}:${e.port} ` +
              `(stored=${e.storedFingerprint}, presented=${e.presentedFingerprint})`,
          );
        }
        return false;
      }
    },
  };
}

const tofuOptions: WithSftpOptions = { configureConnect: withHostKeyVerifier };

export function sftpList(config: SftpConfig, dirPath: string): Promise<SftpEntry[]> {
  return sftpListImpl(config, dirPath, tofuOptions);
}

export function sftpMkdir(config: SftpConfig, dirPath: string): Promise<void> {
  return sftpMkdirImpl(config, dirPath, tofuOptions);
}

export function sftpDelete(config: SftpConfig, remotePath: string, isDir: boolean): Promise<void> {
  return sftpDeleteImpl(config, remotePath, isDir, tofuOptions);
}

export function sftpUpload(config: SftpConfig, remotePath: string, data: Buffer): Promise<void> {
  return sftpUploadImpl(config, remotePath, data, tofuOptions);
}

export function sftpDownloadToBuffer(config: SftpConfig, remotePath: string): Promise<Buffer> {
  return sftpDownloadToBufferImpl(config, remotePath, tofuOptions);
}

export type { SftpEntry };
