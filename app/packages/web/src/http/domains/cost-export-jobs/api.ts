/**
 * Background cost export jobs, the endpoint definitions, under
 * `/api/org/:orgId/costs/exports/jobs`.
 *
 * `costs:read` throughout, like the streamed `POST /costs/focus-export` they
 * are the asynchronous sibling of: the file goes to the person who asked,
 * once, and holds nothing they could not already read through the graphs (the
 * job is read inside their cost visibility). A job is visible to its creator
 * only; anyone else's id reads as not found.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import { COST_EXPORT_JOB_FORMATS, FOCUS_VERSIONS } from "@infrawrench/client-core";
import { CostExportJobRequest } from "@infrawrench/ui/schemas";
import { InvalidRequestMessage, RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, Gone, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { IsoDateTime, OrgId, OrgParams } from "../../schemas/common";

const CostExportJobFormat = Schema.Literals(COST_EXPORT_JOB_FORMATS).annotate({
  description:
    "`csv` / `ndjson`: Infrawrench's own columns (`day`, the group-by dimension or tag " +
    "columns, `currency`, `amount`, `usage_amount`, `usage_unit`, `exported_at`, " +
    "`collection_watermark`), plus per-day unit-cost columns (`unit_cost_metric`, " +
    "`unit_cost_mode`, `unit_cost_scope_cost`, `unit_cost_metric_value`, `unit_cost_value`, " +
    "`unit_cost_gap`) when the exported report draws a unit cost. `focus`: the FOCUS layout " +
    "at full row grain, as CSV.",
});

const CostExportJobStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]).annotate({
  description:
    "`queued` until a gateway process claims it, `running` while the file is written, then " +
    "`succeeded` (download it), `failed` (see `error`), `cancelled`, or `expired` once the " +
    "file has been deleted, 24 hours after it finished.",
});

export const CostExportJob = Schema.Struct({
  id: Schema.String,
  status: CostExportJobStatus,
  format: CostExportJobFormat,
  focusVersion: Schema.NullOr(Schema.Literals(FOCUS_VERSIONS)),
  from: Schema.String,
  to: Schema.String,
  source: Schema.Struct({
    kind: Schema.Literals(["report", "query"]),
    reportId: Schema.NullOr(Schema.String),
    reportName: Schema.NullOr(Schema.String),
    unitCostMetric: Schema.NullOr(Schema.String).annotate({
      description: "The metric (or usage unit) whose per-day unit-cost columns the file carries.",
    }),
  }),
  progress: Schema.Finite.annotate({
    description: "0 to 1: the share of the range written so far.",
  }),
  rowCount: Schema.Int,
  byteCount: Schema.Finite.annotate({ description: "Uncompressed bytes written so far." }),
  error: Schema.NullOr(Schema.String),
  fileName: Schema.String,
  contentType: Schema.String,
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  expiresAt: Schema.NullOr(IsoDateTime).annotate({
    description: "When the file is deleted: 24 hours after it finished.",
  }),
  downloadUrl: Schema.NullOr(Schema.String).annotate({
    description:
      "Path of `GET /costs/exports/jobs/{jobId}/download` once `succeeded`, else null. " +
      "Authenticated like every other route.",
  }),
}).annotate({ identifier: "CostExportJob" });

export const CostExportJobs = Schema.Struct({ jobs: Schema.Array(CostExportJob) });

const JobParams = { orgId: OrgId, jobId: Schema.String } as const;

export class CostExportJobsGroup extends HttpApiGroup.make("costExportJobs")
  .add(
    HttpApiEndpoint.post("create", "/exports/jobs", {
      params: OrgParams,
      payload: CostExportJobRequest,
      success: CostExportJob.pipe(HttpApiSchema.status(202)),
      error: [BadRequest, NotFound, Conflict],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Start a background cost export")
      .annotate(
        OpenApi.Description,
        "Queues an export of a saved report (`reportId`) or an ad-hoc scope (`query`) as CSV, " +
          "NDJSON or FOCUS CSV, and answers at once with the job. The file is written on the " +
          "gateway in the background; poll `GET /costs/exports/jobs/{jobId}` for `progress` and " +
          "download from `downloadUrl` once `status` is `succeeded`. Up to 731 days per job and " +
          "256 MB per file; three queued or running jobs per person. Rows are read inside the " +
          "caller's cost visibility, and what is exported is fixed when the job is created, so " +
          "editing the report afterwards does not change the file.",
      )
      .annotate(SuccessDescription, "Queued")
      .annotate(InvalidRequestMessage, "Invalid export job"),
    HttpApiEndpoint.get("list", "/exports/jobs", {
      params: OrgParams,
      success: CostExportJobs,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "List your recent export jobs")
      .annotate(
        OpenApi.Description,
        "The caller's 20 most recent export jobs, newest first. Jobs are private to their creator.",
      )
      .annotate(SuccessDescription, "Jobs"),
    HttpApiEndpoint.get("get", "/exports/jobs/:jobId", {
      params: JobParams,
      success: CostExportJob,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Get an export job's status")
      .annotate(
        OpenApi.Description,
        "Status, progress, row count, error and, once finished, the download path and expiry.",
      )
      .annotate(SuccessDescription, "The job"),
    HttpApiEndpoint.get("download", "/exports/jobs/:jobId/download", {
      params: JobParams,
      success: [
        Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" })),
        Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/x-ndjson" })),
      ],
      error: [NotFound, Conflict, Gone],
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Download an export job's file")
      .annotate(
        OpenApi.Description,
        "The finished file, streamed. 409 while the job is still queued or running (or failed); " +
          "410 once the file has expired or been deleted.",
      )
      .annotate(SuccessDescription, "The file"),
    HttpApiEndpoint.delete("cancel", "/exports/jobs/:jobId", {
      params: JobParams,
      success: CostExportJob,
      error: NotFound,
    })
      .annotate(RequiredPermission, "costs:read")
      .annotate(OpenApi.Summary, "Cancel an export job or delete its file")
      .annotate(
        OpenApi.Description,
        "Cancels a queued or running job (the writer stops at its next chunk), or deletes a " +
          "finished file before it expires. Answers with the job's new state.",
      )
      .annotate(SuccessDescription, "The job"),
  )
  .prefix("/api/org/:orgId/costs")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Costs") {}

export class CostExportJobsApi extends withApiDefaults(
  HttpApi.make("cost-export-jobs").add(CostExportJobsGroup),
) {}
