import { useMemo } from "react";
import { ProviderIncidentBanner } from "@infrawrench/ui";
import { createWebStatusIncidentsClient } from "@/lib/status-incidents-client";

/**
 * Shell mount for the shared provider-incident banner ("is it me or is it
 * them?"). Sits next to ChangeFreezeBanner in the app shell; the shared
 * component renders nothing when no active incident overlaps the org.
 */
export function ProviderIncidentShellBanner({ orgId }: { orgId: string }) {
  const client = useMemo(() => createWebStatusIncidentsClient(orgId), [orgId]);
  return (
    <ProviderIncidentBanner
      key={orgId}
      client={client}
      onOpenUrl={(url) => window.open(url, "_blank", "noopener,noreferrer")}
    />
  );
}
