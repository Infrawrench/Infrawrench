/**
 * Org-wide approvals inbox: every workflow run currently suspended on
 * `infra.waitForApproval(...)`, whoever started it.
 *
 * Host-injected client, like `CostsPanel` / `SavingsPanel`: the web app talks
 * to `/api/org/:orgId/workflow-approvals` over fetch, the desktop app proxies
 * the same routes over IPC, and this component knows about neither. Reading the
 * list needs `workflows:read`; the Approve/Deny buttons need
 * `workflows:approve` — pass `canDecide` from whatever the host knows about the
 * viewer's permissions. The server enforces both regardless.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApprovalCard } from "./ApprovalCard.js";
import type { ApprovalsClient, WorkflowApprovalRow } from "./types.js";

export interface ApprovalsInboxProps {
  client: ApprovalsClient;
  /** Whether the viewer holds `workflows:approve`. Defaults to true. */
  canDecide?: boolean;
  /** Render nothing at all when there is nothing pending (banner-style hosts). */
  hideWhenEmpty?: boolean;
  /** Open the workflow a request came from, when the host can navigate. */
  onOpenWorkflow?: (workflowId: string) => void;
  /** Poll interval in ms. Requests expire on a timer, so the list goes stale. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 15_000;

export function ApprovalsInbox({
  client,
  canDecide = true,
  hideWhenEmpty = false,
  onOpenWorkflow,
  pollMs = DEFAULT_POLL_MS,
}: ApprovalsInboxProps) {
  const [approvals, setApprovals] = useState<WorkflowApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Two slots, because the refresh that follows a decision must not wipe the
  // message that decision produced ("someone else already decided this").
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const error = decideError ?? loadError;
  // Poll failures must not blank a list the user is mid-decision on, so the
  // first load and the refreshes are treated differently.
  const loadedOnce = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const rows = await client.list("pending");
      setApprovals(rows);
      setLoadError(null);
      loadedOnce.current = true;
    } catch (e) {
      if (!loadedOnce.current) {
        setLoadError(e instanceof Error ? e.message : "Failed to load approval requests");
      }
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);

  const decide = useCallback(
    async (approvalId: string, decision: "approve" | "deny") => {
      setDecidingId(approvalId);
      setDecideError(null);
      try {
        await client.decide(approvalId, decision);
        // Drop it immediately — a decided request is no longer pending, and
        // waiting for the next poll would leave a dead row clickable.
        setApprovals((rows) => rows.filter((r) => r.id !== approvalId));
      } catch (e) {
        // 409 means someone else got there first; re-listing shows the truth.
        setDecideError(e instanceof Error ? e.message : "Failed to record the decision");
      } finally {
        setDecidingId(null);
        void refresh();
      }
    },
    [client, refresh],
  );

  if (hideWhenEmpty && !loading && approvals.length === 0 && !error) return null;

  return (
    <div className="flex flex-col min-h-0">
      {error && (
        <div className="mx-3 mt-3 px-3 py-2 text-xs text-red-300 border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}
      {loading && approvals.length === 0 ? (
        <p className="px-3 py-3 text-xs opacity-60">Loading…</p>
      ) : approvals.length === 0 ? (
        <p className="px-3 py-3 text-xs opacity-60">
          Nothing waiting. Requests appear here while a workflow run is suspended on{" "}
          <code>infra.waitForApproval(...)</code>.
        </p>
      ) : (
        <div className="border-t border-amber-400/30 bg-amber-400/5 overflow-auto">
          {approvals.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              showWorkflow
              canDecide={canDecide}
              deciding={decidingId === a.id}
              onDecide={(id, decision) => void decide(id, decision)}
              {...(onOpenWorkflow ? { onOpenWorkflow } : {})}
            />
          ))}
        </div>
      )}
    </div>
  );
}
