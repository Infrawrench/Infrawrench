/**
 * Schemas the SSH groups share: the connect configs the renderer resolves
 * (key material included; it never leaves this machine), and the one error
 * every SSH, SFTP and tunnel operation fails with.
 */
import { Schema } from "effect";
import type { SftpConfig as SftpConfigType } from "@infrawrench/plugin-base";
import { exact } from "../exact";

/**
 * Why an SSH operation failed, as the sentence the terminal or toast shows:
 * `SSH error: All configured authentication methods failed`, a host-key
 * refusal, a missing 1Password socket. The text is the main process's own,
 * unchanged from the `ipcMain.handle` era.
 */
export class SshError extends Schema.TaggedError<SshError>()("SshError", {
  message: Schema.String,
}) {}

/** One intermediate jump host, outermost first. */
export const SshJumpHop = Schema.Struct({
  host: Schema.String,
  port: Schema.Finite,
  username: Schema.String,
  privateKey: Schema.String,
});

/**
 * Everything `connectSshChain` dials: the target, its key (or an agent
 * sentinel), and the jump hops in front of it. `cols`/`rows` size the PTY
 * when the connection opens a shell.
 */
export const SshShellConfig = Schema.Struct({
  host: Schema.String,
  port: Schema.Finite,
  username: Schema.String,
  privateKey: Schema.String,
  cols: Schema.Finite,
  rows: Schema.Finite,
  agentForward: Schema.optionalKey(Schema.Boolean),
  /**
   * Set when `privateKey` is the cloud-key sentinel: the org key to sign
   * with. Its private half stays in Infrawrench Cloud.
   */
  cloudKey: Schema.optionalKey(Schema.Struct({ orgId: Schema.String, sshKeyId: Schema.String })),
  jumpHops: Schema.optionalKey(Schema.Array(SshJumpHop)),
});
export type SshShellConfig = typeof SshShellConfig.Type;

/** The connect config of a tunnel's, exec's and workflow's single hop. */
export const SshHostConfig = Schema.Struct({
  sshHost: Schema.String,
  sshPort: Schema.Finite,
  sshUser: Schema.String,
  privateKey: Schema.String,
});
export type SshHostConfig = typeof SshHostConfig.Type;

export const SftpConfig = exact<SftpConfigType>()(
  Schema.Struct({
    host: Schema.String,
    port: Schema.Finite,
    username: Schema.String,
    privateKey: Schema.String,
  }),
);
