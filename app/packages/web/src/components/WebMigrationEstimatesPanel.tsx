import { MigrationEstimatesPanel } from "@infrawrench/ui/migration-estimates/MigrationEstimatesPanel";
import type { MigrationResourceRef } from "@infrawrench/ui/migration-estimates/types";
import { useMigrationClient } from "./useStartMigrationEstimate";

/**
 * Web host for the shared migration estimates screen, rendered as the
 * "migration-estimates" workspace tab. Which estimate is open lives in the URL
 * (`/org/:orgId/migration-estimates/:id`), the resource reports stance.
 */
export function WebMigrationEstimatesPanel({
  orgId,
  estimateId,
  onSelectEstimate,
  onOpenResource,
  onOpenServices,
  onOpenResourceReports,
}: {
  orgId: string;
  estimateId?: string | undefined;
  onSelectEstimate: (estimateId: string | null) => void;
  onOpenResource: (ref: MigrationResourceRef) => void;
  onOpenServices: () => void;
  onOpenResourceReports: () => void;
}) {
  const client = useMigrationClient(orgId);
  return (
    <div className="w-full p-6 max-w-[1400px] mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <MigrationEstimatesPanel
        key={orgId}
        client={client}
        estimateId={estimateId}
        onEstimateChange={onSelectEstimate}
        onOpenResource={onOpenResource}
        onOpenServices={onOpenServices}
        onOpenResourceReports={onOpenResourceReports}
      />
    </div>
  );
}
