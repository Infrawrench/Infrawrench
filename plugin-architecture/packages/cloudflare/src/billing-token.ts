/**
 * Billing access for "Connect with Cloudflare" (OAuth) connections.
 *
 * Cloudflare's third-party OAuth catalog has no billing scope (the live
 * `GET /oauth/scopes` list, checked 2026-10, has none; Cloudflare's own
 * Workers tooling marks `billing:read` registered-but-ungrantable), so an
 * OAuth access token can never read `/billable-usage`. The catalog does offer
 * `account-api-tokens.write`, and Cloudflare lets a member grant an
 * account-owned token any permission their own role holds. So a cost run on
 * an OAuth connection mints an account-owned token carrying only Billing Read
 * on the one account, set to expire within the hour, uses it, and deletes it.
 *
 * Nothing is persisted: no stored secret to leak or rotate, nothing to revoke
 * on disconnect, and a delete that fails still expires on its own. The scope
 * is optional on the consent screen, so a user who declines it keeps every
 * other feature and gets a cost banner explaining what to grant.
 *
 * Endpoints (Cloudflare API reference, verified 2026-10):
 *   - `GET /accounts/{id}/tokens/permission_groups?name=&scope=`: needs
 *     Account API Tokens Read or Write; `is_selectable` is false for a group
 *     the caller's role cannot grant.
 *   - `POST /accounts/{id}/tokens`: needs Account API Tokens Write, and the
 *     member must be a Super Administrator or hold API token provisioning.
 *   - `DELETE /accounts/{id}/tokens/{token_id}`.
 */
import { CloudflareApi } from "./clients/shared.js";

/** Name of the temporary token, as it appears in the account's token list. */
export const BILLING_TOKEN_NAME = "Infrawrench cost sync (temporary)";

const BILLING_READ_GROUP = "Billing Read";
const ACCOUNT_SCOPE = "com.cloudflare.api.account";
/** Long enough for a slow month chunk; short enough that a leaked or undeleted token is moot. */
const TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/**
 * Why a billing token could not be minted:
 *   - `scope`: the grant lacks `account-api-tokens.write` (declined on consent,
 *     or connected before the scope was requested).
 *   - `role`: the connecting member's role has no billing access to delegate.
 *   - `provisioning`: the role cannot create account API tokens.
 */
export type BillingTokenFailure = "scope" | "role" | "provisioning";

export class BillingTokenError extends Error {
  constructor(
    message: string,
    readonly reason: BillingTokenFailure,
  ) {
    super(message);
    this.name = "BillingTokenError";
  }
}

function isAuthStatus(err: unknown): boolean {
  const status = (err as { status?: unknown }).status;
  return status === 401 || status === 403;
}

async function billingReadGroupId(api: CloudflareApi, accountId: string): Promise<string> {
  let groups: Array<{ id?: string; name?: string; is_selectable?: boolean }>;
  try {
    groups = await api.collect(
      api.cf.accounts.tokens.permissionGroups.list({
        account_id: accountId,
        name: BILLING_READ_GROUP,
        scope: ACCOUNT_SCOPE,
      }),
    );
  } catch (err) {
    if (isAuthStatus(err)) {
      throw new BillingTokenError(
        "this connection was not granted Account API Tokens Write, which cost collection needs because Cloudflare's OAuth has no billing scope; reconnect with Cloudflare and allow it",
        "scope",
      );
    }
    throw err;
  }
  const group = groups.find((g) => g.name === BILLING_READ_GROUP);
  // `is_selectable` is in the API response but not yet in the SDK's types.
  if (!group?.id || group.is_selectable === false) {
    throw new BillingTokenError(
      "the Cloudflare member who connected this account has no billing access to delegate; reconnect as a Super Administrator, Administrator or Billing member",
      "role",
    );
  }
  return group.id;
}

/**
 * Run `fn` with a client authenticated by a freshly minted, Billing Read-only
 * account token, then delete the token. `api` is the OAuth-authenticated
 * client; the one handed to `fn` already knows its account id.
 */
export async function withBillingToken<T>(
  api: CloudflareApi,
  accountId: string,
  fn: (billingApi: CloudflareApi) => Promise<T>,
): Promise<T> {
  const groupId = await billingReadGroupId(api, accountId);
  let created: { id?: string; value?: string };
  try {
    created = await api.cf.accounts.tokens.create({
      account_id: accountId,
      name: BILLING_TOKEN_NAME,
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: groupId }],
          resources: { [`${ACCOUNT_SCOPE}.${accountId}`]: "*" },
        },
      ],
      // Second precision: Cloudflare's examples carry no fractional seconds.
      expires_on: new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  } catch (err) {
    if (isAuthStatus(err)) {
      throw new BillingTokenError(
        "the Cloudflare member who connected this account cannot create account API tokens; a Super Administrator can grant API token provisioning, or reconnect as one",
        "provisioning",
      );
    }
    throw err;
  }
  if (!created.id || !created.value) {
    throw new Error("Cloudflare created the billing token but did not return its value.");
  }

  const tokenId = created.id;
  const billingApi = new CloudflareApi(created.value);
  billingApi.cfAccountId = accountId;
  try {
    return await fn(billingApi);
  } finally {
    // Best effort: the token expires within the hour regardless.
    await api.cf.accounts.tokens.delete(tokenId, { account_id: accountId }).catch(() => undefined);
  }
}
