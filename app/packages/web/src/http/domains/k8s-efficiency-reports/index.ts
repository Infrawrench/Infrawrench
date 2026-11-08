/**
 * Kubernetes efficiency reports: `/api/org/:orgId/k8s-efficiency-reports`,
 * the handlers.
 *
 * Every read runs under the caller's cost visibility scope, which the org
 * middleware establishes and `legacy` re-enters. The logic lives in
 * services/k8s-efficiency-reports.ts; this file is transport only.
 */
import { Effect, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  kubernetesEfficiencyCsv,
  kubernetesEfficiencyExportRecords,
} from "@infrawrench/client-core";
import { logAudit } from "../../../services/audit";
import { CostReportFolderError } from "../../../services/cost-report-folders";
import {
  createKubernetesEfficiencyReport,
  getKubernetesEfficiencyOptions,
  getKubernetesEfficiencyReport,
  getKubernetesEfficiencyTagValues,
  listKubernetesEfficiencyReports,
  queryKubernetesEfficiency,
  runKubernetesEfficiencyReport,
  softDeleteKubernetesEfficiencyReport,
  updateKubernetesEfficiencyReport,
} from "../../../services/k8s-efficiency-reports";
import { makeDomain } from "../../domain";
import { badRequest, BadRequest, notFound } from "../../errors";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";
import { ok } from "../../schemas/common";
import {
  KubernetesEfficiencyOptions,
  KubernetesEfficiencyReport,
  KubernetesEfficiencyReportsApi,
  KubernetesEfficiencyResult,
  KubernetesEfficiencyRunResult,
  KubernetesEfficiencyValues,
} from "./api";

/** A folder the caller cannot file into: 400 with the service's sentence. */
const folderRefusal = (error: unknown) =>
  error instanceof CostReportFolderError ? new BadRequest({ error: error.message }) : undefined;

const KubernetesEfficiencyReportsHandlers = HttpApiBuilder.group(
  KubernetesEfficiencyReportsApi,
  "k8sEfficiencyReports",
  (handlers) =>
    handlers
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const reports = yield* legacy(() => listKubernetesEfficiencyReports(organizationId));
          return yield* respond(Schema.Array(KubernetesEfficiencyReport))(reports);
        }),
      )
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const created = yield* legacyTry(
            () => createKubernetesEfficiencyReport(organizationId, payload, session.userId ?? null),
            folderRefusal,
          );
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "kubernetes_efficiency_report.create",
              entityType: "kubernetes_efficiency_report",
              entityId: created.id,
              metadata: { name: created.name },
            }),
          );
          return yield* respond(KubernetesEfficiencyReport)(created);
        }),
      )
      .handle("options", () =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const options = yield* legacy(() => getKubernetesEfficiencyOptions(organizationId));
          return yield* respond(KubernetesEfficiencyOptions)(options);
        }),
      )
      .handle("values", ({ query }) =>
        Effect.gen(function* () {
          const tagKey = query.tagKey?.trim();
          if (!tagKey) return yield* badRequest("tagKey is required");
          const { organizationId } = yield* OrgPrincipal;
          const values = yield* legacy(() =>
            getKubernetesEfficiencyTagValues(organizationId, tagKey),
          );
          return yield* respond(KubernetesEfficiencyValues)({ values });
        }),
      )
      .handle("query", ({ payload }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* legacy(() =>
            queryKubernetesEfficiency(organizationId, payload.config),
          );
          return yield* respond(KubernetesEfficiencyResult)(result);
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const report = yield* legacy(() =>
            getKubernetesEfficiencyReport(organizationId, params.id),
          );
          if (!report) return yield* notFound();
          return yield* respond(KubernetesEfficiencyReport)(report);
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const updated = yield* legacyTry(
            () => updateKubernetesEfficiencyReport(organizationId, params.id, payload),
            folderRefusal,
          );
          if (!updated) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "kubernetes_efficiency_report.update",
              entityType: "kubernetes_efficiency_report",
              entityId: updated.id,
              metadata: { name: updated.name },
            }),
          );
          return yield* respond(KubernetesEfficiencyReport)(updated);
        }),
      )
      .handle("delete", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const deleted = yield* legacy(() =>
            softDeleteKubernetesEfficiencyReport(organizationId, params.id),
          );
          if (!deleted) return yield* notFound();
          yield* fireAndForget(() =>
            logAudit({
              organizationId,
              userId: session.userId,
              action: "kubernetes_efficiency_report.delete",
              entityType: "kubernetes_efficiency_report",
              entityId: params.id,
              metadata: {},
            }),
          );
          return ok;
        }),
      )
      .handle("run", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId } = yield* OrgPrincipal;
          const result = yield* legacy(() =>
            runKubernetesEfficiencyReport(organizationId, params.id),
          );
          if (!result) return yield* notFound();
          return yield* respond(KubernetesEfficiencyRunResult)(result);
        }),
      )
      /**
       * The report as a file: one record per row and cost category plus the
       * totals, and with `perPeriod` each row's figures per bucket as well.
       * NDJSON is one record per line, for loading into a warehouse or a notebook.
       */
      .handle("export", ({ params, query }) =>
        Effect.gen(function* () {
          const format = query.format ?? "csv";
          if (format !== "csv" && format !== "ndjson") {
            return yield* badRequest("format must be csv or ndjson");
          }
          const perPeriod = query.perPeriod === "true" || query.perPeriod === "1";
          const { organizationId } = yield* OrgPrincipal;
          const run = yield* legacy(() => runKubernetesEfficiencyReport(organizationId, params.id));
          if (!run) return yield* notFound();
          const slug =
            run.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "") || "efficiency";
          const filename = `${slug}-${run.result.from}-${run.result.to}.${format === "csv" ? "csv" : "ndjson"}`;
          const body =
            format === "csv"
              ? kubernetesEfficiencyCsv(run.result, { perPeriod })
              : kubernetesEfficiencyExportRecords(run.result, { perPeriod })
                  .map((r) => JSON.stringify(r))
                  .join("\n") + "\n";
          return HttpServerResponse.text(body, {
            contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson",
            headers: { "content-disposition": `attachment; filename="${filename}"` },
          });
        }),
      ),
);

export const k8sEfficiencyReportsDomain = makeDomain(
  "k8s-efficiency-reports",
  KubernetesEfficiencyReportsApi,
  KubernetesEfficiencyReportsHandlers,
);
