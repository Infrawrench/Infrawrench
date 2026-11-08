import { ipcMain } from "electron";
import { cloudFetchText } from "./shared";

// Cross-cloud access review: cloud mode only. The review, its dismissals and
// restores ride the cloud transport (`cloudClient("accessReview")` in
// `src/lib/cloud-resources.ts`); only the evidence export is still a channel,
// because its answer is text the transport's client cannot read yet.

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
