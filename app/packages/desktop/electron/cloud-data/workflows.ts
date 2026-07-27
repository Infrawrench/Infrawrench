/**
 * Cloud workflow IPC — the org-scoped `/workflows` routes, proxied for the
 * renderer's cloud WorkflowClient.
 *
 * Desktop workflows normally live in local SQLite (see the renderer's
 * `lib/workflow-client.ts`), but with an org selected the Workflows tab shows
 * the org's workflows instead — the same swap accounts, dashboards, and costs
 * already make. Everything here is transport: the isolate runs server-side for
 * cloud workflows, so there is no host to bridge.
 *
 * Git triggers need the org's GitHub App connection, which is why the
 * `/github` reads live here too rather than in a file of their own.
 */
import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

interface WorkflowIdArgs {
  orgId: string;
  id: string;
}

ipcMain.handle("cloud_list_workflows", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch<unknown[]>(orgId, "/workflows")) ?? [];
});

ipcMain.handle(
  "cloud_create_workflow",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, "/workflows", { method: "POST", body: JSON.stringify(body) });
  },
);

ipcMain.handle(
  "cloud_update_workflow",
  async (_e, { orgId, id, body }: { orgId: string; id: string; body: unknown }) => {
    return cloudFetch(orgId, `/workflows/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle("cloud_delete_workflow", async (_e, { orgId, id }: WorkflowIdArgs) => {
  await cloudFetch(orgId, `/workflows/${encodeURIComponent(id)}`, { method: "DELETE" });
  return { ok: true };
});

ipcMain.handle("cloud_workflow_typings", async (_e, { orgId, id }: WorkflowIdArgs) => {
  const res = await cloudFetch<{ dts: string }>(
    orgId,
    `/workflows/${encodeURIComponent(id)}/typings`,
  );
  return res?.dts ?? "";
});

// Non-interactive run. Interactive/debug runs go over the websocket instead
// (`workflow:*` frames), exactly as they do in the browser.
ipcMain.handle("cloud_run_workflow", async (_e, { orgId, id }: WorkflowIdArgs) => {
  return cloudFetch(orgId, `/workflows/${encodeURIComponent(id)}/run`, { method: "POST" });
});

ipcMain.handle("cloud_workflow_runs", async (_e, { orgId, id }: WorkflowIdArgs) => {
  return (await cloudFetch<unknown[]>(orgId, `/workflows/${encodeURIComponent(id)}/runs`)) ?? [];
});

ipcMain.handle("cloud_workflow_metrics", async (_e, { orgId, id }: WorkflowIdArgs) => {
  return (await cloudFetch<unknown[]>(orgId, `/workflows/${encodeURIComponent(id)}/metrics`)) ?? [];
});

// --- GitHub connection (git triggers) -------------------------------------

ipcMain.handle("cloud_github_status", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/github/status");
});

ipcMain.handle("cloud_github_repos", async (_e, { orgId }: { orgId: string }) => {
  const res = await cloudFetch<{ repos: unknown[] }>(orgId, "/github/repos");
  return res?.repos ?? [];
});

ipcMain.handle(
  "cloud_github_install_url",
  async (_e, { orgId, returnTo }: { orgId: string; returnTo?: string }) => {
    const query = returnTo ? `?return=${encodeURIComponent(returnTo)}` : "";
    const res = await cloudFetch<{ url: string }>(orgId, `/github/install-url${query}`);
    return res?.url ?? null;
  },
);
