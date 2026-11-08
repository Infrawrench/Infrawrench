import { ipcMain } from "electron";
import { cloudFetchBytes, cloudFetchText } from "./shared";

// The cost answers that are not JSON: the FOCUS CSV, a finished export job's
// file, and the report and dashboard PDFs. Every JSON cost call goes through
// the cloud transport instead (`src/lib/cloud-costs.ts`); these wait for its
// text and bytes reads (KNOWLEDGE.md, "Handlers that are not a bare
// `cloudFetch`").

// The FOCUS CSV of a report's rows. Text, not JSON, so `cloudFetchText`;
// the renderer hands the body to the browser's own download path.
ipcMain.handle(
  "cloud_costs_focus_export",
  async (_e, { orgId, request }: { orgId: string; request: unknown }) => {
    return cloudFetchText(orgId, "/costs/focus-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  },
);

// A finished background export job's file, as bytes for the renderer's
// download path. The job id is the only path input, encoded, so the renderer
// cannot steer this at another route.
ipcMain.handle(
  "cloud_cost_export_job_download",
  async (_e, { orgId, jobId }: { orgId: string; jobId: string }) => {
    return cloudFetchBytes(orgId, `/costs/exports/jobs/${encodeURIComponent(jobId)}/download`);
  },
);

/* ------------------------------------------------------------------ *
 * PDF export: a cost report or a dashboard rendered server-side. Bytes,
 * not JSON; the renderer turns them into a download.
 * ------------------------------------------------------------------ */

/**
 * `?tz=` with the local zone, so the PDF's "generated at" line reads in the
 * user's time. client-core's `withPdfTimezone`, re-derived here: this module
 * graph is CommonJS and client-core is ESM (see `local-posture.ts`).
 */
function withPdfTimezone(path: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz ? `${path}?tz=${encodeURIComponent(tz)}` : path;
}

ipcMain.handle(
  "cloud_cost_report_pdf",
  async (_e, { orgId, reportId }: { orgId: string; reportId: string }) => {
    return cloudFetchBytes(
      orgId,
      withPdfTimezone(`/cost-reports/${encodeURIComponent(reportId)}/pdf`),
    );
  },
);

ipcMain.handle(
  "cloud_dashboard_pdf",
  async (_e, { orgId, dashboardId }: { orgId: string; dashboardId: string }) => {
    return cloudFetchBytes(
      orgId,
      withPdfTimezone(`/dashboards/${encodeURIComponent(dashboardId)}/pdf`),
    );
  },
);
