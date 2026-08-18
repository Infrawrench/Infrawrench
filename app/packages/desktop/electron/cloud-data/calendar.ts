import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// The operations calendar — cloud only, deliberately. Five of its six sources
// (freezes, commitments, workflow schedules, incidents, and the org's expiry
// settings) are org state with nowhere to live in a single-machine workspace,
// and a calendar that could only ever show one of them would be the wrong half
// of the feature. The panel says so rather than rendering an empty month.

ipcMain.handle(
  "cloud_calendar",
  async (
    _e,
    { orgId, from, to, kinds }: { orgId: string; from: string; to: string; kinds?: string },
  ) => {
    const params = new URLSearchParams({ from, to });
    if (kinds) params.set("kinds", kinds);
    return cloudFetch(orgId, `/calendar?${params.toString()}`);
  },
);

ipcMain.handle("cloud_calendar_subscriptions", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/calendar/subscriptions");
});

ipcMain.handle(
  "cloud_calendar_subscription_create",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/calendar/subscriptions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_calendar_subscription_revoke",
  async (_e, { orgId, subscriptionId }: { orgId: string; subscriptionId: string }) => {
    return cloudFetch(orgId, `/calendar/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: "DELETE",
    });
  },
);
