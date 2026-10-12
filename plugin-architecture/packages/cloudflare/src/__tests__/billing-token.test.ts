import { describe, it, expect, vi } from "vitest";
import { BILLING_TOKEN_NAME, BillingTokenError, withBillingToken } from "../billing-token.js";
import { asyncIter, makeApi } from "./_helpers.js";

const status = (code: number) => Object.assign(new Error(`HTTP ${code}`), { status: code });

function tokenApi({
  groups = [{ id: "grp-billing", name: "Billing Read", is_selectable: true }] as unknown[],
  listError = null as unknown,
  createError = null as unknown,
  deleteError = null as unknown,
} = {}) {
  const list = vi.fn(() => {
    if (listError) throw listError;
    return asyncIter(groups);
  });
  const create = vi.fn(async () => {
    if (createError) throw createError;
    return { id: "tok-1", value: "minted-secret" };
  });
  const del = vi.fn(async () => {
    if (deleteError) throw deleteError;
    return null;
  });
  const api = makeApi({
    cf: { accounts: { tokens: { create, delete: del, permissionGroups: { list } } } },
  });
  return { api, list, create, del };
}

describe("withBillingToken", () => {
  it("mints an account-scoped Billing Read token, hands it over, then deletes it", async () => {
    const { api, list, create, del } = tokenApi();
    const seen = await withBillingToken(api, "acct-1", async (billingApi) => ({
      token: billingApi.apiToken,
      account: await billingApi.getAccountId(),
    }));

    expect(seen).toEqual({ token: "minted-secret", account: "acct-1" });
    expect(list).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: "Billing Read",
      scope: "com.cloudflare.api.account",
    });
    const params = (create.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(params["name"]).toBe(BILLING_TOKEN_NAME);
    expect(params["policies"]).toEqual([
      {
        effect: "allow",
        permission_groups: [{ id: "grp-billing" }],
        resources: { "com.cloudflare.api.account.acct-1": "*" },
      },
    ]);
    const expires = Date.parse(String(params["expires_on"]));
    expect(expires - Date.now()).toBeGreaterThan(50 * 60 * 1000);
    expect(expires - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(del).toHaveBeenCalledWith("tok-1", { account_id: "acct-1" });
  });

  it("deletes the token when the callback throws, and rethrows", async () => {
    const { api, del } = tokenApi();
    const err = await withBillingToken(api, "acct-1", async () => {
      throw new Error("boom");
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe("boom");
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("ignores a failed delete, since the token expires anyway", async () => {
    const { api } = tokenApi({ deleteError: status(500) });
    await expect(withBillingToken(api, "acct-1", async () => "ok")).resolves.toBe("ok");
  });

  it("reports a missing token scope when permission groups are forbidden", async () => {
    const { api, create } = tokenApi({ listError: status(403) });
    const err = await withBillingToken(api, "acct-1", async () => "ok").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingTokenError);
    expect((err as BillingTokenError).reason).toBe("scope");
    expect(create).not.toHaveBeenCalled();
  });

  it("reports a role without billing when Billing Read is not selectable", async () => {
    const { api } = tokenApi({
      groups: [{ id: "grp-billing", name: "Billing Read", is_selectable: false }],
    });
    const err = await withBillingToken(api, "acct-1", async () => "ok").catch((e: unknown) => e);
    expect((err as BillingTokenError).reason).toBe("role");
  });

  it("reports missing token provisioning when the create is forbidden", async () => {
    const { api } = tokenApi({ createError: status(403) });
    const err = await withBillingToken(api, "acct-1", async () => "ok").catch((e: unknown) => e);
    expect((err as BillingTokenError).reason).toBe("provisioning");
  });
});
