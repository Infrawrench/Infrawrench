// The wire types themselves are re-exported by `./config.ts` (the one place,
// so the barrel's star exports never turn ambiguous and get dropped from the
// built d.ts); this module only adds the client seam.
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

/**
 * What a host must provide for the metric alerts panel. The write methods are
 * optional — their absence renders the panel read-only, the same capability
 * gating `CostsClient` uses.
 */
export interface MetricAlertsClient {
  listRules(): Promise<MetricAlertRuleWithStatus[]>;
  listEvents(options?: { ruleId?: string; limit?: number }): Promise<MetricAlertEvent[]>;
  listMetricKeys(filter?: {
    pluginId?: string | null;
    resourceTypeId?: string | null;
  }): Promise<MetricSeriesKeyOption[]>;
  selectorOptions(): Promise<MetricAlertSelectorOptions>;
  previewSelector(selector: MetricAlertSelector): Promise<MetricAlertSelectorPreview | null>;
  createRule?(input: MetricAlertRuleInput): Promise<MetricAlertRule | null>;
  updateRule?(ruleId: string, input: MetricAlertRuleInput): Promise<MetricAlertRule | null>;
  deleteRule?(ruleId: string): Promise<void>;
}
