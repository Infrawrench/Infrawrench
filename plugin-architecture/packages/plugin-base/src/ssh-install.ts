/** A plugin owns enrollment; the host supplies an authenticated SSH transport. */
export interface SshInstallResult {
  message: string;
  address?: string;
  warnings?: string[];
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
}

export interface SshInstallInput {
  installerAccountId: string;
  target: { accountId: string; resourceTypeId: string; resourceId: string };
  sshKeyId?: string | undefined;
  username?: string | undefined;
  port?: number | undefined;
}
