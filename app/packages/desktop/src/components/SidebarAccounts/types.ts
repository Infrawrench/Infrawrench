export interface Account {
  id: string;
  pluginId: string;
  displayName: string;
  encrypted_credentials: string;
  credentials_iv: string;
  /** True when this account lives in a cloud workspace: credentials are
   * server-side, so decrypt/tunnel/secret-export features are disabled here. */
  cloudManaged?: boolean;
  /** Provider OAuth state: null for a pasted credential. */
  oauthStatus?: "connected" | "reconnect_required" | null;
}

export interface PluginGroup {
  pluginId: string;
  displayName: string;
  logoSvg: string;
  accounts: Account[];
  /** This mode can run the plugin's OAuth flow, so Reconnect can show. */
  oauthAvailable?: boolean;
}
