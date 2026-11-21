import { useMemo } from "react";
import { useGT } from "gt-react";
import { useNavigate } from "@tanstack/react-router";
import { useUIStore } from "@infrawrench/ui";
import { EnvFilesPanel } from "@infrawrench/ui/env-files/EnvFilesPanel";
import { openExternalUrl } from "@/lib/app-shell";
import { createDesktopEnvFilesClient } from "@/lib/env-files-client";
import { navigateToWorkspaceTarget, settingsTabTarget } from "@/lib/workspace-tabs";

/**
 * Environment files on desktop. Rendered as a workspace tab. Cloud-only: the
 * references resolve against the org's synced resources and secrets, and the
 * file is read and committed through the org's GitHub App, so without an org
 * the tab says so rather than fetching.
 */
export function DesktopEnvFilesPanel() {
  const gt = useGT();
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(() => createDesktopEnvFilesClient(), []);

  if (!activeCloudOrgId) {
    return (
      <div className="p-6 text-sm text-on-surface-faint">
        {gt("Environment files require cloud mode: sign in to sync.")}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <EnvFilesPanel
        key={activeCloudOrgId}
        client={client}
        orgId={activeCloudOrgId}
        openExternal={(url) => void openExternalUrl(url)}
        onOpenGithubSettings={() =>
          void navigateToWorkspaceTarget(navigate, settingsTabTarget("github-issues"), {
            label: gt("Settings"),
          })
        }
      />
    </div>
  );
}
