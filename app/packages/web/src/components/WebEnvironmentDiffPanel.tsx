import { useMemo } from "react";
import {
  EnvironmentDiffSection,
  type EnvironmentDiffAccount,
  type EnvironmentDiffClient,
  type EnvironmentDiffQuery,
  type EnvironmentDiffResourceTarget,
  type EnvironmentDiffResponse,
} from "@infrawrench/ui";
import { apiGet } from "@/lib/api";

interface WebEnvironmentDiffPanelProps {
  orgId: string;
  /** Preselected accounts, from the tab target / URL. */
  a?: string | undefined;
  b?: string | undefined;
  onSelectionChange: (selection: { a?: string; b?: string }) => void;
  openResource: (target: EnvironmentDiffResourceTarget) => void;
}

/**
 * Web host for the shared environment diff: the panel owns the pickers and the
 * rendering, this wires them to the org API. Both calls are plain reads over
 * synced state, so there is nothing to refresh on `RESOURCES_CHANGED_EVENT`
 * that the user wouldn't rather trigger by re-picking.
 */
export function WebEnvironmentDiffPanel({
  orgId,
  a,
  b,
  onSelectionChange,
  openResource,
}: WebEnvironmentDiffPanelProps) {
  const client = useMemo<EnvironmentDiffClient>(
    () => ({
      async listAccounts() {
        const rows = await apiGet<EnvironmentDiffAccount[]>(`/api/org/${orgId}/accounts`);
        return [...rows].sort((x, y) => x.displayName.localeCompare(y.displayName));
      },
      async compare(query: EnvironmentDiffQuery) {
        const params = new URLSearchParams({ a: query.a, b: query.b });
        if (query.includeIdentityFields) params.set("includeIdentityFields", "true");
        return apiGet<EnvironmentDiffResponse>(
          `/api/org/${orgId}/environment-diff?${params.toString()}`,
        );
      },
    }),
    [orgId],
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
