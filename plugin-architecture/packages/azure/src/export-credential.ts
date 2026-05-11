/**
 * Credential export — produces the downloadable secret bundle shown in the
 * "Export credentials" UI.
 *
 * Storage account: lists both account keys and emits either an INI of both
 * keys or the canonical connection string.
 * App registration: calls Graph `addPassword` to mint a fresh client secret
 * (Graph only returns the secret text on this single call) and packages it as
 * a .env file alongside the tenant/client id.
 */
import type { CredentialExport } from "@infrawrench/plugin-base";
import type { AzureCredentials } from "./auth.js";
import { ARM, type AzureHttpContext } from "./shared.js";
import type { ResourceInstance } from "@infrawrench/plugin-base";

export interface ExportCredentialContext extends AzureHttpContext {
  getResource(typeId: string, resourceId: string, accountId: string): Promise<ResourceInstance>;
  graphRequest<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T>;
  creds: AzureCredentials;
}

export async function exportAzureCredential(
  ctx: ExportCredentialContext,
  typeId: string,
  resourceId: string,
  accountId: string,
  formatId: string,
): Promise<CredentialExport> {
  if (typeId === "azure-storage-account") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const [rg, name] = (resource.externalId ?? "").split("/");
    if (!rg || !name) throw new Error("Cannot determine storage account name / resource group");
    const keysResp = await ctx.post<{
      keys?: Array<{ keyName: string; value: string; permissions?: string }>;
    }>(
      `${ARM}/subscriptions/${ctx.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Storage/storageAccounts/${name}/listKeys?api-version=2023-01-01`,
      {},
    );
    const keys = keysResp.keys ?? [];
    const key1 = keys.find((k) => k.keyName === "key1")?.value ?? keys[0]?.value ?? "";
    const key2 = keys.find((k) => k.keyName === "key2")?.value ?? keys[1]?.value ?? "";
    if (!key1) throw new Error("Azure returned no storage account keys");
    const connStr = `DefaultEndpointsProtocol=https;AccountName=${name};AccountKey=${key1};EndpointSuffix=core.windows.net`;
    if (formatId === "connection-string") {
      return {
        content: connStr,
        filename: `${name}.connection-string`,
        mimeType: "text/plain",
        fields: [
          { label: "Account Name", value: name },
          { label: "Connection String", value: connStr, sensitive: true },
        ],
        warning:
          "Contains the primary account key. Anyone with this string has full access to the storage account. Rotate by regenerating the key.",
      };
    }
    if (formatId === "access-keys") {
      const ini = `[${name}]\nprimary_key=${key1}\n${key2 ? `secondary_key=${key2}\n` : ""}`;
      return {
        content: ini,
        filename: `${name}.keys`,
        mimeType: "text/plain",
        fields: [
          { label: "Account Name", value: name },
          {
            label: "Primary Key (key1)",
            value: key1,
            sensitive: true,
            hint: "Full account access",
          },
          ...(key2
            ? [{ label: "Secondary Key (key2)", value: key2, sensitive: true as const }]
            : []),
        ],
        warning:
          "Both keys are full-access. Rotate one at a time: regenerate key1 while apps use key2, then swap.",
      };
    }
  }
  if (typeId === "azure-app-registration" && formatId === "client-secret") {
    const resource = await ctx.getResource(typeId, resourceId, accountId);
    const objectId = String(resource.externalId ?? resource.fields["objectId"] ?? "");
    const appId = String(resource.fields["appId"] ?? "");
    const displayName = String(resource.displayName ?? resource.fields["displayName"] ?? "");
    if (!objectId || !appId) {
      throw new Error("Cannot determine app registration object id / appId");
    }
    // Default two-year expiry, Graph-side default.
    const secretDisplayName = `infrawrench-${new Date().toISOString().slice(0, 10)}`;
    const pw = await ctx.graphRequest<{
      secretText?: string;
      keyId?: string;
      displayName?: string;
      endDateTime?: string;
    }>("POST", `/applications/${objectId}/addPassword`, {
      passwordCredential: { displayName: secretDisplayName },
    });
    const secretText = pw.secretText ?? "";
    const keyId = pw.keyId ?? "";
    if (!secretText) throw new Error("Graph returned an empty secretText");
    const envFile =
      `# Azure service principal: ${displayName}\n` +
      `AZURE_TENANT_ID=${ctx.creds.tenantId}\n` +
      `AZURE_CLIENT_ID=${appId}\n` +
      `AZURE_CLIENT_SECRET=${secretText}\n`;
    return {
      content: envFile,
      filename: `${displayName || appId}.env`,
      mimeType: "text/plain",
      fields: [
        { label: "Tenant ID", value: ctx.creds.tenantId },
        { label: "Client ID (appId)", value: appId },
        {
          label: "Client Secret",
          value: secretText,
          sensitive: true,
          hint: "Only shown once",
        },
        ...(keyId ? [{ label: "Key ID", value: keyId }] : []),
        ...(pw.endDateTime ? [{ label: "Expires", value: pw.endDateTime }] : []),
      ],
      warning:
        "Save now. Microsoft Graph does not return this secret again — if lost, delete the credential (removePassword) and create a new one. Default expiry is 2 years.",
    };
  }

  throw new Error(
    `Azure plugin: exportCredential not supported for type "${typeId}" / format "${formatId}"`,
  );
}
