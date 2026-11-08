/**
 * Background cost export jobs, the handlers. The jobs, their files and the
 * writer live in `services/cost-export-jobs.ts`; the loop that claims them in
 * `services/cost-export-job-loop.ts`.
 */
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import {
  BadRequest,
  Conflict,
  CostExportJob,
  CostExportJobs,
  CostExportJobsApi,
  Gone,
  NotFound,
  notFound,
} from "@infrawrench/api-contract";
import {
  CostExportJobError,
  cancelCostExportJob,
  createCostExportJob,
  getCostExportJob,
  listCostExportJobs,
  openCostExportJobFile,
} from "../../../services/cost-export-jobs";
import { kickCostExportJobLoop } from "../../../services/cost-export-job-loop";
import { makeDomain } from "../../domain";
import { fireAndForget, legacy, legacyTry } from "../../legacy";
import { costVisibilityPrincipal, OrgPrincipal } from "../../principal";
import { respond } from "../../response";

/** The service's refusals, with the status each carries. */
const jobRefusal = (error: unknown): BadRequest | NotFound | Conflict | undefined => {
  if (!(error instanceof CostExportJobError)) return undefined;
  switch (error.status) {
    case 404:
      return new NotFound({ error: error.message });
    case 409:
      return new Conflict({ error: error.message });
    default:
      return new BadRequest({ error: error.message });
  }
};

const jobNotFound = () => notFound("Export job not found");

/** The file's chunks as a web stream, pulled one at a time as the client reads. */
function chunkStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

const CostExportJobsHandlers = HttpApiBuilder.group(
  CostExportJobsApi,
  "costExportJobs",
  (handlers) =>
    handlers
      // Queue an export; answers 202 with the job.
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const principal = yield* OrgPrincipal;
          const job = yield* legacyTry(
            () =>
              createCostExportJob(
                principal.organizationId,
                costVisibilityPrincipal(principal),
                payload,
              ),
            jobRefusal,
          );
          yield* fireAndForget(async () => kickCostExportJobLoop());
          return yield* respond(CostExportJob, { status: 202 })(job);
        }),
      )
      // The caller's recent jobs, newest first.
      .handle("list", () =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const jobs = yield* legacy(() => listCostExportJobs(organizationId, session.userId));
          return yield* respond(CostExportJobs)({ jobs });
        }),
      )
      // Status, progress, and the download path when done.
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const job = yield* legacy(() =>
            getCostExportJob(organizationId, session.userId, params.jobId),
          );
          if (!job) return yield* jobNotFound();
          return yield* respond(CostExportJob)(job);
        }),
      )
      // The finished file, streamed chunk by chunk. 409 while the job is not
      // finished; 410 once the file has expired or been deleted.
      .handle("download", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const opened = yield* legacy(() =>
            openCostExportJobFile(organizationId, session.userId, params.jobId),
          );
          if (!opened) {
            const job = yield* legacy(() =>
              getCostExportJob(organizationId, session.userId, params.jobId),
            );
            if (!job) return yield* jobNotFound();
            if (job.status === "expired" || job.status === "cancelled") {
              return yield* new Gone({
                error: "This export's file has been deleted. Run the export again.",
              });
            }
            return yield* new Conflict({
              error: `The export is ${job.status}, not ready to download.`,
            });
          }
          // The web response the route always built, passed through untouched.
          return HttpServerResponse.raw(
            new Response(chunkStream(opened.chunks), {
              headers: {
                "Content-Type": opened.job.contentType,
                "Content-Disposition": `attachment; filename="${opened.job.fileName}"`,
                "Content-Length": String(opened.job.byteCount),
                "Cache-Control": "no-store",
              },
            }),
          );
        }),
      )
      // Cancel a queued or running job, or delete a finished file early.
      .handle("cancel", ({ params }) =>
        Effect.gen(function* () {
          const { organizationId, session } = yield* OrgPrincipal;
          const job = yield* legacy(() =>
            cancelCostExportJob(organizationId, session.userId, params.jobId),
          );
          if (!job) return yield* jobNotFound();
          return yield* respond(CostExportJob)(job);
        }),
      ),
);

export const costExportJobsDomain = makeDomain(
  "cost-export-jobs",
  CostExportJobsApi,
  CostExportJobsHandlers,
);
