import { ipcMain } from "electron";
import { cloudFetch, cloudFetchText } from "./shared";

// Cross-cloud access review — cloud mode only. The review is computed
// server-side over the org's synced rows (`GET /access-review`), the same
// endpoint the web screen uses.
//
// There is deliberately no local-mode counterpart, unlike Posture and
// Expiring. Two of the five rules need state only the cloud has — the resource
// ownership records and the shared dismissal store — and a local review that
// silently answered "unowned" for every principal would be reporting on the
// desktop app rather than on the customer's clouds.

ipcMain.handle(
  "cloud_access_review",
  async (_e, { orgId, staleDays }: { orgId: string; staleDays?: number }) => {
    const query = staleDays === undefined ? "" : `?staleDays=${staleDays}`;
    return cloudFetch(orgId, `/access-review${query}`);
  },
);

// Accepting a finding is org state, not machine state, so it is recorded
// through the API — a dismissal made on this laptop has to be the same
// dismissal the web app, the alerts and everyone else's desktop see.
ipcMain.handle(
  "cloud_access_review_dismiss",
  async (
    _e,
    {
      orgId,
      resourceId,
      ruleId,
      reason,
    }: { orgId: string; resourceId: string; ruleId: string; reason?: string },
  ) => {
    return cloudFetch(orgId, "/access-review/dismissals", {
      method: "POST",
      body: JSON.stringify({ resourceId, ruleId, reason: reason ?? null }),
    });
  },
);

ipcMain.handle(
  "cloud_access_review_restore",
  async (
    _e,
    { orgId, resourceId, ruleId }: { orgId: string; resourceId: string; ruleId: string },
  ) => {
    const query = new URLSearchParams({ resourceId, ruleId });
    return cloudFetch(orgId, `/access-review/dismissals?${query.toString()}`, { method: "DELETE" });
  },
);

// The evidence export comes back as text (CSV) or a JSON document; either way
// the renderer writes it to a file the user picks, so the handler returns the
// body rather than following the browser's Content-Disposition.
ipcMain.handle(
  "cloud_access_review_export",
  async (
    _e,
    { orgId, format, staleDays }: { orgId: string; format: "csv" | "json"; staleDays?: number },
  ) => {
    const query = new URLSearchParams({ format });
    if (staleDays !== undefined) query.set("staleDays", String(staleDays));
    // `cloudFetchText`, not `cloudFetch`: the CSV body is not JSON, and the
    // JSON body wants to reach the file byte-for-byte as the server formatted
    // it rather than round-tripping through a parse.
    return cloudFetchText(orgId, `/access-review/export?${query.toString()}`);
  },
);
