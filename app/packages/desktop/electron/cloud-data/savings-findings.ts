import { ipcMain } from "electron";
import type { SavingsFindingStatusInput, SavingsViewInput } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { cloudFetch } from "./shared";

// The savings findings workflow, cloud mode only: statuses, detected dates
// and saved views live server-side (`savings_finding_states`,
// `savings_views`), so there is no local counterpart. Sharing a view rides
// the existing `cloud_settings_request` proxy (`sharing/` is allowlisted).

/** Pull the server's `{ error }` out of cloudFetch's "Cloud request failed" message. */
function serverError(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err);
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as { error?: unknown };
      if (typeof parsed.error === "string") return new Error(parsed.error);
    } catch {
      // Not a JSON body: keep the original message.
    }
  }
  return err instanceof Error ? err : new Error(text);
}

async function withServerMessage<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    throw serverError(err);
  }
}

ipcMain.handle(
  "cloud_savings_findings_list",
  async (_e, { orgId, refresh }: { orgId: string; refresh?: boolean }) => {
    return withServerMessage(
      cloudFetch(orgId, `/savings/findings${refresh ? "?refresh=true" : ""}`),
    );
  },
);

ipcMain.handle(
  "cloud_savings_findings_status",
  async (_e, { orgId, input }: { orgId: string; input: SavingsFindingStatusInput }) => {
    return withServerMessage(
      cloudFetch(orgId, "/savings/findings/status", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    );
  },
);

ipcMain.handle("cloud_savings_views_list", async (_e, { orgId }: { orgId: string }) => {
  return withServerMessage(cloudFetch(orgId, "/savings-views"));
});

ipcMain.handle(
  "cloud_savings_view_create",
  async (_e, { orgId, input }: { orgId: string; input: SavingsViewInput }) => {
    return withServerMessage(
      cloudFetch(orgId, "/savings-views", { method: "POST", body: JSON.stringify(input) }),
    );
  },
);

ipcMain.handle(
  "cloud_savings_view_update",
  async (_e, { orgId, id, input }: { orgId: string; id: string; input: SavingsViewInput }) => {
    return withServerMessage(
      cloudFetch(orgId, `/savings-views/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    );
  },
);

ipcMain.handle(
  "cloud_savings_view_delete",
  async (_e, { orgId, id }: { orgId: string; id: string }) => {
    await withServerMessage(
      cloudFetch(orgId, `/savings-views/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );
  },
);
