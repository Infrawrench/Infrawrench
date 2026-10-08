// Build-time environment electron-vite inlines into the main process.
// Only `MAIN_VITE_`-prefixed variables reach main; see
// electron/provider-oauth/build-env.ts for the one reader.

interface ImportMetaEnv {
  /**
   * The desktop app's public OAuth client id for a plugin, set at build time:
   * `MAIN_VITE_PROVIDER_OAUTH_<ID>_CLIENT_ID`, where `<ID>` is
   * `oauthEnvPrefix(pluginId)` minus its `PROVIDER_OAUTH_` prefix. Unset means
   * the plugin shows no "Connect" button for local accounts.
   */
  readonly [key: `MAIN_VITE_PROVIDER_OAUTH_${string}_CLIENT_ID`]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
