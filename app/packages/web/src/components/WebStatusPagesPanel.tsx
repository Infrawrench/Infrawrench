import { useMemo } from "react";
import { StatusPagesPanel, probesTabTarget } from "@infrawrench/ui";
import { useNavigate } from "@tanstack/react-router";
import { createWebStatusPagesClient } from "@/lib/status-pages-client";
import { getWorkspaceNavigateArgs } from "@/lib/workspace-tabs";

/** Standalone workspace tool for configuring public status pages. */
export function WebStatusPagesPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const client = useMemo(() => createWebStatusPagesClient(orgId), [orgId]);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <StatusPagesPanel
        key={orgId}
        client={client}
        onOpenProbes={() => void navigate(getWorkspaceNavigateArgs(probesTabTarget()))}
      />
    </div>
  );
}
