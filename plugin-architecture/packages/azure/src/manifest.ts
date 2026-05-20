/**
 * ARM "manifest" support — read the raw ARM JSON for a resource and write it
 * back (PUT). Used by the manifest editor UI.
 *
 * The mapping in `AZURE_ARM_SPECS` is shared with `delete-handlers.ts` for
 * everything except SQL database (which has a different URL shape between
 * read-by-name and the delete operation — both are handled here directly).
 */
import { ARM, AZURE_ARM_SPECS, type AzureHttpContext } from "./shared.js";

function buildAzureArmUrl(subscriptionId: string, typeId: string, externalId: string): string {
  // SQL database uses a nested provider path, distinct from the (empty)
  // delete-handler entry.
  if (typeId === "azure-sql-database") {
    const [rg, server, db] = externalId.split("/");
    return `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Sql/servers/${server}/databases/${db}?api-version=2023-05-01-preview`;
  }

  const spec = AZURE_ARM_SPECS[typeId];
  if (!spec) throw new Error(`Azure plugin: manifest not supported for "${typeId}"`);

  if (typeId === "azure-resource-group") {
    return `${ARM}/subscriptions/${subscriptionId}/resourcegroups/${externalId}?api-version=${spec.apiVersion}`;
  }
  const [rg, name] = externalId.split("/");
  return `${ARM}/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/${spec.provider}/${name}?api-version=${spec.apiVersion}`;
}

export async function getAzureManifest(ctx: AzureHttpContext, resourceId: string): Promise<string> {
  // Resource ID format: accountId:typeId:externalId
  const parts = resourceId.split(":");
  const typeId = parts[1] ?? "";
  const externalId = parts.slice(2).join(":");
  const url = buildAzureArmUrl(ctx.subscriptionId, typeId, externalId);
  const raw = await ctx.get<Record<string, unknown>>(url);
  return JSON.stringify(raw, null, 2);
}

export async function applyAzureManifest(
  ctx: AzureHttpContext,
  resourceId: string,
  manifest: string,
): Promise<void> {
  const parts = resourceId.split(":");
  const typeId = parts[1] ?? "";
  const externalId = parts.slice(2).join(":");
  const url = buildAzureArmUrl(ctx.subscriptionId, typeId, externalId);
  const body = JSON.parse(manifest);
  await ctx.put(url, body);
}
