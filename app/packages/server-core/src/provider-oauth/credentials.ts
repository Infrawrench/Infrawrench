/**
 * Turning what a client submits into what is stored, for accounts whose
 * credentials may carry provider OAuth grant state under `__oauth`.
 *
 * A browser never holds a real grant: after the callback it holds a sealed
 * one (see `seal.ts`), and the only `__oauth` value an account create or
 * credential update accepts is such a sealed grant, minted for this org,
 * this user and this plugin, and not yet expired. Anything else is refused,
 * so a client cannot plant grant state (say, a refresh token for another
 * client) that the server would then use.
 *
 * Clients do see a *redacted* grant: `GET .../credentials` returns the grant
 * state without its refresh token (and registered client secret), because
 * plugins branch on `readOAuthGrantState` (Bearer vs Basic, say) and the
 * desktop in cloud mode builds clients from those credentials. When such a
 * copy comes back on a save it counts as no grant at all: the stored grant is
 * kept by the preservation rule, never replaced by the copy.
 */
import {
  OAUTH_CREDENTIAL_KEY,
  applyOAuthTokens,
  readOAuthGrantState,
  type OAuthGrantState,
  type PluginManifest,
} from "@infrawrench/plugin-base";

import type { RegisteredOAuthClient } from "./config";
import { unsealGrant } from "./seal";

/**
 * Grant state as the server stores it. `clientSecret` sits beside
 * `clientId` for a dynamically registered confidential client; it never
 * leaves the server (see {@link redactOAuthGrantState}).
 */
export type ServerOAuthGrantState = OAuthGrantState & { clientSecret?: string };

/** Parse the stored grant state, including the server-only fields. */
export function readServerGrantState(
  credentials: Record<string, string>,
): ServerOAuthGrantState | null {
  return readOAuthGrantState(credentials) as ServerOAuthGrantState | null;
}

/**
 * The credentials a client may see: the grant state minus the refresh token
 * and any registered client secret. Plugins still find the grant (and branch
 * on it); nothing in it can mint a token.
 */
export function redactOAuthGrantState(credentials: Record<string, string>): Record<string, string> {
  const { [OAUTH_CREDENTIAL_KEY]: raw, ...rest } = credentials;
  if (!raw) return rest;
  const state = readServerGrantState(credentials);
  if (!state) return rest;
  const { refreshToken: _refreshToken, clientSecret: _clientSecret, ...redacted } = state;
  return { ...rest, [OAUTH_CREDENTIAL_KEY]: JSON.stringify(redacted) };
}

/** True for a redacted copy handed out by {@link redactOAuthGrantState}. */
function isRedactedGrantCopy(value: string): boolean {
  if (!value.startsWith("{")) return false;
  const state = readServerGrantState({ [OAUTH_CREDENTIAL_KEY]: value });
  return state !== null && !state.refreshToken && !state.clientSecret;
}

/** Write a dynamically registered client into the grant state JSON. */
function withRegisteredClient(
  credentials: Record<string, string>,
  client: RegisteredOAuthClient | undefined,
): void {
  if (!client) return;
  const state = readServerGrantState(credentials);
  if (!state) return;
  const next: ServerOAuthGrantState = {
    ...state,
    clientId: client.clientId,
    ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
  };
  credentials[OAUTH_CREDENTIAL_KEY] = JSON.stringify(next);
}

export type OAuthStatus = "connected" | "reconnect_required";

/** A submitted `__oauth` that cannot be used. Routes answer it with HTTP 400. */
export class OAuthCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthCredentialError";
  }
}

export interface SubmittedCredentialContext {
  manifest: PluginManifest;
  organizationId: string;
  /** The signed-in user (or API key owner) saving the account. */
  userId: string | undefined;
}

export interface AcceptedCredentials {
  credentials: Record<string, string>;
  /** What `accounts.oauth_status` becomes: null for a pasted credential. */
  oauthStatus: OAuthStatus | null;
}

/** A non-empty `__oauth` that is not a redacted copy: it must be a sealed grant. */
function hasSubmittedGrant(credentials: Record<string, string>): boolean {
  const value = credentials[OAUTH_CREDENTIAL_KEY];
  return typeof value === "string" && value.length > 0 && !isRedactedGrantCopy(value);
}

function withoutGrantKey(credentials: Record<string, string>): Record<string, string> {
  const { [OAUTH_CREDENTIAL_KEY]: _omitted, ...rest } = credentials;
  return rest;
}

/**
 * Validate and open the credentials of a new account (or a probe of
 * not-yet-saved credentials). A sealed grant is replaced by the real grant
 * state and the access token it carries; credentials without one pass
 * through untouched.
 */
export async function acceptSubmittedCredentials(
  credentials: Record<string, string>,
  context: SubmittedCredentialContext,
): Promise<AcceptedCredentials> {
  if (!hasSubmittedGrant(credentials)) {
    return { credentials: withoutGrantKey(credentials), oauthStatus: null };
  }
  const declaration = context.manifest.oauth;
  if (!declaration) {
    throw new OAuthCredentialError(
      `${context.manifest.displayName} does not support connecting with OAuth.`,
    );
  }
  const grant = await unsealGrant(credentials[OAUTH_CREDENTIAL_KEY]!);
  if (
    !grant ||
    grant.orgId !== context.organizationId ||
    !context.userId ||
    grant.userId !== context.userId ||
    grant.pluginId !== context.manifest.id ||
    grant.client !== "server" ||
    typeof grant.tokens?.accessToken !== "string"
  ) {
    throw new OAuthCredentialError(
      `The ${context.manifest.displayName} connection expired or is not valid here. Connect again.`,
    );
  }
  const opened = withoutGrantKey(credentials);
  applyOAuthTokens(declaration, opened, { ...grant.tokens, raw: {} }, "server");
  withRegisteredClient(opened, grant.registeredClient);
  return { credentials: opened, oauthStatus: "connected" };
}

/**
 * The credentials to store for `PUT .../credentials`.
 *
 * - A sealed grant in the body: a (re)connect; validated like a create.
 * - No grant in the body, but the stored credentials have one: editing a
 *   picker must not disconnect, so when the token field is absent or still
 *   holds the stored token the stored token and grant are kept. A different
 *   token means the user switched to a pasted one, and the grant is dropped.
 * - Neither: a plain credential edit.
 */
export async function resolveCredentialUpdate(
  submitted: Record<string, string>,
  stored: Record<string, string>,
  context: SubmittedCredentialContext & { currentStatus: OAuthStatus | null },
): Promise<AcceptedCredentials> {
  if (hasSubmittedGrant(submitted)) return acceptSubmittedCredentials(submitted, context);

  const next = withoutGrantKey(submitted);
  const declaration = context.manifest.oauth;
  const storedGrant = stored[OAUTH_CREDENTIAL_KEY];
  if (!declaration || !storedGrant || !readOAuthGrantState(stored)) {
    return { credentials: next, oauthStatus: null };
  }
  const tokenField = declaration.tokenField;
  const submittedToken = next[tokenField];
  if (submittedToken && submittedToken !== stored[tokenField]) {
    return { credentials: next, oauthStatus: null };
  }
  const storedToken = stored[tokenField];
  return {
    credentials: {
      ...next,
      ...(storedToken !== undefined ? { [tokenField]: storedToken } : {}),
      [OAUTH_CREDENTIAL_KEY]: storedGrant,
    },
    oauthStatus: context.currentStatus ?? "connected",
  };
}
