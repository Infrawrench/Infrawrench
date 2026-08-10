import { ipcMain } from "electron";
import { getAccessToken, forceRefreshAccessToken } from "../cloud-auth";
import { CLOUD_URL } from "../../env";
import { cloudFetch } from "./shared";

ipcMain.handle("cloud_ssh_fanout_targets", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, `/ssh-fanout/targets`);
});

/**
 * Run a fan-out. Unlike the generic `cloudFetch`, a 423 (change freeze) is not
 * an error here — the renderer surfaces it with an override affordance — so
 * the handler returns `{ status, body }` and lets the caller decide.
 */
ipcMain.handle(
  "cloud_ssh_fanout_run",
  async (
    _e,
    { orgId, body, overrideFreeze }: { orgId: string; body: unknown; overrideFreeze?: boolean },
  ) => {
    let token = await getAccessToken();
    if (!token) throw new Error("Not authenticated to Infrawrench Cloud");
    const url = `${CLOUD_URL}/api/org/${encodeURIComponent(orgId)}/ssh-fanout/run`;
    const buildInit = (t: string): RequestInit => ({
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${t}`,
        "Content-Type": "application/json",
        ...(overrideFreeze ? { "x-change-freeze-override": "true" } : {}),
      },
    });
    let res = await fetch(url, buildInit(token));
    if (res.status === 401) {
      const refreshed = await forceRefreshAccessToken();
      if (!refreshed) throw new Error("Authentication expired; please sign in again");
      token = refreshed;
      res = await fetch(url, buildInit(token));
    }
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* non-JSON error body */
    }
    return { status: res.status, body: parsed };
  },
);

ipcMain.handle("cloud_ssh_fanout_snippets_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, `/ssh-fanout/snippets`);
});

ipcMain.handle(
  "cloud_ssh_fanout_snippets_create",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) => {
    return cloudFetch(orgId, `/ssh-fanout/snippets`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  },
);

ipcMain.handle(
  "cloud_ssh_fanout_snippets_delete",
  async (_e, { orgId, id }: { orgId: string; id: string }) => {
    return cloudFetch(orgId, `/ssh-fanout/snippets/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
);
