/** Metric alert rule bodies (POST/PUT /metric-alerts), as Effect schemas. */
import { Schema } from "effect";
import {
  METRIC_ALERT_LIMITS,
  type MetricAlertRuleInput as MetricAlertRuleInputContract,
  type MetricAlertSelector as MetricAlertSelectorContract,
} from "@infrawrench/client-core";
import { maxLength, minLength, trimmed } from "./checks";
import type { Exact } from "./contract";

const L = METRIC_ALERT_LIMITS;

export const MetricAlertComparator = Schema.Literals([">", ">=", "<", "<="]).annotate({
  examples: [">"],
});

/** A selector part: a non-empty bounded string (after trimming), or null for "any". */
const selectorPart = (max: number) => Schema.NullOr(trimmed([minLength(1), maxLength(max)]));

const metricAlertSelectorFields = {
  pluginId: selectorPart(100).annotateKey({
    description: "Selector: plugin the resource must belong to. Null matches any plugin.",
  }),
  resourceTypeId: selectorPart(100).annotateKey({
    description: "Selector: resource type within the plugin. Null matches any type.",
  }),
  tagKey: selectorPart(L.maxTagLength).annotateKey({
    description:
      "Selector: tag key the resource must carry (matched case-insensitively). Null applies no tag filter. Resources are always selected by this query, never by id, so rules cover resources created later.",
  }),
  tagValue: selectorPart(L.maxTagLength).annotateKey({
    description: "Selector: exact value tagKey must have. Null matches any value.",
  }),
};

export const MetricAlertSelector = Schema.Struct(metricAlertSelectorFields);

/**
 * Flat rather than extending a registered selector, as the Zod spec was:
 * extending a registered schema emits `allOf` over its `$ref`, and an `allOf`
 * whose branches are all `additionalProperties: false` can never validate.
 */
export const MetricAlertRuleInput = Schema.Struct({
  ...metricAlertSelectorFields,
  name: trimmed([minLength(1), maxLength(L.maxNameLength)]),
  metricKey: trimmed([minLength(1), maxLength(L.maxMetricKeyLength)], {
    description:
      "The metric series label as the resource's charts report it (see /metric-alerts/metric-keys).",
    examples: ["CPU %"],
  }),
  comparator: MetricAlertComparator,
  threshold: Schema.Finite,
  forMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: L.minForMinutes, maximum: L.maxForMinutes }),
  ).annotate({
    description: "Trailing window (minutes) the condition must hold for before firing.",
  }),
  cooldownMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: L.minCooldownMinutes, maximum: L.maxCooldownMinutes }),
  ).annotate({ description: "Least minutes between notified firings for one (rule, resource)." }),
  enabled: Schema.Boolean,
}).annotate({ identifier: "MetricAlertRuleInput" });

export type MetricAlertSchemasMatchContract = [
  Exact<typeof MetricAlertRuleInput.Type, MetricAlertRuleInputContract>,
  Exact<typeof MetricAlertSelector.Type, MetricAlertSelectorContract>,
];
[true, true] satisfies MetricAlertSchemasMatchContract;
