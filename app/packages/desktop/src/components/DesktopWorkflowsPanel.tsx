import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ApprovalsInbox,
  WorkflowsPanel,
  type ApprovalsClient,
  type BudgetOption,
  type GitRepoOption,
  type WorkflowClient,
} from "@infrawrench/ui/workflows";
import { useUIStore } from "@infrawrench/ui";

import { createDesktopWorkflowClient } from "@/lib/workflow-client";
import {
  createCloudApprovalsClient,
  createCloudWorkflowClient,
  getCloudGithubInstallUrl,
  getCloudGithubStatus,
  listCloudGithubRepos,
} from "@/lib/cloud-workflows";
import { listCloudBudgets } from "@/lib/cloud-costs";
import { invoke } from "@/lib/invoke";
import { navigateToWorkspaceTarget, workflowsTabTarget } from "@/lib/workspace-tabs";

/**
 * Desktop wrapper around the shared WorkflowsPanel.
 *
 * Which workflows you see follows the org switcher, exactly as accounts,
 * dashboards, and costs do: with an org selected the panel talks to the org's
 * cloud workflows; in local mode it talks to the SQLite-backed client that runs
 * the isolate on this machine. The client is keyed by org so switching orgs
 * remounts the panel's data (the panel re-lists whenever `client` changes).
 *
 * Cloud mode also unlocks the two trigger sources that need a server: git
 * triggers (a GitHub App watching a repo) and budget triggers (evaluated by the
 * poller's cost pass). Local mode leaves both off — there is nothing always-on
 * to watch a repo, and budgets are a cloud feature.
 */

// One local client for the whole session — the local client runs workflows
// in-renderer, so a stable instance keeps run state tidy.
let localClient: WorkflowClient | null = null;
function getLocalClient(): WorkflowClient {
  if (!localClient) localClient = createDesktopWorkflowClient();
  return localClient;
}

// Cloud clients are cheap (pure IPC), but cache per org so a re-render doesn't
// hand the panel a new object and refire its effects.
const cloudClients = new Map<string, WorkflowClient>();
function getCloudClient(orgId: string): WorkflowClient {
  let client = cloudClients.get(orgId);
  if (!client) {
    client = createCloudWorkflowClient(orgId);
    cloudClients.set(orgId, client);
  }
  return client;
}

const approvalsClients = new Map<string, ApprovalsClient>();
function getApprovalsClient(orgId: string): ApprovalsClient {
  let client = approvalsClients.get(orgId);
  if (!client) {
    client = createCloudApprovalsClient(orgId);
    approvalsClients.set(orgId, client);
  }
  return client;
}

export function DesktopWorkflowsPanel({ workflowId }: { workflowId?: string | undefined }) {
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const navigate = useNavigate();
  const client = useMemo(
    () => (activeCloudOrgId ? getCloudClient(activeCloudOrgId) : getLocalClient()),
    [activeCloudOrgId],
  );

  const onWorkflowChange = useCallback(
    (next: string | null) => {
      void navigateToWorkspaceTarget(navigate, workflowsTabTarget(next ?? undefined), {
        label: "Workflows",
      });
    },
    [navigate],
  );

  const [repos, setRepos] = useState<GitRepoOption[]>([]);
  const [configured, setConfigured] = useState(false);
  const [gitLoading, setGitLoading] = useState(true);
  const [budgets, setBudgets] = useState<BudgetOption[]>([]);
  const [budgetsLoading, setBudgetsLoading] = useState(true);

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

  // The picker only needs id/name/amount; a member without `budgets:read`
  // simply gets an empty list (and no Budget option).
  const refreshBudgets = useCallback(async () => {
    if (!activeCloudOrgId) {
      setBudgets([]);
      setBudgetsLoading(false);
      return;
    }
    setBudgetsLoading(true);
    try {
      const rows = await listCloudBudgets(activeCloudOrgId);
      setBudgets(
        rows.map(({ id, name, amountCents, currency }) => ({ id, name, amountCents, currency })),
      );
    } catch {
      setBudgets([]);
    } finally {
      setBudgetsLoading(false);
    }
  }, [activeCloudOrgId]);

  useEffect(() => {
    void refreshGit();
    void refreshBudgets();
  }, [refreshGit, refreshBudgets]);

  // Re-check on focus — e.g. after installing the GitHub App in the browser.
  useEffect(() => {
    const onFocus = () => void refreshGit();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshGit]);

  const onConnect = useCallback(() => {
    if (!activeCloudOrgId) return;
    void getCloudGithubInstallUrl(activeCloudOrgId)
      .then((url) => {
        // The install flow is a GitHub web page — hand it to the system
        // browser rather than a renderer window (that's where the user's
        // GitHub session lives).
        if (url) void invoke("open_external_url", { url });
      })
      .catch(() => undefined);
  }, [activeCloudOrgId]);

  if (!activeCloudOrgId)
    return (
      <WorkflowsPanel client={client} workflowId={workflowId} onWorkflowChange={onWorkflowChange} />
    );

  // The org-wide inbox rides above the panel rather than living in a tab of its
  // own: the desktop app has no settings-route tree to hang it off, and an
  // approval that nobody lands blocks a run, so it should be hard to miss. It
  // collapses to nothing when there is nothing pending. Permission gating is
  // the server's — the desktop renderer does not resolve the viewer's role, so
  // a decision by someone without `workflows:approve` comes back 403.
  return (
    <div className="h-full flex flex-col min-h-0">
      <ApprovalsInbox client={getApprovalsClient(activeCloudOrgId)} hideWhenEmpty />
      <div className="flex-1 min-h-0">
        <WorkflowsPanel
          client={client}
          workflowId={workflowId}
          onWorkflowChange={onWorkflowChange}
          gitTriggers
          gitIntegration={{ configured, repos, loading: gitLoading, onConnect }}
          budgetIntegration={{ budgets, loading: budgetsLoading }}
        />
      </div>
    </div>
  );
}
