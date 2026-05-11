import type { ResourceInstance } from "@infrawrench/plugin-base";
import type { AzureCreateContext } from "./create-handlers-shared.js";

/**
 * Create an Entra ID app registration + matching service principal. Three Graph calls:
 * 1. POST /applications → creates the app, returns object `id` and `appId` (different GUIDs).
 * 2. POST /servicePrincipals with `{appId}` → creates the SP, returns `id` (SP object id).
 * 3. (optional) PUT roleAssignment on ARM if a role is requested — not wired in this version;
 *    users assign roles via the Azure portal or future policy-picker support.
 */
export async function createAppRegistration(
  ctx: AzureCreateContext,
  accountId: string,
  fields: Record<string, string>,
): Promise<ResourceInstance> {
  const displayName = fields["displayName"] ?? "";
  if (!displayName) throw new Error("displayName is required");
  const app = (await ctx.graphClient.api("/applications").post({ displayName })) as {
    id?: string;
    appId?: string;
    displayName?: string;
    signInAudience?: string;
    createdDateTime?: string;
  };
  const objectId = app.id ?? "";
  const appId = app.appId ?? "";
  if (!objectId || !appId) throw new Error("Graph returned an empty application");
  // Create the SP — without this, the app can't be used as a principal for role assignments.
  let spId = "";
  try {
    const sp = (await ctx.graphClient.api("/servicePrincipals").post({ appId })) as {
      id?: string;
    };
    spId = sp.id ?? "";
  } catch (e) {
    // Roll back the app if SP creation fails so we don't leak an orphan.
    let cleanupNote = "";
    try {
      await ctx.graphClient.api(`/applications/${objectId}`).delete();
    } catch (cleanupErr) {
      cleanupNote = ` (cleanup of orphaned app ${objectId} also failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)})`;
    }
    const baseMsg = e instanceof Error ? e.message : String(e);
    throw new Error(`Service principal creation failed${cleanupNote}: ${baseMsg}`);
  }
  const now = new Date().toISOString();
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
      servicePrincipalId: spId,
      signInAudience: String(app.signInAudience ?? ""),
      createdDateTime: String(app.createdDateTime ?? now),
    },
    resolvedOutputs: { appId, tenantId: ctx.tenantId },
    secretStates: [],
    externalId: objectId,
    createdAt: String(app.createdDateTime ?? now),
    updatedAt: now,
  };
}
