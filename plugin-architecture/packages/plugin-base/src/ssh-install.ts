/** A plugin owns enrollment; the host supplies an authenticated SSH transport. */
export interface SshInstallResult {
  message: string;
  address?: string;
  warnings?: string[];
  /**
   * Opaque, plugin-owned handle to what was installed (e.g. a tailnet device
   * id). A host that later destroys the server passes it back to
   * `PluginClient.releaseSshInstall` so the plugin can clean up after it.
   */
  ref?: string;
}

export interface SshInstallContext {
  /** Reject on a non-zero exit. Commands and their output must not be audit-logged. */
  exec(command: string): Promise<string>;
}

export interface SshInstallAccount {
  accountId: string;
  displayName: string;
  pluginId: string;
  serviceName: string;
  description: string;
  /** The plugin's manifest logo, for pickers. */
  logoSvg?: string;
}

export interface SshInstallInput {
  installerAccountId: string;
  target: { accountId: string; resourceTypeId: string; resourceId: string };
  sshKeyId?: string | undefined;
  username?: string | undefined;
  port?: number | undefined;
}
