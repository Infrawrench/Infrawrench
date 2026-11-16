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

/** A credential field the SSH tunnel rewrites: its key and `CredentialField.tunnel`. */
const TunnelField = Schema.Struct({
  key: Schema.String,
  tunnel: Schema.Literals(["address", "kubeconfig"]),
});

export class SshTunnelRpcs extends RpcGroup.make(
  Rpc.make("SshTunnelOpen", { payload: SshTunnelConfig, success: OpenedTunnel, error: SshError }),
  Rpc.make("SshTunnelClose", { payload: { tunnelId: Schema.String } }),
  /**
   * A local account's credentials pointed at its SSH tunnel (`ssh_tunnel_configs`),
   * opened first when it is not: the `fields` its plugin marked `tunnel`, and only
   * their addresses. Unchanged when the account has no tunnel. `peer` is set for a
   * peer plugin's credentials, which only an address naming the tunnel's remote end
   * changes. What it answers is for a client to connect with, never to store.
   */
  Rpc.make("SshTunnelAccountCredentials", {
    payload: {
      accountId: Schema.String.check(Schema.isBetweenLength(1, 128)),
      fields: Schema.Array(TunnelField),
      credentials: Schema.Record(Schema.String, Schema.String),
      peer: Schema.optionalKey(Schema.Boolean),
    },
    success: Schema.Record(Schema.String, Schema.String),
    error: SshError,
  }),
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
