/**
 * Server-side client configuration for provider OAuth ("Connect with X").
 *
 * Every plugin's confidential client comes from the same two variables,
 * `PROVIDER_OAUTH_<ID>_CLIENT_ID` and `PROVIDER_OAUTH_<ID>_CLIENT_SECRET`
 * (`oauthEnvPrefix`), read here and nowhere else. A plugin whose manifest
 * declares `oauth.clients.server` but whose variables are unset simply shows
 * no Connect button; manual credentials keep working.
 *
 * Variables are read per call, so a test or a late `process.env` write sees
 * the current value.
 */
import {
  oauthEnvPrefix,
  type OAuthClientCredentials,
  type OAuthDeclaration,
  type PluginManifest,
} from "@infrawrench/plugin-base";

import { appBaseUrl } from "../app-url";

export interface ServerOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** The configured server client for a plugin, or null when either variable is missing. */
export function serverOAuthClient(pluginId: string): ServerOAuthClient | null {
  const prefix = oauthEnvPrefix(pluginId);
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * The plugin's OAuth declaration when this server can run its flow: the
 * manifest declares a server client and both variables are set. Null
 * otherwise, which is what hides the Connect button.
 */
export function serverOAuthDeclaration(manifest: PluginManifest): OAuthDeclaration | null {
  const declaration = manifest.oauth;
  if (!declaration?.clients.server) return null;
  return serverOAuthClient(manifest.id) ? declaration : null;
}

/** Token-endpoint client identity for the server client of `declaration`. */
export function serverClientCredentials(
  declaration: OAuthDeclaration,
  client: ServerOAuthClient,
): OAuthClientCredentials {
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    auth: declaration.clients.server?.auth ?? "client_secret_post",
  };
}

/** `APP_URL` without a trailing slash, falling back to the local dev server like Slack's flow. */
export function providerOAuthAppBaseUrl(): string {
  return appBaseUrl() ?? "http://localhost:3000";
}

/**
 * The redirect URI to register with each provider:
 * `<APP_URL>/api/provider-oauth/<pluginId>/callback`. The authorize request
 * and the code exchange must send the same value, so both derive it here.
 */
export function providerOAuthRedirectUri(pluginId: string): string {
  return `${providerOAuthAppBaseUrl()}/api/provider-oauth/${encodeURIComponent(pluginId)}/callback`;
}

/** The listing's `oauth` summary for a plugin, present only when the server can run the flow. */
export function pluginOAuthSummary(manifest: PluginManifest):
  | {
      access: OAuthDeclaration["access"];
      refresh: OAuthDeclaration["refresh"];
      docsUrl?: string;
      tokenField: string;
      clients: ("server" | "desktop")[];
    }
  | undefined {
  const declaration = serverOAuthDeclaration(manifest);
  if (!declaration) return undefined;
  const clients: ("server" | "desktop")[] = ["server"];
  if (declaration.clients.desktop) clients.push("desktop");
  return {
    access: declaration.access,
    refresh: declaration.refresh,
    ...(declaration.docsUrl ? { docsUrl: declaration.docsUrl } : {}),
    tokenField: declaration.tokenField,
    clients,
  };
}
