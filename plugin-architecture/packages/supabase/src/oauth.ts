/**
 * "Connect with Supabase": a Supabase OAuth app (Management API).
 *
 * Protocol facts (Supabase docs, "Build a Supabase Integration" and "OAuth
 * Scopes", plus the Management API OpenAPI document at
 * `https://api.supabase.com/api/v1-json`; verified 2026-10):
 * - authorize `https://api.supabase.com/v1/oauth/authorize`, token
 *   `https://api.supabase.com/v1/oauth/token` (form-encoded, the client id
 *   and secret as HTTP Basic auth). PKCE (S256) is recommended.
 * - Scopes are chosen on the OAuth app in the organization's settings, not
 *   in the authorize URL (the `scope` parameter is deprecated), so the
 *   declaration requests none.
 * - The token response carries a refresh token; Supabase does not document
 *   whether a refresh rotates it, so it is treated as rotating (the host then
 *   persists every refresh atomically, which is also right for a reusable one).
 * - The user picks one organization on the consent screen and the token covers
 *   that organization's projects. It is sent as `Authorization: Bearer`, the
 *   same as a personal access token, so the client needs no change.
 * - Every exchange needs the client secret and Supabase documents no public
 *   client, so the flow is server-only.
 *
 * The plugin creates, edits and deletes projects, branches, functions, keys
 * and settings, so the app is registered with read and write scopes.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { SUPABASE_API } from "./api.js";

export const SUPABASE_OAUTH: OAuthDeclaration = {
  authorizeUrl: `${SUPABASE_API}/v1/oauth/authorize`,
  tokenUrl: `${SUPABASE_API}/v1/oauth/token`,
  scopes: [],
  tokenField: "accessToken",
  clients: { server: { auth: "client_secret_basic", pkce: true } },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration",
};

/** After consent: name the account after the organization the user connected. */
export async function completeSupabaseOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  try {
    const res = await context.fetch(`${SUPABASE_API}/v1/organizations`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return {};
    const orgs = (await res.json()) as Array<{ name?: string }>;
    const names = Array.isArray(orgs)
      ? orgs.map((o) => o.name).filter((n): n is string => !!n)
      : [];
    return names.length === 1 ? { accountName: `Supabase (${names[0]})` } : {};
  } catch {
    return {};
  }
}
