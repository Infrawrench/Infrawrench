/**
 * Resource reports: `/api/org/:orgId/resource-reports`, the handlers.
 *
 * Cost and virtual tag cells follow the caller's `costs:read`: without it a
 * run answers with those cells empty rather than a 403. The logic lives in
 * services/resource-reports.ts; this file is transport.
 */
import { Effect, Predicate, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import {
  RESOURCE_REPORT_LIMITS,
  parseResourceReportColumn,
  resourceReportCsvFilename,
  type ResourceReportConfig as ResourceReportConfigValue,
  type ResourceReportSort,
} from "@infrawrench/client-core";
import { ResourceReportConfig, STRICT_PARSE_OPTIONS } from "@infrawrench/ui/schemas";
import { logAudit } from "../../../services/audit";
import { CostReportFolderError } from "../../../services/cost-report-folders";
import {
  ResourceReportError,
  VirtualTagUnresolvedError,
  createResourceReport,
  getResourceReport,
  getResourceReportOptions,
  getResourceReportTagValues,
  listResourceReportFolders,
  listResourceReports,
  resourceReportCsv,
  runResourceReport,
  softDeleteResourceReport,
  updateResourceReport,
} from "../../../services/resource-reports";
import { makeDomain } from "../../domain";
import { BadRequest, badRequest, notFound } from "../../errors";
import { readJsonOr } from "../../request-body";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { holdsPermission, OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import { CostReportFolder } from "../../schemas/cost-report-folder";
import {
  ResourceReport,
  ResourceReportOptions,
  ResourceReportRows,
  ResourceReportsApi,
  ResourceReportTagValues,
} from "./api";

const canReadCosts = holdsPermission("costs:read");

/** A run error the caller can fix, as a 400; anything else stays a defect. */
const runRefusal = (error: unknown) =>
  error instanceof ResourceReportError || error instanceof VirtualTagUnresolvedError
    ? new BadRequest({ error: error.message })
    : undefined;

/** A folder the caller cannot file into: 400 with the service's sentence. */
const folderRefusal = (error: unknown) =>
  error instanceof CostReportFolderError ? new BadRequest({ error: error.message }) : undefined;

const csvResponse = (name: string, body: string) =>
  HttpServerResponse.text(body, {
    contentType: "text/csv; charset=utf-8",
    headers: {
      "content-disposition": `attachment; filename="${resourceReportCsvFilename(name)}"`,
    },
  });

function intParam(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The `sort`/`direction` query overrides; null when absent, an error string when bad. */
function sortOverride(
  column: string | undefined,
  direction: string | undefined,
): ResourceReportSort | null | string {
  if (!column) return null;
  if (!parseResourceReportColumn(column)) return `"${column}" is not a column to sort by.`;
  return { column, direction: direction === "desc" ? "desc" : "asc" };
}

/**
 * The CSV body's config, decoded strictly like the zod twin: a refusal is the
 * endpoint's payload 400, `{ error: "Invalid resource report config", issues }`,
 * with the issues relative to the config as they always were.
 */
const decodeCsvConfig = (value: unknown) =>
  Schema.decodeUnknownEffect(ResourceReportConfig)(value, {
    ...STRICT_PARSE_OPTIONS,
    errors: "all",
  }).pipe(
    Effect.mapError((cause) => new HttpApiError.HttpApiSchemaError({ kind: "Payload", cause })),
    // The renderer answers a schema error raised as a defect as it does a typed one.
    Effect.orDie,
  );

const ResourceReportsHandlers = HttpApiBuilder.group(
  ResourceReportsApi,
  "resourceReports",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const reports = yield* legacy(() => listResourceReports(organizationId));
          return yield* respond(Schema.Array(ResourceReport))(reports);
        }),
      )
      .handle("folders", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const folders = yield* legacy(() => listResourceReportFolders(organizationId));
          return yield* respond(Schema.Array(CostReportFolder))(folders);
        }),
      )
      /** `types` narrows the metadata fields to what those resource types expose. */
      .handle("options", ({ query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const types = (query.types ?? "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, RESOURCE_REPORT_LIMITS.maxFilterValues)
            .flatMap((t) => {
              const idx = t.indexOf("/");
              return idx > 0
                ? [{ pluginId: t.slice(0, idx), resourceTypeId: t.slice(idx + 1) }]
                : [];
            });
          const includeCosts = yield* canReadCosts;
          const options = yield* legacy(() =>
            getResourceReportOptions(organizationId, { types, includeCosts }),
          );
          return yield* respond(ResourceReportOptions)(options);
        }),
      )
      .handle("tagValues", ({ query }) =>
        Effect.gen(function* () {
          const source = query.source === "virtual_tag" ? "virtual_tag" : "tag";
          const key = (query.key ?? "").trim();
          if (!key || key.length > RESOURCE_REPORT_LIMITS.maxKeyLength) {
            return yield* badRequest("key is required");
          }
          const { organizationId } = yield* OrgPrincipal;
          const includeCosts = yield* canReadCosts;
          const values = yield* legacyTry(
            () => getResourceReportTagValues(organizationId, source, key, includeCosts),
            runRefusal,
          );
          return yield* respond(ResourceReportTagValues)({ values });
        }),
      )
      /** An unsaved config, for the editor's live preview. */
      .handle("query", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const includeCosts = yield* canReadCosts;
          const rows = yield* legacyTry(
            () =>
              runResourceReport(organizationId, payload.config, {
                offset: payload.offset,
                limit: payload.limit,
                includeCosts,
              }),
            runRefusal,
          );
          return yield* respond(ResourceReportRows)(rows);
        }),
      )
      /** An unsaved config's rows as CSV. Only the config is validated; `name` is best effort. */
      .handleRaw("csv", ({ request }) =>
        Effect.gen(function* () {
          const body = yield* readJsonOr(request, null);
          const fields = Predicate.isObject(body) ? body : {};
          const config = yield* decodeCsvConfig(fields["config"]);
          const rawName = fields["name"];
          const name = Predicate.isString(rawName) && rawName.trim() ? rawName : "resource-report";
          const { organizationId } = yield* OrgPrincipal;
          const includeCosts = yield* canReadCosts;
          const csv = yield* legacyTry(
            () => resourceReportCsv(organizationId, config, { includeCosts }),
            runRefusal,
          );
          return csvResponse(name, csv);
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const created = yield* legacyTry(
            () => createResourceReport(organizationId, payload, session.userId ?? null),
            folderRefusal,
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "resource_report.create",
              entityType: "resource_report",
              entityId: created.id,
              metadata: { name: created.name },
            }),
          );
          return yield* respond(ResourceReport, { status: 201 })(created);
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const report = yield* legacy(() => getResourceReport(organizationId, params.id));
          if (!report) return yield* notFound();
          return yield* respond(ResourceReport)(report);
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const updated = yield* legacyTry(
            () => updateResourceReport(organizationId, params.id, payload),
            folderRefusal,
          );
          if (!updated) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "resource_report.update",
              entityType: "resource_report",
              entityId: updated.id,
              metadata: { name: updated.name },
            }),
          );
          return yield* respond(ResourceReport)(updated);
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const deleted = yield* legacy(() => softDeleteResourceReport(organizationId, params.id));
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "resource_report.delete",
              entityType: "resource_report",
              entityId: params.id,
              metadata: {},
            }),
          );
          return ok;
        }),
      )
      /** A saved report; `sort`/`direction` override the saved sort for this request only. */
      .handle("rows", ({ params, query }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const report = yield* legacy(() => getResourceReport(organizationId, params.id));
          if (!report) return yield* notFound();
          const sort = sortOverride(query.sort, query.direction);
          if (Predicate.isString(sort)) return yield* badRequest(sort);
          const config: ResourceReportConfigValue = report.config;
          const includeCosts = yield* canReadCosts;
          const rows = yield* legacyTry(
            () =>
              runResourceReport(organizationId, config, {
                offset: intParam(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
                limit: intParam(
                  query.limit,
                  config.pageSize,
                  1,
                  RESOURCE_REPORT_LIMITS.maxPageSize,
                ),
                sort: sort ?? undefined,
                includeCosts,
              }),
            runRefusal,
          );
          return yield* respond(ResourceReportRows)(rows);
        }),
      )
      .handle("csvSaved", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const report = yield* legacy(() => getResourceReport(organizationId, params.id));
          if (!report) return yield* notFound();
          const includeCosts = yield* canReadCosts;
          const csv = yield* legacyTry(
            () => resourceReportCsv(organizationId, report.config, { includeCosts }),
            runRefusal,
          );
          return csvResponse(report.name, csv);
        }),
      ),
);

export const resourceReportsDomain = makeDomain(
  "resource-reports",
  ResourceReportsApi,
  ResourceReportsHandlers,
);
