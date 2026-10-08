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
 */
import {
  OAUTH_CREDENTIAL_KEY,
  applyOAuthTokens,
  readOAuthGrantState,
  type PluginManifest,
} from "@infrawrench/plugin-base";

import { unsealGrant } from "./seal";

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

function hasSubmittedGrant(credentials: Record<string, string>): boolean {
  const value = credentials[OAUTH_CREDENTIAL_KEY];
  return typeof value === "string" && value.length > 0;
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
