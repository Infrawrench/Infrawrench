/**
 * Metric threshold alert rules — cloud-mode only (rules are evaluated by the
 * cloud poller against the cloud metric store). One wrapper per allowlisted
 * IPC channel, matching `cloud-costs.ts`.
 */
import type {
  MetricAlertEvent,
  MetricAlertRule,
  MetricAlertRuleInput,
  MetricAlertRuleWithStatus,
  MetricAlertSelector,
  MetricAlertSelectorOptions,
  MetricAlertSelectorPreview,
  MetricSeriesKeyOption,
} from "@infrawrench/ui/metric-alerts";
import { invoke } from "./invoke";

export async function listCloudMetricAlertRules(
  orgId: string,
): Promise<MetricAlertRuleWithStatus[]> {
  return invoke("cloud_metric_alerts_list", { orgId });
}

export async function listCloudMetricAlertEvents(
  orgId: string,
  options?: { ruleId?: string; limit?: number },
): Promise<MetricAlertEvent[]> {
  return invoke("cloud_metric_alerts_events", { orgId, ...options });
}

export async function listCloudMetricSeriesKeys(
  orgId: string,
  filter?: { pluginId?: string | null; resourceTypeId?: string | null },
): Promise<MetricSeriesKeyOption[]> {
  return invoke("cloud_metric_alerts_metric_keys", {
    orgId,
    ...(filter?.pluginId ? { pluginId: filter.pluginId } : {}),
    ...(filter?.resourceTypeId ? { resourceTypeId: filter.resourceTypeId } : {}),
  });
}

export async function loadCloudMetricAlertSelectorOptions(
  orgId: string,
): Promise<MetricAlertSelectorOptions> {
  return invoke("cloud_metric_alerts_selector_options", { orgId });
}

export async function previewCloudMetricAlertSelector(
  orgId: string,
  selector: MetricAlertSelector,
): Promise<MetricAlertSelectorPreview> {
  return invoke("cloud_metric_alerts_selector_preview", { orgId, selector });
}

export async function createCloudMetricAlertRule(
  orgId: string,
  input: MetricAlertRuleInput,
): Promise<MetricAlertRule> {
  return invoke("cloud_metric_alerts_create", { orgId, input });
}

export async function updateCloudMetricAlertRule(
  orgId: string,
  ruleId: string,
  input: MetricAlertRuleInput,
): Promise<MetricAlertRule> {
  return invoke("cloud_metric_alerts_update", { orgId, ruleId, input });
}

export async function deleteCloudMetricAlertRule(orgId: string, ruleId: string): Promise<void> {
  await invoke("cloud_metric_alerts_delete", { orgId, ruleId });
}
