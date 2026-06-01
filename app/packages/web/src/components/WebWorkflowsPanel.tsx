import { useCallback, useEffect, useState } from "react";
import { WorkflowsPanel, type GitRepoOption, type WorkflowClient } from "@infrawrench/ui/workflows";
import { apiGet } from "@/lib/api";

/**
 * Web wrapper around the shared WorkflowsPanel that supplies the GitHub
 * integration for git triggers: it loads the org's connection status + repos
 * and opens the install flow. Desktop renders WorkflowsPanel directly (git off).
 */
export function WebWorkflowsPanel({ client, orgId }: { client: WorkflowClient; orgId: string }) {
  const [repos, setRepos] = useState<GitRepoOption[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const status = await apiGet<{ configured: boolean }>(`/api/org/${orgId}/github/status`);
      setConfigured(status.configured);
      if (status.configured) {
        const res = await apiGet<{ repos: GitRepoOption[] }>(`/api/org/${orgId}/github/repos`);
        setRepos(res.repos);
      } else {
        setRepos([]);
      }
    } catch {
      /* leave previous state on transient failure */
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-check when the window regains focus — e.g. after the user installs the
  // app / picks repos in the GitHub tab and comes back.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const onConnect = useCallback(() => {
    void apiGet<{ url: string }>(`/api/org/${orgId}/github/install-url`)
      .then((r) => {
        if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
      })
      .catch(() => undefined);
  }, [orgId]);

  return (
    <WorkflowsPanel
      client={client}
      gitTriggers
      gitIntegration={{ configured, repos, loading, onConnect }}
    />
  );
}
