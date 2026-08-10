import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Synthetic probes — cloud-mode only (checks run in the cloud poller through
// the egress proxy, and results live in the cloud metric store).

ipcMain.handle("cloud_probes_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/probes");
});

ipcMain.handle("cloud_probes_suggestions", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/probes/suggestions");
});

ipcMain.handle(
  "cloud_probes_metrics",
  async (
    _e,
    {
      orgId,
      probeId,
      startMs,
      endMs,
    }: { orgId: string; probeId: string; startMs: number; endMs: number },
  ) => {
    const params = new URLSearchParams({ startMs: String(startMs), endMs: String(endMs) });
    return cloudFetch(orgId, `/probes/${encodeURIComponent(probeId)}/metrics?${params.toString()}`);
  },
);

ipcMain.handle(
  "cloud_probes_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/probes", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_probes_update",
  async (_e, { orgId, probeId, patch }: { orgId: string; probeId: string; patch: unknown }) => {
    return cloudFetch(orgId, `/probes/${encodeURIComponent(probeId)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_probes_delete",
  async (_e, { orgId, probeId }: { orgId: string; probeId: string }) => {
    return cloudFetch(orgId, `/probes/${encodeURIComponent(probeId)}`, { method: "DELETE" });
  },
);
