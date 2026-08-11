import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Change timeline / drift feed — cloud-mode only. The events are recorded by
// the cloud poller as it re-syncs accounts, so local-only mode has no poller
// and therefore no feed (the CLI's `infrawrench changes` says the same thing).

interface ChangeFeedArgs {
  orgId: string;
  page: number;
  pageSize: number;
  accountId?: string;
  kind?: string;
}

ipcMain.handle(
  "cloud_changes_list",
  async (_e, { orgId, page, pageSize, accountId, kind }: ChangeFeedArgs) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (accountId) params.set("accountId", accountId);
    if (kind) params.set("kind", kind);
    return cloudFetch(orgId, `/changes?${params.toString()}`);
  },
);

// Reverting a change event. Two channels rather than one with a mode flag, so
// the read (a dry run that only reads the provider) and the write (a real
// provider mutation, freeze-gated and audit-logged server-side) stay visibly
// distinct on the IPC surface.
ipcMain.handle(
  "cloud_change_revert_preview",
  async (_e, { orgId, changeId }: { orgId: string; changeId: string }) =>
    cloudFetch(orgId, `/changes/${encodeURIComponent(changeId)}/revert`),
);

ipcMain.handle(
  "cloud_change_revert_apply",
  async (_e, { orgId, changeId }: { orgId: string; changeId: string }) =>
    cloudFetch(orgId, `/changes/${encodeURIComponent(changeId)}/revert`, { method: "POST" }),
);

/**
 * Cost per change — batched for a whole feed page.
 *
 * Cloud-only for the same reason the feed is, and additionally because the
 * comparison reads collected provider spend out of ClickHouse, which only the
 * cloud has. Nothing is stored: the answer is recomputed server-side on every
 * call so late-arriving cost keeps moving it.
 */
ipcMain.handle(
  "cloud_changes_cost_impacts",
  async (_e, { orgId, changeIds }: { orgId: string; changeIds: string[] }) =>
    cloudFetch(orgId, "/changes/cost-impacts", {
      method: "POST",
      body: JSON.stringify({ changeIds }),
    }),
);

/** Pin a change's or a deploy's cost impact onto the cost charts. */
ipcMain.handle(
  "cloud_cost_impact_annotate",
  async (
    _e,
    { orgId, subjectKind, subjectId }: { orgId: string; subjectKind: string; subjectId: string },
  ) =>
    cloudFetch(orgId, "/cost-annotations/change-impact", {
      method: "POST",
      body: JSON.stringify({ subjectKind, subjectId }),
    }),
);

// Provider status correlation ("is it me or is it them?") — also cloud-only:
// the incident cache is filled by the cloud poller watching provider status
// feeds, so the desktop reads the correlated view from the API rather than
// fetching feeds itself.
ipcMain.handle("cloud_status_incidents", async (_e, { orgId }: { orgId: string }) =>
  cloudFetch(orgId, "/status-incidents"),
);
