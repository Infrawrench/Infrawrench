/**
 * "Connect with OpenRouter": OpenRouter's OAuth PKCE flow, which mints an
 * ordinary inference API key for the signed-in user.
 *
 * Protocol facts (openrouter.ai/docs/guides/overview/auth/oauth, verified
 * 2026-10):
 * - No app registration and no client id: the consent page is
 *   `https://openrouter.ai/auth?callback_url=...` with an optional PKCE
 *   `code_challenge` / `code_challenge_method` (S256), `key_label` (prefills
 *   the new key's name) and `state` (returned unchanged). It takes
 *   `callback_url`, not `redirect_uri`, hence the plugin's own authorize URL
 *   builder (`clientRegistration: "none"`).
 * - Localhost callbacks are allowed on any port.
 * - The code (valid 10 minutes) is exchanged with
 *   `POST https://openrouter.ai/api/v1/auth/keys` and a JSON body
 *   `{ code, code_verifier, code_challenge_method }`, which answers `{ key }`:
 *   a normal, non-expiring API key. Nothing to refresh.
 *
 * What the key can do: inference on the user's credits (OpenRouter has no
 * narrower key), so `access` is `full`. It is NOT a management key, which
 * OpenRouter only lets you create in its settings: the console API
 * (`/credits`, `/activity`, `/keys`, guardrails, workspaces, BYOK) answers 403
 * to it. A connected account therefore sees the model catalogue, endpoints,
 * providers and the Speech tab; adding a management key unlocks the rest.
 */

import type {
  OAuthAuthorizeUrlParams,
  OAuthDeclaration,
  OAuthExchangeRequest,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { OAuthTokenError } from "@infrawrench/plugin-base";

export const OPENROUTER_OAUTH: OAuthDeclaration = {
  authorizeUrl: "https://openrouter.ai/auth",
  tokenUrl: "https://openrouter.ai/api/v1/auth/keys",
  scopes: [],
  tokenField: "apiKey",
  clients: { server: { pkce: true }, desktop: { loopbackHost: "localhost" } },
  access: "full",
  refresh: "none",
  docsUrl: "https://openrouter.ai/docs/guides/overview/auth/oauth",
  clientRegistration: "none",
};

/** The consent URL: `callback_url` instead of `redirect_uri`, and no client id. */
export function buildOpenRouterAuthorizeUrl(params: OAuthAuthorizeUrlParams): string {
  const url = new URL(OPENROUTER_OAUTH.authorizeUrl);
  url.searchParams.set("callback_url", params.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("key_label", "Infrawrench");
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Exchange the code for an API key. */
export async function exchangeOpenRouterCode(
  request: OAuthExchangeRequest,
): Promise<OAuthTokenSet> {
  const body: Record<string, string> = { code: request.code };
  if (request.codeVerifier) {
    body["code_verifier"] = request.codeVerifier;
    body["code_challenge_method"] = "S256";
  }
  const res = await request.fetch(OPENROUTER_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Keep the raw text for the error below.
  }
  const key = json["key"];
  if (!res.ok || typeof key !== "string" || !key) {
    const error = json["error"];
    const message =
      (error && typeof error === "object" && "message" in error
        ? String((error as { message: unknown }).message)
        : typeof error === "string"
          ? error
          : "") || `OpenRouter's key exchange returned HTTP ${res.status}`;
    throw new OAuthTokenError(message, res.status, false);
  }
  return { accessToken: key, raw: json };
}
