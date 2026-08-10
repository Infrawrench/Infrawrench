/**
 * Node.js-side driver interfaces — implemented by plugin packages and run
 * inside the Electron main process (or any Node.js host).
 *
 * These are the "server-side" counterparts to the browser-side PluginClient.
 * Plugins that need native Node.js capabilities (native DB clients, Docker SDK,
 * storage downloads, etc.) export one of these from their `./node-driver` path.
 *
 * The host (Electron main) registers them and dispatches generic IPC calls —
 * it never contains plugin-specific logic.
 */

/**
 * Optional per-call options for a SQL driver. Currently used to pass a
 * vendor-provided CA cert (e.g. DigitalOcean's managed-DB CA) so the driver
 * can keep chain verification on while trusting a non-public CA. Drivers
 * that don't understand a given option should ignore it.
 */
export interface SqlNodeDriverOptions {
  caCert?: string;
}

/** SQL database driver — runs queries against a live connection string. */
export interface SqlNodeDriver {
  readonly id: string;
  query(
    connectionString: string,
    sql: string,
    options?: SqlNodeDriverOptions,
  ): Promise<Record<string, unknown>[]>;
  execute(
    connectionString: string,
    sql: string,
    params: unknown[],
    options?: SqlNodeDriverOptions,
  ): Promise<number>;
}

/** Key-value / Redis-compatible driver. */
export interface KvNodeDriver {
  readonly id: string;
  command(connectionString: string, cmd: string, args: (string | number)[]): Promise<unknown>;
}

/** Docker daemon driver. */
export interface DockerNodeDriver {
  readonly id: string;
  command(dockerHost: string, op: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Kubernetes driver — wraps the official @kubernetes/client-node SDK in the
 * host process. Unlike the browser-fallback K8sFetcher (which parses
 * kubeconfig YAML by hand), this driver understands `exec` credential
 * plugins (gke-gcloud-auth-plugin, aws-iam-authenticator), `auth-provider`,
 * OIDC, and multi-context kubeconfigs.
 */
export interface K8sNodeDriver {
  readonly id: string;
  command(kubeconfig: string, op: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Object-storage driver — lets plugins own the download logic for their
 * storage provider so the host never hard-codes provider-specific URLs or auth.
 */
export interface StorageDownloadOptions {
  /**
   * Host HTTP bridge. When the account is bound to a bastion, the driver
   * should route grant + byte fetches through this so they stay on the
   * tunnelled allowlist path instead of the host's default network.
   */
  http?: import("./manifest.js").HttpHostServices;
}

export interface StorageNodeDriver {
  /** Must match the plugin manifest `id` — used by the host to dispatch. */
  readonly pluginId: string;
  /**
   * Download a single object to `destPath`.
   * The host calls this in a loop and handles directory creation.
   */
  downloadFile(
    bucket: string,
    key: string,
    accessToken: string,
    destPath: string,
    options?: StorageDownloadOptions,
  ): Promise<void>;
}

/**
 * Aggregate of all node drivers a plugin can contribute.
 * Plugins export this from `./node-driver`.
 */
export interface PluginNodeDriver {
  sql?: SqlNodeDriver;
  kv?: KvNodeDriver;
  docker?: DockerNodeDriver;
  k8s?: K8sNodeDriver;
  storage?: StorageNodeDriver;
}
