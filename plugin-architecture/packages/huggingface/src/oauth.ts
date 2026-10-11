/**
 * "Connect with Hugging Face": the Hub's OAuth / OpenID Connect provider.
 *
 * Protocol facts (huggingface.co/docs/hub/oauth and
 * `https://huggingface.co/.well-known/openid-configuration`, verified 2026-10):
 * - authorize `https://huggingface.co/oauth/authorize`, token
 *   `https://huggingface.co/oauth/token` (client_secret_basic or
 *   client_secret_post), PKCE S256.
 * - Apps are self-serve (huggingface.co/settings/applications/new) and can be
 *   created without a secret, which makes them public clients that exchange
 *   with PKCE; the desktop uses one of those. Loopback `http` redirect URIs
 *   match on any port, but `localhost` and `127.0.0.1` are matched separately.
 * - The token response carries a refresh token and `expires_in`; the docs do
 *   not say whether a refresh rotates it, so the host treats it as rotating
 *   (it persists whatever comes back and keeps the old one when none does).
 * - Tokens are sent as `Authorization: Bearer`, like user access tokens, so
 *   the REST client needs no change.
 * - Organization resources are only reachable when the user grants the
 *   organization on the consent screen (or `orgIds` pins one).
 *
 * Scopes, mapped to what the plugin does:
 * - `openid profile`: name the account after the user.
 * - `read-memberships`: list the user's organizations for the namespace picker.
 * - `manage-repos`: list, create and delete model, dataset and Space repos,
 *   edit Space settings, secrets and variables.
 * - `write-endpoints`: list, create, scale, pause and delete Inference Endpoints.
 * - `jobs`: list, run, cancel and schedule Jobs.
 * - `webhooks`: list, create and toggle webhooks.
 * - `inference-api`: the Inference Providers playground and model list.
 * - `read-billing`: billing state. Hugging Face describes this scope as
 *   "whether the user has a payment method", so the usage reports behind
 *   Costs, and org service accounts and member tokens (no OAuth scope covers
 *   them), may answer 403 for a connected account and still need an access
 *   token; the docs page says so.
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { HUB_BASE } from "./http.js";
import type { WhoAmI } from "./wire.js";

export const HUGGINGFACE_OAUTH: OAuthDeclaration = {
  authorizeUrl: `${HUB_BASE}/oauth/authorize`,
  tokenUrl: `${HUB_BASE}/oauth/token`,
  scopes: [
    "openid",
    "profile",
    "read-memberships",
    "manage-repos",
    "write-endpoints",
    "jobs",
    "webhooks",
    "inference-api",
    "read-billing",
  ],
  tokenField: "apiToken",
  clients: {
    server: { auth: "client_secret_basic", pkce: true },
    desktop: { loopbackHost: "127.0.0.1" },
  },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://huggingface.co/docs/hub/oauth",
};

/**
 * After consent: name the account after the Hugging Face user. The namespace
 * stays on the user (its default); the picker lists the organizations the
 * user granted.
 */
export async function completeHuggingFaceOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  try {
    const res = await context.fetch(`${HUB_BASE}/api/whoami-v2`, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return {};
    const me = (await res.json()) as WhoAmI;
    return me.name ? { accountName: `Hugging Face (${me.name})` } : {};
  } catch {
    return {};
  }
}
