/**
 * Business metrics and unit costs: `/api/org/:orgId/business-metrics`, the
 * handlers.
 *
 * The logic lives in `services/business-metrics.ts`,
 * `services/unit-cost-query.ts` and `services/business-metric-forecast-values.ts`
 * (and the importers' host half in `server-core/cost/metric-importers.ts`), so
 * the MCP tools and the CLI drive exactly the same code path; this file is
 * transport only, run through `legacy` inside the request's scopes.
 *
 * Routes that look the metric up before reading the body (or check a second
 * permission first) are served raw and decode the body themselves, so a
 * missing metric is still a 404 and a missing grant a 403 whatever was sent.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  BusinessMetricForecastValuesBody,
  BusinessMetricImporterInput,
  BusinessMetricImportPreviewRequest,
  BusinessMetricImportRunRequest,
  BusinessMetricSourceOptionsRequest,
  BusinessMetricValuesBody,
} from "@infrawrench/ui/schemas";
import {
  BUSINESS_METRIC_LIMITS,
  unitCostExportFile,
  unitCostExportFilename,
  type UnitCostExportFormat,
  type UnitCostQueryResponse as UnitCostQueryResult,
} from "@infrawrench/client-core";
import {
  BusinessMetricIngestError,
  ingestMetricValues,
} from "@infrawrench/server-core/cost/metric-ingest";
import {
  BusinessMetricImporterError,
  deleteBusinessMetricImporter,
  getBusinessMetricImporter,
  listBusinessMetricImportRuns,
  listBusinessMetricSourceAccounts,
  listBusinessMetricSourceOptions,
  previewBusinessMetricImport,
  runBusinessMetricImporterNow,
  upsertBusinessMetricImporter,
} from "@infrawrench/server-core/cost/metric-importers";
import {
  BusinessMetricInputError,
  BusinessMetricKeyConflictError,
  createBusinessMetric,
  getBusinessMetric,
  listBusinessMetricLabels,
  listBusinessMetricValues,
  listBusinessMetrics,
  softDeleteBusinessMetric,
  updateBusinessMetric,
} from "../../../services/business-metrics";
import {
  BusinessMetricNotFoundError,
  CostQueryError,
  listUsageUnits,
  runUnitCostQuery,
  runUsageUnitCostQuery,
} from "../../../services/unit-cost-query";
import {
  BusinessMetricForecastValueError,
  deleteBusinessMetricForecastValues,
  listBusinessMetricForecastValues,
  parseForecastValueRange,
  writeBusinessMetricForecastValues,
} from "../../../services/business-metric-forecast-values";
import { logAudit } from "../../../services/audit";
import { makeDomain } from "../../domain";
import { BadRequest, Conflict, HttpFailure, NotFound, notFound } from "../../errors";
import { decodeAsPayload, readJson, readJsonOr } from "../../json-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { invalidBody, inputRefusal } from "../../object-body";
import { OrgPrincipal, requirePermission } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  BusinessMetric,
  BusinessMetricForecastValueList,
  BusinessMetricForecastValuesDeleted,
  BusinessMetricForecastValuesWritten,
  BusinessMetricImporter,
  BusinessMetricImporterResult,
  BusinessMetricImportPreview,
  BusinessMetricImportRun,
  BusinessMetricImportRunList,
  BusinessMetricLabelList,
  BusinessMetricList,
  BusinessMetricSourceList,
  BusinessMetricSourceOptions,
  BusinessMetricsApi,
  BusinessMetricValueList,
  BusinessMetricValuesWritten,
  UnitCostQueryResponse,
  UsageUnitList,
} from "./api";

/** The write-path refusals, each with the status the route always gave it. */
const writeRefusal = (error: unknown): BadRequest | NotFound | Conflict | undefined => {
  if (error instanceof BusinessMetricKeyConflictError)
    return new Conflict({ error: error.message });
  if (error instanceof BusinessMetricInputError) return new BadRequest({ error: error.message });
  if (error instanceof BusinessMetricIngestError) return new BadRequest({ error: error.message });
  if (error instanceof BusinessMetricImporterError) return inputRefusal(error);
  return undefined;
};

const writeCall = <A>(fn: () => PromiseLike<A>) => legacyTry(fn, writeRefusal);

/** A forecast-value range or write the service refused: a 400 with its sentence. */
const forecastCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(fn, (error) =>
    error instanceof BusinessMetricForecastValueError
      ? new BadRequest({ error: error.message })
      : undefined,
  );

/**
 * A unit-cost query: an unknown metric is a 404 with the service's sentence,
 * and a query the caller can fix a 400 carrying the parse failure, when there
 * is one, beside the message.
 */
const unitCostCall = <A>(fn: () => PromiseLike<A>) =>
  legacyTry(
    async () => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof CostQueryError) {
          throw new HttpFailure(400, {
            error: error.message,
            ...(error.queryError ? { queryError: error.queryError } : {}),
          });
        }
        throw error;
      }
    },
    (error) =>
      error instanceof BusinessMetricNotFoundError
        ? new NotFound({ error: error.message })
        : undefined,
  );

/** The metric by id or key, or a 404. */
const findMetric = Effect.fnUntraced(function* (organizationId: string, idOrKey: string) {
  const metric = yield* legacy(() => getBusinessMetric(organizationId, idOrKey));
  if (!metric) return yield* notFound();
  return metric;
});

/** Importer writes run queries with an account's credentials: `costs:write` too. */
const requireImporterWrite = requirePermission("costs:write");

/** `?limit=` as the routes always read it: absent is the default, anything else an integer in range. */
const pageLimit = (raw: string | undefined, fallback: number, max: number) =>
  Effect.gen(function* () {
    const limit = raw === undefined ? fallback : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
      return yield* invalidBody(`limit must be an integer between 1 and ${max}`);
    }
    return limit;
  });

/**
 * The file answer shared by both export routes: the response the JSON route
 * would have returned, serialised by the same client-core function the card's
 * download button uses, so a file from the API and a file from the chart are
 * the same rows.
 */
const unitCostFileResponse = (
  response: UnitCostQueryResult,
  request: { from: string; to: string; format?: UnitCostExportFormat | undefined },
) => {
  const format = request.format ?? "csv";
  const file = unitCostExportFile(response, format);
  return HttpServerResponse.text(file.body, {
    contentType: file.contentType,
    headers: {
      "Content-Disposition": `attachment; filename="${unitCostExportFilename(response, request, format)}"`,
      "Cache-Control": "no-store",
    },
  });
};

const BusinessMetricsHandlers = HttpApiBuilder.group(
  BusinessMetricsApi,
  "businessMetrics",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const metrics = yield* legacy(() => listBusinessMetrics(organizationId));
          return yield* respond(BusinessMetricList)({ metrics });
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const created = yield* writeCall(() =>
            createBusinessMetric(organizationId, payload, session.userId ?? null),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.create",
              entityType: "business_metric",
              entityId: created.id,
              metadata: { key: created.key, kind: created.kind, unit: created.unit },
            }),
          );
          return yield* respond(BusinessMetric)(created);
        }),
      )
      // The org's accounts whose plugin can feed a metric, each with the plugin's importer form.
      .handle("importerSources", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const sources = yield* legacy(() => listBusinessMetricSourceAccounts(organizationId));
          return yield* respond(BusinessMetricSourceList)({ sources });
        }),
      )
      // One picker's choices.
      .handleRaw("importerOptions", ({ request }) =>
        Effect.gen(function* () {
          yield* requireImporterWrite;
          const { accountId, fieldKey, params } = yield* decodeAsPayload(
            BusinessMetricSourceOptionsRequest,
            yield* readJson(request),
          );
          const { organizationId } = yield* OrgPrincipal;
          const options = yield* writeCall(() =>
            listBusinessMetricSourceOptions(organizationId, accountId, fieldKey, params),
          );
          return yield* respond(BusinessMetricSourceOptions)({ options });
        }),
      )
      // Run a source over a window (or dry-run it) and return what it would write, writing nothing.
      .handleRaw("importerPreview", ({ request }) =>
        Effect.gen(function* () {
          yield* requireImporterWrite;
          const preview = yield* decodeAsPayload(
            BusinessMetricImportPreviewRequest,
            yield* readJson(request),
          );
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* writeCall(() =>
            previewBusinessMetricImport(organizationId, preview),
          );
          return yield* respond(BusinessMetricImportPreview)(result);
        }),
      )
      // The provider usage units the org's cost rows carry, most spend first,
      // so nobody has to know that a provider spells it `GB-Mo`.
      .handle("usageUnits", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const units = yield* legacy(() => listUsageUnits(organizationId));
          return yield* respond(UsageUnitList)({ units });
        }),
      )
      // Spend ÷ the usage quantity providers report in one unit. No business
      // metric involved; both halves come from the same cost rows.
      .handle("usageUnitCosts", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* unitCostCall(() => runUsageUnitCostQuery(organizationId, payload));
          return yield* respond(UnitCostQueryResponse)(result);
        }),
      )
      .handle("exportUsageUnitCosts", ({ payload }) =>
        Effect.gen(function* () {
          const { format, ...query } = payload;
          const { organizationId } = yield* OrgPrincipal;
          const response = yield* unitCostCall(() => runUsageUnitCostQuery(organizationId, query));
          return unitCostFileResponse(response, { from: query.from, to: query.to, format });
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          return yield* respond(BusinessMetric)(metric);
        }),
      )
      // A full replace. Changing `key` never orphans history (values are keyed
      // on the metric's id), but it does break a workflow still writing to the
      // old key, which is why the key is separate from the display name.
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const updated = yield* writeCall(() =>
            updateBusinessMetric(organizationId, params.id, payload),
          );
          if (!updated) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.update",
              entityType: "business_metric",
              entityId: updated.id,
              metadata: { key: updated.key, kind: updated.kind, unit: updated.unit },
            }),
          );
          return yield* respond(BusinessMetric)(updated);
        }),
      )
      // Soft delete. Not refused when a graph references it: a unit-cost card
      // whose metric is gone fails its query loudly and says so.
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const deleted = yield* legacy(() => softDeleteBusinessMetric(organizationId, metric.id));
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.delete",
              entityType: "business_metric",
              entityId: metric.id,
              metadata: { key: metric.key },
            }),
          );
          return ok;
        }),
      )
      // Reported values, newest day first.
      .handle("values", ({ params, query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const limit = yield* pageLimit(query.limit, 90, BUSINESS_METRIC_LIMITS.maxValuesPageSize);
          const values = yield* legacy(() => listBusinessMetricValues(metric.id, limit));
          return yield* respond(BusinessMetricValueList)({ values });
        }),
      )
      // The label keys this metric's values carry, each with its distinct values and its mapping.
      .handle("labels", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const labels = yield* legacy(() => listBusinessMetricLabels(metric));
          return yield* respond(BusinessMetricLabelList)({ labels });
        }),
      )
      // Report a batch of days. Re-reporting a day restates it rather than
      // adding to it, so a nightly job is safe to retry. The audit entry
      // records how many days were written: "who restated March" has to be
      // answerable.
      .handleRaw("writeValues", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const { values } = yield* decodeAsPayload(
            BusinessMetricValuesBody,
            yield* readJson(request),
          );
          const result = yield* writeCall(() =>
            ingestMetricValues({
              organizationId,
              metricId: metric.id,
              values,
              source: {
                errorPrefix: "business-metrics/values",
                source: "api",
                userId: session.userId ?? null,
                maxValues: BUSINESS_METRIC_LIMITS.maxValuesPerCall,
              },
            }),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.values.write",
              entityType: "business_metric",
              entityId: metric.id,
              metadata: { key: metric.key, days: result.written },
            }),
          );
          return yield* respond(BusinessMetricValuesWritten)(result);
        }),
      )
      // The metric's forecasted (planned) values in day order. Kept apart
      // from the actuals: no unit-cost or threshold reader ever sees them.
      .handle("forecastValues", ({ params, query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const values = yield* forecastCall(async () =>
            listBusinessMetricForecastValues(
              metric.id,
              parseForecastValueRange(query.from, query.to),
            ),
          );
          return yield* respond(BusinessMetricForecastValueList)({ values });
        }),
      )
      // Write planned days. Re-sending a day restates it, as with actuals.
      .handleRaw("writeForecastValues", ({ params, request }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const { values } = yield* decodeAsPayload(
            BusinessMetricForecastValuesBody,
            yield* readJsonOr(request, null),
          );
          const result = yield* forecastCall(() =>
            writeBusinessMetricForecastValues(
              organizationId,
              metric.id,
              values,
              session.userId ?? null,
            ),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.forecast_values.write",
              entityType: "business_metric",
              entityId: metric.id,
              metadata: { key: metric.key, days: result.written },
            }),
          );
          return yield* respond(BusinessMetricForecastValuesWritten)(result);
        }),
      )
      // Remove planned days in a range (both bounds optional; neither clears all).
      .handle("deleteForecastValues", ({ params, query }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const { range, result } = yield* forecastCall(async () => {
            const range = parseForecastValueRange(query.from, query.to);
            return { range, result: await deleteBusinessMetricForecastValues(metric.id, range) };
          });
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.forecast_values.delete",
              entityType: "business_metric",
              entityId: metric.id,
              metadata: { key: metric.key, days: result.deleted, ...range },
            }),
          );
          return yield* respond(BusinessMetricForecastValuesDeleted)(result);
        }),
      )
      // The importer, or `{ importer: null }`.
      .handle("importer", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const importer = yield* legacy(() =>
            getBusinessMetricImporter(organizationId, metric.id),
          );
          return yield* respond(BusinessMetricImporterResult)({ importer });
        }),
      )
      // Create or replace.
      .handleRaw("saveImporter", ({ params, request }) =>
        Effect.gen(function* () {
          yield* requireImporterWrite;
          const { organizationId, session } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const input = yield* decodeAsPayload(
            BusinessMetricImporterInput,
            yield* readJson(request),
          );
          const importer = yield* writeCall(() =>
            upsertBusinessMetricImporter(organizationId, metric.id, input, session.userId ?? null),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.importer.save",
              entityType: "business_metric",
              entityId: metric.id,
              metadata: {
                key: metric.key,
                accountId: importer.accountId,
                pluginId: importer.pluginId,
                schedule: importer.schedule,
                enabled: importer.enabled,
              },
            }),
          );
          return yield* respond(BusinessMetricImporter)(importer);
        }),
      )
      // Stop importing. Values stay.
      .handle("deleteImporter", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const deleted = yield* legacy(() =>
            deleteBusinessMetricImporter(organizationId, metric.id),
          );
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.importer.delete",
              entityType: "business_metric",
              entityId: metric.id,
              metadata: { key: metric.key },
            }),
          );
          return ok;
        }),
      )
      // Run now, over the importer's own window or the `from`/`to` given (a
      // backfill). Synchronous: the response is the finished run, failed or
      // not, because "did it work" is the whole reason someone pressed the
      // button.
      .handleRaw("runImporter", ({ params, request }) =>
        Effect.gen(function* () {
          yield* requireImporterWrite;
          const { organizationId, session } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          // An empty body is "the importer's own window".
          const body = yield* readJsonOr(request, {});
          const window = yield* decodeAsPayload(BusinessMetricImportRunRequest, body ?? {});
          const run = yield* writeCall(() =>
            runBusinessMetricImporterNow(organizationId, metric.id, session.userId ?? null, window),
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "business_metric.importer.run",
              entityType: "business_metric",
              entityId: metric.id,
              metadata: {
                key: metric.key,
                from: run.from,
                to: run.to,
                status: run.status,
                days: run.daysWritten,
              },
            }),
          );
          return yield* respond(BusinessMetricImportRun)(run);
        }),
      )
      // Newest first.
      .handle("importRuns", ({ params, query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const metric = yield* findMetric(organizationId, params.id);
          const limit = yield* pageLimit(query.limit, 20, 50);
          const runs = yield* legacy(() =>
            listBusinessMetricImportRuns(organizationId, metric.id, limit),
          );
          return yield* respond(BusinessMetricImportRunList)({ runs });
        }),
      )
      // Spend ÷ metric, or margin, bucketed the way the caller asked. A read:
      // it computes nothing that is stored. A bucket with no metric value
      // comes back with `value: null` and a `gap` reason rather than a zero.
      .handle("unitCosts", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* unitCostCall(() =>
            runUnitCostQuery(organizationId, params.id, payload),
          );
          return yield* respond(UnitCostQueryResponse)(result);
        }),
      )
      // The same query as a CSV or NDJSON file, one row per bucket per series
      // (and per label value when grouped). A gap is an empty `value` with its
      // reason in `gap`, never a zero.
      .handle("exportUnitCosts", ({ params, payload }) =>
        Effect.gen(function* () {
          const { format, ...query } = payload;
          const { organizationId } = yield* OrgPrincipal;
          const response = yield* unitCostCall(() =>
            runUnitCostQuery(organizationId, params.id, query),
          );
          return unitCostFileResponse(response, { from: query.from, to: query.to, format });
        }),
      ),
);

export const businessMetricsDomain = makeDomain(
  "business-metrics",
  BusinessMetricsApi,
  BusinessMetricsHandlers,
);
