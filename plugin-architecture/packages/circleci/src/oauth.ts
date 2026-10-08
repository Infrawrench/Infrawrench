/**
 * "Connect with CircleCI": OAuth 2.0 with dynamic client registration.
 *
 * Protocol facts (circleci.com/docs/guides/toolkit/oauth-dynamic-client-registration/,
 * verified 2026-10):
 * - No pre-registered app: `POST https://app.circleci.com/oauth/register`
 *   (RFC 7591, unauthenticated) with `client_name`, `redirect_uris`,
 *   `grant_types: ["authorization_code"]` and `response_types: ["code"]`
 *   answers 201 with a `client_id` and `token_endpoint_auth_method: "none"`.
 *   No secret is issued; PKCE S256 is mandatory and `state` is required.
 * - Redirect URIs must be loopback (`127.0.0.1`, `::1` or `localhost`) on a
 *   port from 1025 to 65535, so only the desktop app can run the flow: there
 *   is no server client.
 * - authorize `https://app.circleci.com/oauth/authorize`, token
 *   `https://app.circleci.com/oauth/token` (form body with `client_id` and
 *   `code_verifier`), both standard, so only registration needs a hook.
 * - There are no scope strings: the user picks Read, Write or Admin on the
 *   consent screen, capped by their own role. The plugin edits projects,
 *   contexts, variables, schedules and runners, so Write is what it needs.
 * - The result is a standard personal API token (`ccipat_`) that lasts 90
 *   days, with no refresh token. Connecting again revokes the previous token
 *   for that client and issues a new one. It works with API v2 in the
 *   `Circle-Token` header and with v3 as Bearer, exactly like a pasted token.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { API_BASE, APP_BASE } from "./api.js";
import type { CircleCollaboration } from "./mappers.js";

export const CIRCLECI_OAUTH: OAuthDeclaration = {
  authorizeUrl: `${APP_BASE}/oauth/authorize`,
  tokenUrl: `${APP_BASE}/oauth/token`,
  scopes: [],
  tokenField: "apiToken",
  clients: { desktop: { loopbackHost: "127.0.0.1" } },
  access: "read-write",
  refresh: "none",
  docsUrl: "https://circleci.com/docs/guides/toolkit/oauth-dynamic-client-registration/",
  clientRegistration: "dynamic",
};

/** Register a public client for this flow's redirect URI. */
export async function registerCircleCIClient(request: {
  redirectUri: string;
  fetch: typeof fetch;
}): Promise<{ clientId: string }> {
  const res = await request.fetch(`${APP_BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: "Infrawrench",
      redirect_uris: [request.redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
    }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  const clientId = body["client_id"];
  if (!res.ok || typeof clientId !== "string" || !clientId) {
    const detail =
      typeof body["error_description"] === "string"
        ? body["error_description"]
        : typeof body["error"] === "string"
          ? body["error"]
          : text.slice(0, 200);
    throw new Error(
      `CircleCI refused to register Infrawrench for sign-in (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return { clientId };
}

async function getJson<T>(
  context: OAuthCompletionContext,
  token: string,
  path: string,
): Promise<T | null> {
  try {
    const res = await context.fetch(`${API_BASE}${path}`, {
      headers: { "Circle-Token": token, Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * After consent: pick the organization when the user belongs to exactly one,
 * and name the account after the user.
 */
export async function completeCircleCIOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const [me, orgs] = await Promise.all([
    getJson<{ login?: string; name?: string }>(context, tokens.accessToken, "/me"),
    getJson<CircleCollaboration[]>(context, tokens.accessToken, "/me/collaborations"),
  ]);
  const result: OAuthCompletionResult = {};
  if (Array.isArray(orgs) && orgs.length === 1) {
    const org = orgs[0]!;
    const id = org.id || org.slug;
    if (id) result.credentials = { organization: id };
  }
  const who = me?.login || me?.name;
  if (who) result.accountName = `CircleCI (${who})`;
  return result;
}
