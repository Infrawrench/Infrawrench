/**
 * Workflow approval requests for Bearer hosts (mobile today).
 *
 * A run that calls `infra.waitForApproval(...)` suspends and writes a pending
 * `workflow_approvals` row; these are the reads and writes that land the
 * decision. Server contract: `/api/org/:orgId/workflow-approvals` (web
 * `api/routes/workflow-approvals.ts`) — listing takes `workflows:read`,
 * approving or denying takes `workflows:approve`, which is deliberately not
 * `workflows:write`.
 *
 * Web and desktop reach the same endpoints through the `ApprovalsClient`
 * transport they inject into `@infrawrench/ui`'s `ApprovalsInbox`; the row
 * shape here is the same HTTP shape that component's `WorkflowApprovalRow`
 * describes. This module is the client-core half of it, for hosts that talk to
 * the cloud API directly and cannot load a DOM component library.
 */
import { CloudApiError, type CloudFetch } from "./fetch";

export type WorkflowApprovalStatus = "pending" | "approved" | "denied" | "expired";

/** One approval request as returned by `GET /workflow-approvals`. */
export interface WorkflowApproval {
  id: string;
  workflowId: string;
  /** Null when the workflow has since been deleted. */
  workflowName: string | null;
  /** The run suspended on this request. */
  runId: string;
  title: string;
  message: string;
  status: WorkflowApprovalStatus;
  /** When a still-pending request is treated as denied (ISO). */
  expiresAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  createdAt: string;
}

export type ApprovalDecision = "approve" | "deny";

/**
 * Approval requests across the org, newest first. A `"pending"` listing is
 * filtered server-side to requests whose timeout has not passed, so it never
 * offers a decision the waiting run would ignore.
 */
export async function fetchWorkflowApprovals(
  api: CloudFetch,
  orgId: string,
  status?: WorkflowApprovalStatus,
): Promise<WorkflowApproval[]> {
  const path = status
    ? `/workflow-approvals?status=${encodeURIComponent(status)}`
    : "/workflow-approvals";
  return (await api.org<WorkflowApproval[]>(orgId, path)) ?? [];
}

/**
 * Land a decision. Throws a {@link CloudApiError} with status 409 when someone
 * else decided first or the request expired — see {@link isApprovalConflict}.
 */
export async function decideWorkflowApproval(
  api: CloudFetch,
  orgId: string,
  approvalId: string,
  decision: ApprovalDecision,
): Promise<WorkflowApproval | null> {
  return api.org<WorkflowApproval>(
    orgId,
    `/workflow-approvals/${encodeURIComponent(approvalId)}/${decision}`,
    { method: "POST" },
  );
}

/**
 * True when a failed decision was a conflict: the request had already been
 * approved, denied or expired. The server's conditional UPDATE is what makes
 * two people racing the same request produce exactly one decision — the loser
 * gets this, and the honest thing to do is say so and re-list rather than
 * retry.
 */
export function isApprovalConflict(error: unknown): boolean {
  return error instanceof CloudApiError && error.status === 409;
}

/** Whether the request's timeout has already passed. */
export function isApprovalExpired(approval: WorkflowApproval, now: number = Date.now()): boolean {
  const at = new Date(approval.expiresAt).getTime();
  return !Number.isNaN(at) && at <= now;
}

/**
 * "expires in 4m" / "expires in 2h" / "expired 3m ago".
 *
 * Approval windows are short by nature, so the countdown is the headline and
 * the absolute timestamp is the detail. Mirrors `formatExpiry` in
 * `@infrawrench/ui`'s `ApprovalCard` so the phone and the desktop inbox word
 * the same request the same way.
 */
export function formatApprovalExpiry(expiresAt: string, now: number = Date.now()): string {
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
