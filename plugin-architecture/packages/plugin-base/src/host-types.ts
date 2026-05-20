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

/** Kubernetes `kubectl exec` PTY config used by both the web Node server and the desktop Electron main. */
export interface K8sExecConfig {
  kubeconfig: string;
  namespace: string;
  podName: string;
  containerName?: string | undefined;
  cols: number;
  rows: number;
}

/** k9s PTY config used by both the web Node server and the desktop Electron main. */
export interface K9sConfig {
  kubeconfig: string;
  namespace?: string | undefined;
  cols: number;
  rows: number;
}

/**
 * Context handed to a credential rewriter before a plugin client is created.
 *
 * Rewriters live in host-side packages (`@infrawrench/server-core` on the web
 * server, the desktop renderer's own registry) but the shape they receive is
 * identical across hosts — both web and desktop want to inject the same
 * account/resource metadata. Keeping the contract in plugin-base lets both
 * hosts share a single declaration without dragging in DB or filesystem deps.
 */
export interface RewriterContext {
  /** Org the account belongs to. Optional for desktop / single-tenant flows. */
  orgId?: string | undefined;
  /** Account whose credentials are being rewritten. Always present. */
  accountId: string;
  /**
   * The resource the credentials will be used against. Set for rewriters
   * that need resource-level context — e.g. Cloud SQL Auth Proxy needs the
   * cloudsql-instance's `databaseVersion` field and `connectionName` output.
   *
   * Callers that have the parent resource on hand (peer-pane render, resource
   * detail) populate `resourceFields` / `resourceOutputs` directly so rewriters
   * never have to round-trip through storage to read what's already in memory.
   */
  resourcePluginId?: string | undefined;
  resourceTypeId?: string | undefined;
  resourceId?: string | undefined;
  resourceFields?: Record<string, unknown> | undefined;
  resourceOutputs?: Record<string, unknown> | undefined;
}

/** A credential rewriter mutates a plugin's resolved credentials in place before client construction. */
export interface CredentialRewriter {
  /**
   * Mutate `credentials` in place if this rewriter applies to `ctx`. Errors
   * thrown here propagate to the caller; rewriters that can't apply should
   * silently return.
   */
  rewrite(ctx: RewriterContext, credentials: Record<string, string>): Promise<void>;
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
