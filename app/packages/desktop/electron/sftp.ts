import fs from "node:fs";
import path from "node:path";
import { Client as SshClient } from "ssh2";
import type { SFTPWrapper, FileEntry } from "ssh2";

export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export interface SftpEntry {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  isDirectory: boolean;
}

function withSftp<T>(config: SftpConfig, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    client.once("ready", () => {
      client.sftp((err, sftp) => {
        if (err) { client.end(); reject(err); return; }
        fn(sftp)
          .then((result) => { client.end(); resolve(result); })
          .catch((e) => { client.end(); reject(e); });
      });
    });
    client.once("error", (err) => reject(new Error(`SSH error: ${err.message}`)));
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      hostVerifier: () => true,
    });
  });
}

export function sftpList(config: SftpConfig, dirPath: string): Promise<SftpEntry[]> {
  return withSftp(config, (sftp) =>
    new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list: FileEntry[]) => {
        if (err) { reject(err); return; }
        const entries: SftpEntry[] = list
          .filter((item) => item.filename !== "." && item.filename !== "..")
          .map((item) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mode = (item.attrs as any).mode as number ?? 0;
            const isDir = (mode & 0o170000) === 0o040000;
            const normalized = dirPath.endsWith("/") ? dirPath : `${dirPath}/`;
            return {
              key: `${normalized}${item.filename}`,
              name: item.filename,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              size: (item.attrs as any).size as number ?? 0,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              lastModified: new Date(((item.attrs as any).mtime as number ?? 0) * 1000).toISOString(),
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
  );
}

export function sftpMkdir(config: SftpConfig, dirPath: string): Promise<void> {
  return withSftp(config, (sftp) =>
    new Promise((resolve, reject) => {
      sftp.mkdir(dirPath, (err) => {
        if (err) { reject(err); return; }
        resolve();
      });
    }),
  );
}

export function sftpDelete(config: SftpConfig, remotePath: string, isDir: boolean): Promise<void> {
  return withSftp(config, (sftp) =>
    new Promise((resolve, reject) => {
      const done = (err: Error | null | undefined) => { if (err) reject(err); else resolve(); };
      if (isDir) sftp.rmdir(remotePath, done);
      else sftp.unlink(remotePath, done);
    }),
  );
}

export function sftpUpload(
  config: SftpConfig,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  return withSftp(config, (sftp) =>
    new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      stream.once("error", reject);
      stream.once("close", () => resolve());
      stream.end(data);
    }),
  );
}

export function sftpDownload(
  config: SftpConfig,
  remotePath: string,
  localPath: string,
): Promise<void> {
  return withSftp(config, (sftp) =>
    new Promise((resolve, reject) => {
      const dir = path.dirname(localPath);
      fs.mkdirSync(dir, { recursive: true });
      sftp.fastGet(remotePath, localPath, (err) => {
        if (err) { reject(err); return; }
        resolve();
      });
    }),
  );
}
