/**
 * App registration listing — uses Microsoft Graph rather than ARM.
 *
 * Graph doesn't support an `IN`-style filter on `appId`, so service principal
 * lookups are made one at a time. The client-credentials flow has no `/me`,
 * so we list all apps the SP can see and rely on the SP's permissions to gate
 * the result set.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface AppRegistrationContext {
  graphRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  graphToken(): Promise<string>;
  makeId(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  tenantId: string;
}

export async function listAppRegistrations(
  ctx: AppRegistrationContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const apps: Array<Record<string, unknown>> = [];
  let nextLink: string | undefined;
  const servicePrincipals = new Map<string, string>(); // appId -> sp.id

  // First page: apps
  let data = await ctx.graphRequest<{
    value: Array<Record<string, unknown>>;
    "@odata.nextLink"?: string;
  }>("GET", "/applications?$top=100&$select=id,appId,displayName,signInAudience,createdDateTime");
  apps.push(...data.value);
  nextLink = data["@odata.nextLink"];
  while (nextLink) {
    const tok = await ctx.graphToken();
    const res = await fetch(nextLink, { headers: { Authorization: `Bearer ${tok}` } });
    if (!res.ok) break;
    data = (await res.json()) as typeof data;
    apps.push(...data.value);
    nextLink = data["@odata.nextLink"];
  }

  // Look up service principals one at a time — Graph doesn't support IN filters on appId,
  // and the batch endpoint adds complexity. Owned-by scopes are typically small.
  for (const app of apps) {
    const appId = String(app["appId"] ?? "");
    if (!appId) continue;
    try {
      const spList = await ctx.graphRequest<{ value: Array<Record<string, unknown>> }>(
        "GET",
        `/servicePrincipals?$filter=appId eq '${appId}'&$select=id`,
      );
      const spId = spList.value[0]?.["id"];
      if (typeof spId === "string") servicePrincipals.set(appId, spId);
    } catch {
      // skip — SP lookup failure shouldn't block listing
    }
  }

  const now = ctx.now();
  return apps.map((a) => {
    const appId = String(a["appId"] ?? "");
    const objectId = String(a["id"] ?? "");
    const displayName = String(a["displayName"] ?? objectId);
    return {
      id: ctx.makeId(accountId, "azure-app-registration", objectId),
      pluginId: "azure",
      resourceTypeId: "azure-app-registration",
      accountId,
      displayName,
      fields: {
        displayName,
        appId,
        objectId,
        servicePrincipalId: servicePrincipals.get(appId) ?? "",
        signInAudience: String(a["signInAudience"] ?? ""),
        createdDateTime: String(a["createdDateTime"] ?? ""),
      },
      resolvedOutputs: { appId, tenantId: ctx.tenantId },
      secretStates: [],
      externalId: objectId,
      createdAt: String(a["createdDateTime"] ?? now),
      updatedAt: now,
    };
  });
}
