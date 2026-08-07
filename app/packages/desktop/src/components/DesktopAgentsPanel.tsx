import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentsPanel, type AgentClient } from "@infrawrench/ui/agents";
import { type GitRepoOption } from "@infrawrench/ui/workflows";
import { useUIStore } from "@infrawrench/ui";
import { createDesktopAgentClient } from "@/lib/agent-client";
import { createCloudAgentClient } from "@/lib/cloud-agent-client";
import {
  getCloudGithubInstallUrl,
  getCloudGithubStatus,
  listCloudGithubRepos,
} from "@/lib/cloud-workflows";
import { invoke } from "@/lib/invoke";
import { getWorkspaceNavigateArgs } from "@/lib/workspace-tabs";

/**
 * The Agents tab, in whichever mode the app is in.
 *
 * Local-only mode keeps the original client: sessions live in this machine's
 * SQLite, VMs are provisioned and bootstrapped from here, and a session can be
 * a local folder. With an org selected the panel switches to the org's
 * sessions over the cloud API — the same ones web and mobile see — which is
 * also the only mode where the accounts on offer are the *org's* accounts.
 * Before this switch existed the tab always listed local accounts, so an
 * account that only lived in the org (a GCP project, say) could never be
 * picked as an agent target no matter which org was active.
 *
 * The mode follows `activeCloudOrgId` exactly like the accounts sidebar: it is
 * a switch, not a merge. Showing both stores in one list would leave no honest
 * way to say which VMs your teammates can see.
 */
export function DesktopAgentsPanel({
  navigate,
}: {
  navigate: (args: ReturnType<typeof getWorkspaceNavigateArgs>) => void;
}) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const client: AgentClient = useMemo(
    () => (activeCloudOrgId ? createCloudAgentClient() : createDesktopAgentClient()),
    [activeCloudOrgId],
  );

  const [repos, setRepos] = useState<GitRepoOption[]>([]);
  const [configured, setConfigured] = useState(false);
  const [gitLoading, setGitLoading] = useState(true);

  const refreshGit = useCallback(async () => {
    if (!activeCloudOrgId) {
      setConfigured(false);
      setRepos([]);
      setGitLoading(false);
      return;
    }
    setGitLoading(true);
    try {
      const status = await getCloudGithubStatus(activeCloudOrgId);
      setConfigured(status.configured);
      setRepos(status.configured ? await listCloudGithubRepos(activeCloudOrgId) : []);
    } catch {
      /* leave previous state on transient failure */
    } finally {
      setGitLoading(false);
    }
  }, [activeCloudOrgId]);

  useEffect(() => {
    void refreshGit();
  }, [refreshGit]);

  // Re-check on focus — e.g. after installing the GitHub App in the browser.
  useEffect(() => {
    const onFocus = () => void refreshGit();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshGit]);

  const onConnect = useCallback(() => {
    if (!activeCloudOrgId) return;
    void getCloudGithubInstallUrl(activeCloudOrgId, "agents")
      .then((url) => {
        // The install flow is a GitHub web page — hand it to the system
        // browser rather than a renderer window (that's where the user's
        // GitHub session lives).
        if (url) void invoke("open_external_url", { url });
      })
      .catch(() => undefined);
  }, [activeCloudOrgId]);

  const openWorkspaceTarget: Parameters<typeof AgentsPanel>[0]["openWorkspaceTarget"] = (target) =>
    navigate(getWorkspaceNavigateArgs(target));

  // Keyed by org so switching org refetches rather than leaving the previous
  // org's sessions, accounts and saved defaults on screen.
  if (!activeCloudOrgId) {
    return <AgentsPanel key="local" client={client} openWorkspaceTarget={openWorkspaceTarget} />;
  }

  return (
    <AgentsPanel
      key={activeCloudOrgId}
      client={client}
      openWorkspaceTarget={openWorkspaceTarget}
      gitIntegration={{ configured, repos, loading: gitLoading, onConnect }}
    />
  );
}
