/**
 * Workflow approval requests: `/api/org/:orgId/workflow-approvals`, the
 * endpoint definitions.
 *
 * Listing takes `workflows:read` (the permission that opens the Workflows
 * tab); approving or denying takes `workflows:approve`, deliberately not
 * `workflows:write`: an approval step exists so a second person signs off.
 */
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { RequiredPermission, SuccessDescription } from "../../annotations";
import { withApiDefaults } from "../../domain";
import { BadRequest, Conflict, NotFound } from "../../errors";
import { OrgAuth } from "../../middleware-tags";
import { documentedAs } from "../../schemas/documented";
import { IsoDateTime, OrgIdParams, OrgParams, Uuid } from "../../schemas/common";

export const WorkflowApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "denied",
  "expired",
]).annotate({ identifier: "WorkflowApprovalStatus" });

export const WorkflowApproval = Schema.Struct({
  id: Uuid,
  workflowId: Uuid,
  workflowName: Schema.NullOr(Schema.String),
  runId: Uuid,
  title: Schema.String,
  message: Schema.String,
  status: WorkflowApprovalStatus,
  expiresAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
  decidedByName: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
}).annotate({ identifier: "WorkflowApproval" });

const decideEndpoint = (name: "approve" | "deny", summary: string, description: string) =>
  HttpApiEndpoint.post(name, `/:id/${name}`, {
    params: OrgIdParams,
    success: WorkflowApproval,
    error: [NotFound, Conflict],
  })
    .annotate(RequiredPermission, "workflows:approve")
    .annotate(OpenApi.Summary, summary)
    .annotate(OpenApi.Description, description)
    .annotate(SuccessDescription, "The decided request");

export class WorkflowApprovalsGroup extends HttpApiGroup.make("workflowApprovals")
  .add(
    HttpApiEndpoint.get("list", "/", {
      params: OrgParams,
      // Read as sent: the handler names the accepted statuses in its own 400.
      query: {
        status: Schema.optionalKey(documentedAs(WorkflowApprovalStatus)),
        workflowId: Schema.optionalKey(documentedAs(Uuid)),
        runId: Schema.optionalKey(documentedAs(Uuid)),
      },
      success: Schema.Array(WorkflowApproval),
      error: BadRequest,
    })
      .annotate(RequiredPermission, "workflows:read")
      .annotate(OpenApi.Summary, "List workflow approval requests")
      .annotate(
        OpenApi.Description,
        "Approval requests raised by `infra.waitForApproval(...)` inside workflow runs, newest " +
          "first. Filter with `status=pending` to build an approvals inbox.",
      )
      .annotate(SuccessDescription, "Approval requests"),
    decideEndpoint(
      "approve",
      "Approve a pending workflow approval request",
      "The suspended run resumes within a few seconds of the decision landing.",
    ),
    decideEndpoint(
      "deny",
      "Deny a pending workflow approval request",
      "Denial fails the waiting `infra.waitForApproval(...)` call in the run.",
    ),
  )
  .prefix("/api/org/:orgId/workflow-approvals")
  .middleware(OrgAuth)
  .annotate(OpenApi.Title, "Workflows") {}

export class WorkflowApprovalsApi extends withApiDefaults(
  HttpApi.make("workflowApprovals").add(WorkflowApprovalsGroup),
) {}
