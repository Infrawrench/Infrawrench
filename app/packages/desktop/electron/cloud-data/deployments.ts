/**
 * Cloud deploy IPC — the org-scoped `/deployments` routes, proxied for the
 * renderer's cloud DeploymentClient.
 *
 * Everything that answers in one shot lives here. The full deploy does not: it
 * needs a live round trip for `select(...)` and streams build output for
 * minutes, so it runs over the cloud websocket straight from the renderer
 * (`deploy:*` frames), exactly as an interactive workflow run does.
 *
 * Local deploys never reach this file. They are built by the Docker daemon on
 * this machine from `infrawrench deploy` and recorded by `deploy-history.ts`.
 */
import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

ipcMain.handle("cloud_deploy_repos", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch<unknown[]>(orgId, "/deployments/repos")) ?? [];
});

ipcMain.handle(
  "cloud_deploy_envs",
  async (_e, { orgId, repo, branch }: { orgId: string; repo: string; branch: string }) => {
    return cloudFetch(orgId, "/deployments/envs", {
      method: "POST",
      body: JSON.stringify({ repo, branch }),
    });
  },
);

// Plan-only preview over HTTP. Non-interactive by nature, so an unanswered
// select() fails the run naming the key rather than prompting.
ipcMain.handle(
  "cloud_deploy_plan",
  async (_e, { orgId, opts }: { orgId: string; opts: unknown }) => {
    return cloudFetch(orgId, "/deployments/plan", {
      method: "POST",
      body: JSON.stringify(opts),
    });
  },
);

ipcMain.handle("cloud_deploy_runs", async (_e, { orgId, env }: { orgId: string; env?: string }) => {
  const query = env ? `?env=${encodeURIComponent(env)}` : "";
  return (await cloudFetch<unknown[]>(orgId, `/deployments/runs${query}`)) ?? [];
});

ipcMain.handle(
  "cloud_deploy_rollback",
  async (_e, { orgId, runId }: { orgId: string; runId: string }) => {
    return cloudFetch(orgId, `/deployments/runs/${encodeURIComponent(runId)}/rollback`, {
      method: "POST",
    });
  },
);

ipcMain.handle("cloud_deploy_triggers", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch<unknown[]>(orgId, "/deployments/triggers")) ?? [];
});

ipcMain.handle(
  "cloud_deploy_create_trigger",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/deployments/triggers", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_deploy_update_trigger",
  async (_e, { orgId, id, input }: { orgId: string; id: string; input: unknown }) => {
    return cloudFetch(orgId, `/deployments/triggers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_deploy_delete_trigger",
  async (_e, { orgId, id }: { orgId: string; id: string }) => {
    await cloudFetch(orgId, `/deployments/triggers/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    return { ok: true };
  },
);
