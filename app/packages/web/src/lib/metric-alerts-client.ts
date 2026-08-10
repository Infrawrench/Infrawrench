import type { MetricAlertsClient } from "@infrawrench/ui/metric-alerts";
import type {
  MetricAlertEvent,
  MetricAlertRule,
  MetricAlertRuleInput,
  MetricAlertRuleWithStatus,
  MetricAlertSelector,
  MetricAlertSelectorOptions,
  MetricAlertSelectorPreview,
  MetricSeriesKeyOption,
} from "@infrawrench/client-core";
import { apiDelete, apiGet, apiPost, apiPut } from "./api";

/** Web implementation of the shared metric-alerts client, per org. */
export function createWebMetricAlertsClient(orgId: string): MetricAlertsClient {
  const base = `/api/org/${encodeURIComponent(orgId)}/metric-alerts`;
  return {
    listRules: () => apiGet<MetricAlertRuleWithStatus[]>(base),
    listEvents: (options) => {
      const params = new URLSearchParams();
      if (options?.ruleId) params.set("ruleId", options.ruleId);
      if (options?.limit) params.set("limit", String(options.limit));
      const qs = params.toString();
      return apiGet<MetricAlertEvent[]>(`${base}/events${qs ? `?${qs}` : ""}`);
    },
    listMetricKeys: (filter) => {
      const params = new URLSearchParams();
      if (filter?.pluginId) params.set("pluginId", filter.pluginId);
      if (filter?.resourceTypeId) params.set("resourceTypeId", filter.resourceTypeId);
      const qs = params.toString();
      return apiGet<MetricSeriesKeyOption[]>(`${base}/metric-keys${qs ? `?${qs}` : ""}`);
    },
    selectorOptions: () => apiGet<MetricAlertSelectorOptions>(`${base}/selector-options`),
    previewSelector: (selector: MetricAlertSelector) => {
      const params = new URLSearchParams();
      if (selector.pluginId) params.set("pluginId", selector.pluginId);
      if (selector.resourceTypeId) params.set("resourceTypeId", selector.resourceTypeId);
      if (selector.tagKey) params.set("tagKey", selector.tagKey);
      if (selector.tagValue) params.set("tagValue", selector.tagValue);
      const qs = params.toString();
      return apiGet<MetricAlertSelectorPreview>(`${base}/selector-preview${qs ? `?${qs}` : ""}`);
    },
    createRule: (input: MetricAlertRuleInput) => apiPost<MetricAlertRule>(base, input),
    updateRule: (ruleId: string, input: MetricAlertRuleInput) =>
      apiPut<MetricAlertRule>(`${base}/${encodeURIComponent(ruleId)}`, input),
    deleteRule: async (ruleId: string) => {
      await apiDelete(`${base}/${encodeURIComponent(ruleId)}`);
    },
  };
}
