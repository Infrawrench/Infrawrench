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
  /** Absent only for a public server client (`clients.server.auth: "none"`). */
  clientSecret?: string;
}

/**
 * The configured server client for a plugin, or null when a required
 * variable is missing. A public client (`publicClient`, the declaration's
 * `auth: "none"`) needs only the id; a confidential one needs both.
 */
export function serverOAuthClient(
  pluginId: string,
  publicClient = false,
): ServerOAuthClient | null {
  const prefix = oauthEnvPrefix(pluginId);
  const clientId = process.env[`${prefix}_CLIENT_ID`]?.trim();
  if (!clientId) return null;
  if (publicClient) return { clientId };
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!clientSecret) return null;
  return { clientId, clientSecret };
}

/** True when the server client is public: PKCE, no secret, none sent. */
export function isPublicServerClient(declaration: OAuthDeclaration): boolean {
  return declaration.clients.server?.auth === "none";
}

/** A client registered for one flow (`clientRegistration: "dynamic"`). */
export interface RegisteredOAuthClient {
  clientId: string;
  clientSecret?: string;
}

/** How the declaration obtains its client id; `static` when unset. */
export function oauthClientRegistration(
  declaration: OAuthDeclaration,
): NonNullable<OAuthDeclaration["clientRegistration"]> {
  return declaration.clientRegistration ?? "static";
}

/**
 * The plugin's OAuth declaration when this server can run its flow: the
 * manifest declares a server client, and either the client needs no
 * configuration (`none`, `dynamic`) or both variables are set. Null
 * otherwise, which is what hides the Connect button.
 */
export function serverOAuthDeclaration(manifest: PluginManifest): OAuthDeclaration | null {
  const declaration = manifest.oauth;
  if (!declaration?.clients.server) return null;
  if (oauthClientRegistration(declaration) !== "static") return declaration;
  return serverOAuthClient(manifest.id, isPublicServerClient(declaration)) ? declaration : null;
}

/** Token-endpoint client identity for the server client of `declaration`. */
export function serverClientCredentials(
  declaration: OAuthDeclaration,
  client: ServerOAuthClient,
): OAuthClientCredentials {
  if (isPublicServerClient(declaration) || !client.clientSecret) {
    return { clientId: client.clientId, auth: "none" };
  }
  return {
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    auth: declaration.clients.server?.auth ?? "client_secret_post",
  };
}

/** Token-endpoint identity for a dynamically registered client. */
export function registeredClientCredentials(
  declaration: OAuthDeclaration,
  client: RegisteredOAuthClient,
): OAuthClientCredentials {
  return serverClientCredentials(declaration, client);
}

/**
 * The client for a flow or refresh that is not dynamically registered:
 * `static` reads the env variables (null when unset), `none` is an empty
 * public client. Null for `dynamic`, whose client comes from the flow.
 */
export function configuredClientCredentials(
  manifest: PluginManifest,
): OAuthClientCredentials | null {
  const declaration = manifest.oauth;
  if (!declaration) return null;
  const registration = oauthClientRegistration(declaration);
  if (registration === "none") return { clientId: "", auth: "none" };
  if (registration === "dynamic") return null;
  const client = serverOAuthClient(manifest.id, isPublicServerClient(declaration));
  return client ? serverClientCredentials(declaration, client) : null;
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
