/**
 * Zod schemas for metric alert rules — what the web API validates request
 * bodies against, and what the rule editor builds.
 *
 * The *types* those schemas describe live in `@infrawrench/client-core` so
 * mobile and the CLI (which don't depend on this package) share one
 * definition; they are re-exported here so UI imports stay local. The
 * assertion at the bottom fails the build if the schema drifts from the type
 * (the `cost/config.ts` convention).
 */
import { z } from "zod";
import {
  METRIC_ALERT_LIMITS,
  type MetricAlertRuleInput,
  type MetricAlertSelector,
} from "@infrawrench/client-core";

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

export const metricAlertComparatorSchema = z.enum([">", ">=", "<", "<="]);

/** A selector part: a non-empty bounded string, or null for "any". */
const selectorPart = (max: number) => z.string().trim().min(1).max(max).nullable();

export const metricAlertSelectorSchema = z.object({
  pluginId: selectorPart(100),
  resourceTypeId: selectorPart(100),
  tagKey: selectorPart(METRIC_ALERT_LIMITS.maxTagLength),
  tagValue: selectorPart(METRIC_ALERT_LIMITS.maxTagLength),
});

export const metricAlertRuleInputSchema = metricAlertSelectorSchema.extend({
  name: z.string().trim().min(1).max(METRIC_ALERT_LIMITS.maxNameLength),
  metricKey: z.string().trim().min(1).max(METRIC_ALERT_LIMITS.maxMetricKeyLength),
  comparator: metricAlertComparatorSchema,
  threshold: z.number().finite(),
  forMinutes: z
    .number()
    .int()
    .min(METRIC_ALERT_LIMITS.minForMinutes)
    .max(METRIC_ALERT_LIMITS.maxForMinutes),
  cooldownMinutes: z
    .number()
    .int()
    .min(METRIC_ALERT_LIMITS.minCooldownMinutes)
    .max(METRIC_ALERT_LIMITS.maxCooldownMinutes),
  enabled: z.boolean(),
});

/* ------------------------------ drift guards ------------------------------ */

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Compile-time proof the schemas still parse to the shared client-core types. */
export type SchemasMatchMetricAlertContract = [
  Exact<z.infer<typeof metricAlertRuleInputSchema>, MetricAlertRuleInput>,
  Exact<z.infer<typeof metricAlertSelectorSchema>, MetricAlertSelector>,
];
