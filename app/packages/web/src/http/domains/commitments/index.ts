/**
 * Commitments: `/api/org/:orgId/commitments`, the handlers.
 *
 * - `commitments`: the feed (holdings, the coverage range, utilization and
 *   recommendations), read inside the caller's cost visibility scope.
 * - `commitmentReports`: saved commitment reports, following the cost
 *   reports' rules (report folders, per-object sharing, soft delete), each
 *   write audit-logged as `commitment_report.*`. Bodies arrive decoded by the
 *   contract's schemas; the storage and access rules are in
 *   `services/commitment-reports.ts`, the scan in server-core, the metrics in
 *   client-core.
 */
import { Effect, Layer, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { getCommitmentsFeed } from "@infrawrench/server-core/commitments/feed";
import {
  getCommitmentReportOptions,
  runCommitmentReportConfig,
} from "@infrawrench/server-core/commitments/report";
import {
  badRequest,
  CommitmentReport,
  CommitmentReportOptions,
  CommitmentReportResult,
  CommitmentReportRunResult,
  CommitmentsApi,
  CommitmentsFeed,
  notFound,
  ok,
} from "@infrawrench/api-contract";
import { logAudit } from "../../../services/audit";
import { CostReportFolderError } from "../../../services/cost-report-folders";
import {
  createCommitmentReport,
  getCommitmentReport,
  listCommitmentReports,
  runSavedCommitmentReport,
  softDeleteCommitmentReport,
  updateCommitmentReport,
} from "../../../services/commitment-reports";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { OrgPrincipal } from "../../principal";
import { respond } from "../../response";

const CommitmentsHandlers = HttpApiBuilder.group(
  CommitmentsApi,
  "commitments",
  Effect.fn(function* (handlers) {
    return handlers.handleAll({
      feed: Effect.fn("commitments.feed")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const feed = yield* legacy(() => getCommitmentsFeed(organizationId));
        return yield* respond(CommitmentsFeed)(feed);
      }),
    });
  }),
);

/**
 * The folder a write names is not one the report can be filed in (unknown, or
 * another organization's): the caller's 400. A folder the caller may only
 * view is the sharing service's own 403, rendered as such.
 */
class FolderRefused extends Schema.TaggedError<FolderRefused>()("FolderRefused", {
  message: Schema.String,
}) {}

/**
 * A storage write that may file the report into a folder. The service throws
 * `CostReportFolderError` for a folder it refuses; this is the one place that
 * thrown error becomes a typed failure, at the promise boundary.
 */
const filing = <A>(write: () => Promise<A>) =>
  legacyTry(write, (error) =>
    error instanceof CostReportFolderError
      ? new FolderRefused({ message: error.message })
      : undefined,
  );

const audit = Effect.fn("commitmentReports.audit")(function* (
  action: "create" | "update" | "delete",
  reportId: string,
  metadata: Record<string, unknown>,
) {
  const { organizationId, session } = yield* OrgPrincipal;
  yield* fireAndForget(() =>
    logAudit({
      organizationId,
      userId: session.userId,
      action: `commitment_report.${action}`,
      entityType: "commitment_report",
      entityId: reportId,
      metadata,
    }),
  );
});

const CommitmentReportsHandlers = HttpApiBuilder.group(
  CommitmentsApi,
  "commitmentReports",
  Effect.fn(function* (handlers) {
    return handlers.handleAll({
      reportOptions: Effect.fn("commitmentReports.reportOptions")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const options = yield* legacy(() => getCommitmentReportOptions(organizationId));
        return yield* respond(CommitmentReportOptions)(options);
      }),
      // An unsaved config: the editor's preview and the CLI's ad-hoc flags.
      reportQuery: Effect.fn("commitmentReports.reportQuery")(function* ({ payload }) {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() => runCommitmentReportConfig(organizationId, payload));
        return yield* respond(CommitmentReportResult)(result);
      }),
      listReports: Effect.fn("commitmentReports.listReports")(function* () {
        const { organizationId } = yield* OrgPrincipal;
        const reports = yield* legacy(() => listCommitmentReports(organizationId));
        return yield* respond(Schema.Array(CommitmentReport))(reports);
      }),
      createReport: Effect.fn("commitmentReports.createReport")(
        function* ({ payload }) {
          const { organizationId, session } = yield* OrgPrincipal;
          const created = yield* filing(() =>
            createCommitmentReport(organizationId, payload, session.userId ?? null),
          );
          yield* audit("create", created.id, { name: created.name });
          return yield* respond(CommitmentReport)(created);
        },
        Effect.catchTag("FolderRefused", (refusal) => Effect.fail(badRequest(refusal.message))),
      ),
      getReport: Effect.fn("commitmentReports.getReport")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const report = yield* legacy(() => getCommitmentReport(organizationId, params.id));
        if (!report) return yield* notFound();
        return yield* respond(CommitmentReport)(report);
      }),
      updateReport: Effect.fn("commitmentReports.updateReport")(
        function* ({ params, payload }) {
          const { organizationId } = yield* OrgPrincipal;
          const updated = yield* filing(() =>
            updateCommitmentReport(organizationId, params.id, payload),
          );
          if (!updated) return yield* notFound();
          yield* audit("update", updated.id, { name: updated.name });
          return yield* respond(CommitmentReport)(updated);
        },
        Effect.catchTag("FolderRefused", (refusal) => Effect.fail(badRequest(refusal.message))),
      ),
      deleteReport: Effect.fn("commitmentReports.deleteReport")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const deleted = yield* legacy(() => softDeleteCommitmentReport(organizationId, params.id));
        if (!deleted) return yield* notFound();
        yield* audit("delete", params.id, {});
        return ok;
      }),
      // A read despite the method.
      runReport: Effect.fn("commitmentReports.runReport")(function* ({ params }) {
        const { organizationId } = yield* OrgPrincipal;
        const result = yield* legacy(() => runSavedCommitmentReport(organizationId, params.id));
        if (!result) return yield* notFound();
        return yield* respond(CommitmentReportRunResult)(result);
      }),
    });
  }),
);

export const commitmentsDomain = makeDomain(
  "commitments",
  CommitmentsApi,
  Layer.mergeAll(CommitmentsHandlers, CommitmentReportsHandlers),
);
