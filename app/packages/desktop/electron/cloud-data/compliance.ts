import { ipcMain } from "electron";
import { cloudFetch, cloudFetchBytes } from "./shared";

// Compliance: cloud only. The evidence is org state (the audit log, access
// decisions, scanner findings, restore drills) assembled server-side by
// `GET /compliance`, the endpoint the web tab, mobile and the CLI's
// `infrawrench compliance` read. Local mode has none of it, so there is
// deliberately no local counterpart.

type Period = { from: string; to: string };

function query(framework: string, period?: Period): string {
  const q = new URLSearchParams({ framework });
  if (period?.from) q.set("from", period.from);
  if (period?.to) q.set("to", period.to);
  return q.toString();
}

/** Control ids carry dots ("CC6.1"); both segments are encoded. */
function controlPath(frameworkId: string, controlId: string): string {
  return `/compliance/controls/${encodeURIComponent(frameworkId)}/${encodeURIComponent(controlId)}`;
}

ipcMain.handle("cloud_compliance_frameworks", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/compliance/frameworks");
});

ipcMain.handle(
  "cloud_compliance_status",
  async (
    _e,
    { orgId, framework, period }: { orgId: string; framework: string; period: Period },
  ) => {
    return cloudFetch(orgId, `/compliance?${query(framework, period)}`);
  },
);

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

ipcMain.handle(
  "cloud_compliance_control_put",
  async (
    _e,
    {
      orgId,
      frameworkId,
      controlId,
      input,
    }: {
      orgId: string;
      frameworkId: string;
      controlId: string;
      input: {
        applicable: boolean;
        justification?: string | null;
        ownerUserId?: string | null;
        ownerLabel?: string | null;
        notes?: string | null;
      };
    },
  ) => {
    return cloudFetch(orgId, controlPath(frameworkId, controlId), {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_compliance_control_delete",
  async (
    _e,
    { orgId, frameworkId, controlId }: { orgId: string; frameworkId: string; controlId: string },
  ) => {
    await cloudFetch(orgId, controlPath(frameworkId, controlId), { method: "DELETE" });
  },
);

ipcMain.handle(
  "cloud_compliance_schedules",
  async (_e, { orgId, framework }: { orgId: string; framework?: string }) => {
    const q = framework ? `?framework=${encodeURIComponent(framework)}` : "";
    return cloudFetch(orgId, `/compliance/schedules${q}`);
  },
);

ipcMain.handle("cloud_compliance_schedule_targets", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/compliance/schedules/targets");
});

ipcMain.handle(
  "cloud_compliance_schedule_create",
  async (_e, { orgId, input }: { orgId: string; input: Record<string, unknown> }) => {
    return cloudFetch(orgId, "/compliance/schedules", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_compliance_schedule_update",
  async (
    _e,
    {
      orgId,
      scheduleId,
      input,
    }: { orgId: string; scheduleId: string; input: Record<string, unknown> },
  ) => {
    return cloudFetch(orgId, `/compliance/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_compliance_schedule_delete",
  async (_e, { orgId, scheduleId }: { orgId: string; scheduleId: string }) => {
    await cloudFetch(orgId, `/compliance/schedules/${encodeURIComponent(scheduleId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_compliance_schedule_send",
  async (_e, { orgId, scheduleId }: { orgId: string; scheduleId: string }) => {
    return cloudFetch(orgId, `/compliance/schedules/${encodeURIComponent(scheduleId)}/send`, {
      method: "POST",
    });
  },
);
