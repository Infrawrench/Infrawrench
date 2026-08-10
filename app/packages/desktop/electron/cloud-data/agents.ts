import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

/**
 * Agents mode against a cloud org.
 *
 * The desktop app has its own local agent pipeline (SQLite `agent_settings` /
 * `agent_sessions`, bootstrap over the workflow SSH IPC — see
 * `src/lib/agent-client.ts`). These handlers are the *other* mode: when an org
 * is selected, the panel drives the org's sessions through the same
 * `/api/org/:orgId/agents` routes web uses, so the accounts on offer are the
 * org's accounts and the cloud server owns provisioning and VM bootstrap.
 *
 * Deliberately a thin proxy — every rule that matters (permissions, the
 * managed `infrawrench-agent` org SSH key, setup resumption, VM deletion)
 * lives on the server, and duplicating any of it here would let the two
 * surfaces drift.
 */

interface OrgArgs {
  orgId: string;
}

interface SessionArgs extends OrgArgs {
  sessionId: string;
}

ipcMain.handle("cloud_agents_accounts", async (_e, { orgId }: OrgArgs) =>
  cloudFetch(orgId, "/agents/accounts"),
);

ipcMain.handle("cloud_agents_get_settings", async (_e, { orgId }: OrgArgs) =>
  cloudFetch(orgId, "/agents/settings"),
);

ipcMain.handle(
  "cloud_agents_save_settings",
  async (_e, { orgId, settings }: OrgArgs & { settings: unknown }) =>
    cloudFetch(orgId, "/agents/settings", { method: "PUT", body: JSON.stringify(settings) }),
);

ipcMain.handle("cloud_agents_list_sessions", async (_e, { orgId }: OrgArgs) =>
  cloudFetch(orgId, "/agents/sessions"),
);

ipcMain.handle(
  "cloud_agents_create_session",
  async (_e, { orgId, body }: OrgArgs & { body: unknown }) =>
    cloudFetch(orgId, "/agents/sessions", { method: "POST", body: JSON.stringify(body) }),
);

ipcMain.handle("cloud_agents_open_session", async (_e, { orgId, sessionId }: SessionArgs) =>
  cloudFetch(orgId, `/agents/sessions/${encodeURIComponent(sessionId)}/open`, { method: "POST" }),
);

ipcMain.handle("cloud_agents_reconcile_session", async (_e, { orgId, sessionId }: SessionArgs) =>
  cloudFetch(orgId, `/agents/sessions/${encodeURIComponent(sessionId)}/reconcile`, {
    method: "POST",
  }),
);

ipcMain.handle("cloud_agents_delete_session", async (_e, { orgId, sessionId }: SessionArgs) => {
  await cloudFetch(orgId, `/agents/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
});
