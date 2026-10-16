import { Hono } from "hono";
import { costExportJobRequestSchema } from "@infrawrench/ui/cost/config";
import { requirePermission } from "../../auth/permissions";
import { contextPrincipal } from "../../auth/cost-visibility";
import {
  CostExportJobError,
  cancelCostExportJob,
  createCostExportJob,
  getCostExportJob,
  listCostExportJobs,
  openCostExportJobFile,
} from "../../services/cost-export-jobs";
import { kickCostExportJobLoop } from "../../services/cost-export-job-loop";
import type { AuthSession } from "../auth-middleware";

declare module "hono" {
  interface ContextVariableMap {
    session: AuthSession;
  }
}

/**
 * Background cost export jobs, mounted under `/costs` (so the paths are
 * `/costs/exports/jobs…`).
 *
 * `costs:read` throughout, like the streamed `POST /costs/focus-export` they
 * are the asynchronous sibling of: the file goes to the person who asked, once,
 * and holds nothing they could not already read through the graphs (the job is
 * read inside their cost visibility). Unlike a scheduled export it is not
 * standing authorisation to ship spend anywhere. A job is visible to its
 * creator only; anyone else's id reads as not found.
 */
const app = new Hono();

/** POST /api/org/:orgId/costs/exports/jobs: queue an export; answers 202 with the job. */
app.post("/exports/jobs", async (c) => {
  requirePermission(c, "costs:read");
  const parsed = costExportJobRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid export job", issues: parsed.error.issues }, 400);
  }
  try {
    const job = await createCostExportJob(
      c.get("organizationId"),
      contextPrincipal(c),
      parsed.data,
    );
    kickCostExportJobLoop();
    return c.json(job, 202);
  } catch (e) {
    if (e instanceof CostExportJobError) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

/** GET /api/org/:orgId/costs/exports/jobs: the caller's recent jobs, newest first. */
app.get("/exports/jobs", async (c) => {
  requirePermission(c, "costs:read");
  return c.json({
    jobs: await listCostExportJobs(c.get("organizationId"), c.get("session").userId),
  });
});

/** GET /api/org/:orgId/costs/exports/jobs/:jobId: status, progress, and the download path when done. */
app.get("/exports/jobs/:jobId", async (c) => {
  requirePermission(c, "costs:read");
  const job = await getCostExportJob(
    c.get("organizationId"),
    c.get("session").userId,
    c.req.param("jobId"),
  );
  if (!job) return c.json({ error: "Export job not found" }, 404);
  return c.json(job);
});

/**
 * GET /api/org/:orgId/costs/exports/jobs/:jobId/download: the finished file,
 * streamed chunk by chunk. 409 while the job is not finished; 410 once the
 * file has expired or been deleted.
 */
app.get("/exports/jobs/:jobId/download", async (c) => {
  requirePermission(c, "costs:read");
  const organizationId = c.get("organizationId");
  const userId = c.get("session").userId;
  const jobId = c.req.param("jobId");
  const opened = await openCostExportJobFile(organizationId, userId, jobId);
  if (!opened) {
    const job = await getCostExportJob(organizationId, userId, jobId);
    if (!job) return c.json({ error: "Export job not found" }, 404);
    if (job.status === "expired" || job.status === "cancelled") {
      return c.json({ error: "This export's file has been deleted. Run the export again." }, 410);
    }
    return c.json({ error: `The export is ${job.status}, not ready to download.` }, 409);
  }
  const iterator = opened.chunks[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
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
  return new Response(body, {
    headers: {
      "Content-Type": opened.job.contentType,
      "Content-Disposition": `attachment; filename="${opened.job.fileName}"`,
      "Content-Length": String(opened.job.byteCount),
      "Cache-Control": "no-store",
    },
  });
});

/**
 * DELETE /api/org/:orgId/costs/exports/jobs/:jobId: cancel a queued or
 * running job, or delete a finished file before it expires.
 */
app.delete("/exports/jobs/:jobId", async (c) => {
  requirePermission(c, "costs:read");
  const job = await cancelCostExportJob(
    c.get("organizationId"),
    c.get("session").userId,
    c.req.param("jobId"),
  );
  if (!job) return c.json({ error: "Export job not found" }, 404);
  return c.json(job);
});

export { app as costExportJobRoutes };
