/**
 * Generic delete dispatch.
 *
 * Most Azure resource types follow the same URL pattern, so a single
 * `provider / api-version` lookup table is enough. The two exceptions —
 * resource groups (no provider segment) and SQL databases (three-part
 * externalId rg/server/database) — are handled explicitly.
 *
 * The provider/api-version pairs come from `AZURE_ARM_SPECS` in `shared.ts` so
 * an api-version bump lands on read and delete at once; the only delete-side
 * addition is the SQL database entry, which `shared.ts` has no use for.
 */
import type { Client as GraphClient } from "@microsoft/microsoft-graph-client";
import type { ResourceInstance } from "@infrawrench/plugin-base";
import { ARM, AZURE_ARM_SPECS, type ArmResourceSpec, type AzureHttpContext } from "./shared.js";

const DELETE_SPECS: Record<string, ArmResourceSpec> = {
  ...AZURE_ARM_SPECS,
  // Deleting a SQL database needs the three-part rg/server/database externalId,
  // so it is built by hand below rather than from a provider/api-version pair.
  "azure-sql-database": { provider: "", apiVersion: "" },
};

interface DeleteContext extends AzureHttpContext {
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
  graphClient: GraphClient;
}

export async function deleteAzureResource(
  ctx: DeleteContext,
  typeId: string,
  resourceId: string,
  accountId: string,
): Promise<void> {
  if (typeId === "azure-app-registration") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const objectId = String(resource.externalId ?? resource.fields["objectId"] ?? "");
    if (!objectId) throw new Error("Cannot determine app registration object id");
    await ctx.graphClient.api(`/applications/${objectId}`).delete();
    return;
  }
  const resource = await ctx.getResource(typeId, resourceId, accountId);
  const externalId = resource.externalId ?? "";

  const spec = DELETE_SPECS[typeId];
  if (!spec) throw new Error(`Azure plugin: delete not supported for "${typeId}"`);

  if (typeId === "azure-resource-group") {
    const rgName = externalId;
    await ctx.del(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourcegroups/${rgName}?api-version=${spec.apiVersion}`,
    );
    return;
  }

  if (typeId === "azure-sql-database") {
    // externalId is rg/server/database
    const parts = externalId.split("/");
    const [rg, server, db] = parts;
    await ctx.del(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Sql/servers/${server}/databases/${db}?api-version=2023-05-01-preview`,
    );
    return;
  }

  // Standard two-part externalId: rg/name
  const [rg, name] = externalId.split("/");
  await ctx.del(
    `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/${spec.provider}/${name}?api-version=${spec.apiVersion}`,
  );
}
