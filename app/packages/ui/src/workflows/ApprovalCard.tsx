/**
 * One pending `infra.waitForApproval(...)` request, with its Approve/Deny pair.
 *
 * Shared deliberately: the same card renders inside a workflow's detail view
 * (the run you are watching is blocked on it) and in the org-wide approvals
 * inbox (someone else's run is blocked on it). Keeping one component means the
 * two surfaces can't drift on what an approver is shown before deciding.
 */
import type { WorkflowApprovalRow } from "./types.js";

export interface ApprovalCardProps {
  approval: WorkflowApprovalRow;
  /** True while this row's decision is in flight — disables both buttons. */
  deciding?: boolean;
  /**
   * False hides Approve/Deny entirely (the viewer can read approvals but not
   * decide them — `workflows:read` without `workflows:approve`).
   */
  canDecide?: boolean;
  onDecide?: (id: string, decision: "approve" | "deny") => void;
  /** Show which workflow raised it. On by default in the inbox, off in-context. */
  showWorkflow?: boolean;
  /** Open the workflow this request came from, when the host can navigate. */
  onOpenWorkflow?: (workflowId: string) => void;
}

/**
 * "in 4m" / "in 2h" / "3m ago". Approval windows are short by nature, so the
 * absolute timestamp is the tooltip and the countdown is the headline.
 */
export function formatExpiry(expiresAt: string, now: number = Date.now()): string {
  const deltaMs = new Date(expiresAt).getTime() - now;
  if (Number.isNaN(deltaMs)) return "";
  const past = deltaMs < 0;
  const mins = Math.round(Math.abs(deltaMs) / 60_000);
  const body =
    mins < 1
      ? "less than a minute"
      : mins < 60
        ? `${mins}m`
        : mins < 60 * 24
          ? `${Math.round(mins / 60)}h`
          : `${Math.round(mins / (60 * 24))}d`;
  return past ? `expired ${body} ago` : `expires in ${body}`;
}

export function ApprovalCard({
  approval,
  deciding = false,
  canDecide = true,
  onDecide,
  showWorkflow = false,
  onOpenWorkflow,
}: ApprovalCardProps) {
  const expired = new Date(approval.expiresAt).getTime() <= Date.now();
  return (
    <div className="px-3 py-2 flex items-start gap-3 border-b border-white/5">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-amber-300">
          Approval needed: {approval.title}
          <span
            className={`ml-2 font-normal ${expired ? "text-red-300" : "opacity-60"}`}
            title={new Date(approval.expiresAt).toLocaleString()}
          >
            {formatExpiry(approval.expiresAt)}
          </span>
        </div>
        {showWorkflow && (
          <div className="text-[11px] opacity-60 mt-0.5">
            {onOpenWorkflow ? (
              <button
                type="button"
                onClick={() => onOpenWorkflow(approval.workflowId)}
                className="underline underline-offset-2 hover:opacity-80"
              >
                {approval.workflowName ?? "Deleted workflow"}
              </button>
            ) : (
              (approval.workflowName ?? "Deleted workflow")
            )}
            <span className="mx-1.5">·</span>
            <span title={approval.runId}>run {approval.runId.slice(0, 8)}</span>
            <span className="mx-1.5">·</span>
            <span title={new Date(approval.createdAt).toLocaleString()}>
              requested {new Date(approval.createdAt).toLocaleString()}
            </span>
          </div>
        )}
        <div className="text-xs opacity-80 whitespace-pre-wrap break-words">{approval.message}</div>
      </div>
      {canDecide && (
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={deciding}
            onClick={() => onDecide?.(approval.id, "approve")}
            className="px-2 py-1 text-xs rounded bg-green-500/20 text-green-300 hover:bg-green-500/30 disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() => onDecide?.(approval.id, "deny")}
            className="px-2 py-1 text-xs rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 disabled:opacity-50"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
