/**
 * The SFTP file browser and terminal image paste, over
 * `@infrawrench/sftp-host` with the desktop's host-key pins.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { StorageObject } from "@infrawrench/plugin-base";
import { exact } from "../exact";
import { SftpConfig, SshError } from "./ssh-common";

export const SftpEntry = exact<StorageObject>()(
  Schema.Struct({
    key: Schema.String,
    name: Schema.String,
    size: Schema.Finite,
    lastModified: Schema.String,
    isDirectory: Schema.Boolean,
    contentType: Schema.optionalKey(Schema.String),
  }),
);

export class SftpRpcs extends RpcGroup.make(
  Rpc.make("SftpList", {
    payload: { config: SftpConfig, path: Schema.String },
    success: Schema.Array(SftpEntry),
    error: SshError,
  }),
  Rpc.make("SftpMkdir", {
    payload: { config: SftpConfig, path: Schema.String },
    error: SshError,
  }),
  Rpc.make("SftpDelete", {
    payload: { config: SftpConfig, path: Schema.String, isDir: Schema.Boolean },
    error: SshError,
  }),
  /** The bytes travel with the call, so there is no local path to bless. */
  Rpc.make("SftpUpload", {
    payload: { config: SftpConfig, remotePath: Schema.String, data: Schema.Uint8Array },
    error: SshError,
  }),
  /**
   * Download into `destFolder/relativePath`; `destFolder` must be one the
   * user just picked in a folder dialog.
   */
  Rpc.make("SftpDownload", {
    payload: {
      config: SftpConfig,
      remotePath: Schema.String,
      destFolder: Schema.String,
      relativePath: Schema.String,
    },
    error: SshError,
  }),
) {}
