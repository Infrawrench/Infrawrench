export interface Account {
  id: string;
  pluginId: string;
  displayName: string;
  encrypted_credentials: string;
  credentials_iv: string;
  /** True when this account lives in a cloud workspace — credentials are
   * server-side, so decrypt/tunnel/secret-export features are disabled here. */
  cloudManaged?: boolean;
}

export interface PluginGroup {
  pluginId: string;
  displayName: string;
  logoSvg: string;
  accounts: Account[];
}
