/**
 * "Connect with Heroku": a Heroku OAuth client (Platform API web flow).
 *
 * Protocol facts (Heroku Dev Center, "Heroku OAuth"; verified 2026-10):
 * - authorize `https://id.heroku.com/oauth/authorize`, token
 *   `https://id.heroku.com/oauth/token` (form-encoded; the exchange and the
 *   refresh both carry the client secret). Heroku documents no PKCE and no
 *   public clients, so the flow is server-only.
 * - Access tokens (`HRKU-...`) expire 8 hours after they are issued. Refresh
 *   tokens do not expire and the refresh response hands the same one back,
 *   so it is reusable.
 * - The token is a Bearer token, exactly like an API key, so the client needs
 *   no change.
 *
 * Scope: `global`. The plugin edits config vars and releases (protected
 * resources, which need at least `write-protected`) and reads account
 * invoices and credits, which no narrower scope covers (`identity` only
 * reaches `GET /account`). `global` is what an API key already grants, and
 * the UI says so before consent (`access: "full"`).
 */

import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { API_BASE } from "./api.js";

export const HEROKU_OAUTH: OAuthDeclaration = {
  authorizeUrl: "https://id.heroku.com/oauth/authorize",
  tokenUrl: "https://id.heroku.com/oauth/token",
  scopes: ["global"],
  tokenField: "apiKey",
  clients: { server: {} },
  access: "full",
  refresh: "reusable",
  docsUrl: "https://devcenter.heroku.com/articles/oauth",
};

/** After consent: name the account after the signed-in Heroku user. */
export async function completeHerokuOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  try {
    const res = await context.fetch(`${API_BASE}/account`, {
      headers: {
        Accept: "application/vnd.heroku+json; version=3",
        Authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    if (!res.ok) return {};
    const account = (await res.json()) as { email?: string; name?: string | null };
    const who = account.email || account.name;
    return who ? { accountName: `Heroku (${who})` } : {};
  } catch {
    return {};
  }
}
