import { useCallback, useEffect, useState } from "react";
import {
  WorkflowsPanel,
  type BudgetOption,
  type GitRepoOption,
  type WorkflowClient,
} from "@infrawrench/ui/workflows";
import { apiGet } from "@/lib/api";

/**
 * Web wrapper around the shared WorkflowsPanel that supplies the cloud-only
 * trigger sources: the GitHub integration for git triggers (connection status +
 * repos + install flow) and the org's cost budgets for budget triggers. Desktop
 * renders WorkflowsPanel directly with both off.
 *
 * Which workflow is open lives in the URL, the IncidentsPanel stance: that is
 * what records it on the tab so a reload comes back to it, and it makes a
 * workflow a link somebody can paste — Slack/Teams `infra.page()` buttons
 * already mint `/org/{org}/workflows/{id}`.
 */
export function WebWorkflowsPanel({
  client,
  orgId,
  workflowId,
  onSelectWorkflow,
}: {
  client: WorkflowClient;
  orgId: string;
  workflowId?: string | undefined;
  onSelectWorkflow: (workflowId: string | null) => void;
}) {
  const [repos, setRepos] = useState<GitRepoOption[]>([]);
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [budgets, setBudgets] = useState<BudgetOption[]>([]);
  const [budgetsLoading, setBudgetsLoading] = useState(true);

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

  // Budgets are read once — the picker only needs id/name/amount, and a member
  // without `budgets:read` simply gets an empty list (and no Budget option).
  const refreshBudgets = useCallback(async () => {
    setBudgetsLoading(true);
    try {
      const rows = await apiGet<BudgetOption[]>(`/api/org/${orgId}/budgets`);
      setBudgets(
        rows.map(({ id, name, amountCents, currency }) => ({
          id,
          name,
          amountCents,
          currency,
        })),
      );
    } catch {
      setBudgets([]);
    } finally {
      setBudgetsLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void refresh();
    void refreshBudgets();
  }, [refresh, refreshBudgets]);

  // Re-check when the window regains focus — e.g. after the user installs the
  // app / picks repos in the GitHub tab and comes back.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const onConnect = useCallback(() => {
    void apiGet<{ url: string }>(`/api/org/${orgId}/github/install-url?return=workflows`)
      .then((r) => {
        if (r.url) window.open(r.url, "_blank", "noopener,noreferrer");
      })
      .catch(() => undefined);
  }, [orgId]);

  return (
    <WorkflowsPanel
      client={client}
      workflowId={workflowId}
      onWorkflowChange={onSelectWorkflow}
      gitTriggers
      gitIntegration={{ configured, repos, loading, onConnect }}
      budgetIntegration={{ budgets, loading: budgetsLoading }}
    />
  );
}
