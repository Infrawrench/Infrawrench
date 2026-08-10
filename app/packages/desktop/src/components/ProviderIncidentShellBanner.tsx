import { useMemo } from "react";
import { ProviderIncidentBanner, useUIStore } from "@infrawrench/ui";
import { createDesktopStatusIncidentsClient } from "../lib/status-incidents-client";
import { invoke } from "../lib/invoke";

/**
 * Desktop shell mount for the shared provider-incident banner. Cloud-only —
 * renders nothing in local mode (no org) and nothing when no active incident
 * overlaps the org. External links go through the shell's external-URL
 * handler, per the desktop convention.
 */
export function ProviderIncidentShellBanner() {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client = useMemo(() => createDesktopStatusIncidentsClient(), []);
  if (!activeCloudOrgId) return null;
  return (
    <ProviderIncidentBanner
      key={activeCloudOrgId}
      client={client}
      onOpenUrl={(url) => void invoke("open_external_url", { url })}
    />
  );
}
