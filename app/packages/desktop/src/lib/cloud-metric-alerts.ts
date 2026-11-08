/**
 * Metric threshold alert rules: cloud-mode only (rules are evaluated by the
 * cloud poller against the cloud metric store). Typed calls to the
 * contract's `metricAlerts` domain over the cloud transport
 * (`./cloud-client.ts`), matching `cloud-probes.ts`.
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
import { cloudClient } from "./cloud-client";
import { runRpc } from "./rpc/client";

const metricAlerts = () => cloudClient("metricAlerts").metricAlerts;

export async function listCloudMetricAlertRules(
  orgId: string,
): Promise<MetricAlertRuleWithStatus[]> {
  return runRpc(metricAlerts().list({ params: { orgId } }));
}

export async function listCloudMetricAlertEvents(
  orgId: string,
  options?: { ruleId?: string; limit?: number },
): Promise<MetricAlertEvent[]> {
  const query = {
    ...(options?.ruleId ? { ruleId: options.ruleId } : {}),
    ...(options?.limit ? { limit: String(options.limit) } : {}),
  };
  return runRpc(metricAlerts().events({ params: { orgId }, query }));
}

export async function listCloudMetricSeriesKeys(
  orgId: string,
  filter?: { pluginId?: string | null; resourceTypeId?: string | null },
): Promise<MetricSeriesKeyOption[]> {
  const query = {
    ...(filter?.pluginId ? { pluginId: filter.pluginId } : {}),
    ...(filter?.resourceTypeId ? { resourceTypeId: filter.resourceTypeId } : {}),
  };
  return runRpc(metricAlerts().metricKeys({ params: { orgId }, query }));
}

export async function loadCloudMetricAlertSelectorOptions(
  orgId: string,
): Promise<MetricAlertSelectorOptions> {
  return runRpc(metricAlerts().selectorOptions({ params: { orgId } }));
}

export async function previewCloudMetricAlertSelector(
  orgId: string,
  selector: MetricAlertSelector,
): Promise<MetricAlertSelectorPreview> {
  // Empty parts are left out, as the handler reads an absent one as null.
  const query = {
    ...(selector.pluginId ? { pluginId: selector.pluginId } : {}),
    ...(selector.resourceTypeId ? { resourceTypeId: selector.resourceTypeId } : {}),
    ...(selector.tagKey ? { tagKey: selector.tagKey } : {}),
    ...(selector.tagValue ? { tagValue: selector.tagValue } : {}),
  };
  return runRpc(metricAlerts().selectorPreview({ params: { orgId }, query }));
}

export async function createCloudMetricAlertRule(
  orgId: string,
  input: MetricAlertRuleInput,
): Promise<MetricAlertRule> {
  return runRpc(metricAlerts().create({ params: { orgId }, payload: input }));
}

export async function updateCloudMetricAlertRule(
  orgId: string,
  ruleId: string,
  input: MetricAlertRuleInput,
): Promise<MetricAlertRule> {
  return runRpc(metricAlerts().update({ params: { orgId, id: ruleId }, payload: input }));
}

export async function deleteCloudMetricAlertRule(orgId: string, ruleId: string): Promise<void> {
  await runRpc(metricAlerts().delete({ params: { orgId, id: ruleId } }));
}
