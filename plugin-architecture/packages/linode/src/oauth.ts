/**
 * "Connect with Linode": the OAuth declaration and the identity hook.
 *
 * Verified against techdocs.akamai.com/linode-api/reference/get-started
 * (OAuth workflow, 2026-10) and Linode's own clients (linode_api4's
 * `LinodeLoginClient`, Cloud Manager's `OAuth/oauth.ts`):
 *   - Authorize `https://login.linode.com/oauth/authorize`, token
 *     `https://login.linode.com/oauth/token`.
 *   - Private (confidential) clients run the authorization code flow and
 *     exchange the code with `client_id` + `client_secret` in a form body. The
 *     access token lasts two hours and comes with a refresh token; a refresh
 *     returns a new one, so treat it as rotating.
 *   - Public clients only get the implicit flow with no refresh token, which
 *     cannot keep a connection alive, so there is no desktop client: local
 *     desktop accounts keep using a personal access token.
 *   - Scopes are `<area>:read_only` / `<area>:read_write`, comma separated
 *     (the operation reference shows `monitor:read_only, <service>:read_only`;
 *     linode_api4 joins with commas). Cloud Manager sends them as `scope`,
 *     linode_api4 as `scopes`; the declaration sends both with the same value.
 *
 * The scopes are exactly the preflight's per-capability permissions (the
 * plugin creates, resizes and deletes resources in most areas, and only reads
 * the account and Monitor), so the two can never drift.
 */
import type {
  OAuthCompletionContext,
  OAuthCompletionResult,
  OAuthDeclaration,
  OAuthTokenSet,
} from "@infrawrench/plugin-base";
import { LINODE_API_BASE } from "./api.js";
import { LINODE_PREFLIGHT } from "./preflight.js";

export const LINODE_OAUTH_SCOPES: string[] = [
  ...new Set(LINODE_PREFLIGHT.capabilities.flatMap((c) => c.requiredPermissions.map((p) => p.id))),
];

const SCOPE_SEPARATOR = ",";

export const linodeOAuth: OAuthDeclaration = {
  authorizeUrl: "https://login.linode.com/oauth/authorize",
  tokenUrl: "https://login.linode.com/oauth/token",
  scopes: LINODE_OAUTH_SCOPES,
  scopeSeparator: SCOPE_SEPARATOR,
  authorizeParams: { scopes: LINODE_OAUTH_SCOPES.join(SCOPE_SEPARATOR) },
  tokenField: "apiToken",
  clients: { server: { auth: "client_secret_post" } },
  access: "read-write",
  refresh: "rotating",
  docsUrl: "https://techdocs.akamai.com/linode-api/reference/get-started",
};

const nonEmpty = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

async function getJson<T>(doFetch: typeof fetch, token: string, path: string) {
  try {
    const res = await doFetch(`${LINODE_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    return res.ok ? ((await res.json()) as T) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Name the account after the Linode account's company (an OAuth grant covers
 * one Linode account: the one the user signed in to), else the username.
 */
export async function completeLinodeOAuth(
  tokens: OAuthTokenSet,
  context: OAuthCompletionContext,
): Promise<OAuthCompletionResult> {
  const account = await getJson<{ company?: string }>(
    context.fetch,
    tokens.accessToken,
    "/account",
  );
  const company = nonEmpty(account?.company);
  if (company) return { accountName: company };
  const profile = await getJson<{ username?: string; email?: string }>(
    context.fetch,
    tokens.accessToken,
    "/profile",
  );
  const person = nonEmpty(profile?.username) ?? nonEmpty(profile?.email);
  return person ? { accountName: person } : {};
}
