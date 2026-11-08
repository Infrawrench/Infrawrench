/**
 * SSH local forwards (`@infrawrench/ssh-tunnel-core`) and one-off remote
 * commands: the port-forwarded database consoles, Docker setup and the
 * provisioning scripts (Tailscale, the SSH service installers).
 */
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { SshTunnelConfig as SshTunnelConfigType } from "@infrawrench/plugin-base";
import { exact } from "../exact";
import { SshError, SshHostConfig, SshShellConfig } from "./ssh-common";

export const SshTunnelConfig = exact<SshTunnelConfigType>()(
  Schema.Struct({
    sshHost: Schema.String,
    sshPort: Schema.Finite,
    sshUser: Schema.String,
    privateKey: Schema.String,
    remoteHost: Schema.String,
    remotePort: Schema.Finite,
  }),
);

export const OpenedTunnel = Schema.Struct({ tunnelId: Schema.String, localPort: Schema.Finite });

export const ActiveTunnel = Schema.Struct({
  localPort: Schema.Finite,
  sshHost: Schema.String,
  remotePort: Schema.Finite,
});

export const SshExecResult = Schema.Struct({
  stdout: Schema.String,
  stderr: Schema.String,
  code: Schema.Finite,
});

export class SshTunnelRpcs extends RpcGroup.make(
  Rpc.make("SshTunnelOpen", { payload: SshTunnelConfig, success: OpenedTunnel, error: SshError }),
  Rpc.make("SshTunnelClose", { payload: { tunnelId: Schema.String } }),
  /** Open tunnels by id. */
  Rpc.make("SshTunnelsActive", { success: Schema.Record(Schema.String, ActiveTunnel) }),
  /**
   * Run a command string and collect its output. Callers (Docker setup, the
   * env deploy) need multi-step provisioning; narrower typed operations
   * should replace it where they can.
   */
  Rpc.make("SshExecCommand", {
    payload: { config: SshHostConfig, command: Schema.String },
    success: SshExecResult,
    error: SshError,
  }),
  /** Feed a script on stdin through the full chain; resolves its stdout. */
  Rpc.make("SshExecScript", {
    payload: { config: SshShellConfig, script: Schema.String },
    success: Schema.String,
    error: SshError,
  }),
) {}
