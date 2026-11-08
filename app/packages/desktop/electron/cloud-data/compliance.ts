import { ipcMain } from "electron";
import { cloudFetchBytes } from "./shared";

// Compliance: cloud only. The evidence is org state (the audit log, access
// decisions, scanner findings, restore drills) assembled server-side by
// `GET /compliance`, the endpoint the web tab, mobile and the CLI's
// `infrawrench compliance` read. Local mode has none of it, so there is
// deliberately no local counterpart. Every JSON route is a typed call over the
// cloud transport (`src/lib/cloud-resources.ts`); the evidence pack stays here
// until the transport carries bytes.

type Period = { from: string; to: string };

function query(framework: string, period?: Period): string {
  const q = new URLSearchParams({ framework });
  if (period?.from) q.set("from", period.from);
  if (period?.to) q.set("to", period.to);
  return q.toString();
}

// The evidence pack is a ZIP; the bytes cross IPC by structured clone and the
// renderer saves them through the shared download path (the PDF export rule).
ipcMain.handle(
  "cloud_compliance_pack",
  async (
    _e,
    { orgId, framework, period }: { orgId: string; framework: string; period: Period },
  ) => {
    return cloudFetchBytes(orgId, `/compliance/pack?${query(framework, period)}`);
  },
);
