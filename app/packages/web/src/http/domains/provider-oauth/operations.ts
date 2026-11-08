/**
 * Provider OAuth ("Connect with X"), the promise half: each flow is a chain
 * of plugin hooks (client registration, the authorize URL, the code exchange,
 * identity discovery) and sealing, run by the handler as one `legacy` call so
 * every plugin call starts inside the request's scopes.
 *
 * Nothing is stored here. The result fills the account form, and the user
 * saves it through the ordinary account routes, which accept the sealed grant
 * only for the org, user and plugin it was minted for. Someone who forwards a
 * consent link therefore gains nothing: the result is delivered to whoever
 * finished the consent, never to the link's author.
 */
import { Predicate } from "effect";
import { and, eq, isNull } from "drizzle-orm";
import {
  OAUTH_CREDENTIAL_KEY,
  buildOAuthAuthorizeUrl,
  createPkcePair,
  exchangeOAuthCode,
  randomOAuthToken,
  type OAuthAuthorizeUrlParams,
  type OAuthCompletionResult,
  type OAuthExchangeRequest,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";
import {
  GRANT_TTL_MS,
  STATE_TTL_MS,
  providerOAuthAppBaseUrl,
  providerOAuthRedirectUri,
  sealGrant,
  sealState,
  configuredClientCredentials,
  oauthClientRegistration,
  registeredClientCredentials,
  sealableTokens,
  serverOAuthDeclaration,
  unsealState,
  type OAuthReturnTo,
  type RegisteredOAuthClient,
} from "@infrawrench/server-core/provider-oauth";
import { db } from "../../../db/client";
import { accounts } from "../../../db/schema";
import { getPlugin } from "../../../plugins/loader";

export const PROVIDER_OAUTH_MESSAGE_TYPE = "infrawrench:provider-oauth";
export const DESKTOP_PROVIDER_OAUTH_URL = "infrawrench://provider-oauth";

export type ProviderOAuthResult =
  | {
      type: typeof PROVIDER_OAUTH_MESSAGE_TYPE;
      ok: true;
      pluginId: string;
      accountId?: string;
      credentials: Record<string, string>;
      accountName?: string;
    }
  | { type: typeof PROVIDER_OAUTH_MESSAGE_TYPE; ok: false; pluginId: string; error: string };

/** What the authorize endpoint answers: the consent URL, or a refusal in the route's words. */
export type AuthorizeOutcome =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly status: 400 | 404; readonly error: string };

const refuse = (status: 400 | 404, error: string): AuthorizeOutcome => ({
  ok: false,
  status,
  error,
});

const field = (body: unknown, name: string): unknown =>
  Predicate.hasProperty(body, name) ? body[name] : undefined;

/**
 * `POST /api/org/:orgId/provider-oauth/:pluginId/authorize` past its
 * permission gate. `body` is the parsed JSON, or null when it was absent or
 * not JSON.
 */
export async function authorizeProviderOAuth(args: {
  readonly organizationId: string;
  readonly userId: string;
  readonly pluginId: string;
  readonly body: unknown;
}): Promise<AuthorizeOutcome> {
  const { organizationId, pluginId, body } = args;
  const returnToValue = field(body, "returnTo");
  if (!body || (returnToValue !== "web" && returnToValue !== "desktop")) {
    return refuse(400, 'returnTo must be "web" or "desktop"');
  }
  const accountIdValue = field(body, "accountId");
  if (
    accountIdValue !== undefined &&
    accountIdValue !== null &&
    typeof accountIdValue !== "string"
  ) {
    return refuse(400, "accountId must be a string");
  }
  const returnTo: OAuthReturnTo = returnToValue;
  const accountId = typeof accountIdValue === "string" ? accountIdValue : undefined;

  const loaded = await getPlugin(pluginId);
  if (!loaded) return refuse(404, "Plugin not found");
  const { plugin } = loaded;
  const declaration = serverOAuthDeclaration(plugin.manifest);
  const notConfigured = () =>
    refuse(400, `Connecting ${plugin.manifest.displayName} is not configured on this server.`);
  if (!declaration) return notConfigured();

  if (accountId) {
    const [account] = await db
      .select({ pluginId: accounts.pluginId })
      .from(accounts)
      .where(
        and(
          eq(accounts.id, accountId),
          eq(accounts.organizationId, organizationId),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);
    if (!account || account.pluginId !== pluginId) {
      return refuse(404, "Account not found");
    }
  }

  const userId = args.userId;
  if (!userId) return refuse(400, "A connection must be started by a user.");

  // The client: configured (`static`), none needed (`none`, an empty id), or
  // registered for this flow by the plugin (`dynamic`), in which case it
  // rides in the sealed state to the exchange and on into the grant.
  let clientId: string;
  let registeredClient: RegisteredOAuthClient | undefined;
  if (oauthClientRegistration(declaration) === "dynamic") {
    if (!plugin.registerOAuthClient) return notConfigured();
    try {
      registeredClient = await plugin.registerOAuthClient({
        redirectUri: providerOAuthRedirectUri(pluginId),
        fetch,
      });
    } catch (e) {
      console.error(`[provider-oauth] ${pluginId} client registration failed:`, e);
      return refuse(
        400,
        `${plugin.manifest.displayName} did not accept the app registration: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    clientId = registeredClient.clientId;
  } else {
    const configured = configuredClientCredentials(plugin.manifest);
    if (!configured) return notConfigured();
    clientId = configured.clientId;
  }

  const pkce = declaration.clients.server?.pkce ? await createPkcePair() : null;
  const state = await sealState({
    orgId: organizationId,
    userId,
    pluginId,
    returnTo,
    ...(accountId ? { accountId } : {}),
    ...(pkce ? { codeVerifier: pkce.verifier } : {}),
    ...(registeredClient ? { registeredClient } : {}),
    nonce: randomOAuthToken(16),
    exp: Date.now() + STATE_TTL_MS,
  });
  const params: OAuthAuthorizeUrlParams = {
    clientId,
    redirectUri: providerOAuthRedirectUri(pluginId),
    state,
    ...(pkce ? { codeChallenge: pkce.challenge } : {}),
  };
  const url = plugin.buildOAuthAuthorizeUrl
    ? plugin.buildOAuthAuthorizeUrl(params)
    : buildOAuthAuthorizeUrl(declaration, params);
  return { ok: true, url };
}

/** Encode a result for the desktop deep link: base64url of the UTF-8 JSON, unpadded. */
export function encodeDesktopPayload(result: ProviderOAuthResult): string {
  return Buffer.from(JSON.stringify(result), "utf8").toString("base64url");
}

/** JSON that is safe inside an inline `<script>`: nothing can close the element or break the line. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The page the popup lands on: posts the result to the window that opened it
 * (only to the app's own origin), then closes. Without an opener (a strict
 * COOP on the provider's pages severs it) it posts on the same-origin
 * `BroadcastChannel("infrawrench:provider-oauth")` instead, which only this
 * app's own pages can hear; the token is never sent anywhere else.
 */
export function renderPopupResultPage(result: ProviderOAuthResult, appOrigin: string): string {
  const heading = result.ok ? "Connected" : "Connection failed";
  const detail = result.ok
    ? "You can close this window and finish adding the account in Infrawrench."
    : `${result.error} You can close this window and try again.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Infrawrench</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee; } }
  main { max-width: 28rem; padding: 1.5rem; text-align: center; }
  h1 { font-size: 1.25rem; }
  p { line-height: 1.5; opacity: 0.8; }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(detail)}</p>
</main>
<script>
(function () {
  var payload = ${scriptSafeJson(result)};
  var origin = ${scriptSafeJson(appOrigin)};
  if (window.opener && !window.opener.closed) {
    try { window.opener.postMessage(payload, origin); } catch (e) {}
    window.close();
    return;
  }
  // A provider with a strict Cross-Origin-Opener-Policy severs the opener;
  // the app listens on a same-origin channel as well.
  if (typeof BroadcastChannel === "function") {
    try {
      var channel = new BroadcastChannel(${scriptSafeJson(PROVIDER_OAUTH_MESSAGE_TYPE)});
      channel.postMessage(payload);
      channel.close();
      window.close();
    } catch (e) {}
  }
})();
</script>
</body>
</html>`;
}

function describeProviderError(error: string, description: string | undefined): string {
  if (error === "access_denied") return "The request was cancelled at the provider.";
  return description
    ? `The provider refused the request: ${description}`
    : `The provider refused the request (${error}).`;
}

/** How the callback hands its result back: the desktop deep link, or the popup page. */
export type CallbackDelivery =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "page"; readonly html: string };

function deliver(
  result: ProviderOAuthResult,
  returnTo: OAuthReturnTo,
  appOrigin: string,
): CallbackDelivery {
  if (returnTo === "desktop") {
    return {
      kind: "redirect",
      location: `${DESKTOP_PROVIDER_OAUTH_URL}?payload=${encodeDesktopPayload(result)}`,
    };
  }
  // The app sets no script CSP (see `security-headers.ts`), so the inline
  // script runs; everything interpolated into it is script-safe JSON.
  return { kind: "page", html: renderPopupResultPage(result, appOrigin) };
}

/**
 * `GET /api/provider-oauth/:pluginId/callback`: exchange the code, let the
 * plugin read the connected identity, and hand the result back. The refresh
 * token goes back only inside a sealed grant, which an account save unseals.
 */
export async function completeProviderOAuth(args: {
  readonly pluginId: string;
  readonly query: (name: string) => string | undefined;
}): Promise<CallbackDelivery> {
  const { pluginId, query } = args;
  const state = await unsealState(query("state") ?? "");
  const appOrigin = new URL(providerOAuthAppBaseUrl()).origin;

  const fail = (error: string, returnTo: OAuthReturnTo = "web") =>
    deliver({ type: PROVIDER_OAUTH_MESSAGE_TYPE, ok: false, pluginId, error }, returnTo, appOrigin);

  if (!state || state.pluginId !== pluginId) {
    return fail("This sign-in link expired or is not valid. Start the connection again.");
  }
  const returnTo = state.returnTo;

  const providerError = query("error");
  if (providerError) {
    return fail(describeProviderError(providerError, query("error_description")), returnTo);
  }
  const code = query("code");
  if (!code) return fail("The provider did not return an authorization code.", returnTo);

  const loaded = await getPlugin(pluginId);
  const declaration = loaded ? serverOAuthDeclaration(loaded.plugin.manifest) : null;
  const client =
    loaded && declaration
      ? state.registeredClient
        ? registeredClientCredentials(declaration, state.registeredClient)
        : configuredClientCredentials(loaded.plugin.manifest)
      : null;
  if (!loaded || !declaration || !client) {
    return fail("Connecting this provider is not configured on this server.", returnTo);
  }
  const { plugin } = loaded;

  let tokens: OAuthTokenSet;
  try {
    const request: OAuthExchangeRequest = {
      code,
      redirectUri: providerOAuthRedirectUri(pluginId),
      ...(state.codeVerifier ? { codeVerifier: state.codeVerifier } : {}),
      client,
      fetch,
    };
    tokens = plugin.exchangeOAuthCode
      ? await plugin.exchangeOAuthCode(request)
      : await exchangeOAuthCode(declaration, request);
  } catch (e) {
    console.error(`[provider-oauth] ${pluginId} code exchange failed:`, e);
    return fail(
      `${plugin.manifest.displayName} did not accept the sign-in: ${e instanceof Error ? e.message : String(e)}`,
      returnTo,
    );
  }

  // Identity discovery only pre-fills the form; when it fails the user can
  // still fill the remaining fields by hand, so it does not fail the connect.
  let completion: OAuthCompletionResult = {};
  if (plugin.completeOAuthConnection) {
    try {
      completion = await plugin.completeOAuthConnection(tokens, { client: "server", fetch });
    } catch (e) {
      console.warn(`[provider-oauth] ${pluginId} completeOAuthConnection failed:`, e);
    }
  }
  const prefilled: Record<string, string> = {};
  for (const [key, value] of Object.entries(completion.credentials ?? {})) {
    if (key === declaration.tokenField || key === OAUTH_CREDENTIAL_KEY) continue;
    if (typeof value === "string") prefilled[key] = value;
  }

  const sealed = await sealGrant({
    orgId: state.orgId,
    userId: state.userId,
    pluginId,
    tokens: sealableTokens(tokens),
    client: "server",
    ...(state.registeredClient ? { registeredClient: state.registeredClient } : {}),
    exp: Date.now() + GRANT_TTL_MS,
  });

  return deliver(
    {
      type: PROVIDER_OAUTH_MESSAGE_TYPE,
      ok: true,
      pluginId,
      ...(state.accountId ? { accountId: state.accountId } : {}),
      credentials: {
        ...prefilled,
        [declaration.tokenField]: tokens.accessToken,
        [OAUTH_CREDENTIAL_KEY]: sealed,
      },
      ...(completion.accountName ? { accountName: completion.accountName } : {}),
    },
    returnTo,
    appOrigin,
  );
}
