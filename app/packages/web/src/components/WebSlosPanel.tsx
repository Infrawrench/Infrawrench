import { useMemo } from "react";
import { SlosPanel } from "@infrawrench/ui/slos";
import { usePermissions } from "@/auth/permissions-context";
import { createWebSlosClient } from "@/lib/slos-client";

/**
 * Web host for the shared SLOs screen, rendered as the "slos" workspace tab.
 * Which SLO is open lives in the URL (`/org/:orgId/slos/:id`), the incidents
 * stance: that records it on the tab and makes an SLO a link.
 */
export function WebSlosPanel({
  orgId,
  sloId,
  onSelectSlo,
}: {
  orgId: string;
  sloId?: string | undefined;
  onSelectSlo: (sloId: string | null) => void;
}) {
  const { has } = usePermissions();
  const canWrite = has("resources:write");
  const canFreeze = has("freezes:write");
  const client = useMemo(
    () => createWebSlosClient(orgId, canWrite, canFreeze),
    [orgId, canWrite, canFreeze],
  );
  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <SlosPanel key={orgId} client={client} sloId={sloId} onSloChange={onSelectSlo} />
    </div>
  );
}
