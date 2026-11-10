/**
 * The org's connected accounts in cloud mode: typed calls to the contract's
 * `accounts` domain over the cloud transport (`./cloud-client.ts`). Each
 * answer is handed on as the ui type the sidebar and account pages use, so a
 * contract change the desktop's types disagree with fails here at compile
 * time.
 */
import type { Account, AccountDetail, Resource } from "@infrawrench/ui";
import type { ProductId } from "@infrawrench/client-core";
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const accounts = () => cloudClient("accounts").accounts;

/**
 * `POST /accounts/:id/sync-type/:typeId` returns the same `Resource` shape
 * minus the `accountId` field (the caller already knows which account).
 */
type CloudResourceSyncItem = Omit<Resource, "accountId">;

export async function listCloudAccounts(orgId: string): Promise<Account[]> {
  return runRpc(accounts().list({ params: { orgId } }));
}

/**
 * The org's plugin catalog as the server sees it. The desktop renders plugins
 * from its own bundle; this is read for what only the server knows, e.g.
 * `oauth` (present only when the server can run that plugin's OAuth flow).
 */
export async function listCloudAccountPlugins(orgId: string) {
  return runRpc(accounts().plugins({ params: { orgId } }));
}

export async function createCloudAccount(
  orgId: string,
  pluginId: string,
  displayName: string,
  credentials: Record<string, string>,
  /** The apps the connection is for; `null` for every app the plugin offers. */
  products: ProductId[] | null = null,
): Promise<{ id: string } | null> {
  return runRpc(
    accounts().create({
      params: { orgId },
      // Left out for every app, which a server without the field understands.
      payload: { pluginId, displayName, credentials, ...(products ? { products } : {}) },
    }),
  );
}

/** The account's resources with no parent, the sidebar's tree roots. */
export async function listCloudAccountResources(
  orgId: string,
  accountId: string,
): Promise<Resource[]> {
  return runRpc(
    accounts().resources({ params: { orgId, id: accountId }, query: { topLevelOnly: "true" } }),
  );
}

/**
 * The account with its plugin's resource types. The contract leaves
 * `pluralDisplayName` and `parentTypeId` optional where the page's type has
 * both keys; the server always sends the plural (every type definition has
 * one), so the singular stands in only for an answer that lacks it.
 */
export async function getCloudAccountDetail(
  orgId: string,
  accountId: string,
): Promise<AccountDetail | null> {
  const detail = await runRpc(accounts().detail({ params: { orgId, id: accountId } }));
  return {
    ...detail,
    resourceTypes: detail.resourceTypes.map((type) => ({
      ...type,
      pluralDisplayName: type.pluralDisplayName ?? type.displayName,
      parentTypeId: type.parentTypeId,
    })),
  };
}

export async function syncCloudAccountType(
  orgId: string,
  accountId: string,
  typeId: string,
): Promise<CloudResourceSyncItem[]> {
  return runRpc(accounts().syncType({ params: { orgId, id: accountId, typeId } }));
}

export async function deleteCloudAccount(orgId: string, accountId: string): Promise<void> {
  await runRpc(accounts().delete({ params: { orgId, id: accountId } }));
}

export async function renameCloudAccount(
  orgId: string,
  accountId: string,
  displayName: string,
): Promise<{ id: string; displayName: string }> {
  return runRpc(accounts().update({ params: { orgId, id: accountId }, payload: { displayName } }));
}

/** Change the apps a connection is for; `null` is every app the plugin offers. */
export async function updateCloudAccountProducts(
  orgId: string,
  accountId: string,
  products: ProductId[] | null,
): Promise<{ products?: readonly string[] | null | undefined }> {
  return runRpc(accounts().update({ params: { orgId, id: accountId }, payload: { products } }));
}

/** The stored credentials, decrypted server-side for an editor or a preflight. */
export async function getCloudAccountCredentials(
  orgId: string,
  accountId: string,
): Promise<Record<string, string>> {
  return runRpc(accounts().credentials({ params: { orgId, id: accountId } }));
}

export async function updateCloudAccountCredentials(
  orgId: string,
  accountId: string,
  credentials: Record<string, string>,
): Promise<void> {
  await runRpc(
    accounts().rotateCredentials({ params: { orgId, id: accountId }, payload: { credentials } }),
  );
}
