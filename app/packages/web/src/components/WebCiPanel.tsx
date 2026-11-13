import { useMemo } from "react";
import { CiPanel } from "@infrawrench/ui/ci";
import { usePermissions } from "@/auth/permissions-context";
import { createWebCiClient } from "@/lib/ci-client";

/** Web host for the shared CI screen, rendered as the "ci" workspace tab. */
export function WebCiPanel({
  orgId,
  runId,
  onSelectRun,
}: {
  orgId: string;
  runId: string | undefined;
  onSelectRun: (runId: string | null) => void;
}) {
  const { has } = usePermissions();
  const client = useMemo(() => createWebCiClient(orgId), [orgId]);
  return (
    // A run uses the tab's whole width: its graph needs it.
    <div className={runId ? "p-6" : "p-6 max-w-6xl mx-auto"}>
      <CiPanel
        key={orgId}
        client={client}
        selectedRunId={runId ?? null}
        onSelectRun={onSelectRun}
        canWrite={has("ci:write")}
        canManageAccess={has("ci-access:write")}
        canApprove={has("ci:approve")}
        onOpenUrl={(url) => window.open(url, "_blank", "noopener,noreferrer")}
      />
    </div>
  );
}
