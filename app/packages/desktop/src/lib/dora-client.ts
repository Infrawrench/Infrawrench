import { useUIStore } from "@infrawrench/ui";
import type { DoraClient } from "@infrawrench/ui/dora";
import {
  doraQueryString,
  type DoraChangesResponse,
  type DoraReport,
  type DoraRestoresResponse,
  type DoraSettingsView,
} from "@infrawrench/client-core";
import { invoke } from "./invoke";

/**
 * Delivery (DORA metrics) is cloud-only: the deploy events and incidents live
 * in the cloud. The active org is resolved at call time rather than closed
 * over, matching `slos-client.ts`. The settings writer is always offered; the
 * server enforces `org:settings:write` and the modal shows its error.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Delivery metrics require cloud mode: sign in to sync.");
  return orgId;
}

export function createDesktopDoraClient(): DoraClient {
  return {
    getReport: (q) =>
      invoke<DoraReport>("cloud_dora_report", { orgId: requireOrgId(), qs: doraQueryString(q) }),
    listChanges: (q) =>
      invoke<DoraChangesResponse>("cloud_dora_changes", {
        orgId: requireOrgId(),
        qs: doraQueryString(q),
      }),
    listRestores: (q) =>
      invoke<DoraRestoresResponse>("cloud_dora_restores", {
        orgId: requireOrgId(),
        qs: doraQueryString(q),
      }),
    getSettings: () =>
      invoke<DoraSettingsView>("cloud_dora_settings_get", { orgId: requireOrgId() }),
    updateSettings: (patch) =>
      invoke<DoraSettingsView>("cloud_dora_settings_update", { orgId: requireOrgId(), patch }),
  };
}
