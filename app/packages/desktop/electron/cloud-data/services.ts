import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Services and scorecards: cloud-mode only (membership is evaluated against
// the cloud inventory and billing data, scores by the cloud poller). The
// editor's other pickers reuse existing channels: `cloud_ownership_members`,
// `cloud_slos_list`, `cloud_runbooks`, `cloud_list_accounts` and
// `cloud_savings_search_resources`. The three reads below are the ones no
// channel outside the Settings proxy covered.

const service = (id: string) => `/services/${encodeURIComponent(id)}`;
const scorecard = (id: string) => `/scorecards/${encodeURIComponent(id)}`;

ipcMain.handle("cloud_services_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/services");
});

ipcMain.handle(
  "cloud_services_get",
  async (_e, { orgId, serviceId }: { orgId: string; serviceId: string }) => {
    return cloudFetch(orgId, service(serviceId));
  },
);

ipcMain.handle(
  "cloud_services_summary",
  async (_e, { orgId, serviceId }: { orgId: string; serviceId: string }) => {
    return cloudFetch(orgId, `${service(serviceId)}/summary`);
  },
);

ipcMain.handle(
  "cloud_services_scorecards",
  async (_e, { orgId, serviceId }: { orgId: string; serviceId: string }) => {
    return cloudFetch(orgId, `${service(serviceId)}/scorecards`);
  },
);

ipcMain.handle(
  "cloud_services_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/services", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_services_update",
  async (_e, { orgId, serviceId, patch }: { orgId: string; serviceId: string; patch: unknown }) => {
    return cloudFetch(orgId, service(serviceId), {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_services_delete",
  async (_e, { orgId, serviceId }: { orgId: string; serviceId: string }) => {
    return cloudFetch(orgId, service(serviceId), { method: "DELETE" });
  },
);

ipcMain.handle(
  "cloud_services_add_members",
  async (
    _e,
    { orgId, serviceId, resourceIds }: { orgId: string; serviceId: string; resourceIds: string[] },
  ) => {
    return cloudFetch(orgId, `${service(serviceId)}/members`, {
      method: "POST",
      body: JSON.stringify({ resourceIds }),
    });
  },
);

ipcMain.handle(
  "cloud_services_remove_member",
  async (
    _e,
    { orgId, serviceId, resourceId }: { orgId: string; serviceId: string; resourceId: string },
  ) => {
    return cloudFetch(orgId, `${service(serviceId)}/members/${encodeURIComponent(resourceId)}`, {
      method: "DELETE",
    });
  },
);

ipcMain.handle(
  "cloud_services_restore_member",
  async (
    _e,
    { orgId, serviceId, resourceId }: { orgId: string; serviceId: string; resourceId: string },
  ) => {
    return cloudFetch(
      orgId,
      `${service(serviceId)}/members/${encodeURIComponent(resourceId)}?restore=1`,
      { method: "DELETE" },
    );
  },
);

ipcMain.handle(
  "cloud_services_for_resources",
  async (_e, { orgId, resourceIds }: { orgId: string; resourceIds: string[] }) => {
    const ids = resourceIds.map(encodeURIComponent).join(",");
    return cloudFetch(orgId, `/services/for-resources?ids=${ids}`);
  },
);

ipcMain.handle("cloud_services_oncall_schedules", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/on-call/schedules");
});

ipcMain.handle("cloud_services_tag_keys", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/tag-keys");
});

ipcMain.handle("cloud_services_virtual_tags", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/virtual-tags");
});

ipcMain.handle("cloud_scorecards_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/scorecards");
});

ipcMain.handle("cloud_scorecards_overview", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/scorecards/overview");
});

ipcMain.handle(
  "cloud_scorecards_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/scorecards", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_scorecards_update",
  async (
    _e,
    { orgId, scorecardId, patch }: { orgId: string; scorecardId: string; patch: unknown },
  ) => {
    return cloudFetch(orgId, scorecard(scorecardId), {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },
);

ipcMain.handle(
  "cloud_scorecards_delete",
  async (_e, { orgId, scorecardId }: { orgId: string; scorecardId: string }) => {
    return cloudFetch(orgId, scorecard(scorecardId), { method: "DELETE" });
  },
);

ipcMain.handle(
  "cloud_scorecards_evaluate",
  async (_e, { orgId, scorecardId }: { orgId: string; scorecardId: string }) => {
    return cloudFetch(orgId, `${scorecard(scorecardId)}/evaluate`, { method: "POST" });
  },
);
