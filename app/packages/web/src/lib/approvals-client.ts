/**
 * Browser-side ApprovalsClient — the org-wide `/api/org/:orgId/workflow-approvals`
 * routes over fetch (session cookie auth).
 *
 * The per-workflow approvals card in the Workflows tab uses the same endpoints
 * through `lib/workflow-client.ts`; this one is the org-scoped view that backs
 * the approvals inbox.
 */
import type { ApprovalsClient, WorkflowApprovalRow, WorkflowApprovalStatus } from "@infrawrench/ui";
import { jsonInit, jsonOrThrow } from "./cookie-json";

export function createWebApprovalsClient(orgId: string): ApprovalsClient {
  const base = `/api/org/${orgId}/workflow-approvals`;
  return {
    list: (status?: WorkflowApprovalStatus) =>
      fetch(status ? `${base}?status=${encodeURIComponent(status)}` : base, jsonInit("GET")).then(
        (r) => jsonOrThrow<WorkflowApprovalRow[]>(r),
      ),
    decide: (approvalId: string, decision: "approve" | "deny") =>
      fetch(`${base}/${encodeURIComponent(approvalId)}/${decision}`, jsonInit("POST")).then((r) =>
        jsonOrThrow<WorkflowApprovalRow>(r),
      ),
  };
}
