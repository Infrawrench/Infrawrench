/**
 * SSH and SFTP for workflows (`resource.ssh(...)`, `waitUntilReachable()`,
 * `resource.sftp`) and the agent VM setup. The renderer resolves the connect
 * config; the main process dials. Output crosses as base64 so a binary
 * command's bytes survive intact.
 *
 * A streaming command stays the pull-based start/read/close the QuickJS
 * sandbox's host capability expects: the sandbox asks for the next chunk
 * when it wants one.
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { SftpConfig, SshError, SshHostConfig } from "./ssh-common";
import { SftpEntry } from "./sftp";

const WorkflowSshCommand = {
  config: SshHostConfig,
  command: Schema.String,
  /** Accept any host key without the pin prompt (a VM this session just created). */
  skipHostKeyCheck: Schema.optional(Schema.Boolean),
};

export const WorkflowSshExecResult = Schema.Struct({
  stdoutBase64: Schema.String,
  stderrBase64: Schema.String,
  code: Schema.Finite,
});

export const WorkflowSshStreamChunk = Schema.Struct({
  stdoutBase64: Schema.optionalKey(Schema.String),
  stderrBase64: Schema.optionalKey(Schema.String),
  done: Schema.Boolean,
  code: Schema.optionalKey(Schema.Finite),
});

export class WorkflowSshRpcs extends RpcGroup.make(
  Rpc.make("WorkflowSshExec", {
    payload: WorkflowSshCommand,
    success: WorkflowSshExecResult,
    error: SshError,
  }),
  /** Feed a script on stdin (`sh -s`), so a secret in it never reaches the remote argv. */
  Rpc.make("WorkflowSshExecScript", {
    payload: {
      config: SshHostConfig,
      script: Schema.String,
      skipHostKeyCheck: Schema.optional(Schema.Boolean),
    },
    success: Schema.String,
    error: SshError,
  }),
  Rpc.make("WorkflowSshStreamStart", {
    payload: WorkflowSshCommand,
    success: Schema.Struct({ streamId: Schema.String }),
    error: SshError,
  }),
  /** The output since the last read, waiting for some when there is none yet. */
  Rpc.make("WorkflowSshStreamRead", {
    payload: { streamId: Schema.String },
    success: WorkflowSshStreamChunk,
    error: SshError,
  }),
  Rpc.make("WorkflowSshStreamClose", { payload: { streamId: Schema.String } }),
  /** Poll until `host:port` accepts a TCP connection or `timeoutMs` passes. */
  Rpc.make("WorkflowSshProbe", {
    payload: { host: Schema.String, port: Schema.Finite, timeoutMs: Schema.Finite },
    success: Schema.Boolean,
  }),
  Rpc.make("WorkflowSftpList", {
    payload: { config: SftpConfig, path: Schema.String },
    success: Schema.Array(SftpEntry),
    error: SshError,
  }),
  Rpc.make("WorkflowSftpGet", {
    payload: { config: SftpConfig, path: Schema.String },
    success: Schema.Struct({ base64: Schema.String }),
    error: SshError,
  }),
  Rpc.make("WorkflowSftpPut", {
    payload: { config: SftpConfig, path: Schema.String, base64: Schema.String },
    error: SshError,
  }),
  Rpc.make("WorkflowSftpMkdir", {
    payload: { config: SftpConfig, path: Schema.String },
    error: SshError,
  }),
  Rpc.make("WorkflowSftpDelete", {
    payload: { config: SftpConfig, path: Schema.String, isDir: Schema.Boolean },
    error: SshError,
  }),
) {}
