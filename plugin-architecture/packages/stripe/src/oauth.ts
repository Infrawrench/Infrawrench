/**
 * "Connect with Stripe": the OAuth declaration and hooks.
 *
 * Stripe Apps OAuth (docs.stripe.com/stripe-apps/api-authentication/oauth,
 * verified 2026-10):
 *   - Needs a public Stripe App with `stripe_api_access_type: oauth`, its
 *     `allowed_redirect_uris`, and the permissions it uses; what the user
 *     grants is exactly that permission list (set on the app, not per flow,
 *     so `scopes` is empty).
 *   - Install link `https://marketplace.stripe.com/oauth/v2/authorize` with
 *     `client_id`, `redirect_uri` (must match the manifest; HTTPS in live
 *     mode) and `state`. Nothing else is documented, hence the
 *     `buildOAuthAuthorizeUrl` hook.
 *   - The code (single use, 5 minutes) is exchanged at
 *     `POST https://api.stripe.com/v1/oauth/token` with `grant_type` and
 *     `code`, authenticated with the app developer's own secret key (`-u
 *     sk_live_…:`). That key is the "client secret" here
 *     (`PROVIDER_OAUTH_STRIPE_CLIENT_SECRET`), and the app's `ca_…` id is the
 *     client id. The response is `{ access_token, refresh_token, livemode,
 *     scope: "stripe_apps", stripe_publishable_key, stripe_user_id,
 *     token_type }`.
 *   - Access tokens last one hour; refresh tokens a year and roll on every
 *     refresh (`grant_type=refresh_token`, same secret key). The host's
 *     generic refresh sends the key as the `client_secret` form field, which
 *     Stripe's API accepts as the request's API key.
 *   - The access token is used like an API key (Bearer), so the client needs
 *     no change beyond reading its mode (see `keyMode`).
 *   - Server only: both calls need our secret key.
 */
import {
  OAuthTokenError,
  parseOAuthTokenResponse,
  type OAuthAuthorizeUrlParams,
  type OAuthCompletionContext,
  type OAuthCompletionResult,
  type OAuthDeclaration,
  type OAuthExchangeRequest,
  type OAuthTokenSet,
} from "@infrawrench/plugin-base";

export const stripeOAuth: OAuthDeclaration = {
  authorizeUrl: "https://marketplace.stripe.com/oauth/v2/authorize",
  tokenUrl: "https://api.stripe.com/v1/oauth/token",
  scopes: [],
  tokenField: "apiKey",
  clients: { server: { auth: "client_secret_post" } },
  // The app's permissions mirror the restricted-key template: Write on
  // webhook endpoints, products, prices, meters and payouts, Read elsewhere.
  access: "read-write",
  refresh: "rotating",
  // Access tokens last one hour, but the token response has no `expires_in`.
  defaultExpiresIn: 60 * 60,
  docsUrl: "https://docs.stripe.com/stripe-apps/api-authentication/oauth",
};

/** The install link with exactly the documented parameters. */
export function buildStripeAuthorizeUrl(params: OAuthAuthorizeUrlParams): string {
  const url = new URL(stripeOAuth.authorizeUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("state", params.state);
  return url.toString();
}

function stripeError(json: Record<string, unknown>, status: number): OAuthTokenError {
  const err = json["error"];
  if (typeof err === "string") {
    const description =
      typeof json["error_description"] === "string" ? json["error_description"] : err;
    return new OAuthTokenError(description, status, err === "invalid_grant");
  }
  const message =
    err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : `Stripe token endpoint returned HTTP ${status}`;
  return new OAuthTokenError(message, status, false);
}

/** The documented exchange: Basic auth with the secret key as the username. */
export async function exchangeStripeCode(request: OAuthExchangeRequest): Promise<OAuthTokenSet> {
  const secretKey = request.client.clientSecret ?? "";
  const res = await request.fetch(stripeOAuth.tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "authorization_code", code: request.code }).toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  if (!res.ok || json["error"]) throw stripeError(json, res.status);
  return parseOAuthTokenResponse(json, Date.now(), stripeOAuth.defaultExpiresIn);
}

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Name the account after the connected Stripe account, marking test mode. */
export async function completeStripeOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  let name: string | undefined;
  try {
    const res = await context.fetch("https://api.stripe.com/v1/account", {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (res.ok) {
      const account = (await res.json()) as {
        id?: string;
        email?: string;
        business_profile?: { name?: string };
        settings?: { dashboard?: { display_name?: string } };
      };
      name =
        nonEmpty(account.settings?.dashboard?.display_name) ??
        nonEmpty(account.business_profile?.name) ??
        nonEmpty(account.email) ??
        nonEmpty(account.id);
    }
  } catch {
    // Fall back to the account id from the exchange.
  }
  name ??= nonEmpty(tokens.raw["stripe_user_id"]);
  if (!name) return {};
  return { accountName: tokens.raw["livemode"] === false ? `${name} (test)` : name };
}
