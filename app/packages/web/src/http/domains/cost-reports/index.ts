/**
 * Cost reports: `/api/org/:orgId/cost-reports`, the handlers.
 *
 * The logic lives in services/cost-reports.ts, services/cost-reports-bulk.ts
 * and services/cost-forecasts.ts so the MCP/chat tools drive exactly the same
 * code path; these handlers are transport only, calling them through `legacy`
 * inside the request's scopes. Object sharing refusals the services throw
 * render as they always did (see `renderDefect`).
 */
import { Effect, Layer, Schema } from "effect";
import type { HttpServerRequest } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { CostForecastRunRequest, CostReportRunOverrides } from "@infrawrench/ui/schemas";
import { logAudit } from "../../../services/audit";
import {
  CostForecastError,
  CostForecastNameConflictError,
  createCostForecast,
  deleteCostForecast,
  listCostForecasts,
  runCostReportForecast,
  updateCostForecast,
} from "../../../services/cost-forecasts";
import { CostQueryError } from "../../../services/cost-query";
import { CostReportFolderError } from "../../../services/cost-report-folders";
import {
  createCostReport,
  getCostReport,
  listCostReports,
  runCostReport,
  softDeleteCostReport,
  updateCostReport,
} from "../../../services/cost-reports";
import { applyCostReportBulk, CostReportBulkError } from "../../../services/cost-reports-bulk";
import { makeDomain } from "../../domain";
import { BadRequest, Conflict, HttpFailure, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { invalidBody } from "../../object-body";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  CostForecast,
  CostForecastList,
  CostForecastResult,
  CostReport,
  CostReportBulkResult,
  CostReportRunResult,
  CostReportsApi,
} from "./api";

/** A folderId outside the org (or stale) is a bad request, not a server bug. */
const folderRefusal = (error: unknown) =>
  error instanceof CostReportFolderError ? new BadRequest({ error: error.message }) : undefined;

type OptionalBody = { readonly ok: true; readonly body: unknown } | { readonly ok: false };

/** An optional JSON body: empty or absent is `{}`, the ordinary case; anything else must parse. */
const readOptionalJson = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<OptionalBody> =>
  request.text.pipe(
    Effect.orDie,
    Effect.flatMap((text) =>
      text.trim()
        ? Effect.try({
            try: (): OptionalBody => ({ ok: true, body: JSON.parse(text) }),
            catch: () => "invalid",
          }).pipe(Effect.orElseSucceed((): OptionalBody => ({ ok: false })))
        : Effect.succeed<OptionalBody>({ ok: true, body: {} }),
    ),
  );

/**
 * Decode a body the handler read itself, refusing it as a declared payload
 * is refused: the endpoint's `InvalidRequestMessage` and every issue.
 */
const decodeBody = <S extends Schema.Decoder<unknown>>(schema: S, body: unknown) =>
  HttpApiError.HttpApiSchemaError.wrap(
    "Payload",
    Schema.decodeUnknownEffect(schema)(body, { errors: "all" }),
  ).pipe(Effect.orDie);

const CostReportsHandlers = HttpApiBuilder.group(CostReportsApi, "costReports", (handlers) =>
  handlers
    .handle("list", () =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const reports = yield* legacy(() => listCostReports(organizationId));
        return yield* respond(Schema.Array(CostReport))(reports);
      }),
    )
    .handle("create", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* legacyTry(
          () => createCostReport(organizationId, payload, session.userId ?? null),
          folderRefusal,
        );
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_report.create",
            entityType: "cost_report",
            entityId: created.id,
            metadata: { name: created.name },
          }),
        );
        return yield* respond(CostReport)(created);
      }),
    )
    /**
     * Every item is checked (exists, the caller's sharing allows it, the
     * folder tree that would result stays within the nesting limit) before
     * anything is written; any problem is a 400 whose `problems` names each
     * blocking item, and nothing changes. The service writes one audit row
     * per item, with `bulk: true` in the metadata.
     */
    .handle("bulk", ({ payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* legacy(async () => {
          try {
            return await applyCostReportBulk(organizationId, payload, session.userId ?? null);
          } catch (error) {
            // Sent as the service built it: the problems are its own records.
            if (error instanceof CostReportBulkError) {
              throw new HttpFailure(400, { error: error.message, problems: error.problems });
            }
            throw error;
          }
        });
        return yield* respond(CostReportBulkResult)(result);
      }),
    )
    .handle("get", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const report = yield* legacy(() => getCostReport(organizationId, params.id));
        if (!report) return yield* notFound();
        return yield* respond(CostReport)(report);
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* legacyTry(
          () => updateCostReport(organizationId, params.id, payload),
          folderRefusal,
        );
        if (!updated) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_report.update",
            entityType: "cost_report",
            entityId: updated.id,
            metadata: { name: updated.name },
          }),
        );
        return yield* respond(CostReport)(updated);
      }),
    )
    /**
     * Soft delete. Every dashboard card pointing at the report goes with it;
     * see `softDeleteCostReport` for why a card cannot be left behind.
     */
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => softDeleteCostReport(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_report.delete",
            entityType: "cost_report",
            entityId: params.id,
            metadata: {},
          }),
        );
        return ok;
      }),
    )
    /**
     * Execute the report and return the series, with the window its relative
     * preset resolved to. The body may carry one-off display overrides
     * (measure, unit, bin, cumulative) for this run.
     */
    .handleRaw("run", ({ params, request }) =>
      Effect.gen(function* () {
        const read = yield* readOptionalJson(request);
        if (!read.ok) return yield* invalidBody("Invalid JSON body");
        const overrides = yield* decodeBody(CostReportRunOverrides, read.body);
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacyTry(
          () => runCostReport(organizationId, params.id, new Date(), overrides),
          (error) =>
            error instanceof CostQueryError ? new BadRequest({ error: error.message }) : undefined,
        );
        if (!result) return yield* notFound();
        return yield* respond(CostReportRunResult)(result);
      }),
    ),
);

/** A forecast the service refuses (400) or whose name the report already uses (409). */
const forecastRefusal = (error: unknown) => {
  if (error instanceof CostForecastError) return new BadRequest({ error: error.message });
  if (error instanceof CostForecastNameConflictError) return new Conflict({ error: error.message });
  return undefined;
};

const CostForecastsHandlers = HttpApiBuilder.group(CostReportsApi, "costForecasts", (handlers) =>
  handlers
    .handle("list", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const forecasts = yield* legacy(() => listCostForecasts(organizationId, params.id));
        if (!forecasts) return yield* notFound();
        return yield* respond(CostForecastList)({ forecasts });
      }),
    )
    .handle("create", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const created = yield* legacyTry(
          () => createCostForecast(organizationId, params.id, payload, session.userId ?? null),
          forecastRefusal,
        );
        if (!created) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_forecast.create",
            entityType: "cost_forecast",
            entityId: created.id,
            metadata: {
              reportId: created.reportId,
              name: created.name,
              scenarioModelIds: created.scenarioModelIds,
              driverMetricId: created.driverMetricId,
              isDefault: created.isDefault,
            },
          }),
        );
        return yield* respond(CostForecast)(created);
      }),
    )
    .handle("update", ({ params, payload }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const updated = yield* legacyTry(
          () => updateCostForecast(organizationId, params.id, params.forecastId, payload),
          forecastRefusal,
        );
        if (!updated) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_forecast.update",
            entityType: "cost_forecast",
            entityId: updated.id,
            metadata: {
              reportId: updated.reportId,
              name: updated.name,
              scenarioModelIds: updated.scenarioModelIds,
              driverMetricId: updated.driverMetricId,
              isDefault: updated.isDefault,
            },
          }),
        );
        return yield* respond(CostForecast)(updated);
      }),
    )
    .handle("delete", ({ params }) =>
      Effect.gen(function* () {
        const { organizationId, session } = yield* OrgPrincipal;
        const result = yield* legacy(() =>
          deleteCostForecast(organizationId, params.id, params.forecastId),
        );
        if (!result.deleted) return yield* notFound();
        yield* fireAndForget(() =>
          logAudit({
            organizationId,
            userId: session.userId,
            action: "cost_forecast.delete",
            entityType: "cost_forecast",
            entityId: params.forecastId,
            metadata: { reportId: params.id, name: result.name },
          }),
        );
        return ok;
      }),
    )
    // Projected spend for the report's scope, with bounds.
    .handleRaw("forecastedCosts", ({ params, request }) =>
      Effect.gen(function* () {
        const read = yield* readOptionalJson(request);
        if (!read.ok) return yield* invalidBody("Invalid JSON body");
        const run = yield* decodeBody(CostForecastRunRequest, read.body);
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacyTry(
          () => runCostReportForecast(organizationId, params.id, run),
          (error) =>
            error instanceof CostForecastError
              ? new BadRequest({ error: error.message })
              : undefined,
        );
        if (!result) return yield* notFound();
        return yield* respond(CostForecastResult)(result);
      }),
    ),
);

export const costReportsDomain = makeDomain(
  "cost-reports",
  CostReportsApi,
  Layer.mergeAll(CostReportsHandlers, CostForecastsHandlers),
);
