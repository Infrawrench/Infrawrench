import fs from "node:fs";
import path from "node:path";
import { Client as SshClient } from "ssh2";
import type { ConnectConfig, SFTPWrapper, FileEntry } from "ssh2";
import type { SftpConfig, StorageObject } from "@infrawrench/plugin-base" with {
  "resolution-mode": "import",
};

export type SftpEntry = StorageObject;

export interface WithSftpOptions {
  /**
   * Hook called just before the SSH client connects. Receives the default
   * ConnectConfig assembled from the SftpConfig and may return a modified
   * config (e.g. install a `hostVerifier` that consults a TOFU pin store).
   *
   * The default ConnectConfig fails closed — its `hostVerifier` rejects every
   * key with a clear error — so callers MUST provide a verifier here. The
   * web service supplies one backed by an in-memory pin map; the desktop
   * supplies one backed by the local sql.js `ssh_host_keys` table.
   */
  configureConnect?: (opts: ConnectConfig) => ConnectConfig;
}

function buildConnectConfig(config: SftpConfig, options?: WithSftpOptions): ConnectConfig {
  const baseOpts: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    privateKey: config.privateKey,
    hostVerifier: () => {
      throw new Error(
        "sftp-host: no SSH host-key verifier configured. Pass " +
          "options.configureConnect to install one (see the web and desktop " +
          "ssh-host-keys modules for TOFU verifiers).",
      );
    },
  };
  return options?.configureConnect ? options.configureConnect(baseOpts) : baseOpts;
}

export function withSftp<T>(
  config: SftpConfig,
  fn: (sftp: SFTPWrapper) => Promise<T>,
  options?: WithSftpOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    client.once("ready", () => {
      client.sftp((err, sftp) => {
        if (err) {
          client.end();
          reject(err);
          return;
        }
        fn(sftp)
          .then((result) => {
            client.end();
            resolve(result);
          })
          .catch((e) => {
            client.end();
            reject(e);
          });
      });
    });
    client.once("error", (err) => reject(new Error(`SSH error: ${err.message}`)));
    client.connect(buildConnectConfig(config, options));
  });
}

export function sftpList(
  config: SftpConfig,
  dirPath: string,
  options?: WithSftpOptions,
): Promise<SftpEntry[]> {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.readdir(dirPath, (err, list: FileEntry[]) => {
          if (err) {
            reject(err);
            return;
          }
          const entries: SftpEntry[] = list
            .filter((item) => item.filename !== "." && item.filename !== "..")
            .map((item) => {
              const mode = item.attrs.mode ?? 0;
              const isDir = (mode & 0o170000) === 0o040000;
              const normalized = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
              return {
                key: `${normalized}${item.filename}`,
                name: item.filename,
                size: item.attrs.size ?? 0,
                lastModified: new Date((item.attrs.mtime ?? 0) * 1000).toISOString(),
                isDirectory: isDir,
              };
            });
          // Dirs first, then files — both sorted alphabetically
          entries.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          resolve(entries);
        });
      }),
    options,
  );
}

export function sftpMkdir(
  config: SftpConfig,
  dirPath: string,
  options?: WithSftpOptions,
): Promise<void> {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.mkdir(dirPath, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    options,
  );
}

export function sftpRename(
  config: SftpConfig,
  fromPath: string,
  toPath: string,
  options?: WithSftpOptions,
): Promise<void> {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.rename(fromPath, toPath, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    options,
  );
}

export function sftpChmod(
  config: SftpConfig,
  remotePath: string,
  mode: number,
  options?: WithSftpOptions,
): Promise<void> {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        sftp.chmod(remotePath, mode, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    options,
  );
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function rmdirRecursive(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.readdir(dirPath, async (err, list: FileEntry[]) => {
      if (err) {
        reject(err);
        return;
      }
      try {
        for (const item of list) {
          if (item.filename === "." || item.filename === "..") continue;
          const full = joinPath(dirPath, item.filename);
          const isDir = ((item.attrs.mode ?? 0) & 0o170000) === 0o040000;
          if (isDir) {
            await rmdirRecursive(sftp, full);
          } else {
            await new Promise<void>((res, rej) => sftp.unlink(full, (e) => (e ? rej(e) : res())));
          }
        }
        sftp.rmdir(dirPath, (e) => (e ? reject(e) : resolve()));
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function sftpDelete(
  config: SftpConfig,
  remotePath: string,
  isDir: boolean,
  options?: WithSftpOptions,
): Promise<void> {
  return withSftp(
    config,
    (sftp) => {
      if (isDir) return rmdirRecursive(sftp, remotePath);
      return new Promise((resolve, reject) => {
        sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve()));
      });
    },
    options,
  );
}

export function sftpUpload(
  config: SftpConfig,
  remotePath: string,
  data: Buffer,
  options?: WithSftpOptions,
): Promise<void> {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        const stream = sftp.createWriteStream(remotePath);
        stream.once("error", reject);
        stream.once("close", () => resolve());
        stream.end(data);
      }),
    options,
  );
}

/** Stream a remote file straight to disk (desktop pattern). */
export function sftpDownload(
  config: SftpConfig,
  remotePath: string,
  localPath: string,
  options?: WithSftpOptions,
): Promise<void> {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        const dir = path.dirname(localPath);
        fs.mkdirSync(dir, { recursive: true });
        sftp.fastGet(remotePath, localPath, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      }),
    options,
  );
}

/** Buffer the entire remote file into memory (web pattern). */
export function sftpDownloadToBuffer(
  config: SftpConfig,
  remotePath: string,
  options?: WithSftpOptions,
): Promise<Buffer> {
  return withSftp(
    config,
    (sftp) =>
      new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        const stream = sftp.createReadStream(remotePath);
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => resolve(Buffer.concat(chunks)));
        stream.on("error", reject);
      }),
    options,
  );
}
