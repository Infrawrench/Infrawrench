import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { MigrationEstimateSource } from "@infrawrench/client-core";
import { migrationEstimatesTabTarget } from "@infrawrench/ui";
import { NewMigrationEstimateModal } from "@infrawrench/ui/migration-estimates/NewMigrationEstimateModal";
import { usePermissions } from "@/auth/permissions-context";
import { createWebMigrationEstimatesClient } from "@/lib/migration-estimates-client";
import { getWorkspaceNavigateArgs } from "@/lib/workspace-tabs";

/** The org's migration estimates client; writes only with `costs:write`. */
export function useMigrationClient(orgId: string) {
  const { has } = usePermissions();
  const canWrite = has("costs:write");
  return useMemo(() => createWebMigrationEstimatesClient(orgId, canWrite), [orgId, canWrite]);
}

/**
 * The "Estimate migration" action other panels offer (a service, a resource
 * report selection): returns a starter and the dialog it opens, which saves
 * the estimate and opens it in its tab. Null starter without `costs:write`.
 */
export function useStartMigrationEstimate(orgId: string) {
  const client = useMigrationClient(orgId);
  const navigate = useNavigate();
  const [source, setSource] = useState<{ source: MigrationEstimateSource; label: string } | null>(
    null,
  );
  const dialog = source ? (
    <NewMigrationEstimateModal
      client={client}
      source={source}
      onClose={() => setSource(null)}
      onCreated={(created) => {
        setSource(null);
        void navigate(getWorkspaceNavigateArgs(migrationEstimatesTabTarget(created.id)));
      }}
    />
  ) : null;
  return { start: client.create ? setSource : null, dialog };
}
