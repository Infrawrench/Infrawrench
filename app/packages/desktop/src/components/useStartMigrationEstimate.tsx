import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";
import type { MigrationEstimateSource } from "@infrawrench/client-core";
import { NewMigrationEstimateModal } from "@infrawrench/ui/migration-estimates/NewMigrationEstimateModal";
import { createDesktopMigrationEstimatesClient } from "@/lib/migration-estimates-client";
import { migrationEstimatesTabTarget, navigateToWorkspaceTarget } from "@/lib/workspace-tabs";

/**
 * The "Estimate migration" action other panels offer (a service, a resource
 * report selection): a starter and the dialog it opens, which saves the
 * estimate and opens it in its tab. The web hook's twin.
 */
export function useStartMigrationEstimate() {
  const gt = useGT();
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopMigrationEstimatesClient(), []);
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
        void navigateToWorkspaceTarget(navigate, migrationEstimatesTabTarget(created.id), {
          label: gt("Migration estimates"),
        });
      }}
    />
  ) : null;
  return { start: setSource, dialog };
}
