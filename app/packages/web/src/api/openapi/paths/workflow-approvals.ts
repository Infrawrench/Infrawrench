import { z } from "../zod";
import { strict, ErrorResponses, OrgIdParam, Uuid, IsoDateTime } from "../common";
import type { BuildContext } from "../context";

const ApprovalStatus = z
  .enum(["pending", "approved", "denied", "expired"])
  .openapi("WorkflowApprovalStatus");

const WorkflowApproval = strict({
  id: Uuid,
  workflowId: Uuid,
  /** Present on listings (joined); null when the workflow row is gone. */
  workflowName: z.string().nullable(),
  /** The run suspended on this request. */
  runId: Uuid,
  title: z.string(),
  /** What the approver is deciding. */
  message: z.string(),
  status: ApprovalStatus,
  /** When a still-pending request is treated as denied. */
  expiresAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
  /** Display name/email snapshot of the member who decided. */
  decidedByName: z.string().nullable(),
  createdAt: IsoDateTime,
}).openapi("WorkflowApproval");

export function registerWorkflowApprovalPaths(ctx: BuildContext) {
  const { registry } = ctx;
  const idParam = () =>
    OrgIdParam.extend({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

  registry.registerPath({
    method: "get",
    path: "/api/org/{orgId}/workflow-approvals",
    tags: ["Workflows"],
    summary: "List workflow approval requests",
    description:
      "Approval requests raised by `infra.waitForApproval(...)` inside workflow runs, newest " +
      "first. Filter with `status=pending` to build an approvals inbox.",
    request: {
      params: OrgIdParam,
      query: strict({
        status: ApprovalStatus.optional().openapi({ param: { name: "status", in: "query" } }),
        workflowId: Uuid.optional().openapi({ param: { name: "workflowId", in: "query" } }),
        runId: Uuid.optional().openapi({ param: { name: "runId", in: "query" } }),
      }),
    },
    responses: {
      200: {
        description: "Approval requests",
        content: { "application/json": { schema: z.array(WorkflowApproval) } },
      },
      400: ErrorResponses[400],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/workflow-approvals/{id}/approve",
    tags: ["Workflows"],
    summary: "Approve a pending workflow approval request",
    description: "The suspended run resumes within a few seconds of the decision landing.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "The decided request",
        content: { "application/json": { schema: WorkflowApproval } },
      },
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/org/{orgId}/workflow-approvals/{id}/deny",
    tags: ["Workflows"],
    summary: "Deny a pending workflow approval request",
    description: "Denial fails the waiting `infra.waitForApproval(...)` call in the run.",
    request: { params: idParam() },
    responses: {
      200: {
        description: "The decided request",
        content: { "application/json": { schema: WorkflowApproval } },
      },
      404: ErrorResponses[404],
      409: ErrorResponses[409],
    },
  });
}
