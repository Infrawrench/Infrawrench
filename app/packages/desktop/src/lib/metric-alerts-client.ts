import { useUIStore } from "@infrawrench/ui";
import type { MetricAlertsClient } from "@infrawrench/ui/metric-alerts";
import {
  createCloudMetricAlertRule,
  deleteCloudMetricAlertRule,
  listCloudMetricAlertEvents,
  listCloudMetricAlertRules,
  listCloudMetricSeriesKeys,
  loadCloudMetricAlertSelectorOptions,
  previewCloudMetricAlertSelector,
  updateCloudMetricAlertRule,
} from "./cloud-metric-alerts";

/**
 * Metric alerts are cloud-only: rules are evaluated by the cloud poller, so a
 * desktop app in local mode has nothing to show. The active org is resolved
 * at call time rather than closed over, matching `costs-client.ts` — the org
 * can change under a mounted panel when the user switches org.
 */
function requireOrgId(): string {
  const orgId = useUIStore.getState().activeCloudOrgId;
  if (!orgId) throw new Error("Metric alerts require cloud mode — sign in to sync.");
  return orgId;
}

export function createDesktopMetricAlertsClient(): MetricAlertsClient {
  return {
    listRules: () => listCloudMetricAlertRules(requireOrgId()),
    listEvents: (options) => listCloudMetricAlertEvents(requireOrgId(), options),
    listMetricKeys: (filter) => listCloudMetricSeriesKeys(requireOrgId(), filter),
    selectorOptions: () => loadCloudMetricAlertSelectorOptions(requireOrgId()),
    previewSelector: (selector) => previewCloudMetricAlertSelector(requireOrgId(), selector),
    createRule: (input) => createCloudMetricAlertRule(requireOrgId(), input),
    updateRule: (ruleId, input) => updateCloudMetricAlertRule(requireOrgId(), ruleId, input),
    deleteRule: (ruleId) => deleteCloudMetricAlertRule(requireOrgId(), ruleId),
  };
}
