import { useUIStore } from "@infrawrench/ui";
import type { EnvironmentAccount, EnvironmentsClient } from "@infrawrench/ui/environments";
import { listCloudAccounts } from "./cloud-accounts";
import {
  captureCloudEnvironmentDraft,
  createCloudEnvironmentTemplate,
  deleteCloudEnvironmentTemplate,
  estimateCloudEnvironment,
  fetchCloudEnvironmentSettings,
  forgetCloudEnvironment,
  instantiateCloudEnvironment,
  listCloudEnvironmentInstances,
  listCloudEnvironmentTemplates,
  tearDownCloudEnvironment,
  updateCloudEnvironmentSettings,
} from "./cloud-environments";

/**
 * Desktop implementation of the shared environments client — cloud mode only.
 * The org is resolved at call time rather than closed over, so switching orgs
 * mid-session cannot leave a stale id in a captured closure (the
 * `probes-client` convention).
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Ephemeral environments require cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopEnvironmentsClient(): EnvironmentsClient {
  return {
    listTemplates: async () => (await listCloudEnvironmentTemplates(requireOrgId())).templates,
    listInstances: async () => (await listCloudEnvironmentInstances(requireOrgId())).instances,
    getSettings: () => fetchCloudEnvironmentSettings(requireOrgId()),
    listAccounts: async (): Promise<EnvironmentAccount[]> => {
      const rows = await listCloudAccounts(requireOrgId());
      return rows
        .map((account) => ({
          id: account.id,
          displayName: account.displayName,
          pluginId: account.pluginId,
        }))
        .sort((x, y) => x.displayName.localeCompare(y.displayName));
    },
    captureDraft: (selector) => captureCloudEnvironmentDraft(requireOrgId(), selector),
    createTemplate: (input) => createCloudEnvironmentTemplate(requireOrgId(), input),
    deleteTemplate: (templateId) => deleteCloudEnvironmentTemplate(requireOrgId(), templateId),
    estimate: (templateId, body) => estimateCloudEnvironment(requireOrgId(), templateId, body),
    instantiate: (templateId, body) =>
      instantiateCloudEnvironment(requireOrgId(), templateId, body),
    teardown: (instanceId) => tearDownCloudEnvironment(requireOrgId(), instanceId),
    forget: (instanceId) => forgetCloudEnvironment(requireOrgId(), instanceId),
    updateSettings: (settings) => updateCloudEnvironmentSettings(requireOrgId(), settings),
  };
}
