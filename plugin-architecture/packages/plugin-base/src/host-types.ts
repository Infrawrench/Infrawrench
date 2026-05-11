/**
 * Shared host-side connection / transport types used by both the desktop
 * Electron main process and the web Node.js server when proxying SSH and
 * SFTP traffic. These describe wire-level parameters, not plugin contracts.
 *
 * They live in plugin-base because it is the only package that is a
 * dependency of every host process (electron main, web server, renderer)
 * AND has zero runtime dependencies — making it safe to import from any
 * Node.js or browser context.
 */

/** SSH/SFTP connection configuration. */
export interface SftpConfig {
  host: string;
  port: number;
  username: string;
  /** PEM-encoded private key. May be a sentinel value (e.g. "PAGEANT") on platforms that route through an SSH agent. */
  privateKey: string;
}

/** Plain SSH connection configuration (used for ad-hoc command execution). */
export interface SshConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

/** Local-forwarding SSH tunnel configuration. */
export interface SshTunnelConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** PEM-encoded private key. May be a sentinel value (e.g. "PAGEANT") on platforms that route through an SSH agent. */
  privateKey: string;
  remoteHost: string;
  remotePort: number;
}

/** Per-pin probe status returned by the dashboard `/probe-pins` API and
 * mirrored over the desktop `cloud_probe_pins` IPC. */
export interface ProbeStatus {
  phase: "ok" | "error";
  resourceCounts?: Array<{ typeLabel: string; count: number }>;
  stats?: Array<{ label: string; value: string; variant?: string }>;
  sparkline?: Array<{ timestamp: number; value: number }>;
  sparklineLabel?: string;
  error?: string;
}

/** Why an interactive SSH host-key prompt is being raised. */
export type HostKeyPromptKind = "first-connect" | "mismatch";

/**
 * Payload sent over the `ssh_host_key_prompt` IPC channel from the desktop
 * Electron main process to the renderer, asking the user to accept or deny
 * an unknown or changed SSH host key. The renderer replies on the
 * `ssh_host_key_decide` channel keyed by `requestId`.
 */
export interface HostKeyPromptPayload {
  requestId: string;
  host: string;
  port: number;
  kind: HostKeyPromptKind;
  presentedFingerprint: string;
  /** Set when `kind === "mismatch"`. */
  storedFingerprint?: string;
}
