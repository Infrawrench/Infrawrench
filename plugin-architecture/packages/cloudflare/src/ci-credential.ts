/**
 * Lending a Cloudflare connection to a CI job: its API token as
 * `CLOUDFLARE_API_TOKEN` and the account it works in as
 * `CLOUDFLARE_ACCOUNT_ID`, the two variables Wrangler and Cloudflare's CLI
 * (`builtin:wrangler`, `builtin:cf`) read for a deploy with no sign-in.
 *
 * The token is the connection's own, with the scopes it was created with.
 * Cloudflare can mint a narrower one that expires (account API tokens with
 * `expires_on`), but only with a token that may create tokens, which the
 * connection's recommended scopes do not include. The account ID is not a
 * secret, so it is shown in the job's log.
 */
import type { CiLentMaterial } from "@infrawrench/plugin-base";

export function lendCloudflareToken(apiToken: string, accountId: string): CiLentMaterial {
  if (!apiToken) throw new Error("This Cloudflare connection has no API token to lend");
  if (!/^[0-9a-f]{32}$/.test(accountId)) {
    throw new Error(`Cloudflare answered with an account ID that is not one: ${accountId}`);
  }
  return {
    env: {
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: [{ text: accountId }],
    },
    files: [],
    summary: "API token and account ID (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)",
  };
}
