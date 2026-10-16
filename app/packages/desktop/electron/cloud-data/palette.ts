import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// The command palette in cloud mode: the org's search index over saved
// objects, and the member's stars. Resources and workflows stay local (the
// palette searches the local cache for those, as the spotlight always did),
// so the search channel asks the server for object kinds only.

/** Kept in step with client-core's `SEARCH_OBJECT_KINDS` by a renderer test. */
export const PALETTE_REMOTE_KINDS = [
  "cost_report",
  "cost_report_folder",
  "dashboard",
  "budget",
  "cost_canvas",
  "saved_cost_filter",
  "virtual_tag",
  "business_metric",
  "scenario_model",
  "slo",
  "service",
  "runbook",
  "status_page",
  "probe",
  "log_query",
  "query_monitor",
] as const;

const KIND_RE = /^[a-z_]{1,40}$/;

function starPath(kind: string, id: string): string {
  // The kind is validated rather than trusted: it becomes a path segment.
  if (!KIND_RE.test(kind)) throw new Error("Invalid kind");
  return `/starred/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

ipcMain.handle(
  "cloud_palette_search",
  async (_e, { orgId, query }: { orgId: string; query: string }) => {
    const params = new URLSearchParams({ q: query.trim(), kinds: PALETTE_REMOTE_KINDS.join(",") });
    return (await cloudFetch(orgId, `/search?${params.toString()}`)) ?? [];
  },
);

ipcMain.handle("cloud_palette_starred_list", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/starred")) ?? { items: [] };
});

ipcMain.handle(
  "cloud_palette_star",
  async (_e, { orgId, kind, id }: { orgId: string; kind: string; id: string }) => {
    return cloudFetch(orgId, starPath(kind, id), { method: "PUT" });
  },
);

ipcMain.handle(
  "cloud_palette_unstar",
  async (_e, { orgId, kind, id }: { orgId: string; kind: string; id: string }) => {
    return cloudFetch(orgId, starPath(kind, id), { method: "DELETE" });
  },
);
