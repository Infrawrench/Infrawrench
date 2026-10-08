/**
 * "Connect with PagerDuty": a Classic User OAuth app.
 *
 * Protocol facts (PagerDuty developer docs, "OAuth Functionality", "Private
 * Apps" and "PagerDuty OpenID Token", verified 2026-10):
 * - authorize `https://identity.pagerduty.com/oauth/authorize`, token
 *   `https://identity.pagerduty.com/oauth/token`, one identity service for
 *   both service regions.
 * - Classic User OAuth supports confidential clients (secret, PKCE optional)
 *   and non-confidential ones (no secret, PKCE required), so the desktop gets
 *   a public client beside the server's confidential one. Scoped OAuth is
 *   confidential only and its user tokens need an `as_account-<region>.<sub>`
 *   scope naming the account up front, which a "connect any account" button
 *   cannot know, so it is not used.
 * - Classic scopes are `read` or `write`; access is the intersection of the
 *   scope and the authorizing user's role. `openid` is attached to every
 *   token. An unknown scope is not an error: the token silently gets only
 *   `openid` and every call answers 403, so the scope here must be exact.
 * - Access tokens last 30 days, refresh tokens 210 days with a rolling
 *   window; a refresh returns a new access and a new refresh token, so the
 *   host treats it as rotating.
 * - Tokens (`pdus+_...`) are sent as `Authorization: Bearer`. The response's
 *   `id_token` carries the account `subdomain` and, in `aud`, the regional
 *   REST base URL (`https://api.pagerduty.com` or `https://api.eu.pagerduty.com`).
 *
 * Scope: `write`, because the plugin acknowledges and resolves incidents,
 * creates overrides and maintenance windows, subscribes the incident webhook
 * and edits services; with `read` all of those would fail.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { OAUTH_CREDENTIAL_KEY } from "@infrawrench/plugin-base";
import type { PagerDutyRegion } from "./api.js";
import { restBase } from "./api.js";

export const PAGERDUTY_OAUTH: OAuthDeclaration = {
  authorizeUrl: "https://identity.pagerduty.com/oauth/authorize",
  tokenUrl: "https://identity.pagerduty.com/oauth/token",
  scopes: ["write"],
  tokenField: "apiKey",
  clients: {
    server: { auth: "client_secret_post", pkce: true },
    desktop: { loopbackHost: "127.0.0.1" },
  },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://docs.pagerduty.com/developer/oauth-functionality",
};

/**
 * True when the credential is an OAuth access token rather than a REST API
 * key. The grant state marks it on the host that owns the account; the token
 * prefix covers hosts that hand credentials over with the grant state
 * stripped (desktop cloud mode).
 */
export function isPagerDutyOAuth(credentials: Record<string, string>): boolean {
  if (credentials[OAUTH_CREDENTIAL_KEY]) return true;
  const token = (credentials["apiKey"] ?? "").trim();
  return token.startsWith("pdus+_") || token.startsWith("pdua+_");
}

interface IdTokenClaims {
  aud?: string | string[];
  subdomain?: string;
  region?: string;
  sub?: string;
}

/** Read (not verify) the id_token's claims; it came straight from the token endpoint over TLS. */
export function decodeIdToken(idToken: unknown): IdTokenClaims | null {
  if (typeof idToken !== "string") return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
    return JSON.parse(json) as IdTokenClaims;
  } catch {
    return null;
  }
}

function regionFromClaims(claims: IdTokenClaims | null): PagerDutyRegion | null {
  if (!claims) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (aud.some((a) => a.startsWith("https://api.eu.pagerduty.com"))) return "eu";
  if (aud.some((a) => a.startsWith("https://api.pagerduty.com"))) return "us";
  if (claims.region) return /^eu|europe/i.test(claims.region) ? "eu" : "us";
  return null;
}

interface PdMe {
  user?: { email?: string; name?: string };
}

async function readMe(
  context: OAuthCompletionContext,
  token: string,
  region: PagerDutyRegion,
): Promise<PdMe["user"] | null> {
  try {
    const res = await context.fetch(`${restBase(region)}/users/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.pagerduty+json;version=2",
      },
    });
    if (!res.ok) return null;
    return ((await res.json()) as PdMe).user ?? null;
  } catch {
    return null;
  }
}

/**
 * After consent: pick the service region from the id_token, make the
 * connecting user the default acting user (incident writes need one), and
 * name the account after the PagerDuty subdomain.
 */
export async function completePagerDutyOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const claims = decodeIdToken(tokens.raw["id_token"]);
  let region = regionFromClaims(claims);
  let me: PdMe["user"] | null = null;
  if (region) {
    me = await readMe(context, tokens.accessToken, region);
  } else {
    // No id_token: whichever region accepts the token is the account's.
    for (const candidate of ["us", "eu"] as const) {
      me = await readMe(context, tokens.accessToken, candidate);
      if (me) {
        region = candidate;
        break;
      }
    }
  }
  const credentials: Record<string, string> = { region: region ?? "us" };
  if (me?.email) credentials["fromEmail"] = me.email;
  const label = claims?.subdomain ?? me?.email;
  return label ? { credentials, accountName: `PagerDuty (${label})` } : { credentials };
}
