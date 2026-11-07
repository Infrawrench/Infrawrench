/**
 * App registration listing: uses Microsoft Graph rather than ARM.
 *
 * Graph doesn't support an `IN`-style filter on `appId`, so service principal
 * lookups are made one at a time. The client-credentials flow has no `/me`,
 * so we list all apps the SP can see and rely on the SP's permissions to gate
 * the result set.
 */
import type { Client as GraphClient } from "@microsoft/microsoft-graph-client";
import {
  followableLink,
  ListTruncatedError,
  requireListPage,
  type ResourceInstance,
} from "@infrawrench/plugin-base";

const APPLICATIONS_URL = "https://graph.microsoft.com/v1.0/applications";
/** "The default and maximum page sizes are 100 and 999" (application-list). */
const APPLICATIONS_PAGE_SIZE = 999;
/** 100,000 rows at the largest page: the most one poll can write. */
const MAX_APPLICATION_PAGES = Math.ceil(100_000 / APPLICATIONS_PAGE_SIZE);

interface ApplicationsPage {
  value?: Array<Record<string, unknown>> | null;
  "@odata.nextLink"?: string;
}

interface AppRegistrationContext {
  graphClient: GraphClient;
  makeId(accountId: string, typeId: string, externalId: string): string;
  now(): string;
  tenantId: string;
}

export async function listAppRegistrations(
  ctx: AppRegistrationContext,
  accountId: string,
): Promise<ResourceInstance[]> {
  const apps: Array<Record<string, unknown>> = [];
  const servicePrincipals = new Map<string, string>(); // appId -> sp.id

  // The SDK's `.api(absoluteUrl)` accepts the `@odata.nextLink` value verbatim, so
  // paging is just "while there's a nextLink, fetch it". A page that fails, fails the
  // list: what it held would otherwise read as deleted.
  const place = { vendor: "Microsoft Graph", path: "/applications" };
  let pageUrl = APPLICATIONS_URL;
  let page = (await ctx.graphClient
    .api("/applications")
    .top(APPLICATIONS_PAGE_SIZE)
    .select("id,appId,displayName,signInAudience,createdDateTime")
    .get()) as ApplicationsPage;
  for (let read = 1; ; read++) {
    apps.push(...requireListPage(page.value, { ...place, key: "value", page }));
    const nextLink = page["@odata.nextLink"];
    if (!nextLink) break;
    if (read >= MAX_APPLICATION_PAGES) {
      throw new ListTruncatedError({ ...place, items: apps.length, maxPages: read });
    }
    pageUrl = followableLink(nextLink, pageUrl, place);
    page = (await ctx.graphClient.api(pageUrl).get()) as ApplicationsPage;
  }

  // Look up service principals one at a time: Graph doesn't support IN filters on appId,
  // and the batch endpoint adds complexity. Owned-by scopes are typically small.
  for (const app of apps) {
    const appId = String(app["appId"] ?? "");
    if (!appId) continue;
    try {
      const spList = (await ctx.graphClient
        .api("/servicePrincipals")
        .filter(`appId eq '${appId}'`)
        .select("id")
        .get()) as { value: Array<Record<string, unknown>> };
      const spId = spList.value[0]?.["id"];
      if (typeof spId === "string") servicePrincipals.set(appId, spId);
    } catch {
      // skip: SP lookup failure shouldn't block listing
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
