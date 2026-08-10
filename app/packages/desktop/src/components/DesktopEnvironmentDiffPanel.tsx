import { useMemo } from "react";
import {
  EnvironmentDiffSection,
  useUIStore,
  type EnvironmentDiffAccount,
  type EnvironmentDiffClient,
  type EnvironmentDiffQuery,
  type EnvironmentDiffResourceTarget,
} from "@infrawrench/ui";
import { fetchCloudEnvironmentDiff } from "@/lib/cloud-resources";
import { listCloudAccounts } from "@/lib/cloud-accounts";
import { loadLocalEnvironmentDiff } from "@/lib/local-environment-diff";
import { getDb } from "@/db/client";

interface DesktopEnvironmentDiffPanelProps {
  /** Preselected accounts, from the tab target / URL. */
  a?: string | undefined;
  b?: string | undefined;
  onSelectionChange: (selection: { a?: string; b?: string }) => void;
  openResource: (target: EnvironmentDiffResourceTarget) => void;
}

/**
 * Desktop host for the shared environment diff. Cloud mode compares the org's
 * synced rows through the web API; local mode runs the same shared computation
 * over two of this machine's accounts, enumerated live through the plugin
 * (the local workspace has no synced store to read).
 */
export function DesktopEnvironmentDiffPanel({
  a,
  b,
  onSelectionChange,
  openResource,
}: DesktopEnvironmentDiffPanelProps) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);

  const client = useMemo<EnvironmentDiffClient>(
    () => ({
      async listAccounts(): Promise<EnvironmentDiffAccount[]> {
        const rows = activeCloudOrgId
          ? (await listCloudAccounts(activeCloudOrgId)).map((account) => ({
              id: account.id,
              displayName: account.displayName,
              pluginId: account.pluginId,
            }))
          : (
              await (
                await getDb()
              ).select<{ id: string; display_name: string; plugin_id: string }[]>(
                "SELECT id, display_name, plugin_id FROM accounts WHERE deleted_at IS NULL",
              )
            ).map((row) => ({
              id: row.id,
              displayName: row.display_name,
              pluginId: row.plugin_id,
            }));
        return rows.sort((x, y) => x.displayName.localeCompare(y.displayName));
      },
      compare(query: EnvironmentDiffQuery) {
        return activeCloudOrgId
          ? fetchCloudEnvironmentDiff(activeCloudOrgId, query)
          : loadLocalEnvironmentDiff(query.a, query.b, {
              includeIdentityFields: query.includeIdentityFields,
            });
      },
    }),
    [activeCloudOrgId],
  );

  return (
    <EnvironmentDiffSection
      client={client}
      initialA={a}
      initialB={b}
      onSelectionChange={onSelectionChange}
      onOpenResource={openResource}
    />
  );
}
