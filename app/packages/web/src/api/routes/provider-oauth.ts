/**
 * Provider OAuth ("Connect with X") for account credentials.
 *
 * - `POST /api/org/:orgId/provider-oauth/:pluginId/authorize` (org-scoped,
 *   `accounts:write`): returns the provider's consent URL. Everything the
 *   callback needs, the PKCE verifier included, rides in a sealed `state`
 *   (`server-core/provider-oauth/seal.ts`), so no cookie is involved and the
 *   desktop can open the system browser, which has no web session.
 * - `GET /api/provider-oauth/:pluginId/callback` (unauthenticated: the
 *   sealed state is the proof): exchanges the code, lets the plugin read the
 *   connected identity, and hands the result back. The refresh token goes
 *   back only inside a sealed grant, which an account save unseals.
 *
 * Nothing is stored here. The result fills the account form, and the user
 * saves it through the ordinary account routes, which accept the sealed
 * grant only for the org, user and plugin it was minted for. Someone who
 * forwards a consent link therefore gains nothing: the result is delivered to
 * whoever finished the consent, never to the link's author.
 *
 * The callback runs plugin hooks, so it is a gateway route
 * (`edge/gateway-routes.ts`).
 */
import { Hono } from "hono";
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
import { db } from "../../db/client";
import { accounts } from "../../db/schema";
import { getPlugin } from "../../plugins/loader";
import { requirePermission } from "../../auth/permissions";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

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

const app = new Hono();

/** POST /api/org/:orgId/provider-oauth/:pluginId/authorize */
app.post("/:pluginId/authorize", async (c) => {
  requirePermission(c, "accounts:write");
  const organizationId = c.get("organizationId");
  const pluginId = c.req.param("pluginId");
  const body = await c.req.json<{ returnTo?: unknown; accountId?: unknown }>().catch(() => null);
  if (!body || (body.returnTo !== "web" && body.returnTo !== "desktop")) {
    return c.json({ error: 'returnTo must be "web" or "desktop"' }, 400);
  }
  if (
    body.accountId !== undefined &&
    body.accountId !== null &&
    typeof body.accountId !== "string"
  ) {
    return c.json({ error: "accountId must be a string" }, 400);
  }
  const returnTo: OAuthReturnTo = body.returnTo;
  const accountId = typeof body.accountId === "string" ? body.accountId : undefined;

  const loaded = await getPlugin(pluginId);
  if (!loaded) return c.json({ error: "Plugin not found" }, 404);
  const { plugin } = loaded;
  const declaration = serverOAuthDeclaration(plugin.manifest);
  const notConfigured = () =>
    c.json(
      { error: `Connecting ${plugin.manifest.displayName} is not configured on this server.` },
      400,
    );
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
      return c.json({ error: "Account not found" }, 404);
    }
  }

  const userId = c.get("session")?.userId;
  if (!userId) return c.json({ error: "A connection must be started by a user." }, 400);

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
      return c.json(
        {
          error: `${plugin.manifest.displayName} did not accept the app registration: ${e instanceof Error ? e.message : String(e)}`,
        },
        400,
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
  return c.json({ url });
});

export { app as providerOAuthRoutes };

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

export const providerOAuthCallbackRoute = new Hono();

/** GET /api/provider-oauth/:pluginId/callback */
providerOAuthCallbackRoute.get("/provider-oauth/:pluginId/callback", async (c) => {
  const pluginId = c.req.param("pluginId");
  const state = await unsealState(c.req.query("state") ?? "");
  const appOrigin = new URL(providerOAuthAppBaseUrl()).origin;

  const respond = (result: ProviderOAuthResult, returnTo: OAuthReturnTo) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    if (returnTo === "desktop") {
      return c.redirect(
        `${DESKTOP_PROVIDER_OAUTH_URL}?payload=${encodeDesktopPayload(result)}`,
        302,
      );
    }
    // The app sets no script CSP (see `security-headers.ts`), so the inline
    // script runs; everything interpolated into it is script-safe JSON.
    return c.html(renderPopupResultPage(result, appOrigin));
  };
  const fail = (error: string, returnTo: OAuthReturnTo = "web") =>
    respond({ type: PROVIDER_OAUTH_MESSAGE_TYPE, ok: false, pluginId, error }, returnTo);

  if (!state || state.pluginId !== pluginId) {
    return fail("This sign-in link expired or is not valid. Start the connection again.");
  }
  const returnTo = state.returnTo;

  const providerError = c.req.query("error");
  if (providerError) {
    return fail(describeProviderError(providerError, c.req.query("error_description")), returnTo);
  }
  const code = c.req.query("code");
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

  return respond(
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
  );
});
