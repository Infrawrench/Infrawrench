import { ipcMain } from "electron";
import { cloudFetchBytes } from "./shared";

/* ------------------------------------------------------------------ *
 * Cost canvases: reports built from a description by the chat agent.
 * Cloud-mode only, like every cost surface. The canvas object, its
 * run/preview and delivery schedules ride the cloud transport (the
 * renderer's `src/lib/cost-canvases-client.ts`); the PDF is bytes, which
 * the transport does not carry yet, so it keeps its own channel.
 * ------------------------------------------------------------------ */

const enc = encodeURIComponent;

function withPdfTimezone(path: string): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz ? `${path}?tz=${enc(tz)}` : path;
}

ipcMain.handle(
  "cloud_cost_canvas_pdf",
  async (_e, { orgId, canvasId }: { orgId: string; canvasId: string }) => {
    return cloudFetchBytes(orgId, withPdfTimezone(`/cost-canvases/${enc(canvasId)}/pdf`));
  },
);
