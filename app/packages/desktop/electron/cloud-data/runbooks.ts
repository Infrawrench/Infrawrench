import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Runbooks — cloud only, deliberately. A runbook is a shared document and a run
// is a record of who did what: both are org state, and a single-machine
// workspace has nowhere to keep either. The panel says so rather than offering
// a checklist nobody else can see.

ipcMain.handle("cloud_runbooks", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/runbooks");
});

ipcMain.handle("cloud_runbook_runs", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/runbooks/runs?limit=50");
});

ipcMain.handle(
  "cloud_runbook_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/runbooks", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_runbook_update",
  async (_e, { orgId, runbookId, patch }: { orgId: string; runbookId: string; patch: unknown }) => {
    return cloudFetch(orgId, `/runbooks/${encodeURIComponent(runbookId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_runbook_delete",
  async (_e, { orgId, runbookId }: { orgId: string; runbookId: string }) => {
    return cloudFetch(orgId, `/runbooks/${encodeURIComponent(runbookId)}`, { method: "DELETE" });
  },
);

ipcMain.handle(
  "cloud_runbook_run_start",
  async (_e, { orgId, runbookId }: { orgId: string; runbookId: string }) => {
    return cloudFetch(orgId, `/runbooks/${encodeURIComponent(runbookId)}/runs`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
);

ipcMain.handle(
  "cloud_runbook_step_update",
  async (
    _e,
    {
      orgId,
      runId,
      stepId,
      patch,
    }: { orgId: string; runId: string; stepId: string; patch: unknown },
  ) => {
    return cloudFetch(
      orgId,
      `/runbooks/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  },
);

ipcMain.handle(
  "cloud_runbook_run_close",
  async (_e, { orgId, runId, body }: { orgId: string; runId: string; body: unknown }) => {
    return cloudFetch(orgId, `/runbooks/runs/${encodeURIComponent(runId)}/close`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);
