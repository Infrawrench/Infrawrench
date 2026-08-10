/**
 * Org-wide approvals inbox.
 *
 * Every workflow run in the org that is currently suspended on
 * `infra.waitForApproval(...)`, in one list. The Workflows tab shows the same
 * requests for one workflow at a time, which is the wrong shape for the person
 * who is on the hook for approving: they want "what is waiting on me", not
 * "what is waiting on this workflow".
 *
 * Reading is gated on `workflows:read` and deciding on `workflows:approve` —
 * both here for the UI and, authoritatively, on the routes themselves.
 */
import { ApprovalsInbox } from "../workflows/ApprovalsInbox.js";
import { useSettingsHost } from "./host.js";

export function ApprovalsSection() {
  const { has, permissionsLoading, approvals, openWorkspace } = useSettingsHost();
  const canRead = has("workflows:read");
  const canDecide = has("workflows:approve");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          Workflow runs waiting on a human. A run that calls <code>infra.waitForApproval(...)</code>{" "}
          suspends until someone approves or denies it here — or until the request expires, which
          fails the run.
        </p>
      </div>

      {permissionsLoading ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : !canRead ? (
        <p className="text-sm text-on-surface-muted">
          Your role does not include <code>workflows:read</code>, so you cannot see the
          organization&rsquo;s approval requests.
        </p>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          {!canDecide && (
            <p className="px-3 py-2 text-xs text-on-surface-muted border-b border-border">
              You can see what is waiting, but deciding needs <code>workflows:approve</code>.
            </p>
          )}
          <ApprovalsInbox
            client={approvals}
            canDecide={canDecide}
            onOpenWorkflow={() => openWorkspace("workflows")}
          />
        </div>
      )}
    </div>
  );
}
