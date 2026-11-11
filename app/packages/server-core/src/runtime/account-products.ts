/**
 * Which accounts a collection pass works, by the apps each connection was
 * made for (`accounts.products`, product ids; NULL is every app).
 *
 * The rules, in one place so the claims cannot disagree:
 *
 * - **The resource sync** runs unless the connection is for Costs alone.
 *   Every other app reads the inventory, so any other choice keeps it.
 * - **A pass that feeds one app** (the bill for Costs, findings for Security)
 *   runs when the connection includes that app. When the plugin never offered
 *   that app as a choice (its preflight declares no capability for it, as
 *   with a scanner that reads with the inventory's permissions), there was
 *   nothing to leave out, so the pass follows the inventory instead.
 *
 * Which apps a plugin offers comes from its manifest
 * (`productsOfferedBy(manifest.preflight)`); nothing here names a plugin.
 */
import { sql, type SQL } from "drizzle-orm";
import { productsOfferedBy, type ProductId } from "@infrawrench/client-core";
import type { PreflightDeclaration } from "@infrawrench/plugin-base";

type AccountsAlias = "accounts" | "a";

/**
 * True when the row's connection is for more than Costs, or for everything.
 * Written out per alias instead of splicing the name in, so the fragment is
 * plain text to anything that reads the statement.
 */
function syncsInventory(alias: AccountsAlias): SQL {
  return alias === "a"
    ? sql`(a.products IS NULL OR jsonb_array_length(a.products - 'costs') > 0)`
    : sql`(accounts.products IS NULL OR jsonb_array_length(accounts.products - 'costs') > 0)`;
}

/**
 * A claim-query condition, starting with ` AND`, keeping accounts whose
 * resources are synced: every account but one connected for Costs alone.
 */
export function accountInventoryCondition(alias: AccountsAlias = "accounts"): SQL {
  return sql` AND ${syncsInventory(alias)}`;
}

/**
 * A claim-query condition, starting with ` AND`, keeping accounts a pass that
 * feeds `product` should work. `offeringPluginIds` are the plugins that offer
 * `product` as a choice ({@link pluginIdsOffering}); an account of any other
 * plugin follows the inventory rule.
 */
export function accountProductCondition(
  product: ProductId,
  offeringPluginIds: readonly string[],
  alias: AccountsAlias = "accounts",
): SQL {
  const wanted = JSON.stringify([product]);
  // No plugin offers the choice: every account follows the inventory rule.
  // (An empty IN list would also be a syntax error.)
  if (offeringPluginIds.length === 0) return accountInventoryCondition(alias);
  const ids = [...offeringPluginIds];
  return alias === "a"
    ? sql` AND (a.products IS NULL OR CASE WHEN a.plugin_id IN ${ids} THEN a.products @> ${wanted}::jsonb ELSE ${syncsInventory(alias)} END)`
    : sql` AND (accounts.products IS NULL OR CASE WHEN accounts.plugin_id IN ${ids} THEN accounts.products @> ${wanted}::jsonb ELSE ${syncsInventory(alias)} END)`;
}

/** Ids of the plugins whose preflight offers `product` as a choice. */
export function pluginIdsOffering(
  loaded: ReadonlyArray<{
    plugin: { manifest: { id: string; preflight?: PreflightDeclaration | undefined } };
  }>,
  product: ProductId,
): string[] {
  return loaded
    .filter((l) => productsOfferedBy(l.plugin.manifest.preflight).includes(product))
    .map((l) => l.plugin.manifest.id);
}
