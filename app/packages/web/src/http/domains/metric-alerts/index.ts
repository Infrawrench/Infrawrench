/**
 * Metric alerts: `/api/org/:orgId/metric-alerts`, the handlers. The rules
 * and their evaluation live in `services/metric-alerts.ts`; the metric key
 * picker reads ClickHouse directly.
 */
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { MetricAlertSelector } from "@infrawrench/api-contract/schemas";
import { listMetricSeriesKeys } from "@infrawrench/server-core/clickhouse/readers";
import {
  MetricAlertEvent,
  MetricAlertRule,
  MetricAlertRuleWithStatus,
  MetricAlertsApi,
  MetricAlertSelectorOptions,
  MetricAlertSelectorPreview,
  MetricSeriesKey,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import {
  createRule,
  getRule,
  listEvents,
  listRulesWithStatus,
  listSelectorOptions,
  previewSelector,
  softDeleteRule,
  updateRule,
} from "../../../services/metric-alerts";
import { makeDomain } from "../../domain";
import { decodeAsPayload } from "../../request-body";
import { legacy } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** `c.req.query(name) || undefined`: an empty parameter is an absent one. */
const present = (value: string | undefined) => value || undefined;

const MetricAlertsHandlers = HttpApiBuilder.group(MetricAlertsApi, "metricAlerts", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rules = yield* legacy(() => listRulesWithStatus(organizationId));
        return yield* respond(Schema.Array(MetricAlertRuleWithStatus))(rules);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* legacy(() =>
          createRule(organizationId, payload, session.userId ?? null),
        );
        return yield* respond(MetricAlertRule)(created);
      }),
    )
    // The series labels that actually exist for the org (optionally narrowed
    // to plugin/type), so the rule builder offers real metrics rather than
    // asking for internal names.
    .handle("metricKeys", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const keys = yield* legacy(() =>
          listMetricSeriesKeys(organizationId, {
            pluginId: present(query.pluginId),
            resourceTypeId: present(query.resourceTypeId),
          }),
        );
        return yield* respond(Schema.Array(MetricSeriesKey))(keys);
      }),
    )
    .handle("selectorOptions", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const options = yield* legacy(() => listSelectorOptions(organizationId));
        return yield* respond(MetricAlertSelectorOptions)(options);
      }),
    )
    .handle("selectorPreview", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const selector = yield* decodeAsPayload(MetricAlertSelector, {
          pluginId: query.pluginId || null,
          resourceTypeId: query.resourceTypeId || null,
          tagKey: query.tagKey || null,
          tagValue: query.tagValue || null,
        });
        const preview = yield* legacy(() => previewSelector(organizationId, selector));
        return yield* respond(MetricAlertSelectorPreview)(preview);
      }),
    )
    .handle("events", ({ query }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const limitRaw = Number(query.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined;
        const events = yield* legacy(() =>
          listEvents(organizationId, { ruleId: present(query.ruleId), limit }),
        );
        return yield* respond(Schema.Array(MetricAlertEvent))(events);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const rule = yield* legacy(() => getRule(organizationId, params.id));
        if (!rule) return yield* notFound();
        return yield* respond(MetricAlertRule)(rule);
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const updated = yield* legacy(() => updateRule(organizationId, params.id, payload));
        if (!updated) return yield* notFound();
        return yield* respond(MetricAlertRule)(updated);
      }),
    )
    // Soft delete; history stays.
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => softDeleteRule(organizationId, params.id));
        if (!deleted) return yield* notFound();
        return ok;
      }),
    ),
);

export const metricAlertsDomain = makeDomain(
  "metric-alerts",
  MetricAlertsApi,
  MetricAlertsHandlers,
);
