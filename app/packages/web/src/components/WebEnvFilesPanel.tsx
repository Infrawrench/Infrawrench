import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { settingsTabTarget } from "@infrawrench/ui/workspace-tabs";
import { EnvFilesPanel } from "@infrawrench/ui/env-files/EnvFilesPanel";
import { createWebEnvFilesClient } from "@/lib/env-files-client";
import { getWorkspaceNavigateArgs } from "@/lib/workspace-tabs";

/** Environment files. Rendered as a workspace tab by WebWorkspaceTabsViewport. */
export function WebEnvFilesPanel({ orgId }: { orgId: string }) {
  const navigate = useNavigate();
  const client = useMemo(() => createWebEnvFilesClient(orgId), [orgId]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Keyed by org so switching org remounts and refetches. */}
      <EnvFilesPanel
        key={orgId}
        client={client}
        orgId={orgId}
        openExternal={(url) => window.open(url, "_blank", "noopener,noreferrer")}
        onOpenGithubSettings={() =>
          void navigate(getWorkspaceNavigateArgs(settingsTabTarget("github-issues")))
        }
      />
    </div>
  );
}
