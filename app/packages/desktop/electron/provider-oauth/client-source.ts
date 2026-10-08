/**
 * Which plugins a LOCAL desktop account can connect with OAuth, and how the
 * flow gets its client. Pure (the build-time client id lookup is injected),
 * so the rule is testable without Electron.
 *
 * Only `manifest.oauth.clients.desktop` matters here. A plugin with only a
 * server client is server-only and never offered for local accounts, however
 * its server client authenticates (a public `auth: "none"` server client is
 * still the server's client, with a redirect the desktop cannot receive).
 */
import type { OAuthPluginHooks, PluginManifest } from "@infrawrench/plugin-base";
import type { LoopbackClient } from "./loopback";

/** The slice of a loaded plugin this rule reads. */
export interface OAuthCapablePlugin {
  manifest: Pick<PluginManifest, "id" | "oauth">;
  registerOAuthClient?: OAuthPluginHooks["registerOAuthClient"];
}

export type LocalClientSource = LoopbackClient | ((redirectUri: string) => Promise<LoopbackClient>);

/**
 * How a local flow gets its client, or null when this build cannot run it:
 * `static` needs the build-time id, `none` needs nothing, `dynamic` needs the
 * plugin's registration hook.
 */
export function localClientSource(
  plugin: OAuthCapablePlugin,
  getClientId: (pluginId: string) => string | undefined,
  doFetch: typeof fetch = (input, init) => fetch(input, init),
): LocalClientSource | null {
  const declaration = plugin.manifest.oauth;
  if (!declaration?.clients.desktop) return null;
  switch (declaration.clientRegistration ?? "static") {
    case "none":
      return { clientId: "" };
    case "dynamic": {
      const register = plugin.registerOAuthClient?.bind(plugin);
      if (!register) return null;
      return async (redirectUri) => {
        const registered = await register({ redirectUri, fetch: doFetch });
        return {
          clientId: registered.clientId,
          ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}),
        };
      };
    }
    default: {
      const clientId = getClientId(plugin.manifest.id);
      return clientId ? { clientId } : null;
    }
  }
}

/** Plugin ids the `provider_oauth_local_clients` IPC reports. */
export function localClientPluginIds(
  plugins: readonly OAuthCapablePlugin[],
  getClientId: (pluginId: string) => string | undefined,
): string[] {
  return plugins
    .filter((p) => localClientSource(p, getClientId) !== null)
    .map((p) => p.manifest.id);
}
