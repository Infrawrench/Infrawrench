/**
 * Cloud SSH operations the JSON transport (`CloudHttp`) cannot carry, run in
 * the main process over the transport's session and host-key prompt
 * (`electron/cloud-ssh.ts`):
 *
 * - an SFTP upload, sent as the multipart form `SftpUploadForm` describes;
 * - an SFTP download, written to a folder the user picked in a dialog, never
 *   handed to the renderer;
 * - the host-key prompt on its own, for a WS-proxy shell, whose
 *   trust-required signal is an `ssh:error` frame rather than a 409.
 *
 * The plain SFTP calls (list, mkdir, delete) go through `CloudHttp` like any
 * other contract route. Interrupting a transfer (the renderer reloading or
 * closing) aborts it, and a download interrupted or failed midway leaves no
 * file behind.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { SshHostKeyTrustRequired } from "@infrawrench/api-contract";
import { CloudRequestError } from "../errors";

/**
 * An org id as a single path segment: the main process builds the URL from
 * it, so nothing that could leave `/api/org/<id>/` gets in.
 */
const CloudOrgId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, { message: "Invalid organization id" }),
);

/**
 * The account and the SSH overrides both transfers take, named as the
 * contract's `SftpUploadForm` fields (the main process builds the form from
 * them, typed against that schema).
 */
const sftpTarget = {
  orgId: CloudOrgId,
  accountId: Schema.String,
  sshKeyId: Schema.optionalKey(Schema.String),
  sshHost: Schema.optionalKey(Schema.String),
  sshUsername: Schema.optionalKey(Schema.String),
};

/** The bytes travel with the call; `filename` defaults to the remote path's last segment. */
export const CloudSftpUploadInput = Schema.Struct({
  ...sftpTarget,
  remotePath: Schema.String,
  data: Schema.Uint8Array,
  filename: Schema.optionalKey(Schema.String),
});
export type CloudSftpUploadInput = typeof CloudSftpUploadInput.Type;

/**
 * One remote file into `destFolder/relativePath`, where `destFolder` came
 * from a folder dialog and `relativePath` is checked like any remote name.
 */
export const CloudSftpDownloadInput = Schema.Struct({
  ...sftpTarget,
  remotePath: Schema.String,
  destFolder: Schema.String,
  relativePath: Schema.String,
});
export type CloudSftpDownloadInput = typeof CloudSftpDownloadInput.Type;

/** The host and key an `ssh:error` frame named, as the contract's 409 names them. */
export const CloudSshHostKeyTrustInput = Schema.Struct({
  orgId: CloudOrgId,
  host: SshHostKeyTrustRequired.fields.host,
  port: SshHostKeyTrustRequired.fields.port,
  kind: SshHostKeyTrustRequired.fields.kind,
  presentedFingerprint: SshHostKeyTrustRequired.fields.presentedFingerprint,
  storedFingerprint: SshHostKeyTrustRequired.fields.storedFingerprint,
});
export type CloudSshHostKeyTrustInput = typeof CloudSshHostKeyTrustInput.Type;

export class CloudSshRpcs extends RpcGroup.make(
  Rpc.make("CloudSftpUpload", { payload: CloudSftpUploadInput, error: CloudRequestError }),
  Rpc.make("CloudSftpDownload", { payload: CloudSftpDownloadInput, error: CloudRequestError }),
  /** Prompt for the key and, on accept, trust it in the org's store; whether it is trusted now. */
  Rpc.make("CloudSshHostKeyTrust", {
    payload: CloudSshHostKeyTrustInput,
    success: Schema.Boolean,
    error: CloudRequestError,
  }),
) {}
