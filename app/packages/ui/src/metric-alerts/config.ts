/**
 * Metric alert rules as the UI imports them: the types, limits and helpers
 * from `@infrawrench/client-core` (shared with mobile and the CLI),
 * re-exported so UI imports stay local. The request schemas the API decodes
 * and the rule editor validates with are `MetricAlertRuleInput` and
 * `MetricAlertSelector` in `@infrawrench/api-contract/schemas`.
 */

export {
  DEFAULT_METRIC_ALERT_INPUT,
  METRIC_ALERT_COMPARATORS,
  METRIC_ALERT_LIMITS,
  describeMetricAlertCondition,
  describeMetricAlertSelector,
} from "@infrawrench/client-core";
export type {
  MetricAlertComparator,
  MetricAlertEvent,
  MetricAlertRule,
  MetricAlertRuleInput,
  MetricAlertRuleWithStatus,
  MetricAlertSelector,
  MetricAlertSelectorOptions,
  MetricAlertSelectorPreview,
  MetricSeriesKeyOption,
} from "@infrawrench/client-core";
