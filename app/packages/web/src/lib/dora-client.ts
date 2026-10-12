import type { DoraClient } from "@infrawrench/ui/dora";
import {
  doraQueryString,
  type DoraChangesResponse,
  type DoraReport,
  type DoraRestoresResponse,
  type DoraSettings,
  type DoraSettingsView,
} from "@infrawrench/client-core";
import { apiGet, apiPut } from "./api";

/**
 * Web implementation of the shared Delivery (DORA) client, per org.
 * `canEditSettings` gates the settings writer (`org:settings:write`); the
 * panel renders the settings read-only without it, and the server enforces
 * regardless.
 */
export function createWebDoraClient(orgId: string, canEditSettings = false): DoraClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/dora`;
  return {
    getReport: (q) => apiGet<DoraReport>(`${base}?${doraQueryString(q)}`),
    listChanges: (q) => apiGet<DoraChangesResponse>(`${base}/changes?${doraQueryString(q)}`),
    listRestores: (q) => apiGet<DoraRestoresResponse>(`${base}/restores?${doraQueryString(q)}`),
    getSettings: () => apiGet<DoraSettingsView>(`${base}/settings`),
    ...(canEditSettings
      ? {
          updateSettings: (patch: Partial<DoraSettings>) =>
            apiPut<DoraSettingsView>(`${base}/settings`, patch),
        }
      : {}),
  };
}
