import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Change timeline / drift feed — cloud-mode only. The events are recorded by
// the cloud poller as it re-syncs accounts, so local-only mode has no poller
// and therefore no feed (the CLI's `infrawrench changes` says the same thing).

interface ChangeFeedArgs {
  orgId: string;
  page: number;
  pageSize: number;
  accountId?: string;
  kind?: string;
}

ipcMain.handle(
  "cloud_changes_list",
  async (_e, { orgId, page, pageSize, accountId, kind }: ChangeFeedArgs) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (accountId) params.set("accountId", accountId);
    if (kind) params.set("kind", kind);
    return cloudFetch(orgId, `/changes?${params.toString()}`);
  },
);
