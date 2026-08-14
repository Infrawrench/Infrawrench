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
import { T, useGT } from "gt-react";
import { ApprovalsInbox } from "../workflows/ApprovalsInbox.js";
import { useSettingsHost } from "./host.js";

export function ApprovalsSection() {
  const gt = useGT();
  const { has, permissionsLoading, approvals, openWorkspace } = useSettingsHost();
  const canRead = has("workflows:read");
  const canDecide = has("workflows:approve");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Approvals")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            Workflow runs waiting on a human. A run that calls{" "}
            <code>infra.waitForApproval(...)</code> suspends until someone approves or denies it
            here — or until the request expires, which fails the run.
          </p>
        </T>
      </div>

      {permissionsLoading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : !canRead ? (
        <T>
          <p className="text-sm text-on-surface-muted">
            Your role does not include <code>workflows:read</code>, so you cannot see the
            organization&rsquo;s approval requests.
          </p>
        </T>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          {!canDecide && (
            <T>
              <p className="px-3 py-2 text-xs text-on-surface-muted border-b border-border">
                You can see what is waiting, but deciding needs <code>workflows:approve</code>.
              </p>
            </T>
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
