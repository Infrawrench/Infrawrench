import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Environment diff — cloud mode. The comparison is computed server-side over
// the org's synced rows (`GET /environment-diff`, the same endpoint the web
// Env diff screen and `infrawrench diff` use). The local-mode counterpart
// lives in the renderer (src/lib/local-environment-diff.ts), which runs the
// shared `computeEnvironmentDiff` over this machine's workspace.

ipcMain.handle(
  "cloud_environment_diff",
  async (
    _e,
    {
      orgId,
      a,
      b,
      includeIdentityFields,
    }: { orgId: string; a: string; b: string; includeIdentityFields?: boolean },
  ) => {
    const params = new URLSearchParams({ a, b });
    if (includeIdentityFields) params.set("includeIdentityFields", "true");
    return cloudFetch(orgId, `/environment-diff?${params.toString()}`);
  },
);
