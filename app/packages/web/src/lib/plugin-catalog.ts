import { apiGet } from "./api";
import type { PluginInfo } from "@infrawrench/ui";

/**
 * The plugin catalog lives on the accounts router (`/accounts/plugins`), not at
 * the org root. Fetch it through here rather than hand-writing the path — the
 * Update Credentials flow shipped with `/api/org/:orgId/plugins`, which 404s.
 */
export function pluginCatalogUrl(orgId: string): string {
  return `/api/org/${orgId}/accounts/plugins`;
}

/** Plugin manifests (credential fields, logo, display name) for this org. */
export function fetchPluginCatalog(orgId: string): Promise<PluginInfo[]> {
  return apiGet<PluginInfo[]>(pluginCatalogUrl(orgId));
}
